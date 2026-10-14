import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { todayPH } from "./time.js";

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

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

// student id -> names of the groups they belong to (same lookup the QR card export uses; one call per group)
async function loadGroupMembership(groups) {
  const byStudent = new Map();
  const results = await Promise.all(
    (groups || []).map(async (g) => {
      const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "group", p_group: g.id });
      if (error) throw error;
      return [g, data || []];
    })
  );
  results.forEach(([g, members]) =>
    members.forEach((m) => {
      if (!byStudent.has(m.id)) byStudent.set(m.id, []);
      byStudent.get(m.id).push(g.name);
    })
  );
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
// Import: link students to parents from a CSV
// The sheet needs Student and Parent. Group, Student email and Parent email are optional and only help
// tell people apart; the import never changes anyone's group. A student can have one parent, so a
// student who already has a different parent is reported and left alone (change it from the Users page).
// =====================================================================

// ---- import logic (pure: no page or database access) ----
const IMPORT_MAX_ROWS = 5000;
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const LINK_CHUNK = 200;

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
function parseCsv(text) {
  text = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
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
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
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
//              | repeat (same pair twice in the file) | problem (with a reason)
function classifyRows(dataRows, idx, ctx) {
  const cell = (r, k) => (idx[k] === undefined ? "" : String(r[idx[k]] ?? "").trim());
  const results = [];

  dataRows.forEach((r, i) => {
    const line = i + 2; // row number as seen in a spreadsheet (row 1 is the header)
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
      if (!student) return fail(`No active student has the email ${sEmail}.`);
    } else if (!sName) {
      return fail("The student is missing.");
    } else {
      let found = ctx.studentsByKey.get(nameKey(sName)) || [];
      if (found.length > 1 && sGroup && ctx.groupsOf) {
        const inGroup = found.filter((st) => (ctx.groupsOf(st.id) || []).some((g) => nameKey(g) === nameKey(sGroup)));
        if (inGroup.length) found = inGroup;
      }
      if (found.length === 0) return fail("No active student has this name.");
      if (found.length > 1) return fail("More than one student has this name. Add the Student email column to tell them apart.");
      student = found[0];
    }
    res.studentId = student.id;
    res.studentText = student.full_name || res.studentText;

    if (!pName && !pEmail) { res.status = "blank"; return; } // nothing to link; normal for students without a parent yet

    // parent
    let parent = null;
    if (pEmail) {
      parent = ctx.parentsByEmail.get(pEmail.toLowerCase()) || null;
      if (!parent) return fail(`No parent has signed up with the email ${pEmail}.`);
    } else {
      const found = ctx.parentsByKey.get(nameKey(pName)) || [];
      if (found.length === 0) return fail("No parent with this name has signed up yet.");
      if (found.length > 1) return fail("More than one parent has this name. Add the Parent email column to tell them apart.");
      parent = found[0];
    }
    res.parentId = parent.id;
    res.parentText = parent.full_name || res.parentText;

    const existing = ctx.linkOf.get(student.id);
    if (existing) {
      if (existing === parent.id) { res.status = "same"; return; }
      return fail(`Already linked to ${ctx.nameOf.get(existing) || "another parent"}. Change it from the Users page.`);
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
      list.forEach((x) => { x.status = "problem"; x.reason = "This student is listed with two different parents in the file."; });
    } else {
      list.slice(1).forEach((x) => { x.status = "repeat"; });
    }
  });
  return results;
}
// ---- end of import logic ----

function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

// Load what the preview needs, once per dialog
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
  const nameOf = new Map([...students, ...parents].map((p) => [p.id, p.full_name]));
  // a parent who is no longer active can still be named in a "already linked to ..." message
  return {
    students,
    studentsByEmail: byEmail(students),
    studentsByKey: group(students, (p) => nameKey(p.full_name)),
    parentsByEmail: byEmail(parents),
    parentsByKey: group(parents, (p) => nameKey(p.full_name)),
    linkOf: new Map(links.map((l) => [l.student_id, l.parent_id])),
    nameOf,
    groupsOf: null,
  };
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
        if (e1) failed.push({ ...p, reason: e1.code === "23505" ? "This student was linked to a parent in the meantime." : friendlyError(e1, "Couldn't link this student.") });
        else linked++;
      }
    }
    onProgress?.(Math.min(i + LINK_CHUNK, pairs.length), pairs.length);
  }
  return { linked, failed };
}

function problemsCsv(problems) {
  const lines = [["Row", "Student", "Parent", "Problem"].join(",")];
  problems.forEach((p) => lines.push([p.line ?? "", csvSafe(p.studentText || ""), csvSafe(p.parentText || ""), csvSafe(p.reason || "")].join(",")));
  return lines;
}

function openImportDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="il-title" style="max-width:480px;max-height:90vh;overflow-y:auto;">
      <h3 id="il-title">Import CSV</h3>
      <p class="text-muted" style="margin:0 0 8px;font-size:0.9rem;">Upload a CSV with a <strong>Student</strong> column and a <strong>Parent</strong> column. Each student is linked to the parent on their row. Parents must have signed up already. Group is optional and never changes anyone's group. Tip: export the Linked students list, fill in the Parent column, then upload it here.</p>
      <div class="field">
        <label for="il-pick">CSV file</label>
        <div style="display:flex;align-items:center;gap:10px;">
          <button type="button" class="icon-action" id="il-pick" title="Choose a CSV file" aria-label="Choose a CSV file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg></button>
          <div id="il-filename" aria-live="polite" style="flex:1;min-width:0;min-height:40px;box-sizing:border-box;display:flex;align-items:center;padding:0 14px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text-muted);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">No file chosen</div>
        </div>
        <input id="il-file" type="file" accept=".csv,text/csv" hidden />
      </div>
      <div id="il-preview"></div>
      <div class="dialog-actions">
        <a class="btn btn-secondary" id="il-users" href="admin-users.html" style="display:none;">Open Users</a>
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="il-go" disabled>Link students</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = (sel) => backdrop.querySelector(sel);
  const previewEl = $("#il-preview");
  const goBtn = $("#il-go");
  const cancelBtn = $('[data-act="cancel"]');
  let busy = false;
  let ctxPromise = null;
  let pending = [];
  let problems = [];
  let fileName = "";
  let runId = 0;

  const onKey = (e) => { if (e.key === "Escape" && !busy) close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !busy) close(); });
  cancelBtn.addEventListener("click", () => { if (!busy) close(); });

  const getContext = () => (ctxPromise ||= loadImportContext().catch((err) => { ctxPromise = null; throw err; }));

  function renderPreview(results, notes) {
    const count = (st) => results.filter((x) => x.status === st).length;
    pending = results.filter((x) => x.status === "link");
    problems = results.filter((x) => x.status === "problem");
    const same = count("same"), blank = count("blank"), repeat = count("repeat");
    const row = (label, n, color) => (n ? `<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;${color ? `color:${color};` : ""}"><span>${label}</span><strong>${n}</strong></div>` : "");
    const list = (items, render, max) =>
      `<div style="max-height:170px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:6px 12px;font-size:0.85rem;margin-top:6px;">${items
        .slice(0, max)
        .map(render)
        .join("")}${items.length > max ? `<div class="text-muted" style="padding:4px 0;">…and ${items.length - max} more</div>` : ""}</div>`;
    previewEl.innerHTML = `
      <div style="font-size:0.9rem;margin:4px 0 8px;">
        ${row("Will be linked", pending.length)}
        ${row("Already linked to this parent (no change)", same)}
        ${row("No parent on the row (skipped)", blank)}
        ${row("Repeated rows (ignored)", repeat)}
        ${row("Problems (skipped)", problems.length, "var(--error)")}
      </div>
      ${notes ? `<p class="text-muted" style="margin:0 0 6px;font-size:0.8rem;">${escapeHtml(notes)}</p>` : ""}
      ${pending.length ? `<div class="text-muted" style="font-size:0.8rem;margin-top:8px;">Will be linked</div>${list(pending, (x) => `<div style="padding:2px 0;">${escapeHtml(x.studentText)} <span class="text-muted">→</span> ${escapeHtml(x.parentText)}</div>`, 200)}` : ""}
      ${problems.length ? `<div style="font-size:0.8rem;margin-top:10px;color:var(--error);">Problems <a href="#" class="link" id="il-problems" style="margin-left:8px;">Download list</a></div>${list(problems, (x) => `<div style="padding:3px 0;"><strong>Row ${x.line}</strong> ${escapeHtml(x.studentText)}<div class="text-muted">${escapeHtml(x.reason)}</div></div>`, 100)}` : ""}`;
    $("#il-problems")?.addEventListener("click", (e) => {
      e.preventDefault();
      saveCsv(problemsCsv(problems), `import-problems-${todayPH()}.csv`);
    });
    goBtn.disabled = pending.length === 0;
    goBtn.textContent = pending.length ? `Link ${pending.length} student${pending.length === 1 ? "" : "s"}` : "Link students";
  }

  async function onFile(file) {
    const myRun = ++runId;
    pending = [];
    problems = [];
    goBtn.disabled = true;
    goBtn.textContent = "Link students";
    if (!file) { previewEl.innerHTML = ""; return; }
    fileName = file.name || "";
    if (file.size > IMPORT_MAX_BYTES) {
      previewEl.innerHTML = `<p style="color:var(--error);">That file is too large (over 2 MB). Please split it.</p>`;
      return;
    }
    previewEl.innerHTML = `<p class="text-muted">Reading the file and checking each row…</p>`;
    try {
      const text = await readFileText(file);
      const all = parseCsv(text);
      if (all.length < 2) { previewEl.innerHTML = `<p style="color:var(--error);">The file has no rows below the header.</p>`; return; }
      const idx = mapHeaders(all[0]);
      if (idx.student === undefined && idx.studentEmail === undefined) {
        previewEl.innerHTML = `<p style="color:var(--error);">The first row needs a <strong>Student</strong> column.</p>`;
        return;
      }
      if (idx.parent === undefined && idx.parentEmail === undefined) {
        previewEl.innerHTML = `<p style="color:var(--error);">The first row needs a <strong>Parent</strong> column.</p>`;
        return;
      }
      const dataRows = all.slice(1);
      if (dataRows.length > IMPORT_MAX_ROWS) {
        previewEl.innerHTML = `<p style="color:var(--error);">That file has ${dataRows.length} rows. The limit is ${IMPORT_MAX_ROWS} per import.</p>`;
        return;
      }
      const ctx = await getContext();
      if (myRun !== runId) return; // a newer file was chosen while this one was loading

      // Group names are only needed when two students share a name and the file has a Group column
      let notes = "";
      if (idx.group !== undefined) {
        const ambiguous = dataRows.some((r) => idx.student !== undefined && (ctx.studentsByKey.get(nameKey(r[idx.student])) || []).length > 1);
        if (ambiguous && !ctx.groupsOf) {
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
      if (myRun !== runId) return;
      if (results.length === 0) { previewEl.innerHTML = `<p style="color:var(--error);">The file has no rows to import.</p>`; return; }
      renderPreview(results, notes);
    } catch (err) {
      console.error(err);
      previewEl.innerHTML = `<p style="color:var(--error);">${escapeHtml(friendlyError(err, "Couldn't read that file."))}</p>`;
    }
  }
  const fileInput = $("#il-file");
  const fileNameEl = $("#il-filename");
  const chooseFile = () => { if (!fileInput.disabled) fileInput.click(); };
  const setPickerDisabled = (on) => { fileInput.disabled = on; $("#il-pick").disabled = on; };
  $("#il-pick").addEventListener("click", chooseFile);
  fileNameEl.addEventListener("click", chooseFile);
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0] || null;
    fileNameEl.textContent = f ? f.name : "No file chosen";
    fileNameEl.style.color = f ? "var(--text)" : "var(--text-muted)";
    onFile(f);
  });

  goBtn.addEventListener("click", async () => {
    if (busy || pending.length === 0) return;
    busy = true;
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    setPickerDisabled(true);
    try {
      const { linked, failed } = await applyLinks(pending, (done, total) => { goBtn.textContent = `Linking ${done} of ${total}…`; });
      if (linked > 0) {
        Promise.resolve(
          logAudit({ action: "user.links_imported", recordType: "organization", recordId: profile.organization_id, details: { linked, problems: problems.length + failed.length, file: fileName } })
        ).catch((e) => console.error("Audit log failed:", e));
      }
      previewEl.innerHTML = `
        <div style="font-size:0.95rem;margin:8px 0;">
          <div style="color:var(--success);"><strong>${linked}</strong> student${linked === 1 ? "" : "s"} linked.</div>
          ${failed.length ? `<div style="color:var(--error);margin-top:4px;"><strong>${failed.length}</strong> couldn't be linked:</div>${failed.slice(0, 20).map((f) => `<div class="text-muted" style="font-size:0.85rem;">${escapeHtml(f.studentText)}: ${escapeHtml(f.reason)}</div>`).join("")}` : ""}
          ${problems.length ? `<div class="text-muted" style="margin-top:6px;font-size:0.85rem;">${problems.length} row${problems.length === 1 ? "" : "s"} skipped earlier because of problems. <a href="#" class="link" id="il-problems2">Download list</a></div>` : ""}
        </div>`;
      $("#il-problems2")?.addEventListener("click", (e) => { e.preventDefault(); saveCsv(problemsCsv(problems), `import-problems-${todayPH()}.csv`); });
      goBtn.style.display = "none";
      $("#il-users").style.display = "";
      cancelBtn.textContent = "Close";
      showToast(linked ? `${linked} student${linked === 1 ? "" : "s"} linked.` : "Nothing was linked.", linked ? "success" : "error");
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to link the students."), "error");
      goBtn.disabled = false;
      goBtn.textContent = `Link ${pending.length} student${pending.length === 1 ? "" : "s"}`;
      setPickerDisabled(false);
    } finally {
      busy = false;
      cancelBtn.disabled = false;
    }
  });
}

importBtn.addEventListener("click", openImportDialog);

// The Users page links here with ?import=links to open the import straight away
if (new URLSearchParams(window.location.search).get("import") === "links") {
  history.replaceState(null, "", `${window.location.pathname}#linked`);
  openImportDialog();
}
