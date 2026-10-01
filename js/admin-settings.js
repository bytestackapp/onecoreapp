import { mountLayout } from "./layout.js";
import { supabase, timeAgo, friendlyError, getCurrentProfile, logAudit } from "./supabase-client.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "admin-settings", pageTitle: "Settings", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

const nameInput = document.getElementById("org-name");
const viewActions = document.getElementById("org-name-view-actions");
const editActions = document.getElementById("org-name-edit-actions");
let originalName = profile.organizations?.name || "";
nameInput.value = originalName;

function enterEditMode() {
  nameInput.disabled = false;
  nameInput.focus();
  viewActions.style.display = "none";
  editActions.style.display = "flex";
}
function exitEditMode() {
  nameInput.disabled = true;
  viewActions.style.display = "flex";
  editActions.style.display = "none";
}

document.getElementById("org-edit-btn").addEventListener("click", enterEditMode);
document.getElementById("org-cancel-btn").addEventListener("click", () => {
  nameInput.value = originalName;
  exitEditMode();
});

document.getElementById("org-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { error } = await supabase
      .from("organizations")
      .update({ name: nameInput.value.trim(), updated_at: new Date().toISOString() })
      .eq("id", profile.organization_id);
    if (error) throw error;
    await getCurrentProfile({ force: true });
    originalName = nameInput.value.trim();
    exitEditMode();
    showToast("Organization updated.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to save changes. Please try again."), "error");
  }
});

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I, avoids ambiguity
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function loadInviteCode() {
  const codeInput = document.getElementById("invite-code");
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("invite_code")
      .eq("id", profile.organization_id)
      .single();
    if (error) throw error;
    codeInput.value = data.invite_code || "";
  } catch (err) {
    console.error(err);
    codeInput.value = "";
	showToast("Unable to load the invite code.", "error");
  }
}
loadInviteCode();

document.getElementById("copy-code-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("invite-code").value);
    showToast("Invite code copied.", "success");
  } catch (err) {
    console.error(err);
    showToast("Unable to copy. Please copy it manually.", "error");
  }
});

document.getElementById("regenerate-code-btn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Regenerate invite code?",
    message: "The current code will stop working immediately. Anyone who hasn't signed up yet will need the new one.",
    confirmLabel: "Regenerate",
    danger: true,
  });
  if (!ok) return;

  const newCode = generateInviteCode();
  try {
    const { error } = await supabase
      .from("organizations")
      .update({ invite_code: newCode, updated_at: new Date().toISOString() })
      .eq("id", profile.organization_id);
    if (error) throw error;
    document.getElementById("invite-code").value = newCode;
    showToast("Invite code regenerated.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to regenerate the invite code."), "error");
  }
});

async function fetchAudit(limit) {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("action, record_type, details, created_at, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

function auditRows(data) {
  return data
    .map(
      (a) => `<div class="list-row">
        <div style="flex:1;min-width:0;"><strong>${escapeHtml(a.profiles?.full_name || "System")}</strong> ${escapeHtml(describeAction(a.action, a.details))}</div>
        <div class="text-muted" style="font-size:0.8rem;white-space:nowrap;">${timeAgo(a.created_at)}</div>
      </div>`
    )
    .join("");
}

// Modal layout: line 1 = user + time, line 2 = what they did.
function auditModalRows(data) {
  return data
    .map((a) => {
      const text = capitalize(describeAction(a.action, a.details).replace(/^[\s\-—–]+/, ""));
      return `<div class="list-row" style="flex-direction:column;align-items:stretch;gap:2px;">
        <div style="display:flex;justify-content:space-between;gap:10px;">
          <strong>${escapeHtml(a.profiles?.full_name || "System")}</strong>
          <span class="text-muted" style="font-size:0.8rem;white-space:nowrap;">${timeAgo(a.created_at)}</span>
        </div>
        <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(text)}</div>
      </div>`;
    })
    .join("");
}

async function loadAudit() {
  const el = document.getElementById("audit-list");
  try {
    const data = await fetchAudit(10);
    if (data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No activity recorded yet</h3></div>`;
      return;
    }
    el.innerHTML = auditRows(data);
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Activity couldn't be loaded</h3></div>`;
    showToast("Activity log couldn't be loaded.", "error");
  }
}

async function openAuditDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="audit-title">
      <h3 id="audit-title">Recent activity</h3>
      <div class="aud-body" id="audit-modal-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  const bodyEl = backdrop.querySelector("#audit-modal-body");
  try {
    const data = await fetchAudit(100);
    bodyEl.innerHTML = data.length ? auditModalRows(data) : `<div class="text-muted" style="padding:8px 0;">No activity recorded yet.</div>`;
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">Activity couldn't be loaded.</div>`;
  }
}
document.getElementById("view-audit-btn").addEventListener("click", openAuditDialog);

document.getElementById("clear-audit-btn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Clear all activity?",
    message: "This permanently deletes the entire activity log. It can't be undone.",
    confirmLabel: "Clear",
    danger: true,
  });
  if (!ok) return;
  try {
    const { data, error } = await supabase.from("audit_logs").delete().gte("created_at", "1970-01-01").select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      showToast("Nothing was cleared. You may not have permission to delete the activity log.", "error");
      return;
    }
    showToast("Activity cleared.", "success");
    loadAudit();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to clear the activity log."), "error");
  }
});

