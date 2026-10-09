import { mountLayout } from "./layout.js";
import { supabase, timeAgo, priorityLabel, friendlyError, logAudit, formatDate, myAcademies, switchToProfile } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "notifications", pageTitle: "Notifications" });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("notifications-list");
const summaryEl = document.getElementById("unread-summary");
const markAllBtn = document.getElementById("mark-all-btn");
const clearBtn = document.getElementById("clear-btn");

const RELATED_PAGE = {
  announcement: "announcements.html",
  event: "events.html",
  leave_request: "leave.html",
  attendance_correction: "attendance.html#corrections", // reviewed on the Attendance page
  signup: "admin-users.html", // new account waiting for approval
};

// Related types an admin reviews inline instead of navigating away.
// (Attendance corrections are reviewed on the Attendance page, so they just link there.)
const ADMIN_REVIEW_TYPES = new Set(["leave_request"]);

// These three types show a fixed label + requester name on the card, instead of
// the raw title/body sentence. Everything else (announcements, events) is unchanged.
const CARD_LABEL = {
  leave_request: "Leave Request",
  attendance_correction: "Correction Request",
  signup: "Sign-up Request",
};

// Announcement and event cards: short fixed headline, then the item's own name on one line.
const FEED_LABEL = { announcement: "New Announcement", event: "New Event" };

// Leave and correction notifications get a status badge (Approved/Rejected) once
// decided, instead of the generic priority badge. Everything else (announcements,
// events, and pending review requests) keeps the priority badge as before.
const REVIEW_TYPES = new Set(["leave_request", "attendance_correction"]);
const STATUS_LABEL = { approved: "Approved", rejected: "Rejected" };

