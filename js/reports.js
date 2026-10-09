import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "reports", pageTitle: "Reports", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

document.getElementById("export-head").innerHTML = sectionHead({
  title: "Attendance export",
  tone: "primary",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
});
document.getElementById("more-head").innerHTML = sectionHead({
  title: "More reports",
  tone: "muted",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
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

const now = new Date();
fromInput.value = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
toInput.value = localDate(now);

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
