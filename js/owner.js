import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError, isPlatformOwner, clearProfileCache } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "owner", pageTitle: "Owner console", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

// The page is only for platform owners; everyone else goes back to the dashboard.
if (!(await isPlatformOwner())) {
  window.location.href = "dashboard.html";
  throw new Error("redirecting");
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Custom messages raised inside the database functions come back with code P0001.
const msg = (err, fallback) => (err?.code === "P0001" && err.message ? err.message : friendlyError(err, fallback));

const PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ENTER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
const RESET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

document.getElementById("academies-head").innerHTML = sectionHead({
  title: "Academies",
  tone: "primary",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V5a2 2 0 012-2h6a2 2 0 012 2v16"/><path d="M15 9h2a2 2 0 012 2v10"/><path d="M9 7h2M9 11h2M9 15h2"/></svg>`,
  linkHtml: `<button type="button" class="icon-action primary" id="new-academy-btn" title="New academy" aria-label="New academy" style="margin-left:auto;">${PLUS}</button>`,
});
document.getElementById("owners-head").innerHTML = sectionHead({
  title: "Platform owners",
  tone: "muted",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
  linkHtml: `<button type="button" class="icon-action primary" id="new-owner-btn" title="Add owner" aria-label="Add owner" style="margin-left:auto;">${PLUS}</button>`,
});

// ---------- small prompt dialog (one text field) ----------
function promptDialog({ title, label, placeholder = "", type = "text", confirmLabel = "Save", hint = "" }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="pd-title">
        <h3 id="pd-title">${escapeHtml(title)}</h3>
        <form id="pd-form">
          <div class="field">
            <label for="pd-input">${escapeHtml(label)}</label>
            <input id="pd-input" type="${type}" placeholder="${escapeHtml(placeholder)}" required />
            ${hint ? `<div class="field-hint">${escapeHtml(hint)}</div>` : ""}
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector("#pd-input");
    input.focus();

    const onKey = (e) => { if (e.key === "Escape") close(null); };
    function close(v) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(v);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    backdrop.querySelector("#pd-form").addEventListener("submit", (e) => {
      e.preventDefault();
      close(input.value.trim() || null);
    });
  });
}

// ---------- Academies ----------
async function loadAcademies() {
  const el = document.getElementById("academies-list");
  try {
    const { data, error } = await supabase.rpc("owner_list_academies");
    if (error) throw error;
    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No academies yet</h3><p>Use + to create the first one.</p></div>`;
      return;
    }
    el.innerHTML = data
      .map((o) => {
        const isCurrent = o.id === profile.organization_id;
        return `<div class="list-row">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(o.name)}${isCurrent ? ` <span class="tag tag-approved">Current</span>` : ""}</div>
            <div class="text-muted" style="font-size:0.85rem;">${o.member_count} member${Number(o.member_count) === 1 ? "" : "s"} · ${o.admin_count} admin${Number(o.admin_count) === 1 ? "" : "s"} · code ${escapeHtml(o.invite_code || "—")}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button type="button" class="icon-action sm copy-code-btn" data-code="${escapeHtml(o.invite_code || "")}" title="Copy invite code" aria-label="Copy invite code">${COPY}</button>
            <button type="button" class="icon-action sm danger wipe-btn" data-id="${o.id}" data-name="${escapeHtml(o.name)}" title="Clear or reset data" aria-label="Clear or reset data">${RESET}</button>
            <button type="button" class="icon-action sm enter-btn" data-id="${o.id}" title="Open this academy" aria-label="Open this academy" ${isCurrent ? "disabled" : ""}>${ENTER}</button>
          </div>
        </div>`;
      })
      .join("");

    el.querySelectorAll(".copy-code-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.getAttribute("data-code"));
          showToast("Invite code copied.", "success");
        } catch {
          showToast("Couldn't copy the code.", "error");
        }
      })
    );
    el.querySelectorAll(".enter-btn").forEach((btn) => btn.addEventListener("click", () => enterAcademy(btn.getAttribute("data-id"))));
    el.querySelectorAll(".wipe-btn").forEach((btn) => btn.addEventListener("click", () => openWipeDialog(btn.getAttribute("data-id"), btn.getAttribute("data-name"))));
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Academies couldn't be loaded</h3></div>`;
    showToast(msg(err, "Academies couldn't be loaded."), "error");
  }
}

