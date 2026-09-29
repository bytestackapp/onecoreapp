import { mountLayout, ICONS } from "./layout.js";
import { supabase, formatDate, timeAgo, priorityLabel } from "./supabase-client.js";
import { sectionHead } from "./ui.js";
import { checkForUpdate } from "./version-check.js";

const profile = await mountLayout({ activeKey: "dashboard", pageTitle: "Dashboard", brandOnMobile: true });
if (!profile) throw new Error("redirecting");
checkForUpdate();

// Local calendar date as YYYY-MM-DD (toISOString() reports the UTC date,
// which is the wrong day for part of the morning in UTC+8).
function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
const today = localDate();

document.getElementById("welcome-line").textContent =
  `Welcome back, ${profile.full_name.split(" ")[0]}. Here's what's happening today.`;

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

async function myTodayStatus() {
  const { data } = await supabase
    .from("attendance_records")
    .select("time_in,time_out")
    .eq("profile_id", profile.id)
    .eq("record_date", today)
    .is("group_id", null)
    .maybeSingle();
  return data?.time_in ? (data?.time_out ? "Complete" : "In progress") : "Not started";
}

async function renderStatTiles() {
  const el = document.getElementById("stat-tiles");
  el.innerHTML = `<div class="skeleton" style="height:80px;grid-column:1/-1;"></div>`;
  let tiles = [];

  try {
    if (profile.role === "admin") {
      const orgId = profile.organization_id;
      const [
        { count: totalUsers },
        { count: teachers },
        { count: students },
        { count: parents },
        { count: pendingLeave },
        { count: pendingApprovals },
        { count: pendingCorrections },
        myStatus,
      ] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "teacher"),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "student"),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "parent"),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "pending"),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_approved", false),
        supabase.from("attendance_corrections").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "pending"),
        myTodayStatus(),
      ]);
      tiles = [
        tile("Total users", totalUsers ?? 0),
        tile("Teachers", teachers ?? 0),
        tile("Students", students ?? 0),
        tile("Parents", parents ?? 0),
        tile("Today's status", myStatus),
        tile("Pending leave requests", pendingLeave ?? 0),
        tile("Pending sign-up approvals", pendingApprovals ?? 0),
        tile("Pending corrections", pendingCorrections ?? 0),
      ];
    } else if (profile.role === "teacher") {
      const [myStatus, { count: pendingLeave }] = await Promise.all([
        myTodayStatus(),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("profile_id", profile.id).eq("status", "pending"),
      ]);
      tiles = [tile("Today's status", myStatus), tile("Pending leave requests", pendingLeave ?? 0)];
    } else if (profile.role === "student") {
      const { count: presentCount } = await supabase
        .from("attendance_records")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profile.id)
        .eq("status", "present");
      tiles = [tile("Days present (recorded)", presentCount ?? 0)];
    } else if (profile.role === "parent") {
      const [{ count: pendingRsvps }, childrenToday] = await Promise.all([
        supabase.from("event_participants").select("id", { count: "exact", head: true }).eq("profile_id", profile.id).is("rsvp_status", null),
        childrenCheckedInToday(),
      ]);
      tiles = [tile("Pending RSVPs", pendingRsvps ?? 0), tile("Children checked in today", childrenToday)];
    }
    el.innerHTML = tiles.join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="card empty-state"><h3>Unable to load your summary</h3><p>Please refresh the page.</p></div>`;
  }
}

async function childrenCheckedInToday() {
  const { data: links } = await supabase.from("guardians").select("student_id").eq("parent_id", profile.id);
  const ids = (links || []).map((l) => l.student_id);
  if (ids.length === 0) return "0 of 0";

  const { data: records } = await supabase
    .from("attendance_records")
    .select("profile_id")
    .in("profile_id", ids)
    .eq("record_date", today)
    .is("group_id", null)
    .not("time_in", "is", null);
  const checkedIn = new Set((records || []).map((r) => r.profile_id)).size;
  return `${checkedIn} of ${ids.length}`;
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
