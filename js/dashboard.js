import { mountLayout } from "./layout.js";
import { supabase, formatDate, formatDateTime, timeAgo, priorityLabel } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "dashboard", pageTitle: "Dashboard" });
if (!profile) throw new Error("redirecting");

document.getElementById("welcome-line").textContent =
  `Welcome back, ${profile.full_name.split(" ")[0]}. Here's what's happening today.`;

renderStatTiles();
renderAnnouncements();
renderEvents();
renderRoleSection();

// -----------------------------------------------------------------
// Stat tiles
// -----------------------------------------------------------------
async function tile(label, value) {
  return `<div class="card stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
}

async function renderStatTiles() {
  const el = document.getElementById("stat-tiles");
  el.innerHTML = `<div class="skeleton" style="height:80px;grid-column:1/-1;"></div>`;
  let tiles = [];

  try {
    if (profile.role === "admin") {
      const orgId = profile.organization_id;
      const [{ count: totalUsers }, { count: teachers }, { count: students }, { count: parents }, { count: pendingLeave }] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "teacher"),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "student"),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("role", "parent"),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "pending"),
      ]);
      tiles = [
        await tile("Total users", totalUsers ?? 0),
        await tile("Teachers", teachers ?? 0),
        await tile("Students", students ?? 0),
        await tile("Parents", parents ?? 0),
        await tile("Pending leave requests", pendingLeave ?? 0),
      ];
    } else if (profile.role === "teacher") {
      const today = new Date().toISOString().slice(0, 10);
      const [{ data: att }, { count: pendingLeave }] = await Promise.all([
        supabase.from("attendance_records").select("time_in,time_out").eq("profile_id", profile.id).eq("record_date", today).maybeSingle(),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("profile_id", profile.id).eq("status", "pending"),
      ]);
      tiles = [
        await tile("Today's status", att?.time_in ? (att?.time_out ? "Complete" : "In progress") : "Not started"),
        await tile("Pending leave requests", pendingLeave ?? 0),
      ];
    } else if (profile.role === "student") {
      const { count: presentCount } = await supabase
        .from("attendance_records")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profile.id)
        .eq("status", "present");
      tiles = [await tile("Days present (recorded)", presentCount ?? 0)];
    } else if (profile.role === "parent") {
      const { count: pendingRsvps } = await supabase
        .from("event_participants")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profile.id)
        .is("rsvp_status", null);
      tiles = [await tile("Pending RSVPs", pendingRsvps ?? 0)];
    }
    el.innerHTML = tiles.join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Unable to load your summary right now.</div>`;
  }
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
      .limit(3);
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
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(a.title)}</div>
            <div class="text-muted" style="font-size:0.8rem;">${timeAgo(a.created_at)}</div>
          </div>
          <span class="tag tag-${a.priority}">${priorityLabel(a.priority)}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Announcements couldn't be loaded.</div>`;
  }
}

// -----------------------------------------------------------------
// Events
// -----------------------------------------------------------------
async function renderEvents() {
  const el = document.getElementById("events-list");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("events")
      .select("id, title, event_date, start_time, location")
      .gte("event_date", today)
      .eq("status", "scheduled")
      .order("event_date", { ascending: true })
      .limit(3);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = emptyState("No upcoming events.", "New events will show up here as soon as they're scheduled.");
      return;
    }
    el.innerHTML = data
      .map(
        (e) => `
        <div class="list-row">
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(e.title)}</div>
            <div class="text-muted" style="font-size:0.8rem;">${formatDate(e.event_date)}${e.start_time ? " · " + e.start_time.slice(0, 5) : ""}${e.location ? " · " + escapeHtml(e.location) : ""}</div>
          </div>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Events couldn't be loaded.</div>`;
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
        <div class="section-head">
          <h2>Pending leave approvals</h2>
          <a class="link" href="leave.html">Manage</a>
        </div>
        <div class="card">
          ${
            !data || data.length === 0
              ? emptyState("Nothing pending.", "All leave requests have been reviewed.")
              : data
                  .map(
                    (r) => `
              <div class="list-row">
                <div style="flex:1;">
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
