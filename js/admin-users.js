import { mountLayout } from "./layout.js";
import { supabase, initials, friendlyError, logAudit, isPlatformOwner } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";
import { sectionHead } from "./ui.js";

const profile = await mountLayout({ activeKey: "admin-users", pageTitle: "Users", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

const isOwner = await isPlatformOwner(); // only the platform owner may grant or revoke admin access
const listEl = document.getElementById("users-list");
const ROLES = ["admin", "teacher", "student", "parent", "guest"];

// Display order for the Active / Inactive lists: Admin, Teacher, Parent, Student, Guest
const ROLE_ORDER = { admin: 0, teacher: 1, parent: 2, student: 3, guest: 4 };
const roleRank = (r) => (r in ROLE_ORDER ? ROLE_ORDER[r] : 99);

// Sort by role first, then alphabetically by name within each role
function sortUsers(list) {
  return [...list].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      (a.full_name || "").localeCompare(b.full_name || "", undefined, { sensitivity: "base" })
  );
}

// Search state (kept outside load() so the search text survives re-renders after actions)
let allActive = [];
let allInactive = [];
const searchTerms = { active: "", inactive: "" };

const ICON = {
  approve:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  reject:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  edit:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  deactivate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
  activate:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1011.4 0"/></svg>`,
  delete:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>`,
  guardians:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
  leaveType:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
};

const SECTION_ICON = {
  pending:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  active:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/></svg>`,
  inactive:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M18 8l5 5M23 8l-5 5"/></svg>`,
};

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

function actionBtn({ cls = "", icon, label, attrs = "", disabled = false }) {
  return `<button type="button" class="icon-action ${cls}" title="${label}" aria-label="${label}" ${attrs} ${disabled ? "disabled" : ""}>${ICON[icon]}</button>`;
}

function userRow(u, mode) {
  const isSelf = u.id === profile.id;
  const adminLocked = u.role === "admin" && !isOwner; // academy admins can't change or deactivate other admins
  const name = escapeHtml(u.full_name);
  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  const common = `data-id="${u.id}" data-name="${name}" data-role="${escapeHtml(u.role)}" data-guest-until="${escapeHtml(u.guest_until || "")}"`;

  const editBtn = actionBtn({ cls: "edit-role-btn", icon: "edit", label: "Edit role", attrs: common, disabled: isSelf || adminLocked });
  const guardianBtn =
    mode !== "pending" && u.role === "student"
      ? actionBtn({ cls: "guardian-btn", icon: "guardians", label: "Guardians", attrs: common })
      : "";
  const leaveTypeBtn =
    mode !== "pending" && (u.role === "teacher" || u.role === "admin")
      ? actionBtn({ cls: "leave-type-btn", icon: "leaveType", label: "Leave types", attrs: common })
      : "";

  const actions =
    mode === "pending"
      ? actionBtn({ cls: "approve approve-btn", icon: "approve", label: "Approve", attrs: common }) +
        actionBtn({ cls: "danger reject-btn", icon: "reject", label: "Reject", attrs: common }) +
        editBtn
      : actionBtn({
          cls: "toggle-active-btn",
          icon: u.is_active ? "deactivate" : "activate",
          label: u.is_active ? "Deactivate" : "Activate",
          attrs: `${common} data-active="${u.is_active}"`,
          disabled: isSelf || adminLocked,
        }) +
        actionBtn({ cls: "danger delete-btn", icon: "delete", label: "Delete", attrs: common, disabled: isSelf || adminLocked }) +
        guardianBtn +
        leaveTypeBtn +
        editBtn;

  const roleLine = escapeHtml(roleLabel) + (u.role === "guest" ? (u.guest_until ? ` · until ${escapeHtml(u.guest_until)}` : " · no end date") : "");

  return `
    <div class="card user-row ${mode === "inactive" ? "is-inactive" : ""}" data-id="${u.id}">
      <div class="avatar">${initials(u.full_name)}</div>
      <div class="user-meta">
        <div class="user-name">${name}${isSelf ? " (you)" : ""}</div>
        <div class="user-email">${escapeHtml(u.email)}</div>
        <div class="user-role">${roleLine}</div>
      </div>
      <div class="user-actions">${actions}</div>
    </div>`;
}

// Small modal for choosing a role. Resolves to the chosen role, or null if cancelled.
function roleDialog({ name, role, guestUntil }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="role-dialog-title">
        <h3 id="role-dialog-title">Edit role</h3>
        <p>${escapeHtml(name)}</p>
        <div class="field">
          <label for="role-dialog-select">Role</label>
          <select id="role-dialog-select">
            ${ROLES.filter((r) => r !== "admin" || isOwner || role === "admin").map((r) => `<option value="${r}" ${r === role ? "selected" : ""}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`).join("")}
          </select>
        </div>
        <div class="field" id="role-guest-field" style="display:${role === "guest" ? "block" : "none"};">
          <label for="role-guest-until">Guest until (optional)</label>
          <input id="role-guest-until" type="date" value="${escapeHtml(guestUntil || "")}" />
          <div class="field-hint">Leave empty to keep this guest active until you deactivate them. Guests can only view announcements and events, and respond to them.</div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-act="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const select = backdrop.querySelector("select");
    const guestField = backdrop.querySelector("#role-guest-field");
    const guestInput = backdrop.querySelector("#role-guest-until");
    select.addEventListener("change", () => {
      guestField.style.display = select.value === "guest" ? "block" : "none";
    });
    select.focus();

    const onKey = (e) => { if (e.key === "Escape") close(null); };
    function close(value) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    backdrop.querySelector('[data-act="save"]').addEventListener("click", () => close({ role: select.value, guestUntil: select.value === "guest" ? guestInput.value || null : null }));
  });
}