async function enterAcademy(orgId) {
  try {
    const { error } = await supabase.rpc("owner_enter_academy", { p_org_id: orgId });
    if (error) throw error;
    // The active academy is carried in the access token, so get a fresh one.
    const { error: rErr } = await supabase.auth.refreshSession();
    if (rErr) throw rErr;
    clearProfileCache();
    window.location.href = "dashboard.html";
  } catch (err) {
    console.error(err);
    showToast(msg(err, "Unable to open that academy."), "error");
  }
}

document.getElementById("new-academy-btn").addEventListener("click", async () => {
  const name = await promptDialog({ title: "New academy", label: "Academy name", confirmLabel: "Create", hint: "You'll be added as its administrator." });
  if (!name) return;
  try {
    const { data, error } = await supabase.rpc("owner_create_academy", { p_name: name });
    if (error) throw error;
    showToast("Academy created.", "success");
    await loadAcademies();
    const open = await confirmDialog({ title: `Open "${name}" now?`, message: "You can switch back from this page at any time.", confirmLabel: "Open" });
    if (open) enterAcademy(data);
  } catch (err) {
    console.error(err);
    showToast(msg(err, "Unable to create the academy."), "error");
  }
});

// ---------- Clear / reset / delete one academy ----------
async function openWipeDialog(orgId, orgName) {
  const insideIt = orgId === profile.organization_id; // the owner is currently working in this academy
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  const optionStyle = "display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:10px;cursor:pointer;margin-bottom:8px;";
  const lockedStyle = "opacity:0.55;cursor:not-allowed;";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="wp-title" style="max-height:90vh;overflow-y:auto;">
      <h3 id="wp-title" style="margin-bottom:4px;">Clear data</h3>
      <p class="text-muted" style="margin:0 0 12px;">${escapeHtml(orgName)}</p>
      <label style="${optionStyle}">
        <input type="radio" name="wp-mode" value="clear" checked style="width:auto;margin:3px 0 0;" />
        <span><strong>Clear activity</strong><span class="field-hint" style="display:block;">Attendance, leave, events, announcements, notifications, notes and logs.</span></span>
      </label>
      <label style="${optionStyle}">
        <input type="radio" name="wp-mode" value="full" style="width:auto;margin:3px 0 0;" />
        <span><strong>Full reset</strong><span class="field-hint" style="display:block;">Everything above, plus all people, accounts, groups, leave types, and devices. Accounts linked to other academies are retained. The academy remains with a new invite code.</span></span>
      </label>
      <label style="${optionStyle}${insideIt ? lockedStyle : ""}">
        <input type="radio" name="wp-mode" value="delete" ${insideIt ? "disabled" : ""} style="width:auto;margin:3px 0 0;" />
        <span><strong>Delete academy</strong><span class="field-hint" style="display:block;">Purge signs everyone out, resets all data, and permanently deletes the academy.${insideIt ? " Unavailable to proceed. Switch to another academy first." : ""}</span></span>
      </label>
      <div class="field" style="margin-top:14px;">
        <label for="wp-confirm">Type the academy name to confirm</label>
        <input id="wp-confirm" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(orgName)}" />
        <div class="field-hint">This can't be undone.</div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-danger-solid" data-act="wipe" disabled>Clear data</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = (s) => backdrop.querySelector(s);
  const confirmEl = $("#wp-confirm");
  const wipeBtn = $('[data-act="wipe"]');
  let busy = false;

  const mode = () => backdrop.querySelector('input[name="wp-mode"]:checked').value;
  const nameMatches = () => confirmEl.value.trim().toLowerCase() === orgName.trim().toLowerCase();
  const LABELS = { clear: "Clear data", full: "Reset academy", delete: "Delete academy" };

  function updateButton() {
    const blocked = mode() === "delete" && insideIt;
    wipeBtn.disabled = busy || blocked || !nameMatches();
    wipeBtn.textContent = busy ? "Working…" : LABELS[mode()];
  }

  function onKey(e) {
    if (e.key === "Escape" && !busy) close();
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !busy) close(); });
  $('[data-act="cancel"]').addEventListener("click", () => { if (!busy) close(); });
  backdrop.querySelectorAll('input[name="wp-mode"]').forEach((r) => r.addEventListener("change", updateButton));
  confirmEl.addEventListener("input", updateButton);

  wipeBtn.addEventListener("click", async () => {
    if (wipeBtn.disabled) return;
    busy = true;
    updateButton();
    const chosen = mode();
    try {
      if (chosen === "delete") {
        // Server signs every user out, wipes the academy completely and deletes it.
        const { error } = await supabase.rpc("owner_delete_academy", {
          p_org: orgId,
          p_confirm_name: confirmEl.value.trim(),
        });
        if (error) throw error;
        close();
        showToast("Academy deleted.", "success");
      } else {
        const { data, error } = await supabase.rpc("owner_wipe_academy", {
          p_org: orgId,
          p_mode: chosen,
          p_confirm_name: confirmEl.value.trim(),
          p_delete_accounts: chosen === "full", // no orphan logins after a full reset
          p_dry_run: false,
        });
        if (error) throw error;
        close();
        if (orgId === profile.organization_id) clearProfileCache();
        showToast(chosen === "full" && data?.invite_code ? `Academy reset. New invite code: ${data.invite_code}` : chosen === "full" ? "Academy reset." : "Activity cleared.", "success");
      }
      loadAcademies();
    } catch (err) {
      console.error(err);
      busy = false;
      updateButton();
      showToast(msg(err, chosen === "delete" ? "Unable to delete this academy." : "Unable to clear this academy."), "error");
    }
  });

  confirmEl.focus();
  updateButton();
}

