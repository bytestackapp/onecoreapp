import { mountLayout, ICONS, sectionHead } from "./layout.js";
import { supabase, formatDate, timeAgo, priorityLabel, initials } from "./supabase-client.js";
import { todayPH } from "./time.js";
import { escapeHtml } from "./utils.js";

const profile = await mountLayout({ activeKey: "dashboard", pageTitle: "Dashboard", brandOnMobile: true });
if (!profile) throw new Error("redirecting");

// Today's date in Philippine time (YYYY-MM-DD)
const today = todayPH();

// Roles not listed here (student, guest) get no cards and no sub-header.
// Roles not listed here (parent, student, guest) get no Pending Actions block.
const STAT_SECTIONS = {
  admin:   { title: "Pending Actions", icon: ICONS.leave, tone: "info" },
  teacher: { title: "Pending Actions", icon: ICONS.leave, tone: "info" },
};

// Shown to anyone who has linked children, whatever their role.
const CHILDREN_SECTION = { title: "Children Monitoring", icon: ICONS.profile, tone: "info" };

// Where each card goes when clicked (these pages sit in the same folder as dashboard.html)
const TILE_LINKS = {
  leave: "leave.html",
  approvals: "admin-users.html",
  corrections: "attendance.html",
  attendance: "attendance.html", // parent: Time In / Time Out / Break Out / Break In
};

document.getElementById("welcome-line").innerHTML =
  `Welcome back, <strong>${escapeHtml(profile.full_name)}</strong>.`;

document.getElementById("announcements-head").innerHTML = sectionHead({
  title: "Recent announcements",
  icon: ICONS.megaphone,
  tone: "info",
  linkHtml: `<a class="link" href="announcements.html">View all</a>`,
});
document.getElementById("events-head").innerHTML = sectionHead({
  title: "Upcoming events",
  icon: ICONS.event,
  tone: "info",
  linkHtml: `<a class="link" href="events.html">View all</a>`,
});

// One request for the whole page (cards, announcements, events, pending leave).
function fetchSummary() {
  const promise = supabase.rpc("dashboard_summary", { p_today: today }).then(({ data, error }) => {
    if (error) throw error;
    return data || {};
  });
  promise.catch(() => {}); // each section below shows its own error message
  return promise;
}
let summaryPromise = fetchSummary();

renderStatTiles();
renderChildren();
renderAnnouncements();
renderEvents();
renderRoleSection();

// When a push arrives about something this page shows, refresh the page (one request).
const LIVE_TYPES = new Set(["announcement", "event", "leave_request", "attendance_correction", "attendance", "signup"]);
window.addEventListener("onecore:push", (e) => {
  if (!e.detail?.forThisAcademy || !LIVE_TYPES.has(e.detail.related_type)) return;
  summaryPromise = fetchSummary();
  renderStatTiles();
  renderChildren();
  renderAnnouncements();
  renderEvents();
  renderRoleSection();
});

// -----------------------------------------------------------------
// Stat tiles
// -----------------------------------------------------------------
function tile(label, value, href) {
  const n = Number(value) || 0;
  const has = n > 0;
  const dot = has
    ? `<span class="pend-dot is-pending" aria-hidden="true">${n > 99 ? "99+" : n}</span>`
    : `<span class="pend-dot is-clear" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></span>`;
  const status = has ? `For review` : `All clear`;
  const sub = has ? `Needs action` : `No pending`;
  const card = `<div class="card stat-tile">
    <div class="stat-label">${label}</div>
    <div class="pend-body" aria-label="${n} ${label}">
      ${dot}
      <div class="pend-text"><div class="pend-main">${status}</div><div class="pend-sub">${sub}</div></div>
    </div>
  </div>`;
  return href ? `<a class="tile-link" href="${href}">${card}</a>` : card;
}

function childTile(label, kids, key, href) {
  const items = kids
    .map((k) => {
      const done = !!k[key];
      const fullName = k.full_name || "Child";
      const full = escapeHtml(fullName);
      const first = escapeHtml(fullName.trim().split(/\s+/)[0]);
      const state = done ? "Yes" : "Not yet";
      return `<span class="child-item" title="${full}: ${state}">
        <span class="child-dot ${done ? "is-in" : "is-out"}" role="img" aria-label="${full}: ${label} ${state}">${escapeHtml(initials(fullName))}</span>
        <span class="child-name">${first}</span>
      </span>`;
    })
    .join("");

  const body = kids.length
    ? `<div class="child-dots">${items}</div>`
    : `<div class="child-empty">No children linked</div>`;
  const card = `<div class="card stat-tile"><div class="stat-label">${label}</div>${body}</div>`;
  return href ? `<a class="tile-link" href="${href}">${card}</a>` : card;
}

