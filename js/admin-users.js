import { mountLayout, sectionHead } from "./layout.js";
import { supabase, initials, friendlyError, logAudit, isPlatformOwner } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";
import { yearPH } from "./time.js";

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

// ---------- List state ----------
// Lists are read from the database one page at a time and never cached, so what you see is always current.
const PAGE_SIZE = 20;
const STAFF_ROLES = ["admin", "teacher"];           // shown first: page 1 of the Active list
const OTHER_ROLES = ["student", "parent", "guest"]; // page 2 onwards, in this order
const USER_COLS = "id, full_name, email, role, is_active, is_approved, guest_until";
const listState = {
  active:   { page: 1, rows: [], total: 0, pages: 1, counts: null, seq: 0 },
  inactive: { page: 1, rows: [], total: 0, pages: 1, counts: null, seq: 0 },
};
const searchTerms = { active: "", inactive: "" };
const roleFilters = { active: "", inactive: "" };
const searchTimers = {};
let pendingUsers = [];
let inactiveAny = 0; // how many approved users are inactive (ignores search and filters)

// Which students have a linked parent. Looked up for the students on the current page only.
const linkCounts = new Map();  // student_id -> number of parent links
const linkChecked = new Set(); // students whose link status has been looked up

const ICON = {
  approve:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  add:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  reject:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  edit:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  deactivate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
  activate:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1011.4 0"/></svg>`,
  delete:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>`,
  children:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5.5" r="2.5"/><path d="M12 8.5v6M7.5 11l4.5 1.5 4.5-1.5M9 21l3-6.5 3 6.5"/></svg>`,
  leaveType:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
};

const SECTION_ICON = {
  pending:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  active:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/></svg>`,
  inactive:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M18 8l5 5M23 8l-5 5"/></svg>`,
};

// ---------- Student link status (looked up per page) ----------
try { localStorage.removeItem(`admin-users:student-links:${profile.organization_id}`); } catch {} // old 7-day cache, no longer used

async function loadLinksFor(rows) {
  const ids = rows.filter((u) => u.role === "student").map((u) => u.id);
  if (!ids.length) return;
  try {
    const { data, error } = await supabase
      .from("guardians")
      .select("student_id")
      .eq("organization_id", profile.organization_id)
      .in("student_id", ids);
    if (error) throw error;
    ids.forEach((id) => { linkCounts.delete(id); linkChecked.add(id); });
    for (const r of data || []) linkCounts.set(r.student_id, (linkCounts.get(r.student_id) || 0) + 1);
  } catch (err) {
    console.error(err);
    ids.forEach((id) => linkChecked.delete(id)); // unknown: show no badge instead of a wrong one
  }
}

// Apply one link (+1) or unlink (-1) locally and redraw only the cards. No database call.
function adjustLink(studentId, delta) {
  if (!studentId || !linkChecked.has(studentId)) return;
  const n = (linkCounts.get(studentId) || 0) + delta;
  if (n > 0) linkCounts.set(studentId, n);
  else linkCounts.delete(studentId);
  renderCards("active");
  renderCards("inactive");
}

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
  const common = `data-id="${u.id}" data-name="${name}" data-role="${escapeHtml(u.role)}" data-guest-until="${escapeHtml(u.guest_until || "")}"`;

  const editBtn = actionBtn({ cls: "edit-role-btn", icon: "edit", label: "Edit role", attrs: `${common} data-mode="${mode}"`, disabled: isSelf || adminLocked });
  const childBtn =
    mode !== "pending" && ["parent", "teacher", "admin"].includes(u.role)
      ? actionBtn({ cls: "child-btn", icon: "children", label: "Children", attrs: common })
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
      : childBtn +
        leaveTypeBtn +
        actionBtn({
          cls: "toggle-active-btn",
          icon: u.is_active ? "deactivate" : "activate",
          label: u.is_active ? "Deactivate" : "Activate",
          attrs: `${common} data-active="${u.is_active}"`,
          disabled: isSelf || adminLocked,
        }) +
        editBtn;

  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  const roleLine = escapeHtml(roleLabel) + (u.role === "guest" ? (u.guest_until ? ` · until ${escapeHtml(u.guest_until)}` : " · no end date") : "");

  const linkBadge =
    u.role === "student" && mode !== "pending" && linkChecked.has(u.id)
      ? (linkCounts.get(u.id) || 0) > 0
        ? ` · <span class="link-status linked">Linked</span>`
        : ` · <span class="link-status not-linked">Not Linked</span>`
      : "";

  return `
    <div class="card user-row ${mode === "inactive" ? "is-inactive" : ""}${mode === "pending" ? " is-pending" : ""}" data-id="${u.id}">
      <div class="user-meta">
        <div class="user-name">${name}${isSelf ? " (you)" : ""}</div>
        <div class="user-email">${escapeHtml(u.email)}</div>
        <div class="user-role">${roleLine}${linkBadge}</div>
      </div>
      <div class="user-actions">${actions}</div>
    </div>`;
}

