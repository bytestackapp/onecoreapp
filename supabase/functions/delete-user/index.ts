// delete-user: lets an academy administrator remove (or reject) a person from THEIR academy.
//
// Safe for people who belong to several academies:
//   - the caller is identified by the academy profile they are working in right now,
//   - if the person also belongs to other academies, only THIS academy's profile is
//     removed and their login (and other academies) are left alone,
//   - the login itself is deleted only when this was their last profile.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// The academy profile the person is working in is carried in their sign-in token.
function activeProfileId(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).active_profile_id || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // Answer the browser's CORS preflight request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // userId is the PROFILE id of the person being removed (what the Users page sends).
    const { userId } = await req.json();
    if (!userId || typeof userId !== "string") {
      return json({ error: "Missing userId" }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ---- Who is calling? ----------------------------------------------------
    const token = authHeader.replace("Bearer ", "");
    const { data: callerUser, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !callerUser?.user) {
      return json({ error: "Invalid session" }, 401);
    }
    const callerAuthId = callerUser.user.id;

    const callerProfileId = activeProfileId(token) ?? callerAuthId;
    const { data: caller } = await adminClient
      .from("profiles")
      .select("id, role, organization_id, is_active, auth_user_id")
      .eq("id", callerProfileId)
      .maybeSingle();

    if (
      !caller ||
      (caller.auth_user_id ?? caller.id) !== callerAuthId ||
      !caller.is_active ||
      caller.role !== "admin" ||
      !caller.organization_id
    ) {
      return json({ error: "Not authorized" }, 403);
    }

    // ---- Who is being removed? ----------------------------------------------
    const { data: target } = await adminClient
      .from("profiles")
      .select("id, role, organization_id, auth_user_id")
      .eq("id", userId)
      .maybeSingle();

    if (!target || target.organization_id !== caller.organization_id) {
      return json({ error: "User not found in your organization" }, 404);
    }
    if (target.id === caller.id) {
      return json({ error: "You can't remove your own account." }, 400);
    }
    const targetAuthId = target.auth_user_id ?? target.id;

    // Platform owners can't be removed here, and only an owner can remove an administrator.
    const { data: ownerRows } = await adminClient
      .from("platform_owners")
      .select("auth_user_id")
      .in("auth_user_id", [callerAuthId, targetAuthId]);
    const ownerIds = new Set((ownerRows ?? []).map((r) => r.auth_user_id));

    if (ownerIds.has(targetAuthId)) {
      return json({ error: "Platform owners can't be removed here." }, 403);
    }
    if (target.role === "admin" && !ownerIds.has(callerAuthId)) {
      return json({ error: "Only the platform owner can remove an administrator." }, 403);
    }

    // ---- Remove ---------------------------------------------------------------
    const { count: otherProfiles } = await adminClient
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("auth_user_id", targetAuthId)
      .neq("id", target.id);

    if ((otherProfiles ?? 0) > 0) {
      // They belong to other academies too: remove only this academy's profile.
      const { error: deleteProfileErr } = await adminClient.from("profiles").delete().eq("id", target.id);
      if (deleteProfileErr) {
        return json({ error: deleteProfileErr.message }, 400);
      }
      return json({ success: true, removed: "profile" });
    }

    // Last profile: remove the whole login.
    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(targetAuthId);
    if (deleteErr) {
      return json({ error: deleteErr.message }, 400);
    }
    return json({ success: true, removed: "account" });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
