import { mountLayout } from "./layout.js";
import { supabase, timeAgo, priorityLabel } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "notifications", pageTitle: "Notifications" });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("notifications-list");
const summaryEl = document.getElementById("unread-summary");
const markAllBtn = document.getElementById("mark-all-btn");

const RELATED_PAGE = {
  announcement: "announcements.html",
  event: "events.html",
  leave_request: "leave.html",
  attendance_correction: "attendance.html",
};

let notifications = [];

async function load() {
  listEl.innerHTML = `<div class="skeleton" style="height:60px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select("id, title, body, priority, related_type, is_read, created_at")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    notifications = data || [];
    const unread = notifications.filter((n) => !n.is_read).length;
    summaryEl.textContent = unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You're all caught up.";
    markAllBtn.disabled = unread === 0;
    render();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">Notifications couldn't be loaded. Please refresh the page.</div>`;
  }
}

function render() {
  if (notifications.length === 0) {
    listEl.innerHTML = `<div class="empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
      <h3>Nothing here yet</h3><p>New announcements, events and requests will show up as notifications.</p>
    </div>`;
    return;
  }

  listEl.innerHTML = notifications
    .map((n) => {
      const href = RELATED_PAGE[n.related_type];
      const inner = `
        <div class="priority-rail tag-${n.priority}"></div>
        <div style="flex:1;${n.is_read ? "" : "font-weight:600;"}">
          <div>${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="text-muted" style="font-weight:400;font-size:0.85rem;margin-top:2px;">${escapeHtml(n.body)}</div>` : ""}
          <div class="text-muted" style="font-weight:400;font-size:0.78rem;margin-top:4px;">${timeAgo(n.created_at)}</div>
        </div>
        <span class="tag tag-${n.priority}">${priorityLabel(n.priority)}</span>
      `;
      return href
        ? `<a class="list-row" style="text-decoration:none;color:inherit;cursor:pointer;" data-id="${n.id}" data-href="${href}">${inner}</a>`
        : `<div class="list-row" data-id="${n.id}">${inner}</div>`;
    })
    .join("");

  listEl.querySelectorAll("[data-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const id = row.getAttribute("data-id");
      await markRead(id);
      const href = row.getAttribute("data-href");
      if (href) window.location.href = href;
    });
  });
}

async function markRead(id) {
  const n = notifications.find((x) => x.id === id);
  if (!n || n.is_read) return;
  n.is_read = true;
  try {
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
    const unread = notifications.filter((x) => !x.is_read).length;
    summaryEl.textContent = unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You're all caught up.";
    markAllBtn.disabled = unread === 0;
  } catch (err) {
    console.error(err);
  }
}

markAllBtn.addEventListener("click", async () => {
  markAllBtn.disabled = true;
  try {
    await supabase.from("notifications").update({ is_read: true }).eq("profile_id", profile.id).eq("is_read", false);
    notifications.forEach((n) => (n.is_read = true));
    summaryEl.textContent = "You're all caught up.";
    render();
  } catch (err) {
    console.error(err);
    markAllBtn.disabled = false;
  }
});

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

load();
