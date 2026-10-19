import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { todayPH } from "./time.js";
import { escapeHtml } from "./utils.js";

const profile = await mountLayout({ activeKey: "reports", pageTitle: "Reports", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

document.getElementById("export-head").innerHTML = sectionHead({
  title: "Attendance export",
  tone: "info",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
});
document.getElementById("linked-head").innerHTML = sectionHead({
  title: "Linked students",
  tone: "info",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.07 0l2.83-2.83a5 5 0 00-7.07-7.07L11.5 4.43"/><path d="M14 11a5 5 0 00-7.07 0L4.1 13.83a5 5 0 007.07 7.07l1.33-1.33"/></svg>`,
});

const fromInput = document.getElementById("from-date");
const toInput = document.getElementById("to-date");

// Export button lives in the section header, top right
const exportBtn = document.createElement("button");
exportBtn.type = "button";
exportBtn.id = "export-btn";
exportBtn.className = "icon-action sm";
exportBtn.title = "Export CSV";
exportBtn.setAttribute("aria-label", "Export CSV");
exportBtn.style.marginLeft = "auto";
exportBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">  <path d="M12 15V3" /><path d="M12 3 L17 8" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 8 L12 3" /></svg>`;
const exportHead = document.getElementById("export-head");
(exportHead.querySelector(".section-head") || exportHead).appendChild(exportBtn);

// Default range: the first day of this month to today, in Philippine time
const todayStr = todayPH();
fromInput.value = todayStr.slice(0, 8) + "01";
toInput.value = todayStr;

// ---------- Attendance export ----------
const EXPORT_PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request, so we read page by page
const EXPORT_ROLES = ["admin", "teacher", "student"]; // people who have attendance (parents do not)
const STAFF_ROLES = ["admin", "teacher"];

// Modal: choose who to include. Resolves { scope, ids } or null when cancelled.
function openExportDialog() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ex-title">
        <h3 id="ex-title">Export attendance</h3>
        <div class="field">
          <label for="ex-scope">Who to include</label>
          <select id="ex-scope">
            <option value="staff">Staff (admins and teachers)</option>
            <option value="student">Students</option>
            <option value="people">Specific people</option>
            <option value="all">Everyone</option>
          </select>
        </div>
        <div id="ex-detail"></div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="ex-go">Export</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const onKey = (e) => { if (e.key === "Escape") close(null); };
    function close(result) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));

    const scopeSelect = backdrop.querySelector("#ex-scope");
    const detailEl = backdrop.querySelector("#ex-detail");
    let peopleCache = null;
    const selected = new Set();

    async function renderDetail() {
      if (scopeSelect.value !== "people") {
        detailEl.innerHTML = "";
        return;
      }
      detailEl.innerHTML = `<p class="text-muted" style="margin:0;">Loading…</p>`;
      if (!peopleCache) {
        const { data, error } = await supabase
          .from("profiles")
          .select("id, full_name, role")
          .eq("organization_id", profile.organization_id)
          .eq("is_active", true)
          .in("role", EXPORT_ROLES)
          .order("full_name");
        if (error) {
          console.error(error);
          detailEl.innerHTML = `<p class="text-muted" style="margin:0;">The people list couldn't be loaded.</p>`;
          return;
        }
        peopleCache = data || [];
      }
      if (scopeSelect.value !== "people") return; // the choice changed while loading
      detailEl.innerHTML = `
        <div class="field aud-search"><input type="search" id="ex-search" placeholder="Search by name…" autocomplete="off" /></div>
        <div class="aud-list" id="ex-people" style="max-height:220px;"></div>
        <p class="text-muted" id="ex-count" style="font-size:0.8rem;margin-top:4px;">${selected.size} selected</p>`;
      renderPeople("");
      detailEl.querySelector("#ex-search").addEventListener("input", (e) => renderPeople(e.target.value));
    }

    function renderPeople(term) {
      const listEl = detailEl.querySelector("#ex-people");
      const q = term.trim().toLowerCase();
      const matches = peopleCache.filter((p) => !q || p.full_name.toLowerCase().includes(q)).slice(0, 100);
      listEl.innerHTML = matches
        .map(
          (p) =>
            `<label class="aud-row"><input type="checkbox" value="${p.id}" ${selected.has(p.id) ? "checked" : ""} /><span>${escapeHtml(p.full_name)}</span><span class="aud-meta">${escapeHtml(p.role)}</span></label>`
        )
        .join("");
      listEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(cb.value);
          else selected.delete(cb.value);
          detailEl.querySelector("#ex-count").textContent = `${selected.size} selected`;
        });
      });
    }

    scopeSelect.addEventListener("change", renderDetail);

    backdrop.querySelector("#ex-go").addEventListener("click", () => {
      const scope = scopeSelect.value;
      if (scope === "people" && selected.size === 0) {
        showToast("Select at least one person.", "error");
        return;
      }
      close({ scope, ids: new Set(selected) });
    });
  });
}

