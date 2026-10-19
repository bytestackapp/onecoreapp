import { mountLayout, sectionHead } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { yearPH } from "./time.js";
import { escapeHtml } from "./utils.js";

const profile = await mountLayout({ activeKey: "leave", pageTitle: "Leave", allowedRoles: ["admin", "teacher"] });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
let myLeaveTypes = []; // only the types assigned to me this year
let myRequests = []; // all of my leave requests, newest filed first
const MY_REQUESTS_PREVIEW = 5; // how many show on the card
const ADMIN_PENDING_PREVIEW = 5; // pending requests shown on the admin card
const HALF_LABEL = { first: "First Half", second: "Second Half" };
const halfTag = (r) => (r.half_day_period ? ` · Half day (${HALF_LABEL[r.half_day_period] || ""})` : "");

document.getElementById("balances-head").innerHTML = sectionHead({
  title: "Leave balance",
  tone: "info",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
});
document.getElementById("requests-head").innerHTML = sectionHead({
  title: "My Leave Requests",
  tone: "info",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16M6 19V9a2 2 0 012-2h4l6 6v6"/><path d="M12 7v6h6"/></svg>`,
  linkHtml: `<span style="margin-left:auto;display:flex;gap:6px;"><button type="button" class="icon-action" id="view-my-requests-btn" title="View all my leave requests" aria-label="View all my leave requests"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button><button type="button" class="icon-action primary" id="file-btn" title="File a leave request" aria-label="File a leave request"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button></span>`,
});

await loadMyLeaveTypes();
loadBalances();
loadMyRequests();

if (isAdmin) {
  document.getElementById("admin-requests-section").style.display = "block";
  document.getElementById("admin-requests-head").innerHTML = sectionHead({
    title: "Leave Requests",
    tone: "info",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
    linkHtml: `<button type="button" class="icon-action" id="view-all-requests-btn" title="View all leave requests" aria-label="View all leave requests" style="margin-left:auto;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>`,
  });
  document.getElementById("view-all-requests-btn").addEventListener("click", openAllRequestsDialog);
  loadAdminRequests();
}

document.getElementById("file-btn").addEventListener("click", fileLeaveDialog);
document.getElementById("view-my-requests-btn").addEventListener("click", openMyRequestsListDialog);

