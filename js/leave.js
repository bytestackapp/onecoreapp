import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "leave", pageTitle: "Leave", allowedRoles: ["admin", "teacher"] });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
let leaveTypes = [];

await loadLeaveTypes();
loadBalances();
loadMyRequests();

if (isAdmin) {
  document.getElementById("admin-section").style.display = "block";
  loadPending();
  renderLeaveTypesAdmin();
  document.getElementById("leave-type-form").addEventListener("submit", createLeaveType);
}

document.getElementById("leave-form").addEventListener("submit", fileLeave);

async function loadLeaveTypes() {
  const { data, error } = await supabase.from("leave_types").select("*").eq("is_active", true).order("name");
  if (error) {
    console.error(error);
    return;
  }
  leaveTypes = data || [];
  const select = document.getElementById("leave-type");
  select.innerHTML = leaveTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("") || `<option disabled>No leave types configured</option>`;
}

async function loadBalances() {
  const el = document.getElementById("balances-list");
  const year = new Date().getFullYear();
  try {
    const { data, error } = await supabase
      .from("leave_balances")
      .select("entitled, used, pending, leave_types(name)")
      .eq("profile_id", profile.id)
      .eq("period_year", year);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = `<div class="card empty-state" style="grid-column:1/-1;"><h3>No leave balance set up yet</h3><p>Ask your administrator to configure your leave balances for this year.</p></div>`;
      return;
    }

    el.innerHTML = data
      .map((b) => {
        const available = (b.entitled || 0) - (b.used || 0) - (b.pending || 0);
        return `<div class="card">
          <div style="font-weight:600;">${escapeHtml(b.leave_types?.name || "Leave")}</div>
          <div class="stat-value" style="margin-top:6px;">${available}</div>
          <div class="stat-label">available (of ${b.entitled} entitled, ${b.used} used, ${b.pending} pending)</div>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error" style="grid-column:1/-1;">Unable to load your leave balance.</div>`;
  }
}

async function fileLeave(e) {
  e.preventDefault();
  const errorEl = document.getElementById("file-error");
  const submitBtn = document.getElementById("file-submit");
  errorEl.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const startDate = document.getElementById("start-date").value;
    const endDate = document.getElementById("end-date").value;
    if (new Date(endDate) < new Date(startDate)) {
      throw new Error("End date can't be before the start date.");
    }

    const { data, error } = await supabase
      .from("leave_requests")
      .insert({
        organization_id: profile.organization_id,
        profile_id: profile.id,
        leave_type_id: document.getElementById("leave-type").value,
        start_date: startDate,
        end_date: endDate,
        reason: document.getElementById("reason").value.trim(),
        status: "pending",
      })
      .select()
      .single();
    if (error) throw error;

    await logAudit({ action: "leave.filed", recordType: "leave_request", recordId: data.id });
    document.getElementById("leave-form").reset();
    showToast("Leave request submitted.", "success");
    loadMyRequests();
    loadBalances();
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message && !err.code ? err.message : friendlyError(err, "Unable to submit your leave request. Please try again.");
    errorEl.style.display = "flex";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit request";
  }
}

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
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(r.leave_types?.name || "Leave")} · ${formatDate(r.start_date)} – ${formatDate(r.end_date)}</div>
            <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.reason)}</div>
            ${r.reviewer_remarks ? `<div class="text-muted" style="font-size:0.8rem;margin-top:2px;">Remarks: ${escapeHtml(r.reviewer_remarks)}</div>` : ""}
          </div>
          <span class="tag tag-${r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending"}">${r.status}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Unable to load your requests.</div>`;
  }
}

// -------------------- Admin: approvals --------------------
async function loadPending() {
  const el = document.getElementById("pending-list");
  try {
    const { data, error } = await supabase
      .from("leave_requests")
      .select("id, start_date, end_date, reason, profiles(full_name), leave_types(name)")
      .eq("organization_id", profile.organization_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>Nothing pending</h3><p>All leave requests have been reviewed.</p></div>`;
      return;
    }

    el.innerHTML = data
      .map(
        (r) => `
        <div class="list-row" data-id="${r.id}">
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(r.profiles?.full_name || "Unknown")} · ${escapeHtml(r.leave_types?.name || "Leave")}</div>
            <div class="text-muted" style="font-size:0.85rem;">${formatDate(r.start_date)} – ${formatDate(r.end_date)}</div>
            <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(r.reason)}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm btn-primary approve-btn" data-id="${r.id}">Approve</button>
            <button class="btn btn-sm btn-danger reject-btn" data-id="${r.id}">Reject</button>
          </div>
        </div>`
      )
      .join("");

    el.querySelectorAll(".approve-btn").forEach((btn) => btn.addEventListener("click", () => reviewRequest(btn.getAttribute("data-id"), "approved")));
    el.querySelectorAll(".reject-btn").forEach((btn) => btn.addEventListener("click", () => reviewRequest(btn.getAttribute("data-id"), "rejected")));
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Unable to load pending requests.</div>`;
  }
}

async function reviewRequest(id, status) {
  const ok = await confirmDialog({
    title: status === "approved" ? "Approve this leave request?" : "Reject this leave request?",
    message: status === "approved" ? "The employee's leave balance will be updated." : "The employee will be notified that this request was rejected.",
    confirmLabel: status === "approved" ? "Approve" : "Reject",
    danger: status === "rejected",
  });
  if (!ok) return;

  try {
    const { error } = await supabase
      .from("leave_requests")
      .update({ status, reviewed_by: profile.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    await logAudit({ action: `leave.${status}`, recordType: "leave_request", recordId: id });
    showToast(status === "approved" ? "Request approved." : "Request rejected.", "success");
    loadPending();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to update this request. Please try again."), "error");
  }
}

// -------------------- Admin: leave types --------------------
function renderLeaveTypesAdmin() {
  const el = document.getElementById("leave-types-list");
  if (leaveTypes.length === 0) {
    el.innerHTML = `<p class="text-muted">No leave types yet — add one below.</p>`;
    return;
  }
  el.innerHTML = leaveTypes.map((t) => `<span class="tag tag-normal" style="margin:0 6px 6px 0;">${escapeHtml(t.name)} · ${t.default_entitlement} days</span>`).join("");
}

async function createLeaveType(e) {
  e.preventDefault();
  try {
    const { error } = await supabase.from("leave_types").insert({
      organization_id: profile.organization_id,
      name: document.getElementById("lt-name").value.trim(),
      default_entitlement: parseFloat(document.getElementById("lt-entitlement").value || "0"),
    });
    if (error) throw error;
    document.getElementById("leave-type-form").reset();
    await loadLeaveTypes();
    renderLeaveTypesAdmin();
    showToast("Leave type added.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to add this leave type."), "error");
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
