import { mountLayout } from "./layout.js";
import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "groups", pageTitle: "Groups" });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
const listEl = document.getElementById("groups-list");
const newBtn = document.getElementById("new-btn");

const GROUP_TYPE_LABELS = { class: "Class", department: "Department", club: "Club", team: "Team", parent_group: "Parent Group" };

const ICON = {
  add:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  remove: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  show:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  manage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3h-6l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.7 7.7 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1L9 21h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4z"/></svg>`,
  import: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/></svg>`,
  trash:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
};

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Who can be a head, per group type ----------
function headOptionsFor(groupType) {
  if (groupType === "class" || groupType === "department") {
    return [{ role: "adviser", personRoles: ["teacher"], label: "Teacher head" }];
  }
  if (groupType === "club" || groupType === "team") {
    return [
      { role: "adviser", personRoles: ["teacher"], label: "Teacher head" },
      { role: "lead", personRoles: ["student"], label: "Student head" },
    ];
  }
  if (groupType === "parent_group") {
    return [
      { role: "adviser", personRoles: ["teacher", "admin"], label: "Staff head" },
      { role: "parent_head", personRoles: ["parent"], label: "Parent head" },
    ];
  }
  return [];
}
function headRoleLabel(groupType, memberRole) {
  return headOptionsFor(groupType).find((o) => o.role === memberRole)?.label || "Head";
}
function isHeadRole(role) {
  return role === "adviser" || role === "lead" || role === "parent_head";
}

// Admins manage every group. Any head of a group (teacher, student or parent) can manage that group's members.
const isTeacher = profile.role === "teacher";
function canManageGroup(g) {
  return isAdmin || (g.group_members || []).some((m) => m.profile_id === profile.id && isHeadRole(m.member_role));
}

// ---------- New group modal ----------
if (isAdmin) newBtn.style.display = "inline-flex";

function newGroupDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ng-title">
      <h3 id="ng-title">New group</h3>
      <form id="new-form">
        <div class="field">
          <label for="name">Name</label>
          <input id="name" required placeholder="e.g. Grade 4 - Section A" />
        </div>
        <div class="field">
          <label for="group_type">Type</label>
          <select id="group_type">
            <option value="class">Class</option>
            <option value="department">Department</option>
            <option value="club">Club</option>
            <option value="team">Team</option>
            <option value="parent_group">Parent Group</option>
          </select>
        </div>
        <div class="field">
          <label for="description">Description</label>
          <input id="description" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="ng-submit">Create</button>
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
  backdrop.querySelector("#name").focus();

  backdrop.querySelector("#new-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#ng-submit");
    submitBtn.disabled = true;
    try {
      const { data, error } = await supabase
        .from("groups")
        .insert({
          organization_id: profile.organization_id,
          name: backdrop.querySelector("#name").value.trim(),
          group_type: backdrop.querySelector("#group_type").value,
          description: backdrop.querySelector("#description").value.trim() || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      await logAudit({ action: "group.created", recordType: "group", recordId: data.id, details: { name: data.name } });
      close();
      showToast("Group created.", "success");
      loadGroups();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to create this group. Please try again."), "error");
      submitBtn.disabled = false;
    }
  });
}

newBtn?.addEventListener("click", newGroupDialog);

// ---------- Paging ----------
const PAGE_SIZE = 10; // groups per page
let page = 1;
let myGroupIds = null; // the groups I belong to (non-admins), read once per loadGroups()
let loadSeq = 0;
const HEAD_ROLES = ["adviser", "lead", "parent_head"]; // member_role values that make someone a head

// Number of regular members per group, for the groups on the current page.
// One call to the database function group_member_counts(). If that function hasn't been
// created yet, falls back to one small count query per group (still no member rows downloaded).
async function fetchMemberCounts(ids) {
  const counts = {};
  const { data, error } = await supabase.rpc("group_member_counts", { p_group_ids: ids });
  if (!error) {
    (data || []).forEach((r) => (counts[r.group_id] = Number(r.member_count) || 0));
    return counts;
  }
  console.warn("group_member_counts() is not available, counting group by group instead.", error);
  await Promise.all(
    ids.map(async (id) => {
      const { count, error: cErr } = await supabase
        .from("group_members")
        .select("id", { count: "exact", head: true })
        .eq("group_id", id)
        .eq("member_role", "member");
      if (cErr) throw cErr;
      counts[id] = count || 0;
    })
  );
  return counts;
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

// ---------- List ----------
// Reload from the start of the load cycle (after create, delete, or closing the manage dialog).
// Stays on the current page.
async function loadGroups() {
  myGroupIds = null; // re-read my memberships
  await loadPage(true);
}

// Reads and draws one page of groups
async function loadPage(showSkeleton = false) {
  const seq = ++loadSeq;
  if (showSkeleton) listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  else listEl.style.opacity = "0.5";
  try {
    if (!isAdmin && myGroupIds === null) {
      const { data: memberships, error: mErr } = await supabase.from("group_members").select("group_id").eq("profile_id", profile.id);
      if (mErr) throw mErr;
      myGroupIds = (memberships || []).map((m) => m.group_id);
    }
    if (!isAdmin && myGroupIds.length === 0) {
      if (seq !== loadSeq) return;
      listEl.style.opacity = "";
      listEl.innerHTML = emptyState();
      return;
    }

    let rows = [];
    let total = 0;
    let pages = 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const from = (page - 1) * PAGE_SIZE;
      let query = supabase
        .from("groups")
        .select("id, name, group_type, description, group_members(profile_id, member_role, profiles(full_name, role))", { count: "exact" })
        .eq("organization_id", profile.organization_id)
        .order("name")
        .order("id");
      query = query.in("group_members.member_role", HEAD_ROLES); // only the heads are embedded, not every member
      if (!isAdmin) query = query.in("id", myGroupIds);
      const { data, count, error } = await query.range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows = data || [];
      total = count || 0;
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page <= pages) break;
      page = pages; // the list got shorter (for example after a delete): go to the last page
    }
    const memberCounts = rows.length ? await fetchMemberCounts(rows.map((g) => g.id)) : {};
    rows.forEach((g) => (g.member_count = memberCounts[g.id] || 0));
    if (seq !== loadSeq) return; // a newer request replaced this one
    listEl.style.opacity = "";

    if (total === 0) {
      listEl.innerHTML = emptyState();
      return;
    }

    listEl.innerHTML = rows.map((g) => groupCard(g)).join("") + pagerHtml(page, pages);

    bindPager(listEl, page, pages, (n) => {
      page = n;
      loadPage();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    listEl.querySelectorAll(".show-btn").forEach((btn) => {
      btn.addEventListener("click", () => openViewDialog(btn.getAttribute("data-id")));
    });
    listEl.querySelectorAll(".manage-btn").forEach((btn) => {
      btn.addEventListener("click", () => openManageDialog(btn.getAttribute("data-id")));
    });
    listEl.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteGroup(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    listEl.style.opacity = "";
    listEl.innerHTML = `<div class="card empty-state"><h3>Groups couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Groups couldn't be loaded.", "error");
  }
}

