// Called by the PARENT's app when they tap "Find My Child".
// Deploy normally (JWT verification stays ON):
//   supabase functions deploy request-child-location
//
// What it does, in order:
//   1. Identifies the caller from their own session (never from the request body).
//   2. Confirms the caller is linked to that child in `guardians`.
//   3. Finds the child's active, registered device.
//   4. Creates a short-lived request row with a one-time code (only its hash is stored).
//   5. Sends a silent push to that one device. The phone answers via submit-child-location.
//
// Expected outcomes always come back as HTTP 200 with { ok: true | false, ... } so the
// app can show "Unable to get current location." Only real errors use 4xx/5xx.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAccessToken, sendDataPush, loadServiceAccount } from "../_shared/fcm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// The academy profile the person is working in is carried in their token
// (same claim the app reads in supabase-client.js).
function activeProfileId(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).active_profile_id || null;
  } catch {
    return null;
  }
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const childId = body?.childId;
    if (!childId || typeof childId !== "string") return json({ error: "Missing childId" }, 400);

    // ---- 1. Who is calling? -------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

    const callerId = activeProfileId(token) ?? userData.user.id;
    const { data: caller } = await admin
      .from("profiles")
      .select("id, organization_id, is_active, auth_user_id")
      .eq("id", callerId)
      .maybeSingle();

    if (!caller || caller.auth_user_id !== userData.user.id || !caller.is_active || !caller.organization_id) {
      return json({ error: "Not authorized" }, 403);
    }

    // ---- 2. Is this caller linked to THIS child? ----------------------------
    const { data: links } = await admin
      .from("guardians")
      .select("id")
      .eq("parent_id", caller.id)
      .eq("student_id", childId)
      .eq("organization_id", caller.organization_id)
      .limit(1);
    if (!links || links.length === 0) return json({ error: "Not authorized" }, 403);

    const { data: child } = await admin
      .from("profiles")
      .select("id, organization_id, is_active")
      .eq("id", childId)
      .maybeSingle();
    if (!child || child.organization_id !== caller.organization_id || !child.is_active) {
      return json({ ok: false, reason: "child_inactive" });
    }

    // Housekeeping: delete expired results even if pg_cron is not enabled.
    try {
      await admin.rpc("purge_location_requests");
    } catch (_) { /* not critical */ }

    // ---- 3. Limits ----------------------------------------------------------
    // A request for this child was just sent: reuse it instead of buzzing the phone again.
    const { data: recent } = await admin
      .from("location_requests")
      .select("id, expires_at")
      .eq("child_id", childId)
      .eq("status", "pending")
      .gt("created_at", new Date(Date.now() - 30_000).toISOString())
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (recent && recent.length > 0) {
      return json({ ok: true, requestId: recent[0].id, expiresAt: recent[0].expires_at, reused: true });
    }

    // At most 10 requests per parent per 10 minutes.
    const { count } = await admin
      .from("location_requests")
      .select("id", { count: "exact", head: true })
      .eq("requested_by", caller.id)
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    if ((count ?? 0) >= 10) return json({ ok: false, reason: "rate_limited" });

    // ---- 4. The child's registered device -----------------------------------
    const { data: devices } = await admin
      .from("child_devices")
      .select("id, push_token, location_permission")
      .eq("profile_id", childId)
      .eq("status", "active")
      .not("push_token", "is", null)
      .order("last_seen", { ascending: false })
      .limit(1);
    const device = devices?.[0];
    if (!device) return json({ ok: false, reason: "no_device" });
    if (device.location_permission === "denied") return json({ ok: false, reason: "permission" });

    // ---- 5. Create the request (only the HASH of the one-time code is stored) -
    const nonce = newNonce();
    const { data: reqRow, error: insErr } = await admin
      .from("location_requests")
      .insert({
        organization_id: caller.organization_id,
        child_id: childId,
        requested_by: caller.id,
        device_id: device.id,
        nonce_hash: await sha256Hex(nonce),
      })
      .select("id, expires_at")
      .single();
    if (insErr || !reqRow) throw insErr ?? new Error("Could not create request");

    // ---- 6. Silent push to that one device ----------------------------------
    const serviceAccount = loadServiceAccount();
    const accessToken = await getAccessToken(serviceAccount);
    const result = await sendDataPush(
      accessToken,
      serviceAccount.project_id,
      device.push_token,
      {
        type: "location_request",
        request_id: reqRow.id,
        device_id: device.id,
        nonce,
        expires_at: String(new Date(reqRow.expires_at).getTime()),
        submit_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/submit-child-location`,
      },
      120
    );

    if (!result.ok) {
      await admin
        .from("location_requests")
        .update({ status: "failed", failure_reason: "push_failed", completed_at: new Date().toISOString() })
        .eq("id", reqRow.id);
      if (result.shouldDelete) {
        await admin.from("child_devices").update({ push_token: null }).eq("id", device.id);
      }
      return json({ ok: false, reason: "unreachable" });
    }

    // Audit trail: who asked about which child, never the location itself.
    try {
      await admin.from("audit_logs").insert({
        organization_id: caller.organization_id,
        actor_id: caller.id,
        action: "find_my_child_requested",
        record_type: "location_request",
        record_id: reqRow.id,
        details: { child_id: childId, device_id: device.id },
      });
    } catch (_) { /* not critical */ }

    return json({ ok: true, requestId: reqRow.id, expiresAt: reqRow.expires_at });
  } catch (err) {
    console.error("request-child-location error:", err);
    return json({ error: "Something went wrong" }, 500);
  }
});
