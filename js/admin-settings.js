import { mountLayout } from "./layout.js";
import { supabase, timeAgo, friendlyError, getCurrentProfile, logAudit } from "./supabase-client.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./toast.js";
import { currentPlatform, isStandalone } from "./version.js";
import { yearPH, dateTimePH } from "./time.js";

const profile = await mountLayout({ activeKey: "admin-settings", pageTitle: "Settings", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

// Every call on this page must use the academy the database says I'm in. A saved profile that went stale
// (academy switched in another tab or device) makes the invite code and archive calls fail, so refresh it once.
const freshProfile = await getCurrentProfile({ force: true }).catch(() => null);
if (freshProfile && freshProfile.organization_id !== profile.organization_id && !sessionStorage.getItem("onecore:settings-refreshed")) {
  sessionStorage.setItem("onecore:settings-refreshed", "1");
  location.reload();
  throw new Error("refreshing");
}
sessionStorage.removeItem("onecore:settings-refreshed");

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
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
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

// ---------- Invite QR ----------
// Public address of the login page. Required because inside the Android app the
// page address is local to the phone. Example: "https://yourdomain.com/pages/login.html"
// On the web version this can stay empty (it uses the current site).
const PUBLIC_LOGIN_URL = "https://onecoreapp.vercel.app/pages/login.html";

function inviteLink(code) {
  let base = PUBLIC_LOGIN_URL;
  if (!base && /^https?:$/.test(location.protocol) && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    base = new URL("login.html", location.href).href;
  }
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("invite", code);
  return u.href;
}

function inviteQrDialog() {
  const canDownload = currentPlatform() === "web" && !isStandalone();
  const code = document.getElementById("invite-code").value.trim();
  if (!code) {
    showToast("There's no invite code to show yet.", "error");
    return;
  }
  if (!window.QRCode) {
    showToast("The QR generator didn't load. Please refresh the page.", "error");
    return;
  }
  const link = inviteLink(code);
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="iq-title" style="text-align:center;">
      <h3 id="iq-title">Invite QR code</h3>
      <p class="text-muted" style="font-size:0.85rem;">${
        link
          ? "Scan with a phone camera to open sign-up with the code filled in."
          : "Scan with the Scan QR button on the sign-up form."
      }</p>
      <div id="iq-box" style="display:inline-block;background:#fff;padding:14px;border-radius:12px;border:1px solid var(--border);"></div>
      <div style="margin-top:10px;font-weight:700;letter-spacing:0.12em;">${escapeHtml(code)}</div>
      ${
        link
          ? ""
          : `<div class="banner banner-info" style="margin-top:12px;text-align:left;">Set PUBLIC_LOGIN_URL in admin-settings.js so this QR also opens the sign-up page from a phone camera.</div>`
      }
      <div class="dialog-actions">
        ${canDownload ? `<button type="button" class="btn btn-secondary" data-act="download">Download PNG</button>` : ""}
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape" && backdrop === [...document.querySelectorAll(".dialog-backdrop")].pop()) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  const box = backdrop.querySelector("#iq-box");
  new QRCode(box, { text: link || code, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });

  backdrop.querySelector('[data-act="download"]')?.addEventListener("click", () => {
    const src = box.querySelector("canvas");
    if (!src) {
      showToast("Unable to download. Take a screenshot instead.", "error");
      return;
    }
    const pad = 24;
    const c = document.createElement("canvas");
    c.width = src.width + pad * 2;
    c.height = src.height + pad * 2;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, pad, pad);
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = "invite-qr.png";
    a.click();
  });
}
document.getElementById("show-invite-qr-btn").addEventListener("click", inviteQrDialog);

async function fetchAudit(limit) {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("action, record_type, details, created_at, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
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

async function openAuditDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="audit-title">
      <h3 id="audit-title">Recent activity</h3>
      <div class="aud-body" id="audit-modal-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="clear" style="color:var(--error);display:none;">Clear all</button>
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => {
    // Ignore Escape while the confirm dialog is sitting on top of this one
    if (e.key === "Escape" && backdrop === [...document.querySelectorAll(".dialog-backdrop")].pop()) close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  const bodyEl = backdrop.querySelector("#audit-modal-body");
  const clearBtn = backdrop.querySelector('[data-act="clear"]');
  const emptyHtml = `<div class="text-muted" style="padding:8px 0;">No activity recorded yet.</div>`;

  try {
    const data = await fetchAudit(100);
    bodyEl.innerHTML = data.length ? auditModalRows(data) : emptyHtml;
    clearBtn.style.display = data.length ? "" : "none";
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">Activity couldn't be loaded.</div>`;
  }

  clearBtn.addEventListener("click", async () => {
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
      bodyEl.innerHTML = emptyHtml;
      clearBtn.style.display = "none";
      showToast("Activity cleared.", "success");
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to clear the activity log."), "error");
    }
  });
}
document.getElementById("view-audit-btn").addEventListener("click", openAuditDialog);

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
  "qr.refreshed": "- refreshed QR codes",
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
          <input id="dev-passcode" type="password" required minlength="4" autocomplete="new-password" placeholder="4+ digits or characters" />
        </div>
        <div class="field">
          <label for="dev-passcode2">Confirm passcode</label>
          <input id="dev-passcode2" type="password" required minlength="4" autocomplete="new-password" placeholder="Type the passcode again" />
          <div class="field-error" id="dev-passcode-error" style="display:none;">The two passcodes don't match.</div>
          <div class="field-hint">Remember this passcode. The admin must provide it, along with the device code, to activate the scanner device.</div>		  
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
  backdrop.querySelector("#dev-passcode2").addEventListener("input", () => {
    backdrop.querySelector("#dev-passcode-error").style.display = "none";
  });
  backdrop.querySelector("#dev-name").focus();

  backdrop.querySelector("#dev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass1 = backdrop.querySelector("#dev-passcode").value;
    const pass2 = backdrop.querySelector("#dev-passcode2").value;
    const mismatch = backdrop.querySelector("#dev-passcode-error");
    if (pass1 !== pass2) {
      mismatch.style.display = "block";
      backdrop.querySelector("#dev-passcode2").focus();
      return;
    }
    mismatch.style.display = "none";
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
      showCredentialsDialog(created.name, created.device_code);
      loadDevices();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to create this device."), "error");
      submitBtn.disabled = false;
    }
  });
}