async function editRole(id, name, currentRole, currentGuestUntil) {
  const result = await roleDialog({ name, role: currentRole, guestUntil: currentGuestUntil });
  if (!result) return;
  if (result.role === currentRole && (result.guestUntil || "") === (currentGuestUntil || "")) return;
  await updateRole(id, result.role, result.guestUntil);
}

// ---------- Guardians dialog: link/unlink parents for a student ----------
let parentsCache = [];

async function openGuardianDialog(studentId, studentName) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="gd-title">
      <h3 id="gd-title">Guardians</h3>
      <p>${escapeHtml(studentName)}</p>
      <div id="gd-body"><div class="skeleton" style="height:50px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
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

  let showAdd = false;
  let search = "";

  async function render() {
    const bodyEl = backdrop.querySelector("#gd-body");
    const { data: links, error } = await supabase
      .from("guardians")
      .select("id, parent_id, profiles!guardians_parent_id_fkey(full_name, email)")
      .eq("student_id", studentId);
    if (error) {
      console.error(error);
      bodyEl.innerHTML = `<p class="text-muted">Unable to load guardians.</p>`;
      return;
    }

    if (parentsCache.length === 0) {
      const { data: parents, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .eq("organization_id", profile.organization_id)
        .eq("role", "parent")
        .eq("is_active", true)
        .order("full_name");
      if (pErr) console.error(pErr);
      parentsCache = parents || [];
    }

    const linkedIds = new Set((links || []).map((l) => l.parent_id));

    bodyEl.innerHTML = `
      <div class="aud-list">
        ${
          links && links.length
            ? links
                .map(
                  (l) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(l.profiles?.full_name || "Unknown")}</span>
                <span class="aud-meta">${escapeHtml(l.profiles?.email || "")}</span>
                <button type="button" class="icon-action sm danger" data-unlink="${l.id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.reject}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No linked parents yet.</div>`
        }
      </div>
      ${
        showAdd
          ? `<div class="field aud-search"><input type="search" id="gd-search" placeholder="Search parents by name or email…" autocomplete="off" value="${escapeHtml(search)}" /></div>
             <div class="aud-list" id="gd-results"></div>
             <button type="button" class="btn btn-secondary btn-sm" data-act="cancel-add" style="margin-top:8px;">Cancel</button>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-act="add" style="margin-top:8px;">Link a parent</button>`
      }
    `;

    bodyEl.querySelectorAll("[data-unlink]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const { error: delErr } = await supabase.from("guardians").delete().eq("id", btn.getAttribute("data-unlink"));
          if (delErr) throw delErr;
          showToast("Parent unlinked.", "success");
          await render();
        } catch (err) {
          console.error(err);
          showToast(friendlyError(err, "Unable to remove this link."), "error");
        }
      });
    });

    bodyEl.querySelector('[data-act="add"]')?.addEventListener("click", () => { showAdd = true; render(); });
    bodyEl.querySelector('[data-act="cancel-add"]')?.addEventListener("click", () => { showAdd = false; search = ""; render(); });

    if (showAdd) {
      const input = bodyEl.querySelector("#gd-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener("input", (e) => { search = e.target.value; renderResults(); });
      renderResults();
    }

    function renderResults() {
      const resEl = bodyEl.querySelector("#gd-results");
      if (!resEl) return;
      const term = search.trim().toLowerCase();
      const matches = parentsCache
        .filter((p) => !linkedIds.has(p.id))
        .filter((p) => !term || p.full_name.toLowerCase().includes(term) || p.email.toLowerCase().includes(term))
        .slice(0, 50);
      resEl.innerHTML = matches.length
        ? matches
            .map(
              (p) => `
          <div class="aud-row">
            <span>${escapeHtml(p.full_name)}</span>
            <span class="aud-meta">${escapeHtml(p.email)}</span>
            <button type="button" class="icon-action sm approve" data-pick="${p.id}" title="Link" aria-label="Link" style="margin-left:8px;">${ICON.approve}</button>
          </div>`
            )
            .join("")
        : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No matches.</div>`;

      resEl.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const { error: insErr } = await supabase.from("guardians").insert({
              organization_id: profile.organization_id,
              parent_id: btn.getAttribute("data-pick"),
              student_id: studentId,
              relationship: "Parent",
            });
            if (insErr) throw insErr;
            await logAudit({ action: "user.guardian_linked", recordType: "profile", recordId: studentId });
            showToast("Parent linked.", "success");
            showAdd = false;
            search = "";
            await render();
          } catch (err) {
            console.error(err);
            showToast(friendlyError(err, "Unable to link this parent."), "error");
          }
        });
      });
    }
  }

  render();
}