async function loadMyLeaveTypes() {
  const { data, error } = await supabase
    .from("leave_balances")
    .select("leave_types(id, name, is_active)")
    .eq("profile_id", profile.id)
    .eq("period_year", yearPH());
  if (error) {
    console.error(error);
    return;
  }
  myLeaveTypes = (data || [])
    .map((b) => b.leave_types)
    .filter((t) => t && t.is_active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const fmtNum = (n) => +Number(n || 0).toFixed(2);

async function loadBalances() {
  const el = document.getElementById("balances-list");
  const year = yearPH();
  try {
    const { data, error } = await supabase
      .from("leave_balances")
      .select("entitled, used, pending, carried_over, leave_types(name, accrual_frequency, default_entitlement)")
      .eq("profile_id", profile.id)
      .eq("period_year", year);
    if (error) throw error;

    const rows = (data || []).sort((x, y) => (x.leave_types?.name || "").localeCompare(y.leave_types?.name || ""));
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No leave balance set up yet</h3><p>Ask your administrator to assign your leave types.</p></div>`;
      return;
    }

    const th = "text-align:right;padding:8px 6px;font-weight:600;";
    const td = "text-align:right;padding:10px 6px;";
    const line = "border-bottom:1px solid var(--border, #e5e7eb);";
    const hasPending = rows.some((b) => b.pending > 0);

    el.innerHTML = `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
          <thead>
            <tr style="${line}">
              <th style="${th}text-align:left;">Leave name</th>
              <th style="${th}">Available</th>
              <th style="${th}">Used</th>
              <th style="${th}">Earned</th>
              <th style="${th}">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((b) => {
                // Total = the full-year credit + carried-over days (what the staff member can use this year)
                const total = (b.leave_types?.default_entitlement ?? b.entitled) + (b.carried_over || 0);
                // Available is measured against the Total, not against what has been earned so far
                const available = total - (b.used || 0) - (b.pending || 0);
                return `<tr style="${line}">
                  <td style="${td}text-align:left;font-weight:600;">${escapeHtml(b.leave_types?.name || "Leave")}</td>
                  <td style="${td}font-weight:600;">${fmtNum(available)}</td>
                  <td style="${td}">${fmtNum(b.used)}</td>
                  <td style="${td}">${fmtNum(b.entitled)}</td>
                  <td style="${td}">${fmtNum(total)}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      ${hasPending ? `<p class="text-muted" style="font-size:0.8rem;margin:10px 0 0;">Available already excludes days on pending requests.</p>` : ""}`;
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Unable to load your leave balance</h3></div>`;
    showToast("Unable to load your leave balance.", "error");
  }
}

// Small shared dialog shell
function openDialogShell(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  return { backdrop, close };
}

// -----------------------------------------------------------------
// File a leave request (modal)
// -----------------------------------------------------------------
function fileLeaveDialog() {
  if (myLeaveTypes.length === 0) {
    showToast("No leave types have been assigned to you yet.", "error");
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="fl-title">
      <h3 id="fl-title">File a leave request</h3>
      <form id="fl-form">
        <div class="field">
          <label for="fl-type">Leave type</label>
          <select id="fl-type" required>${myLeaveTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="fl-daytype">Duration</label>
          <div style="display:flex;gap:12px;">
            <select id="fl-daytype" style="flex:1;min-width:0;">
              <option value="full" selected>Full day</option>
              <option value="half">Half day</option>
            </select>
            <select id="fl-half-period" aria-label="Half day period" style="flex:1;min-width:0;" disabled>
              <option value="first">First Half</option>
              <option value="second">Second Half</option>
            </select>
          </div>
        </div>		
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div class="field">
            <label for="fl-start">Start date</label>
            <input id="fl-start" type="date" required />
          </div>
          <div class="field">
            <label for="fl-end">End date</label>
            <input id="fl-end" type="date" required />
          </div>
        </div>
        <div class="field">
          <label for="fl-reason">Reason</label>
          <textarea id="fl-reason" rows="3" required></textarea>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="fl-submit">Submit request</button>
        </div>
      </form>
    </div>`;
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
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#fl-type").focus();

  // Half day: needs a single date, so the end date follows the start date while "Half day" is chosen
  const dayTypeSel = backdrop.querySelector("#fl-daytype");
  const halfSel = backdrop.querySelector("#fl-half-period");
  const startEl = backdrop.querySelector("#fl-start");
  const endEl = backdrop.querySelector("#fl-end");
  dayTypeSel.addEventListener("change", () => {
    const half = dayTypeSel.value === "half";
    halfSel.disabled = !half;
    endEl.disabled = half;
    if (half) endEl.value = startEl.value;
  });
  startEl.addEventListener("input", () => {
    if (dayTypeSel.value === "half") endEl.value = startEl.value;
  });

  backdrop.querySelector("#fl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#fl-submit");
    const startDate = backdrop.querySelector("#fl-start").value;
    const isHalf = backdrop.querySelector("#fl-daytype").value === "half";
    const endDate = isHalf ? startDate : backdrop.querySelector("#fl-end").value;
    if (new Date(endDate) < new Date(startDate)) {
      showToast("End date can't be before the start date.", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      const { error } = await supabase.rpc("file_leave_request", {
        p_leave_type_id: backdrop.querySelector("#fl-type").value,
        p_start_date: startDate,
        p_end_date: endDate,
        p_reason: backdrop.querySelector("#fl-reason").value.trim(),
		p_half_day_period: isHalf ? backdrop.querySelector("#fl-half-period").value : null,
      });
      if (error) throw error;

      await logAudit({ action: "leave.filed", recordType: "leave_request", recordId: null });
      close();
      showToast("Leave request submitted.", "success");
      loadMyRequests();
      loadBalances();
    } catch (err) {
      console.error(err);
      showToast(err.message && (!err.code || err.code === "P0001") ? err.message : friendlyError(err, "Unable to submit your leave request. Please try again."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit request";
    }
  });
}

// -----------------------------------------------------------------
// Shared helpers for request lists and the details dialog
// -----------------------------------------------------------------
function statusTagHtml(status) {
  const kind = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";
  return `<span class="tag tag-${kind}">${escapeHtml(status)}</span>`;
}

function monthLabel(dateStr) {
  const [y, m] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// rows must already be sorted by dateKey; a month header is inserted whenever the month changes.
function groupedByMonth(rows, dateKey, rowHtml) {
  let current = "";
  return rows
    .map((r) => {
      const label = monthLabel(r[dateKey]);
      const header = label !== current ? `<div class="ack-group-title">${label}</div>` : "";
      current = label;
      return header + rowHtml(r);
    })
    .join("");
}

function byStartDateDesc(a, b) {
  return String(b.start_date).localeCompare(String(a.start_date));
}

// Details dialog: title on the left, status badge on the top right.
function leaveDialogHead(statusHtml = "") {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;">
      <h3 id="lv-title" style="margin:0;">Leave request</h3>
      <span id="lv-status">${statusHtml}</span>
    </div>`;
}

function leaveDetailsHtml(d) {
  const days = Math.round((new Date(d.end_date) - new Date(d.start_date)) / 86400000) + 1;
  return `
    <p><strong>${escapeHtml(d.full_name)}</strong> · ${escapeHtml(d.leave_type_name)}</p>
    <p><strong>Date:</strong> ${formatDate(d.start_date)} – ${formatDate(d.end_date)} (${d.half_day_period ? `0.5 day · ${HALF_LABEL[d.half_day_period] || ""}` : `${days} day${days === 1 ? "" : "s"}`})</p>
    <p><strong>Reason:</strong> ${escapeHtml(d.reason)}</p>
    ${d.status !== "pending" && d.reviewer_remarks ? `<p><strong>Remarks:</strong> ${escapeHtml(d.reviewer_remarks)}</p>` : ""}`;
}

// -----------------------------------------------------------------
// My requests — card shows the 5 newest; the eye button opens the full list
// -----------------------------------------------------------------
function myRequestRow(r) {
  return `
    <div class="list-row" style="cursor:pointer;" data-my-req="${r.id}">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(r.leave_types?.name || "Leave")} · ${formatDate(r.start_date)} – ${formatDate(r.end_date)}${halfTag(r)}</div>
        <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.reason)}</div>
      </div>
      ${statusTagHtml(r.status)}
    </div>`;
}

// Row layout used inside the "My leave requests" modal:
// dates + status on top, then leave type, reason and remarks in muted text.
function myRequestModalRow(r) {
  return `
    <div class="list-row" style="cursor:pointer;" data-my-req="${r.id}">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${formatDate(r.start_date)} – ${formatDate(r.end_date)}${halfTag(r)}</div>
        <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.leave_types?.name || "Leave")}</div>
        <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.reason)}</div>
      </div>
      ${statusTagHtml(r.status)}
    </div>`;
}

function bindMyRequestRows(container) {
  container.querySelectorAll("[data-my-req]").forEach((row) => {
    row.addEventListener("click", () => {
      const r = myRequests.find((x) => String(x.id) === row.getAttribute("data-my-req"));
      if (r) openMyRequestDialog(r);
    });
  });
}

async function loadMyRequests() {
  const el = document.getElementById("my-requests");
  try {
    const { data, error } = await supabase
      .from("leave_requests")
      .select("id, start_date, end_date, reason, status, reviewer_remarks, half_day_period, leave_types(name)")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    myRequests = data || [];
    if (myRequests.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No leave applications yet</h3><p>Requests you file will show up here with their approval status.</p></div>`;
      return;
    }

    el.innerHTML = myRequests.slice(0, MY_REQUESTS_PREVIEW).map(myRequestRow).join("");
    bindMyRequestRows(el);
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Unable to load your requests</h3></div>`;
    showToast("Unable to load your leave requests.", "error");
  }
}

function openMyRequestsListDialog() {
  const sorted = [...myRequests].sort(byStartDateDesc);
  const { backdrop, close } = openDialogShell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="mr-title">
      <h3 id="mr-title">My leave requests</h3>
      <div class="aud-body" id="mr-body">${
        sorted.length
          ? groupedByMonth(sorted, "start_date", myRequestModalRow)
          : `<div class="text-muted" style="padding:8px 0;">No leave applications yet.</div>`
      }</div>
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
    </div>`);
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
  bindMyRequestRows(backdrop.querySelector("#mr-body"));
}

