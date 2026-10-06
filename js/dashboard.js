import { mountLayout, ICONS, sectionHead } from "./layout.js";
import { supabase, formatDate, timeAgo, priorityLabel } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "dashboard", pageTitle: "Dashboard", brandOnMobile: true });
if (!profile) throw new Error("redirecting");

// Local calendar date as YYYY-MM-DD (toISOString() reports the UTC date,
// which is the wrong day for part of the morning in UTC+8).
function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
const today = localDate();

// Roles not listed here (student, guest) get no cards and no sub-header.
const STAT_SECTIONS = {
  admin:   { title: "Pending Actions",     icon: ICONS.leave,   tone: "warning" },
  teacher: { title: "Pending Actions",     icon: ICONS.leave,   tone: "warning" },
  parent:  { title: "Children Monitoring", icon: ICONS.profile, tone: "info" },
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

renderStatTiles();
renderAnnouncements();
renderEvents();
renderRoleSection();

// -----------------------------------------------------------------
// Stat tiles
// -----------------------------------------------------------------
function tile(label, value) {
  return `<div class="card stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
}

function pendingCount(table, filters) {
  let q = supabase.from(table).select("id", { count: "exact", head: true }).eq("status", "pending");
  for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
  return q;
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
    if (profile.role === "admin") {
      const orgId = profile.organization_id;
      const [{ count: leave }, { count: approvals }, { count: corrections }] = await Promise.all([
        pendingCount("leave_requests", { organization_id: orgId }),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_approved", false),
        pendingCount("attendance_corrections", { organization_id: orgId }),
      ]);
      tiles = [
        tile("Leave Requests", leave ?? 0),
        tile("Sign-up Approvals", approvals ?? 0),
        tile("Attendance Corrections", corrections ?? 0),
      ];
    } else if (profile.role === "teacher") {
      const [{ count: leave }, { count: corrections }] = await Promise.all([
        pendingCount("leave_requests", { profile_id: profile.id }),
        pendingCount("attendance_corrections", { profile_id: profile.id }),
      ]);
      tiles = [
        tile("Leave Requests", leave ?? 0),
        tile("Attendance Corrections", corrections ?? 0),
      ];
    } else if (profile.role === "parent") {
      const c = await childrenActivityToday();
      tiles = [
        tile("Time In Today", c.timeIn),
        tile("Time Out Today", c.timeOut),
        tile("Break Out Today", c.breakOut),
        tile("Break In Today", c.breakIn),
      ];
    }
    el.innerHTML = tiles.join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="card empty-state"><h3>Unable to load your summary</h3><p>Please refresh the page.</p></div>`;
  }
}

async function childrenActivityToday() {
  const { data: links } = await supabase.from("guardians").select("student_id").eq("parent_id", profile.id);
  const ids = (links || []).map((l) => l.student_id);
  const total = ids.length;
  if (total === 0) return { timeIn: "0 of 0", timeOut: "0 of 0", breakOut: "0 of 0", breakIn: "0 of 0" };

  const { data: records, error } = await supabase
    .from("attendance_records")
    .select("profile_id, time_in, time_out, break_out, break_in")
    .in("profile_id", ids)
    .eq("record_date", today)
    .is("group_id", null);
  if (error) throw error;

  const countOf = (field) =>
    `${new Set((records || []).filter((r) => r[field]).map((r) => r.profile_id)).size} of ${total}`;

  return {
    timeIn: countOf("time_in"),
    timeOut: countOf("time_out"),
    breakOut: countOf("break_out"),
    breakIn: countOf("break_in"),
  };
}

// -----------------------------------------------------------------
// Announcements
// -----------------------------------------------------------------
async function renderAnnouncements() {
  const el = document.getElementById("announcements-list");
  try {
    const { data, error } = await supabase
      .from("announcements")
      .select("id, title, priority, created_at")
      .order("publish_at", { ascending: false })
      .limit(5);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = emptyState("You're all caught up.", "No new announcements right now.");
      return;
    }
    el.innerHTML = data
      .map(
        (a) => `
        <div class="list-row">
          <div class="priority-rail tag-${a.priority}"></div>
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
    const { data, error } = await supabase
      .from("events")
      .select("id, title, event_date, start_time, location")
      .gte("event_date", today)
      .eq("status", "scheduled")
      .order("event_date", { ascending: true })
      .limit(5);
    if (error) throw error;

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
    const { data, error } = await supabase
      .from("leave_requests")
      .select("id, start_date, end_date, reason, profiles(full_name)")
      .eq("organization_id", profile.organization_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(5);
    if (error) throw error;

    el.innerHTML = `
      <div class="section">
        ${sectionHead({
          title: "Pending leave approvals",
          icon: ICONS.leave,
          tone: "warning",
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
                  <div style="font-weight:600;">${escapeHtml(r.profiles?.full_name || "Unknown")}</div>
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
  }
}

function emptyState(title, body) {
  return `<div class="empty-state">
    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
    <h3>${title}</h3><p>${body}</p>
  </div>`;
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