// ---------- Leave types dialog: assign leave types (with an entitled amount) to a staff member ----------
let leaveTypesCache = [];

async function openLeaveTypeDialog(staffId, staffName) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lt-title">
      <h3 id="lt-title">Leave types</h3>
      <p>${escapeHtml(staffName)}</p>
      <div id="lt-body"><div class="skeleton" style="height:50px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
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

  const year = new Date().getFullYear();
  let showAdd = false;

  async function render() {
    const bodyEl = backdrop.querySelector("#lt-body");
    const { data: balances, error } = await supabase
      .from("leave_balances")
      .select("id, entitled, used, pending, leave_type_id, leave_types(name)")
      .eq("profile_id", staffId)
      .eq("period_year", year);
    if (error) {
      console.error(error);
      bodyEl.innerHTML = `<p class="text-muted">Unable to load leave types.</p>`;
      return;
    }

    if (leaveTypesCache.length === 0) {
      const { data: types, error: tErr } = await supabase.from("leave_types").select("id, name").eq("is_active", true).order("name");
      if (tErr) console.error(tErr);
      leaveTypesCache = types || [];
    }

    const assignedIds = new Set((balances || []).map((b) => b.leave_type_id));
    const available = leaveTypesCache.filter((t) => !assignedIds.has(t.id));

    bodyEl.innerHTML = `
      <p class="text-muted" style="font-size:0.8rem;">For ${year}. A staff member can have more than one type.</p>
      <div class="aud-list">
        ${
          balances && balances.length
            ? balances
                .map(
                  (b) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(b.leave_types?.name || "Unknown")}</span>
                <span class="aud-meta">${b.entitled} days${b.used || b.pending ? ` · ${b.used} used, ${b.pending} pending` : ""}</span>
                <button type="button" class="icon-action sm danger" data-remove="${b.id}" data-used="${b.used}" data-pending="${b.pending}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.reject}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No leave types assigned yet.</div>`
        }
      </div>
      ${
        available.length === 0
          ? ""
          : showAdd
          ? `<div class="field" style="margin-top:8px;">
               <label for="lt-select">Leave type</label>
               <select id="lt-select">${available.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select>
             </div>
             <div class="field">
               <label for="lt-entitled">Entitled days for ${year}</label>
               <input id="lt-entitled" type="number" min="0" step="0.25" value="0" />
             </div>
             <div style="display:flex;gap:8px;">
               <button type="button" class="btn btn-secondary btn-sm" data-act="cancel-add">Cancel</button>
               <button type="button" class="btn btn-primary btn-sm" data-act="save-add">Assign</button>
             </div>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-act="add" style="margin-top:8px;">Assign a leave type</button>`
      }
    `;

    bodyEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const used = parseFloat(btn.getAttribute("data-used") || "0");
        const pending = parseFloat(btn.getAttribute("data-pending") || "0");
        if (used > 0 || pending > 0) {
          showToast("This type has used or pending leave and can't be removed.", "error");
          return;
        }
        try {
          const { error: delErr } = await supabase.from("leave_balances").delete().eq("id", btn.getAttribute("data-remove"));
          if (delErr) throw delErr;
          showToast("Leave type removed.", "success");
          await render();
        } catch (err) {
          console.error(err);
          showToast(friendlyError(err, "Unable to remove this leave type."), "error");
        }
      });
    });

    bodyEl.querySelector('[data-act="add"]')?.addEventListener("click", () => { showAdd = true; render(); });
    bodyEl.querySelector('[data-act="cancel-add"]')?.addEventListener("click", () => { showAdd = false; render(); });
    bodyEl.querySelector('[data-act="save-add"]')?.addEventListener("click", async () => {
      const leaveTypeId = bodyEl.querySelector("#lt-select").value;
      const entitled = parseFloat(bodyEl.querySelector("#lt-entitled").value || "0");
      try {
        const { error: insErr } = await supabase.from("leave_balances").insert({
          organization_id: profile.organization_id,
          profile_id: staffId,
          leave_type_id: leaveTypeId,
          period_year: year,
          entitled,
          used: 0,
          pending: 0,
        });
        if (insErr) throw insErr;
        await logAudit({ action: "user.leave_type_assigned", recordType: "profile", recordId: staffId });
        showToast("Leave type assigned.", "success");
        showAdd = false;
        await render();
      } catch (err) {
        console.error(err);
        showToast(friendlyError(err, "Unable to assign this leave type."), "error");
      }
    });
  }

  render();
}

function searchBox(mode) {
  return `<input type="search" id="${mode}-search" class="user-search" placeholder="Search by name, email or role…" aria-label="Search ${mode} users" value="${escapeHtml(searchTerms[mode])}" autocomplete="off" style="display:block;width:100%;box-sizing:border-box;margin:0 0 12px;padding:10px 14px;border:1px solid rgba(128,128,128,.35);border-radius:10px;background:transparent;color:inherit;font:inherit;" />`;
}

// Render (or re-render) the cards of the Active / Inactive list, applying the current search
function renderCards(mode) {
  const el = document.getElementById(`${mode}-cards`);
  if (!el) return;
  const source = mode === "active" ? allActive : allInactive; // already sorted by role, then name
  const raw = searchTerms[mode].trim();
  const q = raw.toLowerCase();
  const list = q
    ? source.filter((u) => [u.full_name, u.email, u.role].some((v) => (v || "").toLowerCase().includes(q)))
    : source;
  el.innerHTML = list.length
    ? list.map((u) => userRow(u, mode)).join("")
    : `<div class="card empty-state"><p>No users match &ldquo;${escapeHtml(raw)}&rdquo;.</p></div>`;
  bindActions(el);
}

function bindActions(container) {
  container.querySelectorAll(".edit-role-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      editRole(btn.getAttribute("data-id"), btn.getAttribute("data-name"), btn.getAttribute("data-role"), btn.getAttribute("data-guest-until"))
    );
  });
  container.querySelectorAll(".guardian-btn").forEach((btn) => {
    btn.addEventListener("click", () => openGuardianDialog(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
  });
  container.querySelectorAll(".leave-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => openLeaveTypeDialog(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
  });
  container.querySelectorAll(".toggle-active-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleActive(btn.getAttribute("data-id"), btn.getAttribute("data-active") === "true"));
  });
  container.querySelectorAll(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", () => approveUser(btn.getAttribute("data-id")));
  });
  container.querySelectorAll(".delete-btn, .reject-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(btn.getAttribute("data-id"), btn.getAttribute("data-name"), btn.classList.contains("reject-btn")));
  });
}

async function load() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active, is_approved, guest_until")
      .eq("organization_id", profile.organization_id) // RLS also lets you read your own profiles in other academies
      .order("full_name");
    if (error) throw error;

    if (!data || data.length === 0) {
      listEl.innerHTML = `<div class="card empty-state"><h3>No users yet</h3></div>`;
      return;
    }

    const pending = data.filter((u) => !u.is_approved);
    allActive = sortUsers(data.filter((u) => u.is_approved && u.is_active));
    allInactive = sortUsers(data.filter((u) => u.is_approved && !u.is_active));

    const pendingSection = pending.length
      ? `
      <div class="section">
        ${sectionHead({ title: "Pending approval", icon: SECTION_ICON.pending, tone: "warning", count: pending.length })}
        <div class="user-cards" id="pending-cards">${pending.map((u) => userRow(u, "pending")).join("")}</div>
      </div>`
      : "";

    const inactiveSection = allInactive.length
      ? `
      <div class="section">
        ${sectionHead({ title: "Inactive users", icon: SECTION_ICON.inactive, tone: "muted", count: allInactive.length })}
        ${searchBox("inactive")}
        <div class="user-cards" id="inactive-cards"></div>
      </div>`
      : "";

    listEl.innerHTML = `
      ${pendingSection}
      <div class="section">
        ${sectionHead({ title: "Active users", icon: SECTION_ICON.active, tone: "success", count: allActive.length })}
        ${searchBox("active")}
        <div class="user-cards" id="active-cards"></div>
      </div>
      ${inactiveSection}
    `;

    const pendingEl = document.getElementById("pending-cards");
    if (pendingEl) bindActions(pendingEl);

    for (const mode of ["active", "inactive"]) {
      renderCards(mode);
      const input = document.getElementById(`${mode}-search`);
      if (input) {
        input.addEventListener("input", () => {
          searchTerms[mode] = input.value;
          renderCards(mode);
        });
      }
    }
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="card empty-state"><h3>Users couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Users couldn't be loaded.", "error");
  }
}

async function updateRole(id, role, guestUntil = null) {
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ role, guest_until: role === "guest" ? guestUntil : null, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    await logAudit({ action: "user.role_changed", recordType: "profile", recordId: id, details: { role, guest_until: role === "guest" ? guestUntil : null } });
    showToast("Role updated.", "success");
    load();
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

async function approveUser(id) {
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ is_approved: true, is_active: true, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    await logAudit({ action: "user.approved", recordType: "profile", recordId: id });
    showToast("User approved.", "success");
    load();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to approve this user."), "error");
  }
}

async function deleteUser(id, name, isReject) {
  const ok = await confirmDialog({
    title: isReject ? `Reject ${name}'s request?` : `Delete User?`,
    message: isReject
      ? "This permanently deletes their account. This cannot be undone — they would need to sign up again from scratch."
      : "This permanently deletes their account and all access. This cannot be undone.",
    confirmLabel: isReject ? "Reject" : "Delete",
    danger: true,
  });
  if (!ok) return;

  // Instant feedback: dim the row and disable its buttons while the request runs
  const rowEl = document.querySelector(`.user-row[data-id="${id}"]`);
  if (rowEl) {
    rowEl.style.opacity = "0.5";
    rowEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const roleEl = rowEl.querySelector(".user-role");
    if (roleEl) roleEl.textContent = isReject ? "Rejecting…" : "Deleting…";
  }

  try {
    // Never wait forever: if the function doesn't answer in 20s, stop and resync the list
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), 20000));
    const { data, error } = await Promise.race([
      supabase.functions.invoke("delete-user", { body: { userId: id } }),
      timeout,
    ]);
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to complete this action."), "error");
    load(); // the account may still have been removed, so show the real state
    return;
  }

  // Success toast first, so a slow or failing audit log can never hide it
  showToast(isReject ? "Request rejected." : "User deleted.", "success");
  Promise.resolve(logAudit({ action: isReject ? "user.rejected" : "user.deleted", recordType: "profile", recordId: id })).catch((e) =>
    console.error("Audit log failed:", e)
  );
  load();
}

load();