// Read-only details for one of my own requests (same layout as the review dialog).
function openMyRequestDialog(r) {
  const { backdrop, close } = openDialogShell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lv-title">
      ${leaveDialogHead(statusTagHtml(r.status))}
      ${leaveDetailsHtml({ ...r, full_name: profile.full_name || "You", leave_type_name: r.leave_types?.name || "Leave" })}
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
    </div>`);
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
}

// -----------------------------------------------------------------
// Admin: leave requests from all staff
// -----------------------------------------------------------------
async function fetchAdminRequests(limit, { pendingOnly = false } = {}) {
  let query = supabase
    .from("leave_requests")
    .select("id, profile_id, start_date, end_date, reason, status, created_at, half_day_period, leave_types(name)");
  query = pendingOnly
    ? query.eq("status", "pending").order("created_at", { ascending: false })
    : query.order("start_date", { ascending: false }).order("created_at", { ascending: false });
  const { data, error } = await query.limit(limit);
  if (error) throw error;
  const rows = data || [];
  const ids = [...new Set(rows.map((r) => r.profile_id))];
  let names = {};
  if (ids.length) {
    const { data: people } = await supabase.from("profiles").select("id, full_name").in("id", ids);
    names = Object.fromEntries((people || []).map((p) => [p.id, p.full_name]));
  }
  return rows.map((r) => ({ ...r, full_name: names[r.profile_id] || "Unknown" }));
}

function adminRequestRow(r) {
  return `
    <div class="list-row" style="cursor:pointer;" data-req="${r.id}">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(r.full_name)} · ${escapeHtml(r.leave_types?.name || "Leave")}</div>
        <div class="text-muted" style="font-size:0.85rem;">${formatDate(r.start_date)} – ${formatDate(r.end_date)}${halfTag(r)}</div>
        <div class="text-muted" style="font-size:0.8rem;">${escapeHtml(r.reason)}</div>
      </div>
      ${statusTagHtml(r.status)}
    </div>`;
}

// Card: pending requests only, in the order they were submitted (newest first).
async function loadAdminRequests() {
  const el = document.getElementById("admin-requests-list");
  try {
    const rows = await fetchAdminRequests(ADMIN_PENDING_PREVIEW, { pendingOnly: true });
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No pending leave requests</h3><p>New requests from staff will show up here for review.</p></div>`;
      return;
    }
    el.innerHTML = rows.map(adminRequestRow).join("");
    el.querySelectorAll("[data-req]").forEach((row) => {
      row.addEventListener("click", () => openReviewDialog(row.getAttribute("data-req"), loadAdminRequests));
    });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Unable to load leave requests</h3></div>`;
    showToast("Unable to load leave requests.", "error");
  }
}

// Modal: every request, by leave start date, with month headers.
async function openAllRequestsDialog() {
  const { backdrop, close } = openDialogShell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ar-title">
      <h3 id="ar-title">All leave requests</h3>
      <div class="aud-body" id="ar-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
    </div>`);
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  async function renderAll() {
    const bodyEl = backdrop.querySelector("#ar-body");
    try {
      const rows = await fetchAdminRequests(200);
      bodyEl.innerHTML = rows.length
        ? groupedByMonth(rows, "start_date", adminRequestRow)
        : `<div class="text-muted" style="padding:8px 0;">No leave requests yet.</div>`;
      bodyEl.querySelectorAll("[data-req]").forEach((row) => {
        row.addEventListener("click", () =>
          openReviewDialog(row.getAttribute("data-req"), () => {
            renderAll();
            loadAdminRequests();
          })
        );
      });
    } catch (err) {
      console.error(err);
      bodyEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">Unable to load leave requests.</div>`;
    }
  }
  renderAll();
}