// Read every attendance row in the range for this academy, 1000 at a time.
async function fetchAttendance(from, to) {
  const rows = [];
  for (let start = 0; ; start += EXPORT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("id, profile_id, record_date, status, time_in, break_out, break_in, time_out, source, profiles!profile_id(full_name, role)")
      .eq("organization_id", profile.organization_id)
      .gte("record_date", from)
      .lte("record_date", to)
      .order("record_date", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + EXPORT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < EXPORT_PAGE_SIZE) break;
  }
  return rows;
}

exportBtn.addEventListener("click", async () => {
  const from = fromInput.value;
  const to = toInput.value;
  if (!from || !to || new Date(to) < new Date(from)) {
    showToast("Please choose a valid date range.", "error");
    return;
  }

  const choice = await openExportDialog();
  if (!choice) return;

  exportBtn.disabled = true;
  try {
    const keep = {
      staff: (r) => STAFF_ROLES.includes(r.profiles?.role),
      student: (r) => r.profiles?.role === "student",
      people: (r) => choice.ids.has(r.profile_id),
      all: () => true,
    }[choice.scope];

    const rows = (await fetchAttendance(from, to)).filter(keep);
    if (rows.length === 0) {
      showToast("No attendance records found for that selection.", "info");
      return;
    }

    downloadCsv(rows, from, to, choice.scope);
    showToast("Export downloaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to export attendance right now."), "error");
  } finally {
    exportBtn.disabled = false;
  }
});

// Philippine time, 24-hour, always HH:MM:SS (e.g. 08:00:00, 13:00:00)
const phTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function timeCell(value) {
  if (!value) return "";
  let text;
  const plain = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value)); // already a time of day, no date part
  if (plain && !String(value).includes("T") && !String(value).includes("-")) {
    text = `${plain[1]}:${plain[2]}:${plain[3] || "00"}`;
  } else {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    text = phTimeFormat.format(d);
  }
  // ="08:00:00" makes Excel keep the text exactly as written (otherwise it shows 8:00:00 or 8:00 AM)
  return csvSafe(`="${text}"`);
}