async function deleteGroup(id, name) {
  // Count class attendance recorded against this group so the admin knows what is at stake.
  const { count } = await supabase.from("attendance_records").select("id", { count: "exact", head: true }).eq("group_id", id);
  const attendanceCount = count || 0;

  const ok = await confirmDialog({
    title: `Delete ${name}?`,
    message:
      attendanceCount > 0
        ? `This group has ${attendanceCount} class attendance record${attendanceCount === 1 ? "" : "s"}, which may be removed with it. Its member list will also be removed. This cannot be undone.`
        : "The group and its member list will be removed. This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  try {
    const { data, error } = await supabase
      .from("groups")
      .delete()
      .eq("id", id)
      .eq("organization_id", profile.organization_id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("row-level security");
    await logAudit({ action: "group.deleted", recordType: "group", recordId: id, details: { name, attendance_records: attendanceCount } });
    showToast("Group deleted.", "success");
    loadGroups();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to delete this group."), "error");
  }
}

function groupCard(g) {
  const members = g.group_members || [];
  const heads = members.filter((m) => isHeadRole(m.member_role));
  const regular = members.filter((m) => m.member_role === "member");

  return `
    <div class="card" style="margin-bottom:10px;" data-id="${g.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="min-width:0;">
          <h3 style="margin:0;">${escapeHtml(g.name)}</h3>
          ${g.description ? `<p style="margin:4px 0 0;">${escapeHtml(g.description)}</p>` : ""}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="icon-action sm show-btn" data-id="${g.id}" title="Show heads and members" aria-label="Show heads and members">${ICON.show}</button>
          ${canManageGroup(g) ? `<button type="button" class="icon-action sm manage-btn" data-id="${g.id}" title="Manage group" aria-label="Manage group">${ICON.manage}</button>` : ""}
		  ${isAdmin ? `<button type="button" class="icon-action sm danger delete-btn" data-id="${g.id}" data-name="${escapeHtml(g.name)}" title="Delete group" aria-label="Delete group">${ICON.trash}</button>` : ""}
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
        <span class="tag tag-type-${escapeHtml(g.group_type)}">${escapeHtml(GROUP_TYPE_LABELS[g.group_type] || g.group_type)}</span>
        ${
          heads.length
            ? heads
                .map(
                  (h) =>
                    `<span class="tag tag-approved">${escapeHtml(headRoleLabel(g.group_type, h.member_role))}: ${escapeHtml(h.profiles?.full_name || "Unknown")}</span>`
                )
                .join("")
            : `<span class="tag tag-pending">No head assigned</span>`
        }
        <span class="tag tag-normal">${!g.member_count ? "No members" : `${g.member_count} ${g.member_count === 1 ? "member" : "members"}`}</span>
      </div>
    </div>`;
}

function emptyState() {
  return `<div class="card empty-state"><h3>No groups yet</h3><p>${isAdmin ? "Create your first class or group to get started." : "You haven't been added to a group yet."}</p></div>`;
}

// ---------- View dialog: read-only heads + members ----------
async function openViewDialog(groupId) {
  const { data: g, error: gErr } = await supabase.from("groups").select("id, name, group_type").eq("id", groupId).single();
  if (gErr || !g) {
    showToast("Unable to load this group.", "error");
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="vw-title">
      <h3 id="vw-title">${escapeHtml(g.name)}</h3>
      <div class="aud-body" id="vw-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
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
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  const bodyEl = backdrop.querySelector("#vw-body");
  try {
    const members = await fetchGroupDetail(groupId);
    const heads = members.filter((m) => isHeadRole(m.member_role));
    const regular = members.filter((m) => m.member_role === "member");

    const row = (name, meta) => `
      <div class="aud-row" style="cursor:default;">
        <span>${escapeHtml(name || "Unknown")}</span>
        <span class="aud-meta">${escapeHtml(meta)}</span>
      </div>`;

    bodyEl.innerHTML = `
      <div class="ack-group-title">Head${heads.length === 1 ? "" : "s"} (${heads.length})</div>
      <div class="aud-list">
        ${
          heads.length
            ? heads.map((h) => row(h.profiles?.full_name, headRoleLabel(g.group_type, h.member_role))).join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No head assigned yet.</div>`
        }
      </div>
      <div class="ack-group-title" style="margin-top:18px;">Members (${regular.length})</div>
      <div class="aud-list">
        ${
          regular.length
            ? regular.map((m) => row(m.profiles?.full_name, cap(m.profiles?.role || ""))).join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No members yet.</div>`
        }
      </div>`;
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">Unable to load the member list.</div>`;
    showToast(friendlyError(err, "Unable to load the member list."), "error");
  }
}

// ---------- Manage dialog: heads + members ----------
let peopleCache = [];

async function loadPeopleCache() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("organization_id", profile.organization_id)
    .eq("is_active", true)
    .order("full_name");
  if (error) {
    console.error(error);
    return;
  }
  peopleCache = data || [];
}

async function fetchGroupDetail(groupId) {
  const { data, error } = await supabase
    .from("group_members")
    .select("id, profile_id, member_role, profiles(full_name, role)")
    .eq("group_id", groupId);
  if (error) throw error;
  return data || [];
}

async function upsertMember(groupId, profileId, role) {
  const { error } = await supabase
    .from("group_members")
    .upsert({ group_id: groupId, profile_id: profileId, member_role: role }, { onConflict: "group_id,profile_id" });
  if (error) throw error;
}

async function removeRow(rowId) {
  const { error } = await supabase.from("group_members").delete().eq("id", rowId);
  if (error) throw error;
}

// ---------- Import names (Excel / CSV) ----------
const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const IMPORT_CHUNK = 200; // members saved per request

const normName = (s) => String(s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

function colIndexFromRef(ref) {
  // "B7" -> 1
  const letters = (/^[A-Z]+/i.exec(ref) || ["A"])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXml(xml) {
  if (xml.length > 10000000) throw new Error("This spreadsheet is too large to read.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This spreadsheet couldn't be read.");
  return doc;
}

// Text cells of the first worksheet, grouped by column: Map(columnIndex -> [text, ...])
async function readXlsxColumns(file) {
  if (!window.JSZip) throw new Error("The Excel reader didn't load. Please refresh the page and try again.");
  const zip = await window.JSZip.loadAsync(file);
  const text = async (path) => {
    const f = zip.file(path);
    return f ? f.async("string") : null;
  };

  // Which file is the first sheet?
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = await text("xl/workbook.xml");
  const rels = await text("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const firstSheet = parseXml(workbook).getElementsByTagName("sheet")[0];
    const rid = firstSheet && firstSheet.getAttribute("r:id");
    const rel = Array.from(parseXml(rels).getElementsByTagName("Relationship")).find((r) => r.getAttribute("Id") === rid);
    const target = rel && rel.getAttribute("Target");
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  }
  const sheetXml = await text(sheetPath);
  if (!sheetXml) throw new Error("No worksheet was found in this file.");

  // Shared strings (most text cells point into this list)
  const shared = [];
  const sst = await text("xl/sharedStrings.xml");
  if (sst) {
    for (const si of Array.from(parseXml(sst).getElementsByTagName("si"))) {
      shared.push(
        Array.from(si.getElementsByTagName("t"))
          .filter((t) => t.parentNode.nodeName !== "rPh")
          .map((t) => t.textContent)
          .join("")
      );
    }
  }

  const columns = new Map();
  for (const c of Array.from(parseXml(sheetXml).getElementsByTagName("c"))) {
    const type = c.getAttribute("t");
    const v = c.getElementsByTagName("v")[0];
    let value;
    if (type === "s") value = shared[Number(v && v.textContent)] || "";
    else if (type === "inlineStr") value = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent).join("");
    else if (type === "str") value = (v && v.textContent) || "";
    else continue; // numbers, dates, errors: not names
    value = value.trim();
    if (!value) continue;
    const col = colIndexFromRef(c.getAttribute("r") || "A1");
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(value);
  }
  return columns;
}

function readCsvColumns(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const sample = clean.slice(0, 2000);
  const delimiter = sample.split(";").length > sample.split(",").length ? ";" : ",";
  const columns = new Map();
  for (const line of clean.split(/\r?\n/)) {
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    cells.forEach((cell, i) => {
      const v = cell.trim();
      if (!v) return;
      if (!columns.has(i)) columns.set(i, []);
      columns.get(i).push(v);
    });
  }
  return columns;
}

async function readImportColumns(file) {
  if (file.size > IMPORT_MAX_BYTES) throw new Error("That file is too large (limit 2 MB).");
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) return readXlsxColumns(file);
  if (name.endsWith(".csv") || name.endsWith(".txt")) return readCsvColumns(await file.text());
  throw new Error("Please choose an Excel (.xlsx) or CSV file. An older .xls file needs to be saved as .xlsx first.");
}

// Match the names in the file against the people of this academy.
function matchImportedNames(columns, people, existingIds) {
  const byName = new Map();
  for (const p of people) {
    const key = normName(p.full_name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }

  // The names are in the column with the most matches; other columns (numbers, notes) are ignored.
  let best = null;
  for (const [, cells] of Array.from(columns.entries()).sort((a, b) => a[0] - b[0])) {
    const hits = cells.filter((c) => byName.has(normName(c))).length;
    if (!best || hits > best.hits) best = { cells, hits };
  }

  const result = { matched: [], alreadyIn: [], ambiguous: [], unmatched: [] };
  if (!best) return result;
  const seen = new Set();
  for (const cell of best.cells) {
    const key = normName(cell);
    if (seen.has(key)) continue; // the same name twice in the file
    seen.add(key);
    const found = byName.get(key);
    if (!found) result.unmatched.push(cell);
    else if (found.length > 1) result.ambiguous.push(cell); // two people share this name: never guess
    else if (existingIds.has(found[0].id)) result.alreadyIn.push(found[0]);
    else result.matched.push(found[0]);
  }
  return result;
}

// ignoreDuplicates = "do nothing if already in the group", so an existing head can never be changed by an import.
async function addMembersBulk(groupId, profileIds, onProgress) {
  let added = 0;
  for (let i = 0; i < profileIds.length; i += IMPORT_CHUNK) {
    const rows = profileIds.slice(i, i + IMPORT_CHUNK).map((profile_id) => ({ group_id: groupId, profile_id, member_role: "member" }));
    const { error } = await supabase.from("group_members").upsert(rows, { onConflict: "group_id,profile_id", ignoreDuplicates: true });
    if (error) {
      error.added = added;
      throw error;
    }
    added += rows.length;
    if (onProgress) onProgress(added);
  }
  return added;
}

// True when this dialog is the one on top (so Escape only closes the top-most dialog).
const isTopDialog = (el) => el === Array.from(document.querySelectorAll(".dialog-backdrop")).pop();

// ---------- Simple modal that lists names (used by the import summary's view icons) ----------
function openNamesDialog({ title, rows }) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="nm-title">
      <h3 id="nm-title">${escapeHtml(title)} (${rows.length})</h3>
      <div class="aud-list" style="max-height:320px;overflow-y:auto;">
        ${rows
          .map((r) => `<div class="aud-row" style="cursor:default;"><span>${escapeHtml(r.name)}</span><span class="aud-meta">${escapeHtml(r.meta)}</span></div>`)
          .join("")}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape" && isTopDialog(backdrop)) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
}

// ---------- Person picker: lists users to add as head / member ----------
// importConfig (optional, members only) adds an import icon that opens the file selector directly:
//   { groupId, groupName, existingIds, onDone }
function openPersonPicker({ title, people, onPick, importConfig }) {
  const PICKER_MAX = 300; // keeps the list fast on large academies; the search box narrows it
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="pk-title">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;">
        <h3 id="pk-title" style="margin:0;">${escapeHtml(title)}</h3>
        ${
          importConfig
            ? `<button type="button" class="icon-action sm" id="pk-import" title="Import names from Excel or CSV" aria-label="Import names">${ICON.import}</button>
               <input type="file" id="pk-file" accept=".xlsx,.csv,.txt" style="display:none;" />`
            : ""
        }
      </div>
      <div class="field aud-search"><input type="search" id="pk-search" placeholder="Search by name…" autocomplete="off" /></div>
      <div class="aud-list" id="pk-results" style="max-height:320px;overflow-y:auto;"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let busy = false;
  const onKey = (e) => { if (e.key === "Escape" && !busy && isTopDialog(backdrop)) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !busy) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) close(); });

  const searchEl = backdrop.querySelector("#pk-search");
  const resEl = backdrop.querySelector("#pk-results");

  function renderResults() {
    const term = searchEl.value.trim().toLowerCase();
    const matches = people.filter((p) => !term || (p.full_name || "").toLowerCase().includes(term));
    const shown = matches.slice(0, PICKER_MAX);
    resEl.innerHTML = shown.length
      ? shown
          .map(
            (p) => `
        <div class="aud-row">
          <span>${escapeHtml(p.full_name)}</span>
          <span class="aud-meta">${escapeHtml(cap(p.role))}</span>
          <button type="button" class="icon-action sm approve" data-pick="${escapeHtml(p.id)}" title="Add" aria-label="Add ${escapeHtml(p.full_name)}" style="margin-left:8px;">${ICON.add}</button>
        </div>`
          )
          .join("") +
        (matches.length > shown.length
          ? `<div class="text-muted" style="padding:8px 0;font-size:0.8rem;">Showing the first ${PICKER_MAX} of ${matches.length}. Type a name to narrow the list.</div>`
          : "")
      : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No matches.</div>`;
  }

  searchEl.addEventListener("input", renderResults);
  resEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pick]");
    if (!btn || busy) return;
    const person = people.find((p) => p.id === btn.getAttribute("data-pick"));
    if (!person) return;
    busy = true;
    resEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    let done = false;
    try {
      done = await onPick(person);
    } catch (err) {
      console.error(err);
    }
    busy = false;
    if (done) close();
    else resEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
  });

  if (importConfig) {
    const importBtn = backdrop.querySelector("#pk-import");
    const fileInput = backdrop.querySelector("#pk-file");
    importBtn.addEventListener("click", () => {
      if (!busy) fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = ""; // lets the same file be chosen again later
      if (!file || busy) return;
      busy = true;
      importBtn.disabled = true;
      await readAndSummarizeImport(file, {
        ...importConfig,
        onImported: () => {
          close();
          importConfig.onDone();
        },
      });
      busy = false;
      importBtn.disabled = false;
    });
  }

  renderResults();
  searchEl.focus();
}

// ---------- Import names: read the chosen file, then show the summary ----------
async function readAndSummarizeImport(file, { groupId, groupName, existingIds, onImported }) {
  let result;
  try {
    const columns = await readImportColumns(file);
    result = matchImportedNames(columns, peopleCache, existingIds);
  } catch (err) {
    console.error(err);
    showToast(err.message || "This file couldn't be read.", "error");
    return;
  }
  openImportSummaryDialog({ result, fileName: file.name, groupId, groupName, onImported });
}

// ---------- Import summary ----------
function openImportSummaryDialog({ result, fileName, groupId, groupName, onImported }) {
  const ready = result.matched;
  const ids = ready.map((p) => p.id);
  // "Existing" = already in this group. Everything here is left out of the import.
  const skipped = [
    ...result.unmatched.map((n) => ({ name: n, meta: "Not found" })),
    ...result.ambiguous.map((n) => ({ name: n, meta: "Same name as another person, add manually" })),
    ...result.alreadyIn.map((p) => ({ name: p.full_name, meta: "Existing" })),
  ];
  const readyRows = ready.map((p) => ({ name: p.full_name, meta: cap(p.role) }));

  const summaryRow = ({ label, count, key, viewLabel }) => `
    <div class="aud-row" style="cursor:default;">
      <span>${escapeHtml(label)}</span>
      <span class="aud-meta">${count}</span>
      ${count > 0 ? `<button type="button" class="icon-action sm" data-view="${key}" title="${escapeHtml(viewLabel)}" aria-label="${escapeHtml(viewLabel)}" style="margin-left:8px;">${ICON.show}</button>` : ""}
    </div>`;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="sum-title">
      <h3 id="sum-title">Import summary</h3>
      <p class="text-muted" style="margin-top:0;font-size:0.85rem;word-break:break-all;"><strong>Filename:</strong> ${escapeHtml(fileName)}</p>
      <div class="aud-body">
        ${summaryRow({ label: "Ready to import", count: ready.length, key: "ready", viewLabel: "View names ready to import" })}
        ${summaryRow({ label: "Skipped", count: skipped.length, key: "skipped", viewLabel: "View skipped names" })}
      </div>
      ${ready.length ? "" : `<p class="text-muted" style="font-size:0.85rem;margin:10px 0 0;">No new names matched, so there is nothing to import.</p>`}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="sum-go" ${ready.length ? "" : "disabled"}>Import ${ready.length} member${ready.length === 1 ? "" : "s"}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let busy = false;
  const onKey = (e) => { if (e.key === "Escape" && !busy && isTopDialog(backdrop)) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !busy) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) close(); });

  backdrop.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.getAttribute("data-view") === "ready") openNamesDialog({ title: "Ready to import", rows: readyRows });
      else openNamesDialog({ title: "Skipped names", rows: skipped });
    });
  });

  const goBtn = backdrop.querySelector("#sum-go");
  goBtn.addEventListener("click", async () => {
    if (busy || ids.length === 0) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = "Importing…";
    try {
      const added = await addMembersBulk(groupId, ids);
      await logAudit({
        action: "group.members_imported",
        recordType: "group",
        recordId: groupId,
        details: { name: groupName, added, skipped: result.unmatched.length + result.ambiguous.length, already_in_group: result.alreadyIn.length },
      });
      showToast(`${added} member${added === 1 ? "" : "s"} added.`, "success");
      busy = false;
      close();
      onImported();
    } catch (err) {
      console.error(err);
      busy = false;
      const partial = err.added ? ` ${err.added} of ${ids.length} were added before the error.` : "";
      showToast(friendlyError(err, "Unable to add these members.") + partial, "error");
      if (err.added) { close(); onImported(); } // show what was saved
      else { goBtn.disabled = false; goBtn.textContent = `Import ${ids.length} member${ids.length === 1 ? "" : "s"}`; }
    }
  });
}

async function openManageDialog(groupId) {
  const { data: g, error: gErr } = await supabase.from("groups").select("id, name, group_type").eq("id", groupId).single();
  if (gErr || !g) {
    showToast("Unable to load this group.", "error");
    return;
  }
  if (peopleCache.length === 0) await loadPeopleCache();

  // Admins and teachers can add heads; a student or parent head can only manage members.
  const canAddHeads = isAdmin || isTeacher;
  // Admins can remove any head. A teacher can remove other heads, but never themselves.
  const canRemoveHead = (h) => isAdmin || (isTeacher && h.profile_id !== profile.id);

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="mg-title">
      <h3 id="mg-title">${escapeHtml(g.name)}</h3>
      <div class="aud-body" id="mg-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => {
    // ignore Escape while the import dialog is open on top of this one
    if (e.key === "Escape" && backdrop === Array.from(document.querySelectorAll(".dialog-backdrop")).pop()) close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    loadGroups();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  async function render() {
    const members = await fetchGroupDetail(groupId);
    const heads = members.filter((m) => isHeadRole(m.member_role));
    const regular = members.filter((m) => m.member_role === "member");
    const memberIds = new Set(members.map((m) => m.profile_id));
    const options = headOptionsFor(g.group_type);
    const headEligibleRoles = new Set(options.flatMap((o) => o.personRoles));

    const bodyEl = backdrop.querySelector("#mg-body");
    const canShowAddHead = canAddHeads && headEligibleRoles.size > 0 && heads.length < 3;
    const headNote = !canAddHeads
      ? `<p class="text-muted" style="font-size:0.8rem;margin:6px 0 0;">Only an administrator or teacher can change heads.</p>`
      : headEligibleRoles.size > 0 && heads.length >= 3
      ? `<p class="text-muted" style="font-size:0.8rem;margin:6px 0 0;">Maximum of 3 heads reached.</p>`
      : "";
    const titleRowStyle = "display:flex;align-items:center;justify-content:space-between;gap:8px;";

    bodyEl.innerHTML = `
      <div class="ack-group-title" style="${titleRowStyle}">
        <span>Heads (${heads.length}/3)</span>
        ${canShowAddHead ? `<button type="button" class="icon-action sm approve" data-act="add-head" title="Add head" aria-label="Add head">${ICON.add}</button>` : ""}
      </div>
      <div class="aud-list">
        ${
          heads.length
            ? heads
                .map(
                  (h) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(h.profiles?.full_name || "Unknown")}</span>
                <span class="aud-meta">${escapeHtml(headRoleLabel(g.group_type, h.member_role))}</span>
                ${canRemoveHead(h) ? `<button type="button" class="icon-action sm danger" data-remove="${h.id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.remove}</button>` : ""}
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No heads assigned yet.</div>`
        }
      </div>
      ${headNote}

      <div class="ack-group-title" style="margin-top:18px;${titleRowStyle}">
        <span>Members (${regular.length})</span>
        <button type="button" class="icon-action sm approve" data-act="add-member" title="Add member" aria-label="Add member">${ICON.add}</button>
      </div>
      <div class="aud-list">
        ${
          regular.length
            ? regular
                .map(
                  (m) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(m.profiles?.full_name || "Unknown")}</span>
                <span class="aud-meta">${escapeHtml(cap(m.profiles?.role || ""))}</span>
                <button type="button" class="icon-action sm danger" data-remove="${m.id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.remove}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No members yet.</div>`
        }
      </div>
    `;

    bodyEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await removeRow(btn.getAttribute("data-remove"));
          showToast("Removed.", "success");
          await render();
        } catch (err) {
          console.error(err);
          showToast(friendlyError(err, "Unable to remove."), "error");
        }
      });
    });

    bodyEl.querySelector('[data-act="add-head"]')?.addEventListener("click", () => {
      openPersonPicker({
        title: "Add head",
        people: peopleCache.filter((p) => headEligibleRoles.has(p.role) && !heads.some((h) => h.profile_id === p.id)),
        onPick: async (person) => {
          const opt = options.find((o) => o.personRoles.includes(person?.role));
          if (!opt) {
            showToast("This person's role can't be a head of this group.", "error");
            return false;
          }
          try {
            await upsertMember(groupId, person.id, opt.role);
            await logAudit({ action: "group.head_assigned", recordType: "group", recordId: groupId, details: { name: person.full_name, role: opt.label } });
            showToast("Head added.", "success");
            await render();
            return true;
          } catch (err) {
            console.error(err);
            showToast(friendlyError(err, "Unable to add this head. The group may already have 3."), "error");
            return false;
          }
        },
      });
    });

    bodyEl.querySelector('[data-act="add-member"]')?.addEventListener("click", () => {
      openPersonPicker({
        title: "Add member",
        people: peopleCache.filter((p) => !memberIds.has(p.id)),
        importConfig: { groupId, groupName: g.name, existingIds: memberIds, onDone: () => render() },
        onPick: async (person) => {
          try {
            await upsertMember(groupId, person.id, "member");
            showToast("Member added.", "success");
            await render();
            return true;
          } catch (err) {
            console.error(err);
            showToast(friendlyError(err, "Unable to add this member."), "error");
            return false;
          }
        },
      });
    });

  }

  render();
}

loadGroups();