const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

function showCredentialsDialog(name, deviceCode) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="tok-title">
      <h3 id="tok-title">${escapeHtml(name)}</h3>
      <p>Enter the device code and passcode in your designated scanner to activate it.</p>
      <div class="field">
        <label>Device code</label>
        <input readonly value="${escapeHtml(deviceCode)}" onclick="this.select()" style="font-size:1.1rem;letter-spacing:0.1em;text-align:left;" />
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
            : `<button type="button" class="icon-action sm view-device-btn" data-id="${d.id}" title="View device code" aria-label="View device code">${EYE_ICON}</button>
               <button type="button" class="icon-action sm revoke-device-btn" data-id="${d.id}" data-name="${escapeHtml(d.name)}" title="Revoke" aria-label="Revoke"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></button>`
        }
        <button type="button" class="icon-action sm danger delete-device-btn" data-id="${d.id}" data-name="${escapeHtml(d.name)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      </div>`
      )
      .join("");

    el.querySelectorAll(".delete-device-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteDevice(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
    el.querySelectorAll(".view-device-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = devicesCache.find((x) => x.id === btn.getAttribute("data-id"));
        if (!d?.device_code) {
          showToast("The device code isn't available for this device. Revoke it and create a new one.", "error");
          return;
        }
        showCredentialsDialog(d.name, d.device_code);
      });
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

// Parents and guests don't get QR codes: drop them from any list of user ids
async function withoutParents(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("profiles").select("id").in("id", ids).neq("role", "parent").neq("role", "guest");
  if (error) throw error;
  return (data || []).map((p) => p.id);
}