function downloadCsv(rows, from, to, scope) {
  const headers = ["Date", "Name", "Role", "Status", "Time in", "Break out", "Break in", "Time out", "Source"];
  const lines = [headers.join(",")];

  rows.forEach((r) => {
    lines.push(
      [
        r.record_date,
        csvSafe(r.profiles?.full_name || ""),
        r.profiles?.role || "",
        r.status || "",
        timeCell(r.time_in),
        timeCell(r.break_out),
        timeCell(r.break_in),
        timeCell(r.time_out),
        r.source || "",
      ].join(",")
    );
  });

  // The leading BOM makes Excel read the file as UTF-8, so names like "Niño" display correctly.
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance-${scope}-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvSafe(value) {
  const str = String(value);
  return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
}

// ---------- Linked students report: active students with their parent ----------
const linkedBtn = document.createElement("button");
linkedBtn.type = "button";
linkedBtn.id = "linked-btn";
linkedBtn.className = "icon-action sm";
linkedBtn.title = "Export CSV";
linkedBtn.setAttribute("aria-label", "Export linked students CSV");
linkedBtn.style.marginLeft = "6px";
linkedBtn.innerHTML = exportBtn.innerHTML;
const linkedHead = document.getElementById("linked-head");


const importBtn = document.createElement("button");
importBtn.type = "button";
importBtn.id = "import-links-btn";
importBtn.className = "icon-action sm";
importBtn.title = "Import CSV";
importBtn.setAttribute("aria-label", "Import parent links from a CSV file");
importBtn.style.marginLeft = "auto";
importBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;
(linkedHead.querySelector(".section-head") || linkedHead).appendChild(importBtn);
(linkedHead.querySelector(".section-head") || linkedHead).appendChild(linkedBtn);

// Read a whole table for this academy, 1000 rows at a time (the most Supabase returns per request)
async function fetchAll(table, columns, filter) {
  const rows = [];
  for (let start = 0; ; start += EXPORT_PAGE_SIZE) {
    let q = supabase.from(table).select(columns).eq("organization_id", profile.organization_id);
    if (filter) q = filter(q);
    const { data, error } = await q.order("id", { ascending: true }).range(start, start + EXPORT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < EXPORT_PAGE_SIZE) break;
  }
  return rows;
}

const byName = (x, y) => (x || "").localeCompare(y || "", undefined, { sensitivity: "base" });

// Columns of the Linked students sheet. On import only Student and Parent are required; Group and the
// emails are optional helpers that tell two people with the same name apart.
const LINKED_HEADERS = ["Student", "Student email", "Group", "Parent", "Parent email"];

function saveCsv(lines, filename) {
  // The leading BOM makes Excel read the file as UTF-8, so names like "Niño" display correctly.
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// student id -> names of the groups they belong to. One query per 100 groups (not one per group),
// and no QR codes are involved.
async function loadGroupMembership(groups) {
  const byStudent = new Map();
  const list = groups || [];
  if (!list.length) return byStudent;
  const order = new Map(list.map((g, i) => [g.id, i]));
  const nameOf = new Map(list.map((g) => [g.id, g.name]));
  const found = new Map(); // student id -> [[group position, group name], ...]
  for (let i = 0; i < list.length; i += 100) {
    const ids = list.slice(i, i + 100).map((g) => g.id);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("group_members")
        .select("group_id, profile_id")
        .in("group_id", ids)
        .order("group_id")
        .order("profile_id")
        .range(from, from + 999);
      if (error) throw error;
      (data || []).forEach((m) => {
        if (!found.has(m.profile_id)) found.set(m.profile_id, []);
        found.get(m.profile_id).push([order.get(m.group_id), nameOf.get(m.group_id)]);
      });
      if (!data || data.length < 1000) break;
    }
  }
  found.forEach((pairs, id) => byStudent.set(id, pairs.sort((a, b) => a[0] - b[0]).map((p) => p[1])));
  return byStudent;
}

// Modal: choose which students to include. Resolves { scope, groupId, ids } or null when cancelled.
function openLinkedDialog({ students, groups, parentNameOf }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="lk-title">
        <h3 id="lk-title">Export linked students</h3>
        <div class="field">
          <label for="lk-scope">Who to include</label>
          <select id="lk-scope">
            <option value="all">Everyone</option>
            <option value="group">Group</option>
            <option value="people">Specific people</option>
          </select>
        </div>
        <div id="lk-detail"></div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="lk-go">Export</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const onKey = (e) => { if (e.key === "Escape") close(null); };
    function close(result) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));

    const scopeSelect = backdrop.querySelector("#lk-scope");
    const detailEl = backdrop.querySelector("#lk-detail");
    const selected = new Set();

    function renderPeople(term) {
      const listEl = detailEl.querySelector("#lk-people");
      const q = term.trim().toLowerCase();
      const matches = students
        .filter((st) => !q || (st.full_name || "").toLowerCase().includes(q) || parentNameOf(st.id).toLowerCase().includes(q))
        .slice(0, 100);
      listEl.innerHTML = matches
        .map(
          (st) =>
            `<label class="aud-row"><input type="checkbox" value="${st.id}" ${selected.has(st.id) ? "checked" : ""} /><span>${escapeHtml(st.full_name)}</span><span class="aud-meta">${escapeHtml(parentNameOf(st.id) || "No parent")}</span></label>`
        )
        .join("");
      listEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(cb.value);
          else selected.delete(cb.value);
          detailEl.querySelector("#lk-count").textContent = `${selected.size} selected`;
        });
      });
    }

    function renderDetail() {
      const scope = scopeSelect.value;
      if (scope === "group") {
        detailEl.innerHTML = groups.length
          ? `<div class="field"><label for="lk-group">Group</label><select id="lk-group">${groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select></div>`
          : `<p class="text-muted" style="margin:0;">No groups yet.</p>`;
      } else if (scope === "people") {
        detailEl.innerHTML = `
          <div class="field aud-search"><input type="search" id="lk-search" placeholder="Search by student or parent…" autocomplete="off" /></div>
          <div class="aud-list" id="lk-people" style="max-height:220px;"></div>
          <p class="text-muted" id="lk-count" style="font-size:0.8rem;margin-top:4px;">${selected.size} selected</p>`;
        renderPeople("");
        detailEl.querySelector("#lk-search").addEventListener("input", (e) => renderPeople(e.target.value));
      } else {
        detailEl.innerHTML = "";
      }
    }

    scopeSelect.addEventListener("change", renderDetail);

    backdrop.querySelector("#lk-go").addEventListener("click", () => {
      const scope = scopeSelect.value;
      if (scope === "people" && selected.size === 0) {
        showToast("Select at least one person.", "error");
        return;
      }
      const groupId = backdrop.querySelector("#lk-group")?.value || "";
      if (scope === "group" && !groupId) {
        showToast("No group available.", "error");
        return;
      }
      close({ scope, groupId, ids: new Set(selected) });
    });
  });
}