async function openReviewDialog(requestId, onDone) {
  const { backdrop, close } = openDialogShell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lv-title">
      ${leaveDialogHead()}
      <div id="lv-body"><div class="skeleton" style="height:60px;"></div></div>
    </div>`);

  const bodyEl = backdrop.querySelector("#lv-body");
  try {
    const { data, error } = await supabase.rpc("get_leave_request", { p_id: requestId }).single();
    if (error) throw error;
    if (!data) throw new Error("not found");

    const isPending = data.status === "pending";
    backdrop.querySelector("#lv-status").innerHTML = statusTagHtml(data.status);
    bodyEl.innerHTML = `
      ${leaveDetailsHtml(data)}
      ${
        isPending
          ? `<div class="field">
              <label for="lv-remarks">Remarks (optional)</label>
              <textarea id="lv-remarks" rows="2"></textarea>
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
              <button type="button" class="btn" style="background:var(--error-solid);border-color:var(--error-solid);color:#fff;" data-act="reject">Reject</button>
              <button type="button" class="btn btn-primary" data-act="approve">Approve</button>
            </div>`
          : `<div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`
      }`;

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
        onDone?.();
      } catch (err) {
        console.error(err);
        showToast(friendlyError(err, "Unable to save this decision."), "error");
      }
    }

    bodyEl.querySelector('[data-act="close"]')?.addEventListener("click", close);
    bodyEl.querySelector('[data-act="approve"]')?.addEventListener("click", () => review(true));
    bodyEl.querySelector('[data-act="reject"]')?.addEventListener("click", () => review(false));
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<p class="text-muted">This request couldn't be loaded.</p><div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`;
    bodyEl.querySelector('[data-act="close"]').addEventListener("click", close);
    showToast("Unable to load this request.", "error");
  }
}

// Refresh balances and requests when a push about leave arrives while this page is open.
window.addEventListener("onecore:push", (e) => {
  if (!e.detail?.forThisAcademy || e.detail.related_type !== "leave_request" || document.querySelector(".dialog-backdrop")) return;
  loadBalances();
  loadMyRequests();
  if (isAdmin) loadAdminRequests();
});