// ---------- QR refresh ----------
function refreshQrDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="rq-title">
      <h3 id="rq-title">Refresh QR codes</h3>
      <p class="text-muted" style="font-size:0.85rem;">The current code of each selected person stops working immediately and a new one is issued.</p>
      <div class="field">
        <label for="rq-scope">Who</label>
        <select id="rq-scope">
          <option value="people">Specific people</option>
          <option value="role">By role</option>
          <option value="group">By group</option>
          <option value="all">Everyone active</option>
        </select>
      </div>
      <div id="rq-detail"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="rq-go">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let busy = false; // blocks Escape / double-clicks while a request or confirmation is open
  const onKey = (e) => { if (e.key === "Escape" && !busy) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !busy) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) close(); });

  const scopeSelect = backdrop.querySelector("#rq-scope");
  const detailEl = backdrop.querySelector("#rq-detail");
  const goBtn = backdrop.querySelector("#rq-go");
  let groupsCache = null;
  let peopleCache = null;
  const selectedPeople = new Set();

  async function renderDetail() {
    const scope = scopeSelect.value;
    if (scope === "role") {
      detailEl.innerHTML = `
        <div class="field">
          <label for="rq-role">Role</label>
          <select id="rq-role">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        </div>`;
    } else if (scope === "group") {
      if (!groupsCache) {
        const { data } = await supabase.from("groups").select("id, name").eq("organization_id", profile.organization_id).order("name");
        groupsCache = data || [];
      }
      detailEl.innerHTML = groupsCache.length
        ? `<div class="field">
            <label for="rq-group">Group</label>
            <select id="rq-group">${groupsCache.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>
          </div>`
        : `<p class="text-muted">No groups yet.</p>`;
    } else if (scope === "people") {
      if (!peopleCache) {
        const { data } = await supabase.from("profiles").select("id, full_name, role").eq("organization_id", profile.organization_id).eq("is_active", true).neq("role", "parent").neq("role", "guest").order("full_name");
        peopleCache = data || [];
      }
      detailEl.innerHTML = `
        <div class="field aud-search"><input type="search" id="rq-search" placeholder="Search by name…" autocomplete="off" /></div>
        <div class="aud-list" id="rq-people" style="max-height:220px;"></div>
        <p class="text-muted" style="font-size:0.8rem;margin-top:4px;">${selectedPeople.size} selected</p>`;
      renderPeopleList("");
      detailEl.querySelector("#rq-search").addEventListener("input", (e) => renderPeopleList(e.target.value));
    } else {
      detailEl.innerHTML = `<p class="text-muted" style="font-size:0.85rem;">This refreshes every active person's code.</p>`;
    }
  }

  function renderPeopleList(term) {
    const listEl = detailEl.querySelector("#rq-people");
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

  goBtn.addEventListener("click", async () => {
    if (busy) return;
    const scope = scopeSelect.value;
    busy = true;
    goBtn.disabled = true;
    try {
      // Everyone active: unchanged behaviour, same server function as before
      if (scope === "all") {
        const ok = await confirmDialog({
          title: "Refresh all QR codes?",
          message: "Every active person's current code stops working immediately and a new one is issued. This can't be undone.",
          confirmLabel: "Refresh",
          danger: true,
        });
        if (!ok) return;
        const { data: everyone, error: listError } = await supabase.from("profiles").select("id").eq("organization_id", profile.organization_id).eq("is_active", true).neq("role", "parent").neq("role", "guest");
        if (listError) throw listError;
        const { data: refreshed, error } = await supabase.rpc("refresh_qr_tokens_for", { p_user_ids: (everyone || []).map((p) => p.id) });
        const data = typeof refreshed === "number" ? refreshed : (everyone || []).length;
        if (error) throw error;
        showToast(`${data} QR code${data === 1 ? "" : "s"} refreshed.`, "success");
        close();
        return;
      }

      // Work out exactly who is affected
      let people = [];
      let label = "";
      if (scope === "people") {
        if (selectedPeople.size === 0) {
          showToast("Select at least one person.", "error");
          return;
        }
        people = peopleCache.filter((p) => selectedPeople.has(p.id)).map((p) => ({ id: p.id, full_name: p.full_name }));
        label = "selected people";
      } else if (scope === "role") {
        const role = detailEl.querySelector("#rq-role").value;
        const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "role", p_role: role });
        if (error) throw error;
        people = (data || []).map((p) => ({ id: p.id, full_name: p.full_name }));
        label = (ROLE_LABELS[role] || role).toLowerCase();
      } else if (scope === "group") {
        const groupId = detailEl.querySelector("#rq-group")?.value;
        if (!groupId) {
          showToast("No group available.", "error");
          return;
        }
        const { data: groupData, error } = await supabase.rpc("admin_qr_cards", { p_scope: "group", p_group: groupId });
        if (error) throw error;
        const keep = new Set(await withoutParents((groupData || []).map((p) => p.id)));
        const data = (groupData || []).filter((p) => keep.has(p.id));
        if (error) throw error;
        people = (data || []).map((p) => ({ id: p.id, full_name: p.full_name }));
        label = `group ${groupsCache.find((g) => g.id === groupId)?.name || ""}`.trim();
      }

      if (people.length === 0) {
        showToast("Nobody matched this selection.", "error");
        return;
      }

      const few = people.length <= 3;
      const ok = await confirmDialog({
        title: few ? `Refresh QR code?` : `Refresh ${people.length} QR codes?`,
        message: few
          ? "Their current code stops working immediately and a new one is issued. This can't be undone."
          : `The current codes of ${people.length} people (${label}) stop working immediately and new ones are issued. This can't be undone.`,
        confirmLabel: "Refresh",
        danger: true,
      });
      if (!ok) return;

      const ids = people.map((p) => p.id);
      const { data, error } = await supabase.rpc("refresh_qr_tokens_for", { p_user_ids: ids });
      if (error) throw error;
      const n = typeof data === "number" ? data : ids.length;
      showToast(`${n} QR code${n === 1 ? "" : "s"} refreshed.`, "success");

      // Audit trail; a logging failure must never hide the success message
      Promise.resolve(
        logAudit({
          action: "qr.refreshed",
          recordType: "organization",
          recordId: profile.organization_id,
          details: { scope, count: n, ...(ids.length <= 50 ? { user_ids: ids } : {}) },
        })
      ).catch((e) => console.error("Audit log failed:", e));

      close();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to refresh QR codes."), "error");
    } finally {
      busy = false;
      goBtn.disabled = false;
    }
  });
}

