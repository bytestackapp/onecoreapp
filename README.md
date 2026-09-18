# OneCore — Organization Community & Operations Platform

*Connect. Organize. Operate.*

Plain HTML/CSS/JavaScript (no framework, no client-side build), backed by
Supabase (auth, Postgres, RLS), deployable to Vercel straight from GitHub.
The only build step is a tiny script that turns Vercel environment
variables into a config file (see "Environment variables" below).

## Folder structure

```
/
├── index.html                root entry point — the file Vercel looks for
├── pages/                    every other HTML page lives here, flat
│   ├── login.html / reset-password.html / update-password.html
│   ├── dashboard.html
│   ├── announcements.html
│   ├── notifications.html
│   ├── calendar.html
│   ├── events.html
│   ├── groups.html
│   ├── people.html           organization directory
│   ├── attendance.html
│   ├── leave.html
│   ├── profile.html
│   ├── admin-users.html      admin: manage roles/access
│   ├── admin-settings.html   admin: org settings + activity log
│   └── reports.html          admin: CSV export (+ roadmap note)
├── css/
│   └── global.css            the entire design system (OneCore theme)
├── js/
│   ├── supabase-client.js    Supabase init + auth/data helpers
│   ├── env-config.example.js template — copy to env-config.js for local dev
│   ├── env-config.js         ⚠️ generated/local-only, NOT committed (see .gitignore)
│   ├── layout.js             shared sidebar/topbar/bottom-nav — one copy, every page
│   ├── brand.js               product name/tagline/logo in one place
│   ├── toast.js               toast notifications (replaces alert())
│   ├── dialog.js              confirm dialog (replaces confirm())
│   └── <page-name>.js         one file per page, matching pages/<page-name>.html
├── scripts/
│   └── generate-env.js       build step: writes js/env-config.js from env vars
├── supabase/
│   └── schema.sql             tables, RLS policies, trigger, demo-data guide
├── package.json               only holds the "build" script Vercel runs
├── .gitignore
└── vercel.json
```

There is **no separate `admin/` folder** — admin pages (`admin-users.html`,
`admin-settings.html`) are just regular pages in `pages/`, gated by
`allowedRoles: ["admin"]` in their `mountLayout(...)` call and by Row Level
Security in the database. Same idea for their JS: `js/admin-users.js` and
`js/admin-settings.js` sit alongside every other page's script.

### Why is `index.html` at the root instead of inside `pages/`?

Vercel (like any static host) looks for `index.html` at the root of the
site to serve your bare domain (`/`). So `index.html` is the one page kept
at the project root — its only job is to check whether you're signed in
and redirect to `pages/dashboard.html` or `pages/login.html`. Every other
page lives in `pages/` and is reached at `/pages/<name>.html` (e.g.
`/pages/dashboard.html`). Links between pages inside `layout.js` and each
page's own markup are already plain filenames (`dashboard.html`,
`leave.html`, …) since every page in `pages/` is a sibling — nothing else
needs adjusting if you add a new page there.

## Design system: OneCore theme

`css/global.css` implements the full visual spec: Inter typeface, deep
indigo primary (`#4F46E5`) with a teal secondary accent (`#0D9488`), soft
gray background with white cards, 12–16px card radius, 8–10px button/input
radius, and a consistent color language for status (`success` green,
`warning` amber, `error` red, `info` blue). Change any of it in one place —
every page picks it up automatically.

`js/brand.js` holds the product name, tagline, and logo mark — rebrand by
editing one file instead of hunting through every page.

## No more `alert()` / `confirm()`

Per the UX spec, native browser dialogs are gone:

- `js/toast.js` → `showToast(message, "success" | "error" | "info")` for
  lightweight feedback (used after publishing, filing, approving, etc.)
- `js/dialog.js` → `await confirmDialog({ title, message, danger })` for
  anything consequential (approving/rejecting leave, deactivating a user)

Both are self-contained — import and call them from any page's script.

## What's included

Everything from the previous MVP, plus:

- **People** — a searchable, role-filterable organization directory.
- **Reports** (admin) — a real, working attendance CSV export for a date
  range. Deeper reports (leave usage, event turnout) are clearly marked
  "Coming soon" rather than faked.
- A topbar **user menu** (avatar → dropdown with Profile / Sign out).
- A mobile **bottom nav** (Home, Calendar, Notifications, Groups, More) with
  a "More" sheet holding everything else, matching the UX spec.
- Toasts and a confirm dialog in place of `alert()`/`confirm()`.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the entire contents of `supabase/schema.sql`.
   It's safe to re-run.
3. Open **Project Settings → API** and copy your **Project URL** and
   **anon public key**. Keep this tab open for the next section.

### Where these values actually live

Rather than hardcoding the URL/key in `js/supabase-client.js`, this project
generates them at build time from environment variables, so the real
values never get committed to Git:

