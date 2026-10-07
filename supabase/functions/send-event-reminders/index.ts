// Run every minute by pg_cron (see push_notifications.sql and
// PUSH-NOTIFICATIONS.md). Finds events starting in ~15 minutes, pushes a
// reminder to every attendee who RSVP'd "attending" plus the organizer,
// and logs each send in event_reminder_log so it's never sent twice.
//
// Timezone note: event_date/start_time are stored as plain date/time with
// no timezone (see schema.sql) — this compares them against server UTC
// time directly. If your organization isn't in UTC, adjust the window
// calculation below to offset for your timezone, or add an org-level
// timezone column and use it here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { getAccessToken, sendPush, loadServiceAccount } from "../_shared/fcm.ts";

const REMINDER_MINUTES_BEFORE = 15;
const WINDOW_MINUTES = 2; // the cron runs every minute; a small window avoids missing events between ticks

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"]
);

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + (REMINDER_MINUTES_BEFORE - WINDOW_MINUTES / 2) * 60000);
    const windowEnd = new Date(now.getTime() + (REMINDER_MINUTES_BEFORE + WINDOW_MINUTES / 2) * 60000);
    const today = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // today's date in Manila

    // Only events happening today are candidates — keeps the query cheap.
    // (A meeting past midnight UTC would need the query widened to
    // tomorrow's date too; fine to add if you need overnight events.)
    const { data: events, error: eventsError } = await supabaseAdmin
      .from("events")
      .select("id, title, event_date, start_time, location, organizer_id")
      .eq("event_date", today)
      .eq("status", "scheduled")
      .not("start_time", "is", null);
    if (eventsError) throw eventsError;

    const dueEvents = (events || []).filter((e) => {
      const eventTime = new Date(`${e.event_date}T${e.start_time.slice(0, 5)}:00+08:00`); // Manila time
      return eventTime >= windowStart && eventTime <= windowEnd;
    });

    if (dueEvents.length === 0) {
      return new Response(JSON.stringify({ checked: events?.length || 0, due: 0 }), { status: 200 });
    }

    const serviceAccount = loadServiceAccount();
    const accessToken = await getAccessToken(serviceAccount);
    let sentCount = 0;

    for (const event of dueEvents) {
      const { data: attendees, error: attendeesError } = await supabaseAdmin
        .from("event_participants")
        .select("profile_id")
        .eq("event_id", event.id)
        .eq("rsvp_status", "attending");
      if (attendeesError) throw attendeesError;

      const recipientIds = new Set((attendees || []).map((a) => a.profile_id));
      if (event.organizer_id) recipientIds.add(event.organizer_id);
      if (recipientIds.size === 0) continue;

      // Skip anyone already reminded for this event (dedup).
      const { data: alreadySent } = await supabaseAdmin
        .from("event_reminder_log")
        .select("profile_id")
        .eq("event_id", event.id)
        .eq("reminder_type", "15min");
      const alreadySentIds = new Set((alreadySent || []).map((r) => r.profile_id));
      const pendingIds = [...recipientIds].filter((id) => !alreadySentIds.has(id));
      if (pendingIds.length === 0) continue;

      const { data: tokens } = await supabaseAdmin
        .from("device_push_tokens")
        .select("token, profile_id")
        .in("profile_id", pendingIds);

      const body = `Starts at ${event.start_time.slice(0, 5)}${event.location ? " · " + event.location : ""}`;
      const results = await Promise.all(
        (tokens || []).map((t) =>
          sendPush(accessToken, serviceAccount.project_id, t.token, `Starting soon: ${event.title}`, body, {
            related_type: "event",
            related_id: event.id,
          })
        )
      );

      const deadTokens = results.filter((r) => r.shouldDelete).map((r) => r.token);
      if (deadTokens.length > 0) {
        await supabaseAdmin.from("device_push_tokens").delete().in("token", deadTokens);
      }
      sentCount += results.filter((r) => r.ok).length;

      // Log every pending recipient as reminded, even ones with no
      // registered device — otherwise we'd re-check them every minute
      // for the rest of the window forever.
      await supabaseAdmin.from("event_reminder_log").insert(
        pendingIds.map((profile_id) => ({ event_id: event.id, profile_id, reminder_type: "15min" }))
      );
    }

    return new Response(JSON.stringify({ dueEvents: dueEvents.length, sent: sentCount }), { status: 200 });
  } catch (err) {
    console.error("send-event-reminders error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