document.getElementById("refresh-qr-btn").addEventListener("click", refreshQrDialog);

// ---------- Print QR codes ----------
const ROLE_LABELS = { admin: "Admins", teacher: "Teachers", student: "Students" };

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
        const { data } = await supabase.from("groups").select("id, name").eq("organization_id", profile.organization_id).order("name");
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
        const { data } = await supabase.from("profiles").select("id, full_name, role").eq("organization_id", profile.organization_id).eq("is_active", true).neq("role", "parent").neq("role", "guest").order("full_name");
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

// ---------- Yearly archive ----------
// Flow (all inside one modal): preview counts -> type the confirmation -> export to ZIP -> verify ->
// download the ZIP (it is NOT kept in Supabase) -> admin confirms the file is saved -> delete on the server
// in one all-or-nothing step. Only the selected year (Jan 1 - Dec 31) is archived.
const ARC_ORG = profile.organization_id;
const arcYearSel = document.getElementById("archive-year");
const arcPreviewBtn = document.getElementById("archive-preview-btn");
const arcInfoBtn = document.getElementById("archive-info-btn");
let arcBusy = false;
let arcRuns = []; // small history rows: who archived which year
let arcFirstYear = null; // first year that has any data

// Tables in the same order the server uses (children first).
const ARC_TABLES = {
  events: ["event_reminder_log", "event_participants", "events"],
  announcements: ["announcement_acknowledgments", "announcements"],
  attendance: ["attendance_corrections", "attendance_records"],
  leave: ["leave_requests"],
};
const ARC_LABELS = { attendance: "Attendance", events: "Events", announcements: "Announcements", leave: "Leave requests" };

if (currentPlatform() !== "web" || isStandalone()) {
  // File downloads are unreliable inside the phone app, so archiving is a web-only action.
  document.getElementById("archive-form").style.display = "none";
  document.getElementById("archive-web-only").style.display = "block";
}

function arcCategories() {
  return Object.keys(ARC_TABLES).filter((k) => document.getElementById(`arc-cat-${k}`)?.checked);
}
function arcTablesFor(categories) {
  return [...categories.flatMap((c) => ARC_TABLES[c]), "notifications", "audit_logs"];
}
const arcRunYear = (r) => Number(String(r.through_date).slice(0, 4));
// A year counts as archived when at least one archive ran for exactly that year.
const arcRunsFor = (y) => arcRuns.filter((r) => arcRunYear(r) === y).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
const arcWho = (r) => r.performer?.full_name || "an admin (name unavailable)";

// Every year from the first year with data up to last year (so archived years stay in the list).
function arcRenderYearOptions() {
  const keep = arcYearSel.value;
  const thisYear = yearPH();
  const first = Math.min(arcFirstYear ?? thisYear, thisYear, ...arcRuns.map(arcRunYear));
  let html = "";
  for (let y = thisYear - 1; y >= first; y--) {
    html += `<option value="${y}">Year ${y}${arcRunsFor(y).length ? " (archived)" : ""}</option>`;
  }
  const none = html === "";
  arcYearSel.innerHTML = none ? `<option value="">No completed years yet</option>` : html;
  arcYearSel.disabled = none;
  arcPreviewBtn.disabled = none;
  if (keep && [...arcYearSel.options].some((o) => o.value === keep)) arcYearSel.value = keep;
  arcSyncInfoBtn();
}
// The info icon lights up only for a year that has already been archived.
function arcSyncInfoBtn() {
  const has = arcRunsFor(Number(arcYearSel.value)).length > 0;
  arcInfoBtn.disabled = !has;
  arcInfoBtn.classList.toggle("primary", has);
  arcInfoBtn.style.opacity = has ? "" : "0.45";
}

