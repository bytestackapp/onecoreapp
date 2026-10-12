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

// Search state (kept outside load() so the search text survives re-renders after actions)
let allActive = [];
let allInactive = [];
const searchTerms = { active: "", inactive: "" };
const roleFilters = { active: "", inactive: "" };

// Students that have a linked parent: Map(student_id -> number of parent links).
// null = unknown (no badge is shown). Cached locally so normal page loads make no database call.
let linkedStudentIds = null;
let linksSyncedAt = 0;
const LINKS_CACHE_KEY = `admin-users:student-links:${profile.organization_id}`;
const LINKS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // full re-sync at most once a week
const LINKS_PAGE_SIZE = 1000;                  // Supabase returns max 1000 rows per request

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

// ---------- Student link status (cache-first) ----------
function readLinksCache() {
  try {
    const raw = localStorage.getItem(LINKS_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || typeof c.syncedAt !== "number" || !c.counts) return null;
    if (Date.now() - c.syncedAt > LINKS_TTL_MS) return null; // too old: re-sync
    linksSyncedAt = c.syncedAt;
    return new Map(Object.entries(c.counts));
  } catch {
    return null;
  }
}

function saveLinksCache() {
  if (!linkedStudentIds) return;
  try {
    localStorage.setItem(
      LINKS_CACHE_KEY,
      JSON.stringify({ syncedAt: linksSyncedAt, counts: Object.fromEntries(linkedStudentIds) })
    );
  } catch (e) {
    console.error(e); // storage full or blocked: the page still works, just without the cache
  }
}

function invalidateLinksCache() {
  linkedStudentIds = null;
  try { localStorage.removeItem(LINKS_CACHE_KEY); } catch {}
}

// Memory first, then local cache, and only then the database (paged, read-only)
async function loadLinkedStudents(force = false) {
  if (!force) {
    if (linkedStudentIds) return;
    const cached = readLinksCache();
    if (cached) { linkedStudentIds = cached; return; }
  }
  try {
    const counts = new Map();
    for (let from = 0; ; from += LINKS_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("guardians")
        .select("student_id")
        .eq("organization_id", profile.organization_id)
        .order("id")
        .range(from, from + LINKS_PAGE_SIZE - 1);
      if (error) throw error;
      for (const r of data || []) counts.set(r.student_id, (counts.get(r.student_id) || 0) + 1);
      if (!data || data.length < LINKS_PAGE_SIZE) break;
    }
    linkedStudentIds = counts;
    linksSyncedAt = Date.now();
    saveLinksCache();
  } catch (err) {
    console.error(err);
    linkedStudentIds = null; // unknown: show no badge instead of a wrong one
  }
}

// Apply one link (+1) or unlink (-1) locally and redraw only the cards. No database call.
function adjustLink(studentId, delta) {
  if (!linkedStudentIds || !studentId) return;
  const n = (linkedStudentIds.get(studentId) || 0) + delta;
  if (n > 0) linkedStudentIds.set(studentId, n);
  else linkedStudentIds.delete(studentId);
  saveLinksCache();
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

  const editBtn = actionBtn({ cls: "edit-role-btn", icon: "edit", label: "Edit role", attrs: common, disabled: isSelf || adminLocked });
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
        actionBtn({ cls: "danger delete-btn", icon: "delete", label: "Delete", attrs: common, disabled: isSelf || adminLocked }) +
        editBtn;

  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  const roleLine = escapeHtml(roleLabel) + (u.role === "guest" ? (u.guest_until ? ` · until ${escapeHtml(u.guest_until)}` : " · no end date") : "");

  const linkBadge =
    u.role === "student" && mode !== "pending" && linkedStudentIds
      ? linkedStudentIds.has(u.id)
        ? ` · <span class="link-status linked">Linked</span>`
        : ` · <span class="link-status not-linked">Not Linked</span>`
      : "";

  return `
    <div class="card user-row ${mode === "inactive" ? "is-inactive" : ""}" data-id="${u.id}">
      <div class="user-meta">
        <div class="user-name">${name}${isSelf ? " (you)" : ""}</div>
        <div class="user-email">${escapeHtml(u.email)}</div>
        <div class="user-role">${roleLine}${linkBadge}</div>
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
            await render();   // refresh the Linked Student list behind
            renderRows();     // mark this student as linked
          } catch (err) {
            console.error(err);
            btn.disabled = false;
            showToast(friendlyError(err, "Unable to link this student."), "error");
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
      ? { title: "Active users", icon: SECTION_ICON.active, tone: "info" }
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

// Render (or re-render) the cards of the Active / Inactive list, applying the current search
function renderCards(mode) {
  const el = document.getElementById(`${mode}-cards`);
  if (!el) return;
  const source = mode === "active" ? allActive : allInactive; // already sorted by role, then name
  const raw = searchTerms[mode].trim();
  const q = raw.toLowerCase();
  const role = roleFilters[mode];
  const list = source.filter(
    (u) => (!role || u.role === role) && (!q || [u.full_name, u.email].some((v) => (v || "").toLowerCase().includes(q)))
  );

  // Keep the header count in sync with the filtered list
  const head = document.getElementById(`${mode}-head`);
  if (head) head.innerHTML = userSectionHead(mode, list.length);

  el.innerHTML = list.length
    ? list.map((u) => userRow(u, mode)).join("")
    : `<div class="card empty-state"><p>No users match your search or role filter.</p></div>`;
  bindActions(el);
}

function bindActions(container) {
  container.querySelectorAll(".edit-role-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      editRole(btn.getAttribute("data-id"), btn.getAttribute("data-name"), btn.getAttribute("data-role"), btn.getAttribute("data-guest-until"))
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

    await loadLinkedStudents();

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
        <div id="inactive-head">${userSectionHead("inactive", allInactive.length)}</div>
        ${searchBox("inactive")}
        <div class="user-cards" id="inactive-cards"></div>
      </div>`
      : "";

    listEl.innerHTML = `
      ${pendingSection}
      <div class="section">
        <div id="active-head">${userSectionHead("active", allActive.length)}</div>
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
      const roleSel = document.getElementById(`${mode}-role`);
      if (roleSel) {
        roleSel.addEventListener("change", () => {
          roleFilters[mode] = roleSel.value;
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
  invalidateLinksCache(); // next load() re-syncs the links once
  Promise.resolve(logAudit({ action: isReject ? "user.rejected" : "user.deleted", recordType: "profile", recordId: id })).catch((e) =>
    console.error("Audit log failed:", e)
  );
  load();
}

load();