// ---------- Owners ----------
async function loadOwners() {
  const el = document.getElementById("owners-list");
  try {
    const { data, error } = await supabase.rpc("owner_list_owners");
    if (error) throw error;
    el.innerHTML = (data || [])
      .map(
        (o) => `<div class="list-row">
          <div style="flex:1;min-width:0;font-weight:600;">${escapeHtml(o.email)}${o.is_me ? ` <span class="text-muted" style="font-weight:400;">(you)</span>` : ""}</div>
          ${o.is_me ? "" : `<button type="button" class="icon-action sm danger remove-owner-btn" data-id="${o.auth_user_id}" data-email="${escapeHtml(o.email)}" title="Remove owner" aria-label="Remove owner">${TRASH}</button>`}
        </div>`
      )
      .join("");
    el.querySelectorAll(".remove-owner-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: `Remove ${btn.getAttribute("data-email")} as owner?`,
          message: "They keep any admin profile they already have in an academy, but lose owner access.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        try {
          const { error: rErr } = await supabase.rpc("owner_remove_owner", { p_auth_user_id: btn.getAttribute("data-id") });
          if (rErr) throw rErr;
          showToast("Owner removed.", "success");
          loadOwners();
        } catch (err) {
          console.error(err);
          showToast(msg(err, "Unable to remove this owner."), "error");
        }
      })
    );
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Owners couldn't be loaded</h3></div>`;
    showToast(msg(err, "Owners couldn't be loaded."), "error");
  }
}

document.getElementById("new-owner-btn").addEventListener("click", async () => {
  const email = await promptDialog({
    title: "Add platform owner",
    label: "Email",
    type: "email",
    placeholder: "name@example.com",
    confirmLabel: "Add",
    hint: "They must already have an account. Owners can create academies and open any of them.",
  });
  if (!email) return;
  try {
    const { error } = await supabase.rpc("owner_add_owner", { p_email: email });
    if (error) throw error;
    showToast("Owner added.", "success");
    loadOwners();
  } catch (err) {
    console.error(err);
    showToast(msg(err, "Unable to add this owner."), "error");
  }
});

loadAcademies();
loadOwners();
