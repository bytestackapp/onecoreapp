// Triggered by a Supabase Database Webhook on INSERT to `notifications`
// (configured in the Dashboard — see PUSH-NOTIFICATIONS.md). Looks up
// every device the recipient is signed into and pushes to all of them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAccessToken, sendPush, loadServiceAccount } from "../_shared/fcm.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const notification = payload.record; // Database Webhook shape: { type, table, record, ... }

    if (!notification?.profile_id) {
      return new Response(JSON.stringify({ skipped: "no profile_id" }), { status: 200 });
    }

    const { data: tokens, error } = await supabaseAdmin
      .from("device_push_tokens")
      .select("token")
      .eq("profile_id", notification.profile_id);

    if (error) throw error;
    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ skipped: "no registered devices" }), { status: 200 });
    }

    const serviceAccount = loadServiceAccount();
    const accessToken = await getAccessToken(serviceAccount);

    const results = await Promise.all(
      tokens.map((t) =>
        sendPush(accessToken, serviceAccount.project_id, t.token, notification.title, notification.body || "", {
          related_type: notification.related_type || "",
          related_id: notification.related_id || "",
        })
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