// ----- tiny modal helper (one modal can show several steps) -----
function arcOpenModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `<div class="dialog-modal" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(backdrop);
  const box = backdrop.firstElementChild;
  let locked = false;
  const onKey = (e) => {
    if (e.key === "Escape" && !locked) m.close();
  };
  const m = {
    box,
    set: (html) => (box.innerHTML = html),
    lock: (v) => (locked = v),
    close: () => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
    },
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop && !locked) m.close();
  });
  return m;
}

function arcSummaryHtml(c, attachments = 0) {
  const n = (k) => Number(c[k] || 0);
  const rows = [];
  if ("events" in c) rows.push(["Events", n("events"), `${n("event_participants")} responses, ${n("event_reminder_log")} reminder logs`]);
  if ("announcements" in c) rows.push(["Announcements", n("announcements"), `${n("announcement_acknowledgments")} acknowledgments`]);
  if ("attendance_records" in c) rows.push(["Attendance", n("attendance_records"), `time-in, break and time-out records + ${n("attendance_corrections")} corrections`]);
  if ("leave_requests" in c) rows.push(["Leave requests", n("leave_requests"), "balances and carry-over are not touched"]);
  if (attachments > 0) rows.push(["Attachments", attachments, "saved in the ZIP, then removed from storage"]);
  rows.push(["Notifications", n("notifications"), "those still waiting for a decision are kept"]);
  rows.push(["Recent activity", n("audit_logs"), "history is cleared"]);
  return rows
    .map(
      ([title, count, sub]) => `
      <div class="list-row">
        <div style="flex:1;min-width:0;"><div style="font-weight:600;">${title}</div><div class="text-muted" style="font-size:0.8rem;">${escapeHtml(sub)}</div></div>
        <div style="font-weight:700;">${count.toLocaleString()}</div>
      </div>`
    )
    .join("");
}

// ----- Step 1: preview (opened by the eye icon) -----
async function openArchivePreview() {
  if (arcBusy) return;
  const year = Number(arcYearSel.value);
  if (!year) return;
  const cats = arcCategories();
  const through = `${year}-12-31`;
  const m = arcOpenModal();
  m.set(`<h3 style="margin-top:0;">Archive preview · Year ${year}</h3><div class="skeleton" style="height:120px;"></div>`);
  try {
    const { data, error } = await supabase.rpc("archive_preview", { p_org: ARC_ORG, p_through: through, p_categories: cats });
    if (error) throw error;
    arcShowSummary(m, { through, year, cats, cutoff: data.cutoff, counts: data.counts, attachments: Number(data.attachments || 0) });
  } catch (err) {
    console.error(err);
    m.set(`<h3 style="margin-top:0;">Archive preview</h3>
      <p>${escapeHtml(friendlyError(err, "Unable to preview the archive."))}</p>
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`);
    m.box.querySelector('[data-act="close"]').addEventListener("click", m.close);
  }
}

function arcShowSummary(m, a) {
  const total = Object.values(a.counts).reduce((x, y) => x + Number(y), 0);
  m.set(`
    <h3 style="margin-top:0;">Archive preview · Year ${a.year}</h3>
    <div>${arcSummaryHtml(a.counts, a.attachments)}</div>
    ${
      total === 0
        ? `<p class="text-muted" style="margin:12px 0 0;">Nothing to archive for this period.</p>`
        : `<p class="field-hint" style="margin-top:12px;">Only Year ${a.year} is archived. A ZIP file (with the attachments) is downloaded first, and records are deleted only after you confirm the file is saved.</p>`
    }
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" data-act="close">${total === 0 ? "Close" : "Cancel"}</button>
      ${total === 0 ? "" : `<button type="button" class="btn btn-primary" data-act="next" style="background:var(--error);border-color:var(--error);">Archive and delete</button>`}
    </div>`);
  m.box.querySelector('[data-act="close"]').addEventListener("click", m.close);
  m.box.querySelector('[data-act="next"]')?.addEventListener("click", () => arcShowConfirm(m, a));
}

// ----- Step 2: typed confirmation -----
function arcShowConfirm(m, a) {
  const phrase = `ARCHIVE ${a.year}`;
  m.set(`
    <h3 style="margin-top:0;">Archive Year ${a.year}?</h3>
    <p style="font-size:0.92rem;">This permanently deletes the Year ${a.year} records listed in the preview from the database. A ZIP file is downloaded to your device first, and nothing is deleted until you confirm you have it. Leave balances and carry-over are not touched.</p>
    <div class="field" style="margin-top:12px;">
      <label for="arc-phrase">Type <strong>${escapeHtml(phrase)}</strong> to confirm</label>
      <input id="arc-phrase" autocomplete="off" />
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" data-act="back">Back</button>
      <button type="button" class="btn btn-primary" data-act="go" disabled style="background:var(--error);border-color:var(--error);">Archive and delete</button>
    </div>`);
  const input = m.box.querySelector("#arc-phrase");
  const go = m.box.querySelector('[data-act="go"]');
  input.addEventListener("input", () => (go.disabled = input.value.trim() !== phrase));
  m.box.querySelector('[data-act="back"]').addEventListener("click", () => arcShowSummary(m, a));
  go.addEventListener("click", () => arcRun(m, a));
  input.focus();
}

// ----- export helpers -----
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.join(",")];
  rows.forEach((r) => lines.push(cols.map((c) => csvCell(r[c])).join(",")));
  return "\uFEFF" + lines.join("\n");
}
function arcSetStatus(text) {
  const el = document.getElementById("arc-progress");
  if (el) el.textContent = text || "";
}
async function arcFetchAll(table, a) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.rpc("archive_export_page", {
      p_org: ARC_ORG, p_through: a.through, p_cutoff: a.cutoff, p_table: table, p_offset: offset, p_limit: 1000,
    });
    if (error) throw error;
    rows.push(...data);
    arcSetStatus(`Exporting ${table.replace(/_/g, " ")}… ${rows.length.toLocaleString()} rows`);
    if (data.length < 1000) break;
  }
  return rows;
}
async function arcFetchPeople() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("profiles").select("id, full_name, email, role, is_active").eq("organization_id", ARC_ORG).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}
// ----- Readable names: replace ids with people / event / leave-type names in the exported files -----
// Columns that hold a person's profile id -> the readable column name that replaces them.
const ARC_PERSON_COLS = {
  profile_id: "person", actor_id: "actor", created_by: "created_by", reviewed_by: "reviewed_by", recorded_by: "recorded_by", organizer_id: "organizer",
};
const ARC_DROP_COLS = new Set(["id", "organization_id", "related_id", "record_id"]); // internal ids that mean nothing to a reader

async function arcFetchNames(table) {
  const map = new Map();
  try {
    const { data, error } = await supabase.from(table).select("id, name").eq("organization_id", ARC_ORG).range(0, 4999);
    if (error) throw error;
    (data || []).forEach((r) => map.set(r.id, r.name));
  } catch (err) {
    console.warn(`Couldn't load ${table} names`, err);
  }
  return map;
}

