# OneCore — Organization Community & Operations Platform

*One Core. Everything Connected.*

OneCore is a web app and Android app for schools and other organizations. It runs on
plain HTML, CSS and JavaScript (no framework), with Supabase for sign-in, database and
server functions. The website is hosted on Vercel, and the Android app is the same
website packaged with Capacitor.

## What it does

- **People and roles:** admin, teacher, student, parent and guest, plus platform owners who
  can manage several academies. One login can belong to several academies and switch between them.
- **Announcements, events and calendar:** targeted by role, group or person, with RSVPs and reminders.
- **Groups:** classes, sections and teams.
- **Attendance:** QR scanner devices (with offline queue), class roll call, correction requests,
  and a CSV export.
- **Leave:** leave types, balances, requests, approvals and yearly carry-over.
- **Notifications:** in the app and as phone push notifications.
- **Find My Child:** a parent can ask for the current location of a linked child's phone.
- **Admin tools:** user approval, invite codes, QR card printing, yearly archive, activity log.
- **Owner console:** create academies and manage platform owners.

## Folder structure

```
/
├── index.html              Start page (checks sign-in, then opens login or dashboard)
├── pages/                  One HTML file per screen
├── css/global.css          The whole design system
├── js/                     One script per page, plus shared files
│   ├── supabase-client.js  Connection to Supabase and shared helpers
│   ├── layout.js           Sidebar, top bar and bottom navigation shared by every page
│   ├── toast.js, dialog.js Messages and confirm pop-ups
│   ├── push.js             Phone push notification setup
│   ├── find-my-child.js    Find My Child (parent and student side)
│   ├── scanner.js          QR scanner mode
│   ├── version.js          App version number (change on every release)
│   ├── env-config.js       Generated at build time. Never commit it.
│   └── vendor/             Libraries hosted with the app (QR reader, QR maker, ZIP)
├── scripts/generate-env.js Writes js/env-config.js from environment variables
├── supabase/functions/     Server functions (see below)
├── android/                Android project (Capacitor)
└── .github/workflows/      Builds the Android app
```

## Server functions (Supabase Edge Functions)

| Function | Called by | Deploy |
|---|---|---|
| `delete-user` | Users page (reject or remove a person) | `supabase functions deploy delete-user --use-api` |
| `request-child-location` | Parent's app | `supabase functions deploy request-child-location --use-api` |
| `submit-child-location` | Child's phone (no sign-in) | `supabase functions deploy submit-child-location --use-api --no-verify-jwt` |
| `send-notification-push` | Database trigger on new notifications | `supabase functions deploy send-notification-push --use-api --no-verify-jwt` |
| `send-event-reminders` | Scheduled job, every minute | `supabase functions deploy send-event-reminders --use-api --no-verify-jwt` |

`send-notification-push` and `send-event-reminders` refuse any request that doesn't carry the
`x-push-secret` header. Shared code is in `supabase/functions/_shared/fcm.ts`.

## Secrets and settings

| Where | Name | What it is |
|---|---|---|
| Vercel (environment variables) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Project address and the **publishable** key |
| GitHub (Actions secrets) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Same two values, used when building the Android app |
| GitHub (Actions secrets) | `GOOGLE_SERVICES_JSON_B64` | Firebase file for push notifications, base64 encoded |
| GitHub (Actions secrets) | `ONECORE_DEBUG_KEYSTORE_B64`, `ONECORE_KEYSTORE_PASSWORD` | Android signing key (the file name says "debug" for historical reasons) and its password |
| Supabase (Edge Function secrets) | `FCM_SERVICE_ACCOUNT_JSON` | Firebase service account for sending push notifications |
| Supabase (Edge Function secrets) | `PUSH_SECRET` | Shared password between the database and the two push functions |

The publishable key is meant to be public. The Supabase **secret** key must never be placed in
any file that reaches the browser or the repository.

## Running locally

1. Make sure `js/env-config.js` contains your project address and publishable key.
2. Run `OneCoreApp.bat` and open http://localhost:3005.

## Releasing the Android app

1. Run `git-push.bat` and choose **4 (Release)**. It raises the version in `js/version.js` and
   `android/app/build.gradle`, then commits and pushes.
2. On GitHub, open **Actions → Build Android APK → Run workflow**.
3. Download the APK from the finished run and upload it to your hosting.
4. Update the `android` row of the `app_versions` table: `latest_version`, `changelog`, `download_url`.

The app keeps the same signing key between releases, so phones update in place.

## Database

The database was built step by step in the Supabase SQL Editor, so there is no single schema file yet.
Every table has Row Level Security turned on. Access rules, helper functions and triggers live in the
database itself. Before changing a policy or function, read its current version in the SQL Editor first.
Scheduled jobs (reminders every minute, location clean-up, yearly leave carry-over) use `pg_cron`.

## Good to know

- Never commit `js/env-config.js`, `google-services.json`, keystore files or any secret key.
- Page scripts only show text that was escaped first. Keep using the `escapeHtml` helper for anything a person typed.
- Time zone: attendance and reminders use Manila time (UTC+8).