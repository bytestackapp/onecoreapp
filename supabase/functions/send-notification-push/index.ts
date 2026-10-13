// Sends the push notifications for new rows in `notifications`.
//
// Called by the database (see push-batch.sql) ONCE per post with the list of new notification ids,
// for example { "ids": ["...", "..."] }. One announcement to 500 people is one call, not 500.
// The older one-row-at-a-time shape { "record": { "id": "..." } } is still understood.
//
// Multi-academy people: one person can have a separate profile in each academy, and the phone's
// push token is saved under whichever profile was active last, so every notification is pushed
// to the devices of ALL of that person's profiles (done inside the push_batch_rows database function).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { getAccessToken, sendPush, loadServiceAccount } from "../_shared/fcm.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"]
);

const IDS_PER_QUERY = 500; // notification ids handed to the database in one go
const SENDS_AT_ONCE = 40; // phones contacted at the same moment
const TOKENS_PER_DELETE = 100;

// Reuse the Google access token while this instance is warm instead of requesting a new one
// every time (they last an hour).
let cachedToken: { value: string; expiresAt: number } | null = null;
async function fcmAccessToken(serviceAccount: ReturnType<typeof loadServiceAccount>): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const value = await getAccessToken(serviceAccount);
  cachedToken = { value, expiresAt: Date.now() + 55 * 60 * 1000 };
  return value;
}

// Runs `worker` on every item, a limited number at a time.
async function inGroups<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(worker))));
  }
  return out;
}

interface PushRow {
  notification_id: string;
  profile_id: string;
  title: string;
  body: string | null;
  related_type: string | null;
  related_id: string | null;
  tokens: string[] | null;
  unread: number | string | null;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) {
    console.error("403: x-push-secret mismatch");   // <-- add this line
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  try {
    const payload = await req.json();
    const ids: string[] = Array.isArray(payload?.ids)
      ? payload.ids
      : payload?.record?.id
      ? [payload.record.id]
      : [];

    if (ids.length === 0) {
      return new Response(JSON.stringify({ skipped: "no notification ids" }), { status: 200 });
    }

    // Who to send to, which phones, and the unread total (for the app-icon badge): a few queries in total.
    const rows: PushRow[] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
      const { data, error } = await supabaseAdmin.rpc("push_batch_rows", { p_ids: ids.slice(i, i + IDS_PER_QUERY) });
      if (error) throw error;
      rows.push(...((data || []) as PushRow[]));
    }

    const jobs = rows.flatMap((r) => (r.tokens || []).map((token) => ({ r, token })));
    if (jobs.length === 0) {
      return new Response(JSON.stringify({ skipped: "no registered devices", notifications: ids.length }), { status: 200 });
    }

    const serviceAccount = loadServiceAccount();
    const accessToken = await fcmAccessToken(serviceAccount);

    const results = await inGroups(jobs, SENDS_AT_ONCE, ({ r, token }) =>
      sendPush(
        accessToken,
        serviceAccount.project_id,
        token,
        r.title,
        r.body || "",
        {
          related_type: r.related_type || "",
          related_id: r.related_id || "",
          profile_id: r.profile_id, // which academy's profile this is for
        },
        Number(r.unread) || 0
      )
    );

    // Forget phones that no longer exist (app uninstalled, token rotated).
    const deadTokens = [...new Set(results.filter((r) => r.shouldDelete).map((r) => r.token))];
    for (let i = 0; i < deadTokens.length; i += TOKENS_PER_DELETE) {
      await supabaseAdmin.from("device_push_tokens").delete().in("token", deadTokens.slice(i, i + TOKENS_PER_DELETE));
    }

    return new Response(
      JSON.stringify({ notifications: ids.length, sent: results.filter((r) => r.ok).length, total: results.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-notification-push error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});