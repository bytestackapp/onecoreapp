import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { sectionHead } from "./ui.js";

const profile = await mountLayout({ activeKey: "leave", pageTitle: "Leave", allowedRoles: ["admin", "teacher"] });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
let leaveTypes = []; // all active types in the org (admin overview)
let myLeaveTypes = []; // only the types assigned to me this year

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("balances-head").innerHTML = sectionHead({
  title: "Leave balance",
  tone: "success",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
});
document.getElementById("requests-head").innerHTML = sectionHead({
  title: "My Leave Requests",
  tone: "primary",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16M6 19V9a2 2 0 012-2h4l6 6v6"/><path d="M12 7v6h6"/></svg>`,
  linkHtml: `<button type="button" class="icon-action primary" id="file-btn" title="File a leave request" aria-label="File a leave request" style="margin-left:auto;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>`,
});

await loadLeaveTypes();
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

  document.getElementById("types-section").style.display = "block";
  document.getElementById("types-head").innerHTML = sectionHead({
    title: "Leave types",
    tone: "muted",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41L11 3.83A2 2 0 009.59 3.24L4 3a1 1 0 00-1 1l.24 5.59a2 2 0 00.58 1.42l9.59 9.58a2 2 0 002.83 0l4.35-4.35a2 2 0 000-2.83z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`,
  });
  renderLeaveTypesReadOnly();
}

document.getElementById("file-btn").addEventListener("click", fileLeaveDialog);

async function loadLeaveTypes() {
  const { data, error } = await supabase.from("leave_types").select("*").eq("is_active", true).order("name");
  if (error) {
    console.error(error);
    return;
  }
  leaveTypes = data || [];
}

async function loadMyLeaveTypes() {
  const { data, error } = await supabase
    .from("leave_balances")
    .select("leave_types(id, name, is_active)")
    .eq("profile_id", profile.id)
    .eq("period_year", new Date().getFullYear());
  if (error) {
    console.error(error);
    return;
  }
  myLeaveTypes = (data || [])
    .map((b) => b.leave_types)
    .filter((t) => t && t.is_active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderLeaveTypesReadOnly() {
  const el = document.getElementById("leave-types-list");
  if (leaveTypes.length === 0) {
    el.innerHTML = `<div class="empty-state"><h3>No leave types yet</h3><p>Set these up in Settings → Leave types.</p></div>`;
    return;
  }
  el.innerHTML = leaveTypes
    .map(
      (t) => `
      <div class="list-row">
        <div style="flex:1;min-width:0;font-weight:600;">${escapeHtml(t.name)}</div>
        <div class="text-muted" style="font-size:0.85rem;">${t.default_entitlement} days/year${t.accrual_frequency === "monthly" ? " · earned monthly" : ""}</div>
      </div>`
    )
    .join("");
}

const fmtNum = (n) => +Number(n || 0).toFixed(2);

async function loadBalances() {
  const el = document.getElementById("balances-list");
  const year = new Date().getFullYear();
  try {
    const { data, error } = await supabase
      .from("leave_balances")
      .select("entitled, used, pending, leave_types(name, accrual_frequency, default_entitlement)")
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
                const available = (b.entitled || 0) - (b.used || 0) - (b.pending || 0);
                const total = b.leave_types?.default_entitlement ?? b.entitled;
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

  backdrop.querySelector("#fl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#fl-submit");
    const startDate = backdrop.querySelector("#fl-start").value;
    const endDate = backdrop.querySelector("#fl-end").value;
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
      });
      if (error) throw error;

      await logAudit({ action: "leave.filed", recordType: "leave_request", recordId: null });
      close();
      showToast("Leave request submitted.", "success");
      loadMyRequests();
      loadBalances();
    } catch (err) {
      console.error(err);
      showToast(err.message && !err.code ? err.message : friendlyError(err, "Unable to submit your leave request. Please try again."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit request";
    }
  });
}

// -----------------------------------------------------------------
// My requests — approvals now happen from Notifications
// -----------------------------------------------------------------
async function loadMyRequests() {
  const el = document.getElementById("my-requests");
  try {
    const { data, error } = await supabase
      .from("leave_requests")
      .select("id, start_date, end_date, reason, status, reviewer_remarks, leave_types(name)")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No leave applications yet</h3><p>Requests you file will show up here with their approval status.</p></div>`;
      return;
    }

    el.innerHTML = data
      .map(
        (r) => `
        <div class="list-row">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(r.leave_types?.name || "Leave")} · ${formatDate(r.start_date)} – ${formatDate(r.end_date)}</div>
            <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.reason)}</div>
            ${r.reviewer_remarks ? `<div class="text-muted" style="font-size:0.8rem;margin-top:2px;">Remarks: ${escapeHtml(r.reviewer_remarks)}</div>` : ""}
          </div>
          <span class="tag tag-${r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending"}">${escapeHtml(r.status)}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Unable to load your requests</h3></div>`;
    showToast("Unable to load your leave requests.", "error");
  }
}

