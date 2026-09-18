# Push notifications setup

This wires up real, OS-level push notifications (banner + sound, works
even with the app closed) on top of the Android app. It has three parts:
a Firebase project (Google's free push infrastructure), two Supabase Edge
Functions, and the Capacitor native app. Do these roughly in order —
each step depends on the one before it.

## 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**. Any name is fine (e.g. "OneCore").
2. You don't need Analytics — you can turn it off.
3. Once created, click **Add app → Android**. Use the same package name
   you'll put in `capacitor.config.json` (`com.yourorg.onecore` — change
   it to something real, like `com.yourschool.onecore`, in **both**
   places before you go further).
4. Download the `google-services.json` file it offers you. Keep it — you'll
   drop it into the Android project in step 4.
5. In the Firebase console, go to **Project settings (gear icon) → Service accounts → Generate new private key**. This downloads a JSON file — this is your `FCM_SERVICE_ACCOUNT_JSON` secret. **Keep this file private** — it's the credential the server functions use to send pushes on your behalf.

## 2. Deploy the two Edge Functions

You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), and your project linked (`supabase link --project-ref YOUR-PROJECT-REF`).

1. Run the schema migration first: open `supabase/push_notifications.sql`
   in the Supabase SQL editor and run it (the pg_cron block at the bottom
   stays commented out for now — you'll come back to it in step 5).
2. Set the two secrets the functions need:
   ```
   supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat path/to/your-service-account.json)"
   ```
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available
   to every Edge Function automatically — no need to set those yourself.)
3. Deploy both functions:
   ```
   supabase functions deploy send-notification-push
   supabase functions deploy send-event-reminders
   ```
4. Note the URLs it prints — you'll need them in steps 4 and 5.

## 3. Wire up the "instant" notifications (announcements, leave approvals, etc.)

In the Supabase Dashboard: **Database → Webhooks → Create a new hook**.
- Table: `notifications`
- Events: `INSERT`
- Type: **Supabase Edge Function**
- Function: `send-notification-push`

That's it — every time your app inserts a row into `notifications` (which
it already does today for announcements, RSVPs, leave decisions, etc.),
this fires automatically and pushes it to the recipient's phone.

## 4. Wire up the 15-minutes-before-a-meeting reminders

This is the part that needs to run on a timer, independent of anything
happening in the app — that's what `pg_cron` is for.

1. In the Supabase SQL editor, uncomment and run the bottom block of
   `supabase/push_notifications.sql`, replacing the two placeholders with
   your project's `send-event-reminders` function URL (from step 2) and
   your `service_role` key (Project Settings → API).
2. `pg_cron` is available on Supabase's paid plans. If your plan doesn't
   offer it, use **Database → Cron Jobs** in the Dashboard instead (same
   thing, no SQL needed), or point any external scheduler (a GitHub
   Actions workflow on a cron trigger works fine) at the same function URL
   with the same `Authorization: Bearer <service_role key>` header.
3. Give it a couple of minutes, then check **Edge Functions → send-event-reminders → Logs** in the Dashboard to confirm it's actually running every minute.

## 5. Build the Android app with push support

1. `npm install` (installs the Capacitor packages already listed in `package.json`)
2. `npx cap add android` (if you haven't already)
3. `npx cap sync`
4. Copy the `google-services.json` from step 1 into `android/app/google-services.json`
5. `npx cap open android` → build and install the APK as before

## 6. Test it

- **Instant**: publish an announcement from another account → the recipient's phone should buzz within a few seconds.
- **Reminder**: create an event starting ~15 minutes from now, RSVP "attending" as the test user, then lock the phone and wait — it should notify even with the app fully closed.

## Notes and limits

- **iOS**: this whole push setup also works for iOS (FCM supports it, and
  the shared code already builds an APNs-compatible payload), but you
  still need the Apple Developer Program account and a properly signed
  build to install it on a device at all — see the earlier conversation
  about IPA distribution.
- **Timezones**: `send-event-reminders` compares event times against
  server UTC time directly, since `events.start_time` has no timezone in
  the schema. If your organization isn't in UTC, you'll want to offset
  for that (or add an organization-level timezone column) — flagged in
  a comment at the top of the function.
- **Cost**: FCM itself is free at any volume. The only potential cost is
  Supabase's `pg_cron` availability on your plan (see step 4).