linkedBtn.addEventListener("click", async () => {
  linkedBtn.disabled = true;
  try {
    const [students, parents, links, groupsRes] = await Promise.all([
      fetchAll("profiles", "id, full_name, email", (q) => q.eq("role", "student").eq("is_active", true).eq("is_approved", true)),
      fetchAll("profiles", "id, full_name, email", (q) => q.eq("role", "parent")),
      fetchAll("guardians", "parent_id, student_id"),
      supabase.from("groups").select("id, name").eq("organization_id", profile.organization_id).order("name"),
    ]);
    if (groupsRes.error) throw groupsRes.error;
    if (students.length === 0) {
      showToast("There are no active students yet.", "info");
      return;
    }

    const parentById = new Map(parents.map((p) => [p.id, p]));
    const parentsOf = new Map(); // student id -> parents
    links.forEach((l) => {
      const p = parentById.get(l.parent_id);
      if (!p) return;
      if (!parentsOf.has(l.student_id)) parentsOf.set(l.student_id, []);
      parentsOf.get(l.student_id).push(p);
    });
    const parentNameOf = (studentId) => (parentsOf.get(studentId) || []).map((p) => p.full_name).join(" / ");

    const choice = await openLinkedDialog({ students, groups: groupsRes.data || [], parentNameOf });
    if (!choice) return;

    let chosen = students;
    if (choice.scope === "group") {
      // Same lookup the QR card export uses for a group
      const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "group", p_group: choice.groupId });
      if (error) throw error;
      const inGroup = new Set((data || []).map((p) => p.id));
      chosen = students.filter((st) => inGroup.has(st.id));
    } else if (choice.scope === "people") {
      chosen = students.filter((st) => choice.ids.has(st.id));
    }
    if (chosen.length === 0) {
      showToast("No active students found for that selection.", "info");
      return;
    }

    // One row per student (a student is meant to have one parent); students without a parent have blank parent columns.
    const rows = [];
    chosen.forEach((st) => {
      const ps = parentsOf.get(st.id);
      if (ps?.length) ps.forEach((p) => rows.push({ student: st, parent: p }));
      else rows.push({ student: st, parent: null });
    });
    rows.sort((x, y) => byName(x.student.full_name, y.student.full_name) || byName(x.parent?.full_name, y.parent?.full_name));

    // Group column: read-only information that also tells two students with the same name apart on import
    let groupMap = new Map();
    try {
      groupMap = await loadGroupMembership(groupsRes.data || []);
    } catch (err) {
      console.error(err);
      showToast("Groups couldn't be loaded, so the Group column is blank.", "info");
    }
    const groupText = (studentId) => (groupMap.get(studentId) || []).slice().sort(byName).join("; ");

    const lines = [LINKED_HEADERS.join(",")];
    rows.forEach((r) =>
      lines.push(
        [csvSafe(r.student.full_name || ""), csvSafe(r.student.email || ""), csvSafe(groupText(r.student.id)), csvSafe(r.parent?.full_name || ""), csvSafe(r.parent?.email || "")].join(",")
      )
    );

    saveCsv(lines, `linked-students-${choice.scope}-${todayPH()}.csv`);
    showToast("Export downloaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to export linked students right now."), "error");
  } finally {
    linkedBtn.disabled = false;
  }
});

