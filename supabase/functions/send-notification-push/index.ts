// Triggered by a Supabase Database Webhook on INSERT to `notifications`
// (configured in the Dashboard — see PUSH-NOTIFICATIONS.md). Looks up
// every device the recipient is signed into and pushes to all of them.
//
// Multi-academy people: one person can have a separate profile in each
// academy. The phone's push token is saved under whichever profile was
// active when the app last opened, so we push to the tokens of ALL of the
// recipient's profiles. That way a notification from any academy reaches
// the phone, whichever academy is currently open.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAccessToken, sendPush, loadServiceAccount } from "../_shared/fcm.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// An announcement to a whole academy fires this function once per recipient
// at the same moment. Reuse the Google access token while this instance is
// warm instead of requesting a new one every time (they last an hour).
let cachedToken: { value: string; expiresAt: number } | null = null;
async function fcmAccessToken(serviceAccount: ReturnType<typeof loadServiceAccount>): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const value = await getAccessToken(serviceAccount);
  cachedToken = { value, expiresAt: Date.now() + 55 * 60 * 1000 };
  return value;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  try {
    const payload = await req.json();
    const notification = payload.record; // Database Webhook shape: { type, table, record, ... }

    if (!notification?.profile_id) {
      return new Response(JSON.stringify({ skipped: "no profile_id" }), { status: 200 });
    }

    // Every profile that belongs to the same person (one per academy).
    let profileIds: string[] = [notification.profile_id];
    const { data: me } = await supabaseAdmin
      .from("profiles")
      .select("auth_user_id")
      .eq("id", notification.profile_id)
      .maybeSingle();
    if (me?.auth_user_id) {
      const { data: mine } = await supabaseAdmin.from("profiles").select("id").eq("auth_user_id", me.auth_user_id);
      if (mine && mine.length > 0) profileIds = mine.map((p) => p.id);
    }

    const { data: tokenRows, error } = await supabaseAdmin
      .from("device_push_tokens")
      .select("token")
      .in("profile_id", profileIds);

    if (error) throw error;
    const tokens = [...new Set((tokenRows || []).map((t) => t.token))];
    if (tokens.length === 0) {
      return new Response(JSON.stringify({ skipped: "no registered devices" }), { status: 200 });
    }

    // Name the academy only when the person belongs to more than one.
    let body: string = notification.body || "";
    if (profileIds.length > 1 && notification.organization_id) {
      const { data: org } = await supabaseAdmin
        .from("organizations")
        .select("name")
        .eq("id", notification.organization_id)
        .maybeSingle();
      if (org?.name) body = body ? `${body} · ${org.name}` : org.name;
    }

    // Unread total across all of the person's academies, for the app-icon badge.
    const { count } = await supabaseAdmin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .in("profile_id", profileIds)
      .eq("is_read", false);

    const serviceAccount = loadServiceAccount();
    const accessToken = await fcmAccessToken(serviceAccount);

    const results = await Promise.all(
      tokens.map((token) =>
        sendPush(
          accessToken,
          serviceAccount.project_id,
          token,
          notification.title,
          body,
          {
            related_type: notification.related_type || "",
            related_id: notification.related_id || "",
            profile_id: notification.profile_id, // which academy's profile this is for
          },
          count ?? undefined
        )
      )
    );

    const deadTokens = results.filter((r) => r.shouldDelete).map((r) => r.token);
    if (deadTokens.length > 0) {
      await supabaseAdmin.from("device_push_tokens").delete().in("token", deadTokens);
    }

    return new Response(JSON.stringify({ sent: results.filter((r) => r.ok).length, total: results.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-notification-push error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