// Small modal for choosing a role. Resolves to the chosen role, or null if cancelled.
function roleDialog({ name, role, guestUntil, canDelete = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="role-dialog-title">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <h3 id="role-dialog-title">Edit role</h3>
          ${canDelete ? `<button type="button" class="icon-action sm danger" data-act="delete" title="Delete user" aria-label="Delete user">${ICON.delete}</button>` : ""}
        </div>
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
    backdrop.querySelector('[data-act="delete"]')?.addEventListener("click", () => close({ delete: true }));
    backdrop.querySelector('[data-act="save"]').addEventListener("click", () => close({ role: select.value, guestUntil: select.value === "guest" ? guestInput.value || null : null }));
  });
}

async function editRole(id, name, currentRole, currentGuestUntil, mode) {
  const result = await roleDialog({ name, role: currentRole, guestUntil: currentGuestUntil, canDelete: mode !== "pending" });
  if (!result) return;
  if (result.delete) {
    await deleteUser(id, name, false); // asks for its own confirmation
    return;
  }
  if (result.role === currentRole && (result.guestUntil || "") === (currentGuestUntil || "")) return;
  await updateRole(id, result.role, result.guestUntil);
}

// ---------- Linked Student dialog: the students (children) linked to a parent ----------
let studentsCache = [];

async function loadStudents() {
  if (studentsCache.length) return;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("organization_id", profile.organization_id)
    .eq("role", "student")
    .eq("is_active", true);
  if (error) console.error(error);
  studentsCache = (data || []).sort((x, y) => (x.full_name || "").localeCompare(y.full_name || "", undefined, { sensitivity: "base" }));
}

// Students that already have a parent (a student can only have one), read 1000 at a time
async function loadLinkedStudentIds() {
  const ids = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("guardians")
      .select("student_id")
      .eq("organization_id", profile.organization_id)
      .order("id")
      .range(from, from + 999);
    if (error) { console.error(error); break; }
    (data || []).forEach((r) => ids.add(r.student_id));
    if (!data || data.length < 1000) break;
  }
  return ids;
}