async function arcBuildLookups(raw) {
  const peopleRows = await arcFetchPeople();
  const titles = (rows = []) => new Map(rows.map((r) => [r.id, r.title]));
  return {
    peopleRows,
    people: new Map(peopleRows.map((p) => [p.id, p.full_name])),
    leaveTypes: await arcFetchNames("leave_types"),
    groups: await arcFetchNames("groups"),
    events: titles(raw.events),
    announcements: titles(raw.announcements),
    attendanceDates: new Map((raw.attendance_records || []).map((r) => [r.id, r.record_date])),
  };
}

function arcNameOf(map, id) {
  if (id === null || id === undefined || id === "") return "";
  return map.get(id) ?? `Unknown (${String(id).slice(0, 8)})`;
}

function arcMakeReadable(rows, L) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (ARC_DROP_COLS.has(key)) continue;
      if (ARC_PERSON_COLS[key]) out[ARC_PERSON_COLS[key]] = arcNameOf(L.people, value);
      else if (key === "leave_type_id") out.leave_type = arcNameOf(L.leaveTypes, value);
      else if (key === "group_id") out.group = arcNameOf(L.groups, value);
      else if (key === "event_id") out.event = arcNameOf(L.events, value);
      else if (key === "announcement_id") out.announcement = arcNameOf(L.announcements, value);
      else if (key === "attachment_url") out.attachment_file = value ? L.attachmentFiles?.get(value) ?? "" : "";
      else if (key === "attendance_record_id") out.attendance_date = value ? L.attendanceDates.get(value) ?? "" : "";
      else if (key === "audience_user_ids") out.audience_people = (value || []).map((v) => arcNameOf(L.people, v)).join("; ");
      else if (key === "audience_group_ids") out.audience_groups = (value || []).map((v) => arcNameOf(L.groups, v)).join("; ");
      else out[key] = value;
    }
    return out;
  });
}

// ----- Attachments: saved into the ZIP, then removed from storage after the records are deleted -----
const ARC_ATTACH_TABLES = ["events", "announcements", "attendance_corrections", "leave_requests"];

function arcParseStorageUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
    if (m) return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) };
  } catch {
    // not a full link
  }
  return null;
}

async function arcSaveAttachments(raw, zip) {
  const files = new Map(); // attachment link -> name inside the ZIP (shown in the CSV)
  const toRemove = []; // only files that were safely saved into the ZIP
  const summary = { saved: 0, notFound: 0, notRecognized: 0 };
  const jobs = [];
  const seen = new Set();
  for (const table of ARC_ATTACH_TABLES) {
    for (const row of raw[table] || []) {
      if (row.attachment_url && !seen.has(row.attachment_url)) {
        seen.add(row.attachment_url);
        jobs.push({ table, url: row.attachment_url });
      }
    }
  }
  let n = 0;
  for (const job of jobs) {
    n++;
    arcSetStatus(`Saving attachments… ${n} of ${jobs.length}`);
    const ref = arcParseStorageUrl(job.url);
    if (!ref) {
      files.set(job.url, "(link not recognized - file left in storage)");
      summary.notRecognized++;
      continue;
    }
    const { data, error } = await supabase.storage.from(ref.bucket).download(ref.path);
    if (error || !data) {
      files.set(job.url, "(file not found)");
      summary.notFound++;
      continue;
    }
    const base = ref.path.split("/").pop().replace(/[^\w.\- ]+/g, "_");
    const name = `attachments/${job.table}/${String(n).padStart(3, "0")}_${base}`;
    zip.file(name, data);
    files.set(job.url, name);
    toRemove.push(ref);
    summary.saved++;
  }
  return { files, toRemove, summary };
}