async function renderStatTiles() {
  const cfg = STAT_SECTIONS[profile.role];
  if (!cfg) return;

  const section = document.getElementById("stats-section");
  const el = document.getElementById("stat-tiles");
  document.getElementById("stats-head").innerHTML = sectionHead(cfg);
  section.style.display = "";
  el.innerHTML = `<div class="skeleton" style="height:80px;grid-column:1/-1;"></div>`;
  let tiles = [];

  try {
    const { stats = {} } = await summaryPromise;
    if (profile.role === "admin") {
      tiles = [
        tile("Leave Requests", stats.leave ?? 0, TILE_LINKS.leave),
        tile("Sign-up Approvals", stats.approvals ?? 0, TILE_LINKS.approvals),
        tile("Corrections", stats.corrections ?? 0, TILE_LINKS.corrections),
      ];
    } else if (profile.role === "teacher") {
      tiles = [
        tile("Leave Requests", stats.leave ?? 0, TILE_LINKS.leave),
        tile("Corrections", stats.corrections ?? 0, TILE_LINKS.corrections),
      ];
    }
    el.innerHTML = tiles.join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="card empty-state"><h3>Unable to load your summary</h3><p>Please refresh the page.</p></div>`;
  }
}

async function renderChildren() {
  const section = document.getElementById("children-section");
  const el = document.getElementById("children-tiles");
  const isParent = profile.role === "parent";

  // Parents always expect this block, so show it loading right away.
  // For other roles it stays hidden unless they actually have linked children.
  if (isParent) {
    document.getElementById("children-head").innerHTML = sectionHead(CHILDREN_SECTION);
    section.style.display = "";
    el.innerHTML = `<div class="skeleton" style="height:80px;grid-column:1/-1;"></div>`;
  }

  try {
    const summary = await summaryPromise;
    const kids = summary.children ?? summary.stats?.children;

    if (!Array.isArray(kids) || kids.length === 0) {
      if (isParent) {
        el.innerHTML = `<div class="card empty-state"><h3>No children linked yet</h3><p>Children linked to your account will show up here.</p></div>`;
      } else {
        section.style.display = "none";
      }
      return;
    }

    document.getElementById("children-head").innerHTML = sectionHead(CHILDREN_SECTION);
    section.style.display = "";
    el.innerHTML = [
      childTile("Time In Today", kids, "time_in", TILE_LINKS.attendance),
      childTile("Time Out Today", kids, "time_out", TILE_LINKS.attendance),
      childTile("Break Out Today", kids, "break_out", TILE_LINKS.attendance),
      childTile("Break In Today", kids, "break_in", TILE_LINKS.attendance),
    ].join("");
  } catch (err) {
    console.error(err);
    if (isParent) {
      el.innerHTML = `<div class="card empty-state"><h3>Unable to load your summary</h3><p>Please refresh the page.</p></div>`;
    } else {
      section.style.display = "none";
    }
  }
}

// -----------------------------------------------------------------
// Announcements
// -----------------------------------------------------------------
async function renderAnnouncements() {
  const el = document.getElementById("announcements-list");
  try {
    const data = (await summaryPromise).announcements;

    if (!data || data.length === 0) {
      el.innerHTML = emptyState("You're all caught up.", "No new announcements right now.");
      return;
    }
    el.innerHTML = data
      .map(
        (a) => `
        <div class="list-row">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(a.title)}</div>
            <div class="text-muted" style="font-size:0.8rem;">${timeAgo(a.created_at)}</div>
          </div>
          <span class="tag tag-${a.priority}">${priorityLabel(a.priority)}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Announcements couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
  }
}

// -----------------------------------------------------------------
// Events
// -----------------------------------------------------------------
async function renderEvents() {
  const el = document.getElementById("events-list");
  try {
    const data = (await summaryPromise).events;

    if (!data || data.length === 0) {
      el.innerHTML = emptyState("No upcoming events.", "New events will show up here as soon as they're scheduled.");
      return;
    }
    el.innerHTML = data
      .map(
        (e) => `
        <div class="list-row">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(e.title)}</div>
            <div class="text-muted" style="font-size:0.8rem;">${formatDate(e.event_date)}${e.start_time ? " · " + e.start_time.slice(0, 5) : ""}${e.location ? " · " + escapeHtml(e.location) : ""}</div>
          </div>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Events couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
  }
}

// -----------------------------------------------------------------
// Role-specific extra section
// -----------------------------------------------------------------
async function renderRoleSection() {
  const el = document.getElementById("role-section");
  if (profile.role !== "admin") return; // teachers/students/parents: covered by tiles above

  try {
    const data = (await summaryPromise).pending_leave;

    el.innerHTML = `
      <div class="section">
        ${sectionHead({
          title: "Pending leave approvals",
          icon: ICONS.leave,
          tone: "info",
          linkHtml: `<a class="link" href="leave.html">Manage</a>`,
        })}
        <div class="card">
          ${
            !data || data.length === 0
              ? emptyState("Nothing pending.", "All leave requests have been reviewed.")
              : data
                  .map(
                    (r) => `
              <div class="list-row">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;">${escapeHtml(r.full_name || "Unknown")}</div>
                  <div class="text-muted" style="font-size:0.8rem;">${formatDate(r.start_date)} – ${formatDate(r.end_date)}</div>
                </div>
                <span class="tag tag-pending">Pending</span>
              </div>`
                  )
                  .join("")
          }
        </div>
      </div>`;
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="section"><div class="card empty-state"><h3>Pending leave approvals couldn't be loaded</h3><p>Please refresh the page.</p></div></div>`;
  }
}

function emptyState(title, body) {
  return `<div class="empty-state">
    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
    <h3>${title}</h3><p>${body}</p>
  </div>`;
}

