import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError } from "./supabase-client.js";
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
exportBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/></svg>`;
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
linkedBtn.style.marginLeft = "auto";
linkedBtn.innerHTML = exportBtn.innerHTML;
const linkedHead = document.getElementById("linked-head");
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

    const lines = [["Student", "Student email", "Parent", "Parent email"].join(",")];
    rows.forEach((r) =>
      lines.push([csvSafe(r.student.full_name || ""), csvSafe(r.student.email || ""), csvSafe(r.parent?.full_name || ""), csvSafe(r.parent?.email || "")].join(","))
    );

    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `linked-students-${choice.scope}-${todayPH()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Export downloaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to export linked students right now."), "error");
  } finally {
    linkedBtn.disabled = false;
  }
});