async function arcRemoveAttachments(toRemove) {
  const byBucket = new Map();
  toRemove.forEach((r) => byBucket.set(r.bucket, [...(byBucket.get(r.bucket) || []), r.path]));
  let removed = 0;
  let failed = 0;
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { data, error } = await supabase.storage.from(bucket).remove(chunk);
      const ok = error ? 0 : data?.length ?? 0; // no permission returns an empty list instead of an error
      removed += ok;
      failed += chunk.length - ok;
    }
  }
  return { removed, failed };
}

function arcDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const arcGuard = (e) => {
  e.preventDefault();
  e.returnValue = "";
};

// ----- Step 3: export, download, confirm, delete -----
const arcProgressHtml = (year) => `
  <h3 style="margin-top:0;">Archiving Year ${year}…</h3>
  <p id="arc-progress" class="text-muted" style="margin:8px 0;">Starting…</p>
  <p class="field-hint">Please keep this page open until it finishes.</p>`;

// The ZIP only exists on this device, so the admin confirms it before anything is deleted.
function arcAskFileSaved(m, fileName) {
  return new Promise((resolve) => {
    m.set(`
      <h3 style="margin-top:0;">Is the file saved?</h3>
      <p style="font-size:0.92rem;">Your archive (with its attachments) was downloaded as <strong>${escapeHtml(fileName)}</strong>. Check your Downloads folder and make sure the file is there. The records are deleted only after you confirm, and this cannot be undone.</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="no">No, don't delete</button>
        <button type="button" class="btn btn-primary" data-act="yes" style="background:var(--error);border-color:var(--error);">Yes, delete the records</button>
      </div>`);
    m.box.querySelector('[data-act="no"]').addEventListener("click", () => resolve(false));
    m.box.querySelector('[data-act="yes"]').addEventListener("click", () => resolve(true));
  });
}

async function arcRun(m, a) {
  if (arcBusy) return;
  if (!window.JSZip) {
    showToast("The ZIP tool couldn't be loaded. Check your connection and reload the page.", "error");
    return;
  }
  arcBusy = true;
  m.lock(true);
  window.addEventListener("beforeunload", arcGuard);
  m.set(arcProgressHtml(a.year));

  let failure = null;
  let cancelled = false;
  try {
    // 1) Export everything and check the numbers match the preview.
    const zip = new window.JSZip();
    const exported = {};
    const raw = {};
    for (const table of arcTablesFor(a.cats)) {
      const rows = await arcFetchAll(table, a);
      if (rows.length !== Number(a.counts[table])) {
        throw new Error(`Export check failed for ${table} (${rows.length} exported, ${a.counts[table]} expected). Nothing was deleted.`);
      }
      raw[table] = rows;
      exported[table] = rows.length;
    }
    arcSetStatus("Adding names…");
    const lookups = await arcBuildLookups(raw);
    const attach = await arcSaveAttachments(raw, zip);
    lookups.attachmentFiles = attach.files;
    for (const [table, rows] of Object.entries(raw)) {
      if (rows.length) zip.file(`${table}.csv`, rowsToCsv(arcMakeReadable(rows, lookups)));
    }
    zip.file("people.csv", rowsToCsv(lookups.peopleRows.map(({ full_name, email, role, is_active }) => ({ full_name, email, role, is_active }))));
    zip.file(
      "manifest.json",
      JSON.stringify({ organization: profile.organizations?.name || null, year: a.year, categories: a.cats, exported, createdAt: new Date().toISOString(), attachments: attach.summary, note: "Ids are replaced with names. people.csv lists everyone in the academy. Attachments are in the attachments folder." }, null, 2)
    );

    // 2) Build the ZIP and download it.
    arcSetStatus("Building the ZIP file…");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const fileName = `onecore-archive-${a.year}.zip`;
    arcDownload(blob, fileName);

    // 3) Wait for the admin to confirm the file is saved, then delete in one all-or-nothing step.
    if (!(await arcAskFileSaved(m, fileName))) {
      cancelled = true;
    } else {
      m.set(arcProgressHtml(a.year));
      arcSetStatus("Deleting archived records…");
      const { data, error } = await supabase.rpc("run_archive", {
        p_org: ARC_ORG, p_through: a.through, p_categories: a.cats, p_cutoff: a.cutoff, p_expected: exported,
      });
      if (error) throw error;
      const removed = Object.values(data).reduce((x, y) => x + Number(y), 0);

      // The records are gone and the files are safe in the ZIP, so now free the storage space they used.
      let attachNote = "";
      let attachProblem = false;
      if (attach.toRemove.length) {
        m.set(arcProgressHtml(a.year));
        arcSetStatus("Removing attachments from storage…");
        try {
          const r = await arcRemoveAttachments(attach.toRemove);
          attachProblem = r.failed > 0;
          attachNote = r.failed ? ` ${r.failed} attachment file(s) could not be removed from storage.` : ` ${r.removed} attachment file(s) removed.`;
        } catch (e) {
          console.error(e);
          attachProblem = true;
          attachNote = " The attachment files could not be removed from storage.";
        }
      }
      showToast(`Archive complete. ${removed.toLocaleString()} records removed.${attachNote}`, attachProblem ? "info" : "success");
    }
  } catch (err) {
    console.error(err);
    failure = friendlyError(err, "The archive did not finish.");
  } finally {
    window.removeEventListener("beforeunload", arcGuard);
    arcBusy = false;
    m.lock(false);
  }

  if (failure) {
    m.set(`
      <h3 style="margin-top:0;">The archive did not finish</h3>
      <p>${escapeHtml(failure)}</p>
      <p class="text-muted" style="font-size:0.85rem;">Nothing is deleted unless the archive is marked complete. The year list shows "(archived)" for years that finished.</p>
      <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`);
    m.box.querySelector('[data-act="close"]').addEventListener("click", m.close);
  } else {
    m.close();
    if (cancelled) showToast("Nothing was deleted.", "info");
  }
  loadArchiveRuns();
}