async function openChildDialog(parentId, parentName) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="cd-title">
      <div class="linked-head">
        <h3 id="cd-title">Linked Student</h3>
        <button type="button" class="icon-action approve" data-act="open-picker" title="Add student" aria-label="Add student">${ICON.add}</button>
      </div>
      <p>${escapeHtml(parentName)}</p>
      <div id="cd-body"><div class="skeleton" style="height:50px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let pickerOpen = false;
  let linkedIds = new Set();

  const onKey = (e) => { if (e.key === "Escape" && !pickerOpen) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
  backdrop.querySelector('[data-act="open-picker"]').addEventListener("click", openPicker);

  async function render() {
    const bodyEl = backdrop.querySelector("#cd-body");
    const { data: links, error } = await supabase
      .from("guardians")
      .select("id, student_id, profiles!guardians_student_id_fkey(full_name)")
      .eq("parent_id", parentId);
    if (error) {
      console.error(error);
      bodyEl.innerHTML = `<p class="text-muted">Unable to load linked students.</p>`;
      return;
    }
    linkedIds = new Set((links || []).map((l) => l.student_id));

    const sorted = [...(links || [])].sort((x, y) =>
      (x.profiles?.full_name || "").localeCompare(y.profiles?.full_name || "", undefined, { sensitivity: "base" })
    );

    bodyEl.innerHTML = `
      <div class="aud-list">
        ${
          sorted.length
            ? sorted
                .map(
                  (l) => `
              <div class="aud-row" style="cursor:default;">
                <span style="flex:1;min-width:0;">${escapeHtml(l.profiles?.full_name || "Unknown")}</span>
                <button type="button" class="icon-action sm danger" data-unlink="${l.id}" data-student="${l.student_id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.reject}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No linked students yet.</div>`
        }
      </div>`;

    bodyEl.querySelectorAll("[data-unlink]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const { error: delErr } = await supabase.from("guardians").delete().eq("id", btn.getAttribute("data-unlink"));
          if (delErr) throw delErr;
          showToast("Student unlinked.", "success");
          adjustLink(btn.getAttribute("data-student"), -1);
          await render();
        } catch (err) {
          console.error(err);
          showToast(friendlyError(err, "Unable to remove this link."), "error");
        }
      });
    });
  }

  // Second modal: every active student in a table-style list, searchable by name
  async function openPicker() {
    pickerOpen = true;
    const pBackdrop = document.createElement("div");
    pBackdrop.className = "dialog-backdrop";
    pBackdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="sp-title">
        <h3 id="sp-title">Add student</h3>
        <div class="field aud-search"><input type="search" id="sp-search" placeholder="Search by name…" autocomplete="off" /></div>
        <div class="picker-scroll"><div id="sp-results"><div class="skeleton" style="height:50px;"></div></div></div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-primary" data-act="close">Done</button>
        </div>
      </div>`;
    document.body.appendChild(pBackdrop);

    const onPickerKey = (e) => { if (e.key === "Escape") closePicker(); };
    function closePicker() {
      document.removeEventListener("keydown", onPickerKey);
      pBackdrop.remove();
      pickerOpen = false;
    }
    document.addEventListener("keydown", onPickerKey);
    pBackdrop.addEventListener("click", (e) => { if (e.target === pBackdrop) closePicker(); });
    pBackdrop.querySelector('[data-act="close"]').addEventListener("click", closePicker);

    const input = pBackdrop.querySelector("#sp-search");
    const resEl = pBackdrop.querySelector("#sp-results");
    input.focus();

    await loadStudents();
    const takenIds = await loadLinkedStudentIds();

    function renderRows() {
      const term = input.value.trim().toLowerCase();
      const rows = studentsCache.filter((st) => !term || (st.full_name || "").toLowerCase().includes(term));
      resEl.innerHTML = rows.length
        ? `<table class="picker-table">
             <thead><tr><th>Name</th><th></th></tr></thead>
             <tbody>${rows
               .map(
                 (st) => `
               <tr>
                 <td>${escapeHtml(st.full_name)}</td>
                 <td class="picker-action">${
                   linkedIds.has(st.id)
                     ? `<span class="text-muted" style="font-size:0.8rem;">Linked</span>`
                     : takenIds.has(st.id)
                     ? `<span class="text-muted" style="font-size:0.8rem;">Taken</span>`
                     : `<button type="button" class="icon-action sm approve" data-pick="${st.id}" title="Link" aria-label="Link ${escapeHtml(st.full_name)}">${ICON.add}</button>`
                 }</td>
               </tr>`
               )
               .join("")}</tbody>
           </table>`
        : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No students found.</div>`;

      resEl.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const studentId = btn.getAttribute("data-pick");
          btn.disabled = true;
          try {
            const { error: insErr } = await supabase.from("guardians").insert({
              organization_id: profile.organization_id,
              parent_id: parentId,
              student_id: studentId,
              relationship: "Parent",
            });
            if (insErr) throw insErr;
            await logAudit({ action: "user.child_linked", recordType: "profile", recordId: studentId });
            showToast("Student linked.", "success");
            adjustLink(studentId, 1);
            takenIds.add(studentId);
            await render();   // refresh the Linked Student list behind
            renderRows();     // mark this student as linked
          } catch (err) {
            console.error(err);
            btn.disabled = false;
            showToast(err?.code === "23505" ? "This student is already linked to a parent." : friendlyError(err, "Unable to link this student."), "error");
          }
        });
      });
    }

    input.addEventListener("input", renderRows);
    renderRows();
  }

  render();
}

// ---------- Leave types dialog: assign leave types (with an entitled amount) to a staff member ----------
let leaveTypesCache = [];

// "5 days/year": the yearly amount set for the leave type in Settings (not this person's running balance)
function daysPerYearText(t) {
  const raw = t?.default_entitlement;
  const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? `${n} ${n === 1 ? "day" : "days"}/year` : "";
}

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

  const year = yearPH();
  let showAdd = false;

  async function render() {
    const bodyEl = backdrop.querySelector("#lt-body");
    const { data: balances, error } = await supabase
      .from("leave_balances")
      .select("id, entitled, used, pending, leave_type_id, leave_types(name, default_entitlement)")
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
                <span class="aud-meta">${daysPerYearText(b.leave_types)}</span>
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
      if (!Number.isFinite(entitled) || entitled < 0) {
        showToast("Please enter 0 or more days.", "error");
        return;
      }
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

// Section header for the Active / Inactive lists. Re-rendered on every filter
// change so the count matches what is actually shown.
function userSectionHead(mode, count) {
  const cfg =
    mode === "active"
      ? {
          title: "Active users",
          icon: SECTION_ICON.active,
          tone: "info",
          linkHtml: `<a class="link" href="reports.html?import=links#linked">Link students to parents</a>`,
        }
      : { title: "Inactive users", icon: SECTION_ICON.inactive, tone: "info" };
  return sectionHead({ ...cfg, count });
}

function searchBox(mode) {
  const roleOptions = [["", "All roles"], ["admin", "Admin"], ["teacher", "Teacher"], ["parent", "Parent"], ["student", "Student"], ["guest", "Guest"]]
    .map(([v, l]) => `<option value="${v}" ${roleFilters[mode] === v ? "selected" : ""}>${l}</option>`)
    .join("");
  return `<div class="user-filters">
    <input type="search" id="${mode}-search" class="user-search" placeholder="Search by name or email…" aria-label="Search ${mode} users" value="${escapeHtml(searchTerms[mode])}" autocomplete="off" />
    <select id="${mode}-role" class="user-role-filter" aria-label="Filter ${mode} users by role">${roleOptions}</select>
  </div>`;
}

// ---------- Loading (one page at a time) ----------
function baseQuery(mode, opts) {
  return supabase
    .from("profiles")
    .select(USER_COLS, opts)
    .eq("organization_id", profile.organization_id) // RLS also lets you read your own profiles in other academies
    .eq("is_approved", true)
    .eq("is_active", mode === "active");
}

// Search text -> PostgREST "or" filter (characters that could break the filter are removed)
function searchClause(mode) {
  const s = searchTerms[mode].replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();
  return s ? `full_name.ilike.%${s}%,email.ilike.%${s}%` : "";
}

// Which rows of the "others" group (students, then parents, then guests) fall on one page
function pageSegments(offset, limit, counts) {
  const segs = [];
  let start = 0; // position in the whole group where this role begins
  for (const role of OTHER_ROLES) {
    const n = counts[role] || 0;
    const from = Math.max(offset, start) - start;
    const to = Math.min(offset + limit, start + n) - start; // exclusive
    if (to > from) segs.push({ role, from, to: to - 1 });
    start += n;
  }
  return segs;
}

// Head-only count queries (no rows are downloaded)
async function fetchCounts() {
  const results = await Promise.all([
    baseQuery("active", { count: "exact", head: true }).in("role", STAFF_ROLES),
    ...OTHER_ROLES.map((r) => baseQuery("active", { count: "exact", head: true }).eq("role", r)),
  ]);
  for (const r of results) if (r.error) throw r.error;
  const counts = { staff: results[0].count || 0 };
  OTHER_ROLES.forEach((r, i) => (counts[r] = results[i + 1].count || 0));
  return counts;
}

// Reads one page of a list. Returns { rows, total, pages, page, counts }.
async function fetchPage(mode) {
  const st = listState[mode];
  const filtered = Boolean(roleFilters[mode] || searchClause(mode));
  let page = st.page;
  let rows = [];
  let total = 0;
  let pages = 1;
  let counts = st.counts;

  if (mode === "active" && !filtered) {
    // Page 1 = admins and teachers. Page 2 onwards = students, then parents, then guests.
    if (!counts) counts = await fetchCounts();
    const othersTotal = OTHER_ROLES.reduce((sum, r) => sum + counts[r], 0);
    total = counts.staff + othersTotal;
    pages = 1 + Math.ceil(othersTotal / PAGE_SIZE);
    page = Math.min(Math.max(page, 1), pages);
    if (page === 1) {
      const { data, error } = await baseQuery("active").in("role", STAFF_ROLES).order("full_name").order("id").limit(200);
      if (error) throw error;
      rows = sortUsers(data || []);
    } else {
      const segs = pageSegments((page - 2) * PAGE_SIZE, PAGE_SIZE, counts);
      const parts = await Promise.all(
        segs.map(async (s) => {
          const { data, error } = await baseQuery("active").eq("role", s.role).order("full_name").order("id").range(s.from, s.to);
          if (error) throw error;
          return data || [];
        })
      );
      rows = parts.flat();
    }
  } else {
    // Searching / filtering (or the Inactive list): one query, sorted by name
    counts = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const from = (page - 1) * PAGE_SIZE;
      let q = baseQuery(mode, { count: "exact" });
      if (roleFilters[mode]) q = q.eq("role", roleFilters[mode]);
      const clause = searchClause(mode);
      if (clause) q = q.or(clause);
      const { data, count, error } = await q.order("full_name").order("id").range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      total = count || 0;
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      rows = data || [];
      if (page <= pages) break;
      page = pages; // the list got shorter (for example after a delete): go to the last page
    }
  }

  await loadLinksFor(rows);
  return { rows, total, pages, page, counts };
}

function applyResult(mode, res) {
  Object.assign(listState[mode], { rows: res.rows, total: res.total, pages: res.pages, page: res.page, counts: res.counts });
}

// Re-read one list from the database and redraw it (used by search, role filter and the pager)
async function refreshList(mode) {
  const st = listState[mode];
  const seq = ++st.seq;
  const el = document.getElementById(`${mode}-cards`);
  if (el) el.style.opacity = "0.5";
  try {
    const res = await fetchPage(mode);
    if (seq !== st.seq) return; // a newer request replaced this one
    applyResult(mode, res);
  } catch (err) {
    console.error(err);
    if (seq === st.seq) showToast("Users couldn't be loaded.", "error");
  }
  if (seq !== st.seq) return;
  if (el) el.style.opacity = "";
  renderCards(mode);
}

// Pager: first, previous, "Page [select] of N", next, last
function pagerHtml(page, pages) {
  if (pages <= 1) return "";
  const btn = (act, label, path, off) =>
    `<button type="button" class="icon-action sm" data-pg="${act}" title="${label}" aria-label="${label}" ${off ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></button>`;
  const options = Array.from({ length: pages }, (_, i) => `<option value="${i + 1}" ${i + 1 === page ? "selected" : ""}>${i + 1}</option>`).join("");
  return `<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;">
    ${btn("first", "First page", "M11 17l-5-5 5-5M18 17l-5-5 5-5", page <= 1)}
    ${btn("prev", "Previous page", "M15 18l-6-6 6-6", page <= 1)}
    <span class="text-muted" style="font-size:0.85rem;display:flex;align-items:center;gap:6px;white-space:nowrap;">Page
      <select data-pg="select" aria-label="Go to page" style="width:auto;min-width:0;padding:4px 24px 4px 8px;">${options}</select>
      of ${pages}</span>
    ${btn("next", "Next page", "M9 18l6-6-6-6", page >= pages)}
    ${btn("last", "Last page", "M13 17l5-5-5-5M6 17l5-5-5-5", page >= pages)}
  </div>`;
}

function bindPager(container, page, pages, goTo) {
  container.querySelector('[data-pg="first"]')?.addEventListener("click", () => goTo(1));
  container.querySelector('[data-pg="prev"]')?.addEventListener("click", () => goTo(page - 1));
  container.querySelector('[data-pg="next"]')?.addEventListener("click", () => goTo(page + 1));
  container.querySelector('[data-pg="last"]')?.addEventListener("click", () => goTo(pages));
  container.querySelector('[data-pg="select"]')?.addEventListener("change", (e) => goTo(Number(e.target.value)));
}

function renderPager(mode) {
  const el = document.getElementById(`${mode}-pager`);
  if (!el) return;
  const st = listState[mode];
  el.innerHTML = pagerHtml(st.page, st.pages);
  bindPager(el, st.page, st.pages, (n) => {
    st.page = n;
    refreshList(mode);
    document.getElementById(`${mode}-head`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// Draw the page already in memory (no database call)
function renderCards(mode) {
  const el = document.getElementById(`${mode}-cards`);
  if (!el) return;
  const st = listState[mode];
  const head = document.getElementById(`${mode}-head`);
  if (head) head.innerHTML = userSectionHead(mode, st.total);
  el.innerHTML = st.rows.length
    ? st.rows.map((u) => userRow(u, mode)).join("")
    : `<div class="card empty-state"><p>No users match your search or role filter.</p></div>`;
  bindActions(el);
  renderPager(mode);
}

function bindActions(container) {
  container.querySelectorAll(".edit-role-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      editRole(btn.getAttribute("data-id"), btn.getAttribute("data-name"), btn.getAttribute("data-role"), btn.getAttribute("data-guest-until"), btn.getAttribute("data-mode"))
    );
  });
  container.querySelectorAll(".child-btn").forEach((btn) => {
    btn.addEventListener("click", () => openChildDialog(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
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
    listState.active.counts = null;
    listState.inactive.counts = null;
    const org = profile.organization_id;
    const [pendingRes, inactiveRes, activeRes] = await Promise.all([
      supabase.from("profiles").select(USER_COLS).eq("organization_id", org).eq("is_approved", false).order("full_name").range(0, 499),
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("is_approved", true).eq("is_active", false),
      fetchPage("active"),
    ]);
    if (pendingRes.error) throw pendingRes.error;
    if (inactiveRes.error) throw inactiveRes.error;
    pendingUsers = pendingRes.data || [];
    inactiveAny = inactiveRes.count || 0;
    applyResult("active", activeRes);
    if (inactiveAny > 0) applyResult("inactive", await fetchPage("inactive"));
    else Object.assign(listState.inactive, { rows: [], total: 0, pages: 1, page: 1, counts: null });

    if (!pendingUsers.length && inactiveAny === 0 && listState.active.total === 0 && !searchTerms.active && !roleFilters.active) {
      listEl.innerHTML = `<div class="card empty-state"><h3>No users yet</h3></div>`;
      return;
    }

    const pendingSection = pendingUsers.length
      ? `
      <div class="section">
        ${sectionHead({ title: "Pending approval", icon: SECTION_ICON.pending, tone: "info", count: pendingUsers.length })}
        <div class="user-cards" id="pending-cards">${pendingUsers.map((u) => userRow(u, "pending")).join("")}</div>
      </div>`
      : "";

    const inactiveSection = inactiveAny > 0
      ? `
      <div class="section">
        <div id="inactive-head">${userSectionHead("inactive", listState.inactive.total)}</div>
        ${searchBox("inactive")}
        <div class="user-cards" id="inactive-cards"></div>
        <div id="inactive-pager"></div>
      </div>`
      : "";

    listEl.innerHTML = `
      ${pendingSection}
      <div class="section">
        <div id="active-head">${userSectionHead("active", listState.active.total)}</div>
        ${searchBox("active")}
        <div class="user-cards" id="active-cards"></div>
        <div id="active-pager"></div>
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
          listState[mode].page = 1;
          clearTimeout(searchTimers[mode]);
          searchTimers[mode] = setTimeout(() => refreshList(mode), 300); // wait until typing pauses
        });
      }
      const roleSel = document.getElementById(`${mode}-role`);
      if (roleSel) {
        roleSel.addEventListener("change", () => {
          roleFilters[mode] = roleSel.value;
          listState[mode].page = 1;
          refreshList(mode);
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