// -----------------------------------------------------------------
// Admin: leave requests from all staff
// -----------------------------------------------------------------
async function fetchAdminRequests(limit) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("id, profile_id, start_date, end_date, reason, status, created_at, leave_types(name)")
    .order("created_at", { ascending: false })
    .limit(limit);
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

function adminRequestRows(rows) {
  return rows
    .map(
      (r) => `
      <div class="list-row" style="cursor:pointer;" data-req="${r.id}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(r.full_name)} · ${escapeHtml(r.leave_types?.name || "Leave")}</div>
          <div class="text-muted" style="font-size:0.85rem;">${formatDate(r.start_date)} – ${formatDate(r.end_date)}</div>
          <div class="text-muted" style="font-size:0.8rem;">${escapeHtml(r.reason)}</div>
        </div>
        <span class="tag tag-${r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending"}">${escapeHtml(r.status)}</span>
      </div>`
    )
    .join("");
}

async function loadAdminRequests() {
  const el = document.getElementById("admin-requests-list");
  try {
    const rows = await fetchAdminRequests(5);
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No leave requests yet</h3><p>Requests filed by staff will show up here.</p></div>`;
      return;
    }
    el.innerHTML = adminRequestRows(rows);
    el.querySelectorAll("[data-req]").forEach((row) => {
      row.addEventListener("click", () => openReviewDialog(row.getAttribute("data-req"), loadAdminRequests));
    });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Unable to load leave requests</h3></div>`;
    showToast("Unable to load leave requests.", "error");
  }
}

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
      bodyEl.innerHTML = rows.length ? adminRequestRows(rows) : `<div class="text-muted" style="padding:8px 0;">No leave requests yet.</div>`;
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
      <h3 id="lv-title">Leave request</h3>
      <div id="lv-body"><div class="skeleton" style="height:60px;"></div></div>
    </div>`);

  const bodyEl = backdrop.querySelector("#lv-body");
  try {
    const { data, error } = await supabase.rpc("get_leave_request", { p_id: requestId }).single();
    if (error) throw error;
    if (!data) throw new Error("not found");

    const isPending = data.status === "pending";
    const days = Math.round((new Date(data.end_date) - new Date(data.start_date)) / 86400000) + 1;
    bodyEl.innerHTML = `
      <p><strong>${escapeHtml(data.full_name)}</strong> · ${escapeHtml(data.leave_type_name)}</p>
      <p>${formatDate(data.start_date)} – ${formatDate(data.end_date)} (${days} day${days === 1 ? "" : "s"})</p>
      <p><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>
      ${
        !isPending
          ? `<p><span class="tag tag-${data.status === "approved" ? "approved" : "rejected"}">${escapeHtml(data.status)}</span>${
              data.reviewer_remarks ? ` <span class="text-muted">${escapeHtml(data.reviewer_remarks)}</span>` : ""
            }</p>`
          : ""
      }
      ${
        isPending
          ? `<div class="field">
              <label for="lv-remarks">Remarks (optional)</label>
              <textarea id="lv-remarks" rows="2"></textarea>
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
              <button type="button" class="btn" style="background:var(--error);border-color:var(--error);color:#fff;" data-act="reject">Reject</button>
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
