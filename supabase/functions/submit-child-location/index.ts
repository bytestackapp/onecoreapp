// Called by the CHILD's phone (native Android code) with the result of one request.
//
// Deploy with JWT verification OFF, because the phone has no login session:
//   supabase functions deploy submit-child-location --no-verify-jwt
//
// Instead of a session, the phone proves itself with the one-time code that came
// in the silent push. The code only works:
//   - for the exact request it was created for,
//   - from the device that request was addressed to (and that is still active),
//   - once (the request flips from 'pending' as part of the same update),
//   - within 2 minutes.
// Every kind of mismatch gets the same 403, so nothing can be probed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FAIL_REASONS = new Set(["permission", "location_off", "timeout", "error", "stale"]);
const PERMISSIONS = new Set(["always", "while_in_use", "denied", "unknown"]);
const MAX_FIX_AGE_MS = 60_000; // a fix older than this is not "current"

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Bad request" }, 400);

    const { requestId, deviceId, nonce, ok, latitude, longitude, accuracy, ageMs, reason, permission } = body;
    for (const v of [requestId, deviceId, nonce]) {
      if (typeof v !== "string" || v.length === 0 || v.length > 200) return json({ error: "Bad request" }, 400);
    }

    const denied = () => json({ error: "Request not valid" }, 403);

    // ---- Is this a live request, for this device, with the right code? ------
    const { data: row } = await admin
      .from("location_requests")
      .select("id, device_id, status, nonce_hash, expires_at")
      .eq("id", requestId)
      .maybeSingle();
    if (!row || row.device_id !== deviceId || row.status !== "pending") return denied();
    if (new Date(row.expires_at).getTime() < Date.now()) return denied();
    if (!safeEqual(await sha256Hex(nonce), row.nonce_hash)) return denied();

    const { data: device } = await admin.from("child_devices").select("id, status").eq("id", deviceId).maybeSingle();
    if (!device || device.status !== "active") return denied();

    const now = new Date();
    let update: Record<string, unknown>;

    if (ok === true) {
      if (typeof latitude !== "number" || typeof longitude !== "number" ||
          !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return json({ error: "Bad coordinates" }, 400);
      }
      const age = typeof ageMs === "number" && Number.isFinite(ageMs) ? ageMs : 0;
      const acc = typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;

      if (age < 0 || age > MAX_FIX_AGE_MS) {
        // Never present an old fix as current.
        update = { status: "failed", failure_reason: "stale", completed_at: now.toISOString() };
      } else {
        update = {
          status: "completed",
          latitude,
          longitude,
          accuracy_m: acc,
          // Age is measured on the phone, so a wrong phone clock cannot fake the time.
          located_at: new Date(now.getTime() - age).toISOString(),
          completed_at: now.toISOString(),
        };
      }
    } else {
      update = {
        status: "failed",
        failure_reason: typeof reason === "string" && FAIL_REASONS.has(reason) ? reason : "error",
        completed_at: now.toISOString(),
      };
    }

    // Single use: only a row that is still 'pending' can be updated.
    const { data: updated, error: updErr } = await admin
      .from("location_requests")
      .update(update)
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) return denied();

    // Keep the device record fresh (powers the "Ready / permission missing" status).
    await admin
      .from("child_devices")
      .update({
        last_seen: now.toISOString(),
        ...(typeof permission === "string" && PERMISSIONS.has(permission) ? { location_permission: permission } : {}),
      })
      .eq("id", deviceId);

    return json({ ok: true });
  } catch (err) {
    console.error("submit-child-location error:", err);
    return json({ error: "Something went wrong" }, 500);
  }
});