// =====================================================================
// Import: link students to parents from a spreadsheet (Excel .xlsx, CSV or TXT)
// Same flow as the Groups page import: tap the icon, choose a file, review the summary, import.
// The sheet needs Student and Parent. Group, Student email and Parent email are optional and only help
// tell people apart; the import never changes anyone's group. A student can have one parent, so a
// student who already has a different parent is skipped (change it from the Users page).
// =====================================================================

// ---- import logic (pure: no page or database access) ----
const IMPORT_MAX_ROWS = 5000;
const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LINK_CHUNK = 200; // links saved per request

// Names are compared without case, accents, punctuation or word order: "Dela Cruz, Juan" = "Juan Dela Cruz"
function nameKey(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Reads comma, semicolon or tab separated text, with quoted cells, doubled quotes and any line ending.
// Each row remembers its row number in the file (row.__line) so messages can point at it.
function parseCsv(text) {
  text = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let rowNo = 1;
  const endRow = () => {
    row.push(field);
    field = "";
    row.__line = rowNo++;
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const HEADER_ALIASES = {
  student: ["student", "studentname", "studentfullname", "nameofstudent"],
  group: ["group", "groupname", "section", "class", "classsection"],
  parent: ["parent", "parentname", "guardian", "guardianname", "parentguardian"],
  studentEmail: ["studentemail", "emailstudent"],
  parentEmail: ["parentemail", "guardianemail", "emailparent"],
};

// header row -> { student: columnIndex, parent: ..., ... } (only the columns that exist)
function mapHeaders(headerRow) {
  const norm = headerRow.map((h) => String(h || "").toLowerCase().replace(/[^a-z]/g, ""));
  const idx = {};
  for (const [key, names] of Object.entries(HEADER_ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

// Decide what happens to every row. `ctx` carries what the database knows:
//   studentsByEmail / studentsByKey, parentsByEmail / parentsByKey (Maps), linkOf (student id -> parent id),
//   nameOf (profile id -> name), groupsOf (student id -> [group names], or null when not loaded)
// Row results: link (will be created) | same (already linked to this parent) | blank (no parent given)
//              | repeat (same pair twice in the file) | problem (with a short reason)
function classifyRows(dataRows, idx, ctx) {
  const cell = (r, k) => (idx[k] === undefined ? "" : String(r[idx[k]] ?? "").trim());
  const results = [];

  dataRows.forEach((r, i) => {
    const line = r.__line ?? i + 2; // the row number in the file (row 1 is the header)
    const sName = cell(r, "student"), sEmail = cell(r, "studentEmail"), sGroup = cell(r, "group");
    const pName = cell(r, "parent"), pEmail = cell(r, "parentEmail");
    if (!sName && !sEmail && !pName && !pEmail) return; // an empty line
    const res = { line, studentText: sName || sEmail, parentText: pName || pEmail, status: "", reason: "", studentId: null, parentId: null };
    results.push(res);
    const fail = (reason) => { res.status = "problem"; res.reason = reason; };

    // student
    let student = null;
    if (sEmail) {
      student = ctx.studentsByEmail.get(sEmail.toLowerCase()) || null;
      if (!student) return fail(`No student with the email ${sEmail}`);
    } else if (!sName) {
      return fail("Student is missing");
    } else {
      let found = ctx.studentsByKey.get(nameKey(sName)) || [];
      if (found.length > 1 && sGroup && ctx.groupsOf) {
        const inGroup = found.filter((st) => (ctx.groupsOf(st.id) || []).some((g) => nameKey(g) === nameKey(sGroup)));
        if (inGroup.length) found = inGroup;
      }
      if (found.length === 0) return fail("Student not found");
      if (found.length > 1) return fail("Same name as another student, add the Student email column");
      student = found[0];
    }
    res.studentId = student.id;
    res.studentText = student.full_name || res.studentText;

    if (!pName && !pEmail) { res.status = "blank"; return; } // nothing to link; normal for students without a parent yet

    // parent
    let parent = null;
    if (pEmail) {
      parent = ctx.parentsByEmail.get(pEmail.toLowerCase()) || null;
      if (!parent) return fail(`No parent with the email ${pEmail}`);
    } else {
      const found = ctx.parentsByKey.get(nameKey(pName)) || [];
      if (found.length === 0) return fail(`Parent not found`);
      if (found.length > 1) return fail("Same name as another parent, add the Parent email column");
      parent = found[0];
    }
    res.parentId = parent.id;
    res.parentText = parent.full_name || res.parentText;

    const existing = ctx.linkOf.get(student.id);
    if (existing) {
      if (existing === parent.id) { res.status = "same"; return; }
      return fail(`Already linked to ${ctx.nameOf.get(existing) || "another parent"}`);
    }
    res.status = "link";
  });

  // The same student listed twice: the identical pair is ignored; two different parents is a conflict
  const byStudent = new Map();
  results.filter((x) => x.status === "link").forEach((x) => {
    if (!byStudent.has(x.studentId)) byStudent.set(x.studentId, []);
    byStudent.get(x.studentId).push(x);
  });
  byStudent.forEach((list) => {
    if (list.length < 2) return;
    if (new Set(list.map((x) => x.parentId)).size > 1) {
      list.forEach((x) => { x.status = "problem"; x.reason = "Listed with two different parents"; });
    } else {
      list.slice(1).forEach((x) => { x.status = "repeat"; });
    }
  });
  return results;
}

// Short reason shown next to a skipped row
function skipReason(x) {
  if (x.status === "same") return "Existing";
  if (x.status === "blank") return "No parent on this row";
  if (x.status === "repeat") return "Repeated row";
  return x.reason || "Skipped";
}
// ---- end of import logic ----

// ---------- reading the file ----------
const fileError = (message) => Object.assign(new Error(message), { userFacing: true });

function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

function colIndexFromRef(ref) {
  // "B7" -> 1
  const letters = (/^[A-Z]+/i.exec(ref) || ["A"])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXml(xml) {
  if (xml.length > 10000000) throw fileError("This spreadsheet is too large to read.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw fileError("This spreadsheet couldn't be read.");
  return doc;
}

// The first worksheet of an .xlsx as rows of cell text (same approach as the Groups page import)
async function readXlsxRows(file) {
  if (!window.JSZip) throw fileError("The Excel reader didn't load. Please refresh the page and try again.");
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
  if (!sheetXml) throw fileError("No worksheet was found in this file.");

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

  const grid = new Map(); // row number -> Map(column -> text)
  let maxCol = -1;
  for (const c of Array.from(parseXml(sheetXml).getElementsByTagName("c"))) {
    const type = c.getAttribute("t");
    const v = c.getElementsByTagName("v")[0];
    let value;
    if (type === "s") value = shared[Number(v && v.textContent)] || "";
    else if (type === "inlineStr") value = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent).join("");
    else if (type === "str") value = (v && v.textContent) || "";
    else if (!type || type === "n") value = (v && v.textContent) || ""; // plain numbers (for example a group called 7)
    else continue; // errors and other types
    value = value.trim();
    if (!value) continue;
    const ref = c.getAttribute("r") || "A1";
    const col = colIndexFromRef(ref);
    const rowNo = Number((/\d+/.exec(ref) || ["1"])[0]);
    if (!grid.has(rowNo)) grid.set(rowNo, new Map());
    grid.get(rowNo).set(col, value);
    if (col > maxCol) maxCol = col;
  }
  return Array.from(grid.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rowNo, cols]) => {
      const row = Array.from({ length: maxCol + 1 }, (_, i) => cols.get(i) || "");
      row.__line = rowNo;
      return row;
    });
}

async function readImportRows(file) {
  if (file.size > IMPORT_MAX_BYTES) throw fileError("That file is too large (limit 2 MB).");
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx")) return readXlsxRows(file);
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(await readFileText(file));
  throw fileError("Please choose an Excel (.xlsx) or CSV file. An older .xls file needs to be saved as .xlsx first.");
}

// Load what the check needs from the database
async function loadImportContext() {
  const [students, parents, links] = await Promise.all([
    fetchAll("profiles", "id, full_name, email", (q) => q.eq("role", "student").eq("is_active", true).eq("is_approved", true)),
    fetchAll("profiles", "id, full_name, email", (q) => q.eq("role", "parent").eq("is_active", true).eq("is_approved", true)),
    fetchAll("guardians", "parent_id, student_id"),
  ]);
  const group = (list, keyOf) => {
    const m = new Map();
    list.forEach((p) => { const k = keyOf(p); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(p); });
    return m;
  };
  const byEmail = (list) => new Map(list.filter((p) => p.email).map((p) => [p.email.toLowerCase(), p]));
  return {
    students,
    studentsByEmail: byEmail(students),
    studentsByKey: group(students, (p) => nameKey(p.full_name)),
    parentsByEmail: byEmail(parents),
    parentsByKey: group(parents, (p) => nameKey(p.full_name)),
    linkOf: new Map(links.map((l) => [l.student_id, l.parent_id])),
    nameOf: new Map([...students, ...parents].map((p) => [p.id, p.full_name])),
    groupsOf: null,
  };
}

// Read the file and decide what would happen to every row. Nothing is saved here.
async function prepareLinkImport(file) {
  const all = await readImportRows(file);
  if (all.length < 2) throw fileError("The file has no rows below the header.");
  const idx = mapHeaders(all[0]);
  if (idx.student === undefined && idx.studentEmail === undefined) throw fileError("The first row needs a Student column.");
  if (idx.parent === undefined && idx.parentEmail === undefined) throw fileError("The first row needs a Parent column.");
  const dataRows = all.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) throw fileError(`That file has ${dataRows.length} rows. The limit is ${IMPORT_MAX_ROWS} per import.`);

  const ctx = await loadImportContext();

  // Group names are only needed when two students share a name and the file has a Group column
  let notes = "";
  if (idx.group !== undefined && idx.student !== undefined) {
    const ambiguous = dataRows.some((r) => (ctx.studentsByKey.get(nameKey(r[idx.student])) || []).length > 1);
    if (ambiguous) {
      try {
        const { data, error } = await supabase.from("groups").select("id, name").eq("organization_id", profile.organization_id).order("name");
        if (error) throw error;
        const map = await loadGroupMembership(data || []);
        ctx.groupsOf = (id) => map.get(id) || [];
      } catch (err) {
        console.error(err);
        notes = "Groups couldn't be loaded, so students with the same name can't be told apart by group.";
      }
    }
  }

  const results = classifyRows(dataRows, idx, ctx);
  if (results.length === 0) throw fileError("The file has no rows to import.");
  return { results, notes };
}

// Create the links in batches. If a batch is refused as a whole (for example someone linked one of the
// students a moment ago), retry that batch one row at a time so every good row still goes through.
async function applyLinks(pairs, onProgress) {
  let linked = 0;
  const failed = [];
  const rowFor = (p) => ({ organization_id: profile.organization_id, parent_id: p.parentId, student_id: p.studentId, relationship: "Parent" });
  for (let i = 0; i < pairs.length; i += LINK_CHUNK) {
    const chunk = pairs.slice(i, i + LINK_CHUNK);
    const { error } = await supabase.from("guardians").insert(chunk.map(rowFor));
    if (!error) {
      linked += chunk.length;
    } else {
      for (const p of chunk) {
        const { error: e1 } = await supabase.from("guardians").insert(rowFor(p));
        if (e1) failed.push({ ...p, reason: e1.code === "23505" ? "Was linked to a parent in the meantime" : friendlyError(e1, "Couldn't link this student.") });
        else linked++;
      }
    }
    onProgress?.(Math.min(i + LINK_CHUNK, pairs.length), pairs.length);
  }
  return { linked, failed };
}

// ---------- the dialogs (same look and flow as the Groups page import) ----------
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

// True when this dialog is the one on top (so Escape only closes the top-most dialog).
const isTopDialog = (el) => el === Array.from(document.querySelectorAll(".dialog-backdrop")).pop();

// Simple modal that lists names (used by the summary's view icons)
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

function openLinkSummaryDialog({ results, fileName, notes }) {
  const ready = results.filter((x) => x.status === "link");
  const skipped = results.filter((x) => x.status !== "link");
  const readyRows = ready.map((x) => ({ name: x.studentText, meta: x.parentText }));
  const skippedRows = skipped.map((x) => ({ name: x.studentText || "(no student)", meta: `Row ${x.line}: ${skipReason(x)}` }));
  const label = (n) => `Import ${n} link${n === 1 ? "" : "s"}`;

  const summaryRow = ({ text, count, key, viewLabel }) => `
    <div class="aud-row" style="cursor:default;">
      <span>${escapeHtml(text)}</span>
      <span class="aud-meta">${count}</span>
      ${count > 0 ? `<button type="button" class="icon-action sm" data-view="${key}" title="${escapeHtml(viewLabel)}" aria-label="${escapeHtml(viewLabel)}" style="margin-left:8px;">${EYE}</button>` : ""}
    </div>`;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="sum-title">
      <h3 id="sum-title">Import summary</h3>
      <p class="text-muted" style="margin-top:0;font-size:0.85rem;word-break:break-all;"><strong>Filename:</strong> ${escapeHtml(fileName)}</p>
      <div class="aud-body">
        ${summaryRow({ text: "Ready to import", count: ready.length, key: "ready", viewLabel: "View links ready to import" })}
        ${summaryRow({ text: "Skipped", count: skipped.length, key: "skipped", viewLabel: "View skipped rows" })}
      </div>
      ${notes ? `<p class="text-muted" style="font-size:0.85rem;margin:10px 0 0;">${escapeHtml(notes)}</p>` : ""}
      ${ready.length ? "" : `<p class="text-muted" style="font-size:0.85rem;margin:10px 0 0;">No new links to make, so there is nothing to import.</p>`}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="sum-go" ${ready.length ? "" : "disabled"}>${label(ready.length)}</button>
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
      else openNamesDialog({ title: "Skipped rows", rows: skippedRows });
    });
  });

  const goBtn = backdrop.querySelector("#sum-go");
  goBtn.addEventListener("click", async () => {
    if (busy || ready.length === 0) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = "Importing…";
    try {
      const { linked, failed } = await applyLinks(ready, (done, total) => { if (total > LINK_CHUNK) goBtn.textContent = `Importing ${done} of ${total}…`; });
      if (linked > 0) {
        Promise.resolve(
          logAudit({
            action: "user.links_imported",
            recordType: "organization",
            recordId: profile.organization_id,
            details: { linked, skipped: skipped.length, failed: failed.length, file: fileName },
          })
        ).catch((e) => console.error("Audit log failed:", e));
      }
      busy = false;
      close();
      if (failed.length) {
        showToast(`${linked} student${linked === 1 ? "" : "s"} linked. ${failed.length} couldn't be linked (${failed[0].reason}).`, "error");
      } else {
        showToast(`${linked} student${linked === 1 ? "" : "s"} linked.`, "success");
      }
    } catch (err) {
      console.error(err);
      busy = false;
      showToast(friendlyError(err, "Unable to link these students."), "error");
      goBtn.disabled = false;
      goBtn.textContent = label(ready.length);
    }
  });
}