const ACTION_LABELS = {
  "user.approved": "- approved a user",
  "user.rejected": "- rejected a sign-up request",
  "user.deleted": "- deleted a user",
  "user.deactivated": "- deactivated a user",
  "user.activated": "- reactivated a user",
  "user.role_changed": "- changed a user's role",
  "announcement.created": "- published an announcement",
  "announcement.updated": "- edited an announcement",
  "announcement.deleted": "- deleted an announcement",
  "attendance.marked_present": " - marked a student present",
  "group.created": "- created a group",
  "group.head_assigned": "- assigned a group head" ,
  "user.guardian_linked": "- linked a parent to a student",
  "attendance.correction_approved": "- approved an attendance correction",
  "attendance.correction_rejected": "- rejected an attendance correction",
  "event.created": "- created an event",
  "leave_type.created": "- added a leave type",
  "leave_type.updated": "- edited a leave type",
  "leave_type.deactivated": "- deactivated a leave type",
  "leave_type.activated": "- reactivated a leave type",
  "leave_type.deleted": "- deleted a leave type",
  "device.deleted": "- deleted a scanner device",
  "user.leave_type_assigned": "- leave type assigned to staff",
  "leave.filed": "- filed a leave request",
  "leave.approved": "- approved a leave request",
  "leave.rejected": "- rejected a leave request",
};

function capitalize(s = "") {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Turns a raw action code into a readable phrase. Unknown actions fall back
// to a cleaned-up version of the code, e.g. "announcement.created" -> "— announcement created".
function describeAction(action = "", details) {
  const known = ACTION_LABELS[action];
  if (typeof known === "function") return known(details);
  if (known) return known;
  return `— ${action.replace(/[._]+/g, " ").trim()}`;
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Leave types ----------
let leaveTypesCache = [];

function carryOverText(t) {
  if (t.carry_over_mode === "all") return "Carried over all unused days";
  if (t.carry_over_mode === "capped") return `Carried over up to ${+Number(t.carry_over_max || 0).toFixed(2)} days`;
  return "No carry over";
}

function leaveTypeDialog(existing) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lt-dialog-title">
      <h3 id="lt-dialog-title">${existing ? "Edit leave type" : "New leave type"}</h3>
      <form id="lt-form">
        <div class="field">
          <label for="lt-name">Name</label>
          <input id="lt-name" required placeholder="e.g. Vacation Leave" value="${existing ? escapeHtml(existing.name) : ""}" />
        </div>
        <div class="field">
          <label for="lt-entitlement">Days per year</label>
          <input id="lt-entitlement" type="number" min="0" step="0.25" value="${existing ? existing.default_entitlement : 0}" required />
        </div>
        <div class="field">
          <label for="lt-frequency">How it's earned</label>
          <select id="lt-frequency">
            <option value="yearly" ${existing?.accrual_frequency !== "monthly" ? "selected" : ""}>All at once, every January</option>
            <option value="monthly" ${existing?.accrual_frequency === "monthly" ? "selected" : ""}>Earned monthly (days ÷ 12 per month)</option>
          </select>
        </div>
        <div class="field">
          <label for="lt-carry">Unused days at year end</label>
          <select id="lt-carry">
            <option value="none" ${(existing?.carry_over_mode || "none") === "none" ? "selected" : ""}>Don't carry over</option>
            <option value="capped" ${existing?.carry_over_mode === "capped" ? "selected" : ""}>Carry over up to a maximum</option>
            <option value="all" ${existing?.carry_over_mode === "all" ? "selected" : ""}>Carry over all unused days</option>
          </select>
          <div class="field-hint">Applied automatically every January 1.</div>
        </div>
        <div class="field" id="lt-carry-max-field" style="display:none;">
          <label for="lt-carry-max">Maximum days to carry over</label>
          <input id="lt-carry-max" type="number" min="0" step="0.25" value="${existing?.carry_over_max ?? ""}" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="lt-submit">${existing ? "Save changes" : "Add type"}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#lt-name").focus();

  const carrySelect = backdrop.querySelector("#lt-carry");
  const carryMaxField = backdrop.querySelector("#lt-carry-max-field");
  const carryMaxInput = backdrop.querySelector("#lt-carry-max");
  function syncCarryMax() {
    const capped = carrySelect.value === "capped";
    carryMaxField.style.display = capped ? "block" : "none";
    carryMaxInput.required = capped;
  }
  carrySelect.addEventListener("change", syncCarryMax);
  syncCarryMax();

  backdrop.querySelector("#lt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#lt-submit");
    submitBtn.disabled = true;
    const fields = {
      name: backdrop.querySelector("#lt-name").value.trim(),
      default_entitlement: parseFloat(backdrop.querySelector("#lt-entitlement").value || "0"),
      accrual_frequency: backdrop.querySelector("#lt-frequency").value,
      carry_over_mode: carrySelect.value,
      carry_over_max: carrySelect.value === "capped" ? parseFloat(carryMaxInput.value || "0") : null,
    };
    try {
      if (existing) {
        const { error } = await supabase.from("leave_types").update(fields).eq("id", existing.id);
        if (error) throw error;
        await logAudit({ action: "leave_type.updated", recordType: "leave_type", recordId: existing.id, details: { name: fields.name } });
        showToast("Leave type updated.", "success");
      } else {
        const { data, error } = await supabase
          .from("leave_types")
          .insert({ organization_id: profile.organization_id, ...fields })
          .select()
          .single();
        if (error) throw error;
        await logAudit({ action: "leave_type.created", recordType: "leave_type", recordId: data.id, details: { name: fields.name } });
        showToast("Leave type added.", "success");
      }
      close();
      loadLeaveTypesAdmin();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to save this leave type."), "error");
      submitBtn.disabled = false;
    }
  });
}