// Best-effort: pull just the person's name out of a notification body sentence,
// e.g. "Jane Doe (jane@x.com) requested to join as teacher." -> "Jane Doe"
// If the body doesn't match that shape, falls back to the full body text.
function extractName(body = "") {
  const m = String(body).match(/^(.*?)(?:\s*\(|\s+(?:requested|submitted|filed|has requested|has submitted))/i);
  return (m ? m[1] : body).trim();
}

let notifications = [];
let academies = [];

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load() {
  listEl.innerHTML = `<div class="skeleton" style="height:60px;"></div>`;
  try {
    // No profile filter: row-level security already limits this to profiles I own,
    // so notifications from all of my academies show up here.
    academies = await myAcademies();
    const { data, error } = await supabase
      .from("notifications")
      .select("id, profile_id, title, body, priority, related_type, related_id, is_read, created_at, subject_name, related_status")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    notifications = data || [];
    updateSummary();
    render();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="card empty-state"><h3>Notifications couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Notifications couldn't be loaded.", "error");
  }
}

function updateSummary() {
  const unread = notifications.filter((n) => !n.is_read).length;
  summaryEl.textContent = unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "You're all caught up.";
  markAllBtn.disabled = unread === 0;
  clearBtn.disabled = notifications.length === 0;
}

const CARD_BASE = "cursor:pointer !important;background:var(--card) !important;border-radius:14px !important;padding:16px 18px !important;";
const CARD_READ = CARD_BASE + "box-shadow:0 4px 14px rgba(0,0,0,0.10) !important;border:1px solid var(--border) !important;";
const CARD_UNREAD = CARD_BASE + "box-shadow:0 0 0 3px var(--primary-light), 0 4px 14px rgba(79,70,229,0.16) !important;border:1px solid var(--primary) !important;";

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
      const isAdminReview = ADMIN_REVIEW_TYPES.has(n.related_type) && profile.role === "admin" && n.profile_id === profile.id;
      const academyName = academies.length > 1 ? academies.find((a) => a.profile_id === n.profile_id)?.academy_name : "";
      const href = !isAdminReview ? RELATED_PAGE[n.related_type] : null;
      const label = CARD_LABEL[n.related_type];
      const feedLabel = FEED_LABEL[n.related_type];
      const headline = feedLabel || n.title;
      const detail = feedLabel
        ? String(n.title || "").replace(/^new\s+(?:announcement|event)\s*[:\-–—]\s*/i, "").trim()
        : n.body || "";
      const detailStyle =
        "font-weight:400;font-size:0.85rem;margin-top:2px;" +
        (feedLabel ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" : "");
      // Prefer the real name filled in by the database; extractName() is only a
      // fallback for older rows created before that column existed.
      const subjectName = n.subject_name || extractName(n.body);
      // Approved/Rejected once decided; the priority badge otherwise (including
      // while a leave/correction request is still pending review).
      const statusLabel = REVIEW_TYPES.has(n.related_type) ? STATUS_LABEL[n.related_status] : null;
      const badgeHtml =
        n.related_type === "event"
          ? ""
          : statusLabel
          ? `<span class="tag tag-${n.related_status}">${statusLabel}</span>`
          : `<span class="tag tag-${n.priority}">${priorityLabel(n.priority)}</span>`;
      const inner = label
        ? `
        <div style="flex:1;min-width:0;${n.is_read ? "" : "font-weight:600;"}">
          <div>${label}</div>
          <div class="text-muted" style="font-weight:400;font-size:0.85rem;margin-top:2px;">${escapeHtml(subjectName)}</div>
          <div class="text-muted" style="font-weight:400;font-size:0.78rem;margin-top:4px;">${timeAgo(n.created_at)}${academyName ? ` · ${escapeHtml(academyName)}` : ""}</div>
        </div>
        ${badgeHtml}
      `
        : `
        <div style="flex:1;min-width:0;${n.is_read ? "" : "font-weight:600;"}">
          <div>${escapeHtml(headline)}</div>
          ${detail ? `<div class="text-muted" style="${detailStyle}">${escapeHtml(detail)}</div>` : ""}
          <div class="text-muted" style="font-weight:400;font-size:0.78rem;margin-top:4px;">${timeAgo(n.created_at)}${academyName ? ` · ${escapeHtml(academyName)}` : ""}</div>
        </div>
        ${badgeHtml}
      `;

      const cardStyle = n.is_read ? CARD_READ : CARD_UNREAD;
      return `<div style="margin-bottom:10px;">
        <div class="list-row" style="${cardStyle}" data-id="${n.id}" data-profile="${n.profile_id}" data-href="${href || ""}" data-review-type="${
        isAdminReview ? n.related_type : ""
      }" data-related-id="${n.related_id || ""}">${inner}</div>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll("[data-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const id = row.getAttribute("data-id");
      await markRead(id);
      const reviewType = row.getAttribute("data-review-type");
      if (reviewType === "leave_request") {
        openLeaveDialog(row.getAttribute("data-related-id"));
        return;
      }
      const href = row.getAttribute("data-href");
      if (!href) return;
      // A notification from another academy: switch there first, then open the page.
      const targetProfile = row.getAttribute("data-profile");
      if (targetProfile && targetProfile !== profile.id) {
        try {
          await switchToProfile(targetProfile);
        } catch (err) {
          console.error(err);
          showToast("Unable to switch academy.", "error");
          return;
        }
      }
      window.location.href = href;
    });
  });
}

async function markRead(id) {
  const n = notifications.find((x) => x.id === id);
  if (!n || n.is_read) return;
  n.is_read = true;
  const row = listEl.querySelector(`[data-id="${id}"]`);
  if (row) {
    row.style.cssText = CARD_READ;
    if (row.firstElementChild) row.firstElementChild.style.fontWeight = "";
  }
  try {
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
    updateSummary();
  } catch (err) {
    console.error(err);
  }
}

markAllBtn.addEventListener("click", async () => {
  markAllBtn.disabled = true;
  try {
    await supabase.from("notifications").update({ is_read: true }).eq("is_read", false);
    notifications.forEach((n) => (n.is_read = true));
    updateSummary();
    render();
  } catch (err) {
    console.error(err);
    showToast("Unable to mark all as read.", "error");
    markAllBtn.disabled = false;
  }
});

clearBtn.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Clear all notifications?",
    message: "This permanently removes every notification in your list. It can't be undone.",
    confirmLabel: "Clear",
    danger: true,
  });
  if (!ok) return;
  try {
    const { data, error } = await supabase.from("notifications").delete().in("profile_id", [...new Set([profile.id, ...academies.map((a) => a.profile_id)])]).select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      showToast("Nothing was cleared. You may not have permission to delete notifications.", "error");
      return;
    }
    notifications = [];
    updateSummary();
    render();
    showToast("Notifications cleared.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to clear notifications."), "error");
  }
});

// -----------------------------------------------------------------
// Shared small dialog shell
// -----------------------------------------------------------------
function openDialog(titleId, html) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, close };
}

// -----------------------------------------------------------------
// Admin: review a leave request without leaving this page
// -----------------------------------------------------------------
async function openLeaveDialog(requestId) {
  if (!requestId) return;
  const { backdrop, close } = openDialog(
    "lv-title",
    `<div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lv-title">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
        <h3 id="lv-title" style="margin:0;">Leave request</h3>
        <span id="lv-badge"></span>
      </div>
      <div id="lv-body"><div class="skeleton" style="height:60px;"></div></div>
    </div>`
  );

  try {
    const { data, error } = await supabase.rpc("get_leave_request", { p_id: requestId }).single();
    if (error) throw error;
    if (!data) throw new Error("not found");

    const bodyEl = backdrop.querySelector("#lv-body");

    function renderBody() {
      const isPending = data.status === "pending";
      const days = Math.round((new Date(data.end_date) - new Date(data.start_date)) / 86400000) + 1;
      const badge = !isPending
        ? `<span class="tag tag-${data.status === "approved" ? "approved" : "rejected"}">${escapeHtml(data.status)}</span>`
        : "";
      backdrop.querySelector("#lv-badge").innerHTML = badge;
      bodyEl.innerHTML = `
        <p><strong>Name:</strong> ${escapeHtml(data.full_name)}</p>
        <p><strong>Leave Type:</strong> ${escapeHtml(data.leave_type_name)}</p>
        <p><strong>Dates:</strong> ${formatDate(data.start_date)} – ${formatDate(data.end_date)} (${days} day${days === 1 ? "" : "s"})</p>
        <p><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>
        ${!isPending && data.reviewer_remarks ? `<p><strong>Remarks:</strong> ${escapeHtml(data.reviewer_remarks)}</p>` : ""}
        ${
          isPending
            ? `<div class="field">
                <label for="lv-remarks">Remarks (optional)</label>
                <textarea id="lv-remarks" rows="2"></textarea>
              </div>
              <div class="dialog-actions">
                <button type="button" class="btn" style="background:var(--error-solid);border-color:var(--error-solid);color:#fff;" data-act="reject">Reject</button>
                <button type="button" class="btn btn-primary" data-act="approve">Approve</button>
              </div>`
            : `<div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`
        }
      `;

      bodyEl.querySelector('[data-act="close"]')?.addEventListener("click", close);
      bodyEl.querySelector('[data-act="approve"]')?.addEventListener("click", () => review(true));
      bodyEl.querySelector('[data-act="reject"]')?.addEventListener("click", () => review(false));
    }

    async function review(approve) {
      const remarks = bodyEl.querySelector("#lv-remarks")?.value.trim() || null;
      try {
        const { error: rErr } = await supabase.rpc("review_leave_request", {
          p_request_id: requestId,
          p_approve: approve,
          p_remarks: remarks,
        });
        if (rErr) throw rErr;
        await logAudit({
          action: approve ? "leave.approved" : "leave.rejected",
          recordType: "leave_request",
          recordId: requestId,
          details: { staff: data.full_name },
        });
        showToast(approve ? "Leave approved." : "Leave rejected.", "success");
        close();
      } catch (err) {
        console.error(err);
        showToast(friendlyError(err, "Unable to save this decision."), "error");
      }
    }

    renderBody();
  } catch (err) {
    console.error(err);
    backdrop.querySelector("#lv-body").innerHTML = `<p class="text-muted">This request couldn't be loaded.</p>`;
    showToast("Unable to load this request.", "error");
  }
}

load();


// A push arrived while this page is open: show the new notification.
window.addEventListener("onecore:push", (e) => {
  if (e.detail?.forThisAcademy && !document.querySelector(".dialog-backdrop")) load();
});