// ---------- the import icon: choose a file, then show the summary ----------
const importFile = document.createElement("input");
importFile.type = "file";
importFile.id = "import-links-file";
importFile.accept = ".xlsx,.csv,.txt";
importFile.style.display = "none";
document.body.appendChild(importFile);

let importBusy = false;
importBtn.addEventListener("click", () => {
  if (!importBusy) importFile.click();
});
importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = ""; // lets the same file be chosen again later
  if (!file || importBusy) return;
  importBusy = true;
  importBtn.disabled = true;
  try {
    const prepared = await prepareLinkImport(file);
    openLinkSummaryDialog({ ...prepared, fileName: file.name });
  } catch (err) {
    console.error(err);
    showToast(err.userFacing ? err.message : friendlyError(err, "This file couldn't be read."), "error");
  } finally {
    importBusy = false;
    importBtn.disabled = false;
  }
});

// The Users page links here with ?import=links. A browser only opens the file chooser after a tap,
// so this brings the import icon into view and points at it instead.
if (new URLSearchParams(window.location.search).get("import") === "links") {
  history.replaceState(null, "", `${window.location.pathname}#linked`);
  importBtn.scrollIntoView({ block: "center" });
  importBtn.focus();
  showToast("Tap the import icon to choose your file.", "info");
}