async function deleteLeaveType(id, name) {
  const ok = await confirmDialog({
    title: `Delete "${name}"?`,
    message: "This removes the leave type and unassigns it from any staff who have it. It can't be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    // Leave types that already have requests filed under them are kept for record-keeping.
    const { count, error: cErr } = await supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("leave_type_id", id);
    if (cErr) throw cErr;
    if (count > 0) {
      showToast("This leave type already has leave requests filed under it and can't be deleted.", "error");
      return;
    }
    const { error: bErr } = await supabase.from("leave_balances").delete().eq("leave_type_id", id);
    if (bErr) throw bErr;
    const { error } = await supabase.from("leave_types").delete().eq("id", id);
    if (error) throw error;
    await logAudit({ action: "leave_type.deleted", recordType: "leave_type", recordId: id, details: { name } });
    showToast("Leave type deleted.", "success");
    loadLeaveTypesAdmin();
    loadAudit();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to delete this leave type."), "error");
  }
}

async function loadLeaveTypesAdmin() {
  const el = document.getElementById("leave-types-list");
  try {
    const { data, error } = await supabase.from("leave_types").select("*").order("is_active", { ascending: false }).order("name");
    if (error) throw error;
    leaveTypesCache = data || [];

    if (leaveTypesCache.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No leave types yet</h3><p>Add one, e.g. Vacation Leave, 15 days a year.</p></div>`;
      return;
    }

    el.innerHTML = leaveTypesCache
      .map(
        (t) => `
      <div class="list-row ${t.is_active ? "" : "is-inactive"}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(t.name)}${t.is_active ? "" : ' <span class="text-muted">(deactivated)</span>'}</div>
          <div class="text-muted" style="font-size:0.82rem;">${t.default_entitlement} days/year${t.accrual_frequency === "monthly" ? " · earned monthly" : " · earned annually"}</div>
          <div class="text-muted" style="font-size:0.82rem;">${carryOverText(t)}</div>
        </div>
        <button type="button" class="icon-action sm edit-lt-btn" data-id="${t.id}" title="Edit" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        <button type="button" class="icon-action sm danger delete-lt-btn" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      </div>`
      )
      .join("");

    el.querySelectorAll(".edit-lt-btn").forEach((btn) => {
      btn.addEventListener("click", () => leaveTypeDialog(leaveTypesCache.find((t) => t.id === btn.getAttribute("data-id"))));
    });
    el.querySelectorAll(".delete-lt-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteLeaveType(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Leave types couldn't be loaded</h3></div>`;
    showToast("Leave types couldn't be loaded.", "error");
  }
}

document.getElementById("new-leave-type-btn").addEventListener("click", () => leaveTypeDialog(null));
loadLeaveTypesAdmin();

// ---------- Scanner devices ----------
let devicesCache = [];

function newDeviceDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="dev-title">
      <h3 id="dev-title">New scanner device</h3>
      <form id="dev-form">
        <div class="field">
          <label for="dev-name">Name</label>
          <input id="dev-name" required placeholder="e.g. Main Gate, Grade 3 room" />
        </div>
        <div class="field">
          <label for="dev-passcode">Scanner passcode</label>
          <input id="dev-passcode" type="text" required minlength="4" placeholder="4+ digits or characters" />
          <div class="field-hint">Whoever sets up this device will need this, along with its device code, to activate it.</div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="dev-submit">Create</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#dev-name").focus();

  backdrop.querySelector("#dev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#dev-submit");
    submitBtn.disabled = true;
    try {
      const { data, error } = await supabase.rpc("create_scanner_device", {
        p_name: backdrop.querySelector("#dev-name").value.trim(),
        p_passcode: backdrop.querySelector("#dev-passcode").value,
      });
      if (error) throw error;
      const created = data?.[0];
      close();
      showCredentialsDialog(created.name, created.device_code, backdrop.querySelector("#dev-passcode")?.value);
      loadDevices();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to create this device."), "error");
      submitBtn.disabled = false;
    }
  });
}

