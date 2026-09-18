import { mountLayout } from "./layout.js";
import { supabase, initials, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "admin-users", pageTitle: "Users", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("users-list");
const ROLES = ["admin", "teacher", "student", "parent"];

async function load() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active")
      .order("full_name");
    if (error) throw error;

    if (!data || data.length === 0) {
      listEl.innerHTML = `<div class="card empty-state"><h3>No users yet</h3></div>`;
      return;
    }

    listEl.innerHTML = `<div class="card">${data
      .map(
        (u) => `
      <div class="list-row" data-id="${u.id}">
        <div class="avatar">${initials(u.full_name)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(u.full_name)}${u.id === profile.id ? " (you)" : ""}</div>
          <div class="text-muted" style="font-size:0.82rem;">${escapeHtml(u.email)}</div>
        </div>
        <select class="role-select" data-id="${u.id}" ${u.id === profile.id ? "disabled" : ""}>
          ${ROLES.map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`).join("")}
        </select>
        <button class="btn btn-sm ${u.is_active ? "btn-secondary" : "btn-primary"} toggle-active-btn" data-id="${u.id}" data-active="${u.is_active}" ${u.id === profile.id ? "disabled" : ""}>
          ${u.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>`
      )
      .join("")}</div>`;

    listEl.querySelectorAll(".role-select").forEach((sel) => {
      sel.addEventListener("change", () => updateRole(sel.getAttribute("data-id"), sel.value));
    });
    listEl.querySelectorAll(".toggle-active-btn").forEach((btn) => {
      btn.addEventListener("click", () => toggleActive(btn.getAttribute("data-id"), btn.getAttribute("data-active") === "true"));
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">Users couldn't be loaded. Please refresh the page.</div>`;
  }
}

async function updateRole(id, role) {
  try {
    const { error } = await supabase.from("profiles").update({ role, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    await logAudit({ action: "user.role_changed", recordType: "profile", recordId: id, details: { role } });
    showToast("Role updated.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to update this user's role."), "error");
    load();
  }
}

async function toggleActive(id, currentlyActive) {
  if (currentlyActive) {
    const ok = await confirmDialog({
      title: "Deactivate this user?",
      message: "They won't be able to sign in until an admin reactivates their account.",
      confirmLabel: "Deactivate",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const { error } = await supabase.from("profiles").update({ is_active: !currentlyActive, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    await logAudit({ action: currentlyActive ? "user.deactivated" : "user.activated", recordType: "profile", recordId: id });
    showToast(currentlyActive ? "User deactivated." : "User activated.", "success");
    load();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to update this user."), "error");
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

load();