// ----- Archived-year details (info icon) -----
function arcRunCard(r) {
  const total = Object.values(r.counts || {}).reduce((x, y) => x + Number(y), 0);
  const included = [...(r.categories || []).map((c) => ARC_LABELS[c] || c), "Notifications", "Recent activity"].join(", ");
  return `<div class="list-row" style="display:block;">
    <div style="font-weight:600;">Archived by ${escapeHtml(arcWho(r))}</div>
    <div class="text-muted" style="font-size:0.8rem;">${escapeHtml(dateTimePH(r.created_at))}</div>
    <div class="text-muted" style="font-size:0.8rem;">Included: ${escapeHtml(included)}</div>
    <div style="font-size:0.85rem;margin-top:4px;">${total.toLocaleString()} records removed</div>
  </div>`;
}

function openArchiveInfo() {
  const year = Number(arcYearSel.value);
  const runs = arcRunsFor(year);
  if (!runs.length) return;
  const m = arcOpenModal();
  m.set(`
    <h3 style="margin-top:0;">Year ${year} · archive details</h3>
    <div style="max-height:55vh;overflow-y:auto;">${runs.map(arcRunCard).join("")}</div>
    <div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>`);
  m.box.querySelector('[data-act="close"]').addEventListener("click", m.close);
}

// ----- Load the small history (for "(archived)" labels) and the first year with data -----
async function loadArchiveRuns() {
  const cols = "id, through_date, categories, counts, created_at";
  try {
    const [firstRes, runsRes] = await Promise.all([
      supabase.rpc("archive_first_year", { p_org: ARC_ORG }),
      supabase.from("archive_runs").select(`${cols}, performer:profiles!performed_by(full_name)`).eq("organization_id", ARC_ORG).order("created_at", { ascending: false }).limit(200),
    ]);
    let runs = runsRes;
    if (runs.error) {
      // Names couldn't be joined: still show which years are archived, without names.
      runs = await supabase.from("archive_runs").select(cols).eq("organization_id", ARC_ORG).order("created_at", { ascending: false }).limit(200);
    }
    if (firstRes.error) throw firstRes.error;
    if (runs.error) throw runs.error;
    arcFirstYear = firstRes.data;
    arcRuns = runs.data || [];
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Couldn't load the archive years."), "error");
  }
  arcRenderYearOptions();
}

arcYearSel.addEventListener("change", arcSyncInfoBtn);
arcPreviewBtn.addEventListener("click", openArchivePreview);
arcInfoBtn.addEventListener("click", openArchiveInfo);
if (currentPlatform() === "web" && !isStandalone()) {
  arcYearSel.innerHTML = `<option value="">Loading…</option>`;
  arcPreviewBtn.disabled = true;
  loadArchiveRuns();
}