function showCredentialsDialog(name, deviceCode, passcode) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="tok-title">
      <h3 id="tok-title">${escapeHtml(name)}</h3>
      <p>Enter these details in “Scanner Mode” to activate the device. The device code is shown only once. If lost, revoke the device and create a new one. The passcode is the one you just entered.</p>
      <div class="field">
        <label>Device code</label>
        <input readonly value="${escapeHtml(deviceCode)}" onclick="this.select()" style="font-size:1.1rem;letter-spacing:0.1em;text-align:left;" />
      </div>
      <div class="field">
        <label>Passcode</label>
        <input readonly value="${escapeHtml(passcode || "")}" onclick="this.select()" />
      </div>
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Done</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-act="close"]').addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
}

async function revokeDevice(id, name) {
  const ok = await confirmDialog({
    title: `Revoke "${name}"?`,
    message: "This device will no longer be able to record scans.",
    confirmLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await supabase.from("scanner_devices").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    showToast("Device revoked.", "success");
    loadDevices();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to revoke this device."), "error");
  }
}

async function deleteDevice(id, name) {
  const ok = await confirmDialog({
    title: `Delete "${name}"?`,
    message: "This permanently removes the device. It will no longer be able to record scans. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await supabase.from("scanner_devices").delete().eq("id", id);
    if (error) throw error;
    await logAudit({ action: "device.deleted", recordType: "scanner_device", recordId: id, details: { name } });
    showToast("Device deleted.", "success");
    loadDevices();
    loadAudit();
  } catch (err) {
    console.error(err);
    if (err?.code === "23503") {
      showToast("This device has recorded scans and can't be deleted. Revoke it instead.", "error");
    } else {
      showToast(friendlyError(err, "Unable to delete this device."), "error");
    }
  }
}

async function loadDevices() {
  const el = document.getElementById("devices-list");
  try {
    const { data, error } = await supabase.from("scanner_devices").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    devicesCache = data || [];

    if (devicesCache.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No devices yet</h3><p>Add the gate scanner or classroom devices here.</p></div>`;
      return;
    }

    el.innerHTML = devicesCache
      .map(
        (d) => `
      <div class="list-row ${d.revoked_at ? "is-inactive" : ""}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(d.name)}${d.revoked_at ? ' <span class="text-muted">(revoked)</span>' : ""}</div>
          <div class="text-muted" style="font-size:0.8rem;">${d.last_seen_at ? "Last seen " + timeAgo(d.last_seen_at) : "Never used"}</div>
        </div>
        ${
          d.revoked_at
            ? ""
            : `<button type="button" class="icon-action sm revoke-device-btn" data-id="${d.id}" data-name="${escapeHtml(d.name)}" title="Revoke" aria-label="Revoke"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></button>`
        }
        <button type="button" class="icon-action sm danger delete-device-btn" data-id="${d.id}" data-name="${escapeHtml(d.name)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      </div>`
      )
      .join("");

    el.querySelectorAll(".delete-device-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteDevice(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
    el.querySelectorAll(".revoke-device-btn").forEach((btn) => {
      btn.addEventListener("click", () => revokeDevice(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Devices couldn't be loaded</h3></div>`;
    showToast("Devices couldn't be loaded.", "error");
  }
}

document.getElementById("new-device-btn").addEventListener("click", newDeviceDialog);
loadDevices();

// ---------- QR refresh ----------
document.getElementById("refresh-qr-btn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Refresh all QR codes?",
    message: "Every active person's current code stops working immediately and a new one is issued. This can't be undone.",
    confirmLabel: "Refresh",
    danger: true,
  });
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc("refresh_qr_tokens");
    if (error) throw error;
    showToast(`${data} QR code${data === 1 ? "" : "s"} refreshed.`, "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to refresh QR codes."), "error");
  }
});

// ---------- Print QR codes ----------
const ROLE_LABELS = { admin: "Admins", teacher: "Teachers", student: "Students", parent: "Parents", guest: "Guests" };

function printQrDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="pq-title">
      <h3 id="pq-title">Print QR codes</h3>
      <div class="field">
        <label for="pq-scope">Who</label>
        <select id="pq-scope">
          <option value="all">Everyone active</option>
          <option value="role">By role</option>
          <option value="group">By group</option>
          <option value="people">Specific people</option>
        </select>
      </div>
      <div id="pq-detail"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="pq-go">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);

  const scopeSelect = backdrop.querySelector("#pq-scope");
  const detailEl = backdrop.querySelector("#pq-detail");
  let groupsCache = null;
  let peopleCache = null;
  const selectedPeople = new Set();

  async function renderDetail() {
    const scope = scopeSelect.value;
    if (scope === "role") {
      detailEl.innerHTML = `
        <div class="field">
          <label for="pq-role">Role</label>
          <select id="pq-role">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        </div>`;
    } else if (scope === "group") {
      if (!groupsCache) {
        const { data } = await supabase.from("groups").select("id, name").order("name");
        groupsCache = data || [];
      }
      detailEl.innerHTML = groupsCache.length
        ? `<div class="field">
            <label for="pq-group">Group</label>
            <select id="pq-group">${groupsCache.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>
          </div>`
        : `<p class="text-muted">No groups yet.</p>`;
    } else if (scope === "people") {
      if (!peopleCache) {
        const { data } = await supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name");
        peopleCache = data || [];
      }
      detailEl.innerHTML = `
        <div class="field aud-search"><input type="search" id="pq-search" placeholder="Search by name…" autocomplete="off" /></div>
        <div class="aud-list" id="pq-people" style="max-height:220px;"></div>
        <p class="text-muted" style="font-size:0.8rem;margin-top:4px;">${selectedPeople.size} selected</p>`;
      renderPeopleList("");
      detailEl.querySelector("#pq-search").addEventListener("input", (e) => renderPeopleList(e.target.value));
    } else {
      detailEl.innerHTML = "";
    }
  }

  function renderPeopleList(term) {
    const listEl = detailEl.querySelector("#pq-people");
    const q = term.trim().toLowerCase();
    const matches = peopleCache.filter((p) => !q || p.full_name.toLowerCase().includes(q)).slice(0, 100);
    listEl.innerHTML = matches
      .map(
        (p) => `<label class="aud-row"><input type="checkbox" value="${p.id}" ${selectedPeople.has(p.id) ? "checked" : ""} /><span>${escapeHtml(p.full_name)}</span><span class="aud-meta">${escapeHtml(p.role)}</span></label>`
      )
      .join("");
    listEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedPeople.add(cb.value);
        else selectedPeople.delete(cb.value);
        detailEl.querySelector("p.text-muted").textContent = `${selectedPeople.size} selected`;
      });
    });
  }

  scopeSelect.addEventListener("change", renderDetail);
  renderDetail();

  backdrop.querySelector("#pq-go").addEventListener("click", () => {
    const scope = scopeSelect.value;
    if (scope === "all") {
      window.open("print-qr.html?scope=all", "_blank");
      close();
    } else if (scope === "role") {
      const role = detailEl.querySelector("#pq-role").value;
      window.open(`print-qr.html?scope=role&role=${encodeURIComponent(role)}`, "_blank");
      close();
    } else if (scope === "group") {
      const groupId = detailEl.querySelector("#pq-group")?.value;
      if (!groupId) {
        showToast("No group available.", "error");
        return;
      }
      window.open(`print-qr.html?scope=group&id=${encodeURIComponent(groupId)}`, "_blank");
      close();
    } else if (scope === "people") {
      if (selectedPeople.size === 0) {
        showToast("Select at least one person.", "error");
        return;
      }
      sessionStorage.setItem("onecore_print_qr_ids", JSON.stringify([...selectedPeople]));
      window.open("print-qr.html?scope=people", "_blank");
      close();
    }
  });
}

document.getElementById("print-qr-btn").addEventListener("click", printQrDialog);

loadAudit();