- **On Vercel:** go to your project → **Settings → Environment Variables**
  and add:
  | Name | Value |
  |---|---|
  | `SUPABASE_URL` | your Project URL |
  | `SUPABASE_ANON_KEY` | your anon public key |

  Then, in **Settings → Build & Development Settings**, set:
  - **Build Command:** `npm run build`
  - **Output Directory:** `.` (a single dot — the repo root)

  Vercel will run `scripts/generate-env.js` on every deploy, which writes
  those two values into `js/env-config.js` before your site goes live —
  that's the file `supabase-client.js` actually imports.

- **For local development** (opening the files directly or with a local
  static server): copy `js/env-config.example.js` to `js/env-config.js`
  and fill in the same two values by hand. `js/env-config.js` is in
  `.gitignore`, so it's safe to put real values there.

The anon key is still visible in the browser once the site is live — it's
meant to be public, and Row Level Security (already in `schema.sql`) is
what actually protects your data, not hiding this key. What this setup
buys you is keeping the value out of your repository and letting you point
different environments (preview vs. production) at different Supabase
projects. **Never** put your `service_role` key in an environment variable
that reaches the browser build — only `SUPABASE_ANON_KEY` belongs here.

## 2. Create your first organization + admin

1. In the Supabase dashboard, go to **Authentication → Users → Add user**
   (or **Invite user**, which emails them a set-password link) and create
   yourself as the first user.
2. The `on_auth_user_created` trigger (in `schema.sql`) automatically adds
   a matching row to `profiles` with `role = 'student'` and no organization.
3. In **Table Editor → organizations**, insert one row for your school, e.g.
   `name: "Sample Academy"`, `slug: "sample-academy"`.
4. In **Table Editor → profiles**, edit your own row: set `organization_id`
   to the org you just created, and `role` to `admin`.
5. Sign in at `/pages/login.html` — you'll land on the Dashboard with the
   full Admin section unlocked in the sidebar.
6. From then on, invite everyone else from **Authentication → Users →
   Invite user**; they'll show up on **Admin → Users** for you to assign a
   role and organization the same way.

## 3. Demo data (optional)

`supabase/schema.sql` ends with a commented-out block showing exactly how
to insert a sample academy with a teacher, student, parent, a class, and
leave types. Uncomment it, swap in the real `auth.users` UUIDs from step 2,
and run it.

## 4. Deploy

1. Push this folder to a GitHub repository. `js/env-config.js` won't be
   included — it's in `.gitignore` on purpose (see the environment
   variables section above).
2. In Vercel: **New Project → Import** your repo.
3. Framework preset: **Other** (or "No framework").
4. Before your first deploy, set the environment variables and build
   settings described in **section 1** above (`SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, Build Command `npm run build`, Output Directory `.`).
5. Deploy. Vercel runs `scripts/generate-env.js` during the build, which
   writes `js/env-config.js` from your environment variables — that's what
   makes the deployed site able to reach Supabase.

## Adding a new page

1. Create `pages/your-page.html`, copying the structure of any existing
   page: a `<div id="page-content">` with your markup inside, `../css/global.css`
   for styles, and at the bottom:
   ```html
   <script type="module" src="../js/your-page.js"></script>
   ```
2. Create `js/your-page.js`, starting with:
   ```js
   import { mountLayout } from "./layout.js";
   const profile = await mountLayout({ activeKey: "dashboard", pageTitle: "My Page" });
   if (!profile) throw new Error("redirecting");
   ```
   `activeKey` must match an entry in `NAV_ITEMS`/`ADMIN_ITEMS` inside
   `js/layout.js` if you want it highlighted in the sidebar — add one there
   if it's a new section (this also controls whether it shows in the mobile
   bottom nav or the "More" sheet, and which roles can see it).
3. Everything else — sidebar, top bar, user menu, notification badge,
   mobile nav, sign-out — is handled for you.
4. Use `showToast(...)` from `js/toast.js` for feedback and
   `confirmDialog(...)` from `js/dialog.js` before any destructive or
   consequential action — never `alert()`/`confirm()`.

## Next steps (natural continuations of this foundation)

- A dedicated "assign organization" screen for the very first admin
  bootstrap step (currently done once, manually, in the Table Editor).
- Weekly calendar view (month + agenda are done).
- Email/push notification delivery (the in-app `notifications` table and
  UI are ready to be triggered from a Supabase Edge Function).
- Parent-child linking UI on the Admin → Users page (the `guardians` table
  already supports it; only the admin UI to create links is missing).
- Deeper reports (leave usage, event turnout) — flagged "Coming soon" on
  the Reports page.
- Payroll, and QR/biometric attendance sources — the schema's
  `attendance_records.source` column already anticipates these.
