import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { todayPH, addDaysISO, timePH, momentPH } from "./time.js";
import { escapeHtml, cap } from "./utils.js";

const profile = await mountLayout({ activeKey: "attendance", pageTitle: "Attendance", allowedRoles: ["admin", "teacher", "student", "parent"] });
if (!profile) throw new Error("redirecting");

// Today's date in Philippine time (YYYY-MM-DD)
const today = todayPH();
const isStaff = profile.role === "admin" || profile.role === "teacher";
const isParent = profile.role === "parent";
const RECENT_COUNT = 7; // rows shown in the history table before "view all"

let allHistory = [];

const ICON = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  correction: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
};

// -----------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------

function fmtTime(iso) {
  if (!iso) return null;
  return timePH(iso);
}

function statusTag(status) {
  const kind = status === "present" ? "approved" : status === "absent" ? "rejected" : "pending";
  return `<span class="tag tag-${kind}">${escapeHtml(cap(status))}</span>`;
}

function sourceLabel(source) {
  return (
    { biometric: "the biometric scanner", gate: "the gate scanner", scanner: "a scanner", web: "the web app", manual: "manual entry" }[source] ||
    source
  );
}

// A day can have a school-wide record (gate/biometric scan, group_id null) and
// class roll-call records (group_id set). Combine them into one entry per date.
function mergeByDate(records) {
  const map = new Map();
  for (const r of records || []) {
    const e = map.get(r.record_date) || {
      date: r.record_date,
      id: null,
      time_in: null,
      break_out: null,
      break_in: null,
      time_out: null,
      status: null,
    };
    if (!r.group_id) {
      e.id = r.id;
      e.time_in = r.time_in;
      e.break_out = r.break_out;
      e.break_in = r.break_in;
      e.time_out = r.time_out;
    } else {
      if (!e.id) e.id = r.id;
      if (r.status) e.status = r.status;
    }
    map.set(r.record_date, e);
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function daySummary(e) {
  if (e.time_in) {
    return `<span>${fmtTime(e.time_in)} – ${fmtTime(e.time_out) || "…"}</span>${e.status ? " " + statusTag(e.status) : ""}`;
  }
  if (e.status) return statusTag(e.status);
  return `<span class="text-muted">No record</span>`;
}

// -----------------------------------------------------------------
// Dialog helpers (shared by all pop-ups on this page)
// -----------------------------------------------------------------
function isTopDialog(el) {
  const all = document.querySelectorAll(".dialog-backdrop");
  return all[all.length - 1] === el;
}

// Wires Escape, click-outside and any [data-act="close|cancel"] button. Returns close().
function attachDialogClose(backdrop) {
  const onKey = (e) => {
    if (e.key === "Escape" && isTopDialog(backdrop)) close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-act="close"], [data-act="cancel"]').forEach((b) => b.addEventListener("click", close));
  return close;
}

// -----------------------------------------------------------------
// Staff: today's record (read-only, captured by scanners)
// -----------------------------------------------------------------
function statusTile(label, value) {
  return `<div class="card stat-tile" style="padding:12px;"><div style="font-weight:600;">${value || "—"}</div><div class="stat-label">${label}</div></div>`;
}

function renderStaffToday(rec) {
  document.getElementById("clock-status").innerHTML =
    statusTile("Time in", fmtTime(rec?.time_in)) +
    statusTile("Break out", fmtTime(rec?.break_out)) +
    statusTile("Break in", fmtTime(rec?.break_in)) +
    statusTile("Time out", fmtTime(rec?.time_out));

  document.getElementById("clock-note").textContent = rec
    ? `Recorded by ${sourceLabel(rec.source)}. This updates automatically.`
    : "Nothing recorded yet today. Your time in and out are captured automatically by the biometric or gate scanners.";
}

async function loadStaffToday(showErrors = false) {
  const { data, error } = await supabase
    .from("attendance_records")
    .select("time_in, break_out, break_in, time_out, source")
    .eq("profile_id", profile.id)
    .eq("record_date", today)
    .is("group_id", null)
    .maybeSingle();
  if (error) {
    console.error(error);
    if (showErrors) showToast("Today's attendance couldn't be loaded.", "error");
    return;
  }
  renderStaffToday(data);
}

// -----------------------------------------------------------------
// Teacher / admin: class check-in view (backup for the scanners)
// -----------------------------------------------------------------
async function initRollcall() {
  const groupSelect = document.getElementById("rollcall-group");
  const dateInput = document.getElementById("rollcall-date");
  const viewBtn = document.getElementById("rollcall-show");
  const hintEl = document.getElementById("rollcall-hint");
  dateInput.value = today;

  let groups = [];
  if (profile.role === "admin") {
    const { data, error } = await supabase.from("groups").select("id, name").order("name").eq("organization_id", profile.organization_id);
    if (error) console.error(error);
    groups = data || [];
  } else {
    const { data, error } = await supabase
      .from("group_members")
      .select("group_id, member_role, groups(id, name)")
      .eq("profile_id", profile.id)
      .in("member_role", ["adviser", "lead"]);
    if (error) console.error(error);
    groups = (data || []).map((r) => r.groups).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (groups.length === 0) {
    groupSelect.innerHTML = `<option>No classes assigned</option>`;
    groupSelect.disabled = true;
    dateInput.disabled = true;
    viewBtn.style.display = "none";
    hintEl.textContent = "You aren't set as the adviser of any class yet.";
    return;
  }

  groupSelect.innerHTML = groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");

  viewBtn.addEventListener("click", () => {
    if (!groupSelect.value || !dateInput.value) {
      showToast("Choose a class and a date.", "error");
      return;
    }
    const groupName = groupSelect.options[groupSelect.selectedIndex].textContent;
    openClassDialog(groupSelect.value, groupName, dateInput.value);
  });
}

// Pop-up with the class list: who has checked in, who hasn't.
function openClassDialog(groupId, groupName, date) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="cls-title">
      <h3 id="cls-title">Class attendance</h3>
      <p>${escapeHtml(groupName)} · ${escapeHtml(formatDate(date))}</p>
      <div id="cls-summary"></div>
      <div id="cls-list" class="ack-list"><div class="skeleton" style="height:40px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  attachDialogClose(backdrop);

  const summaryEl = backdrop.querySelector("#cls-summary");
  const listEl = backdrop.querySelector("#cls-list");

  async function markPresent(studentId, existingRow, btn) {
    btn.disabled = true;
    try {
      const now = new Date().toISOString();
      if (existingRow) {
        const { data, error } = await supabase
          .from("attendance_records")
          .update({ status: "present", source: "manual", recorded_by: profile.id, updated_at: now })
          .eq("id", existingRow.id)
          .select("id");
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("row-level security");
      } else {
        const { error } = await supabase.from("attendance_records").insert({
          organization_id: profile.organization_id,
          profile_id: studentId,
          group_id: groupId,
          record_date: date,
          status: "present",
          source: "manual",
          recorded_by: profile.id,
        });
        if (error) throw error;
      }
      await logAudit({ action: "attendance.marked_present", recordType: "group", recordId: groupId, details: { date } });
      showToast("Marked present.", "success");
      await render();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to save attendance."), "error");
      btn.disabled = false;
    }
  }

  async function render() {
    try {
      const { data: members, error: mErr } = await supabase
        .from("group_members")
        .select("profile_id, profiles(full_name)")
        .eq("group_id", groupId)
        .eq("member_role", "member");
      if (mErr) throw mErr;

      if (!members || members.length === 0) {
        summaryEl.innerHTML = "";
        listEl.innerHTML = `<p class="text-muted" style="margin:0;">This class has no students yet.</p>`;
        return;
      }

      const ids = members.map((m) => m.profile_id);

      // School-wide records (gate / biometric scans)
      const { data: gateRows, error: gErr } = await supabase
        .from("attendance_records")
        .select("profile_id, time_in, time_out")
        .in("profile_id", ids)
        .eq("record_date", date)
        .is("group_id", null);
      if (gErr) throw gErr;

      // Manual class records (backup entries)
      const { data: classRows, error: cErr } = await supabase
        .from("attendance_records")
        .select("id, profile_id, status")
        .eq("group_id", groupId)
        .eq("record_date", date);
      if (cErr) throw cErr;

      const gate = {};
      (gateRows || []).forEach((r) => (gate[r.profile_id] = r));
      const cls = {};
      (classRows || []).forEach((r) => (cls[r.profile_id] = r));

      const rows = members.map((m) => {
        const g = gate[m.profile_id];
        const c = cls[m.profile_id];
        let checkedIn = false;
        let tag;
        if (g?.time_out) {
          checkedIn = true;
          tag = `<span class="tag tag-normal">Left ${fmtTime(g.time_out)}</span>`;
        } else if (g?.time_in) {
          checkedIn = true;
          tag = `<span class="tag tag-approved">In ${fmtTime(g.time_in)}</span>`;
        } else if (c?.status === "present" || c?.status === "late") {
          checkedIn = true;
          tag = `<span class="tag tag-approved">${cap(c.status)} (manual)</span>`;
        } else if (c?.status) {
          tag = statusTag(c.status);
        } else {
          tag = `<span class="tag tag-rejected">Absent</span>`;
        }
        return { id: m.profile_id, name: m.profiles?.full_name || "Unknown", checkedIn, tag, classRow: c };
      });

      // Students who haven't checked in come first.
      rows.sort((a, b) => Number(a.checkedIn) - Number(b.checkedIn) || a.name.localeCompare(b.name));

      const inCount = rows.filter((r) => r.checkedIn).length;
      const pct = Math.round((inCount / rows.length) * 100);

      summaryEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;">${inCount} of ${rows.length} checked in</div>
        <div style="height:6px;border-radius:999px;background:var(--border);overflow:hidden;margin-bottom:6px;">
          <span style="display:block;height:100%;width:${pct}%;background:var(--success);"></span>
        </div>`;

      listEl.innerHTML = rows
        .map(
          (r) => `
        <div class="list-row" style="align-items:center;">
          <div style="flex:1;min-width:0;font-weight:500;">${escapeHtml(r.name)}</div>
          ${r.tag}
          ${
            r.checkedIn
              ? ""
              : `<button type="button" class="icon-action sm approve mark-btn" data-id="${r.id}" title="Mark present" aria-label="Mark present">${ICON.check}</button>`
          }
        </div>`
        )
        .join("");

      listEl.querySelectorAll(".mark-btn").forEach((btn) => {
        const studentId = btn.getAttribute("data-id");
        btn.addEventListener("click", () => markPresent(studentId, cls[studentId], btn));
      });
    } catch (err) {
      console.error(err);
      summaryEl.innerHTML = "";
      listEl.innerHTML = `<p class="text-muted" style="margin:0;">The class list couldn't be loaded.</p>`;
      showToast(friendlyError(err, "The class list couldn't be loaded."), "error");
    }
  }

  render();
}

// -----------------------------------------------------------------
// Parent: children's arrival and departure log
// -----------------------------------------------------------------
const CHILD_RECENT_DAYS = 7; // how far back the child tables look on page load (keeps the request small)
const CHILD_PAGE_SIZE = 10; // days per page in the "view all" list
const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

// Today always comes first. If the child hasn't checked in (and has no status), today shows "Absent" by default.
function withToday(days) {
  const rest = days.filter((d) => d.date !== today);
  let t = days.find((d) => d.date === today) || { date: today, id: null, time_in: null, time_out: null, status: null };
  if (!t.time_in && !t.status) t = { ...t, status: "absent" };
  return [t, ...rest];
}

async function loadChildren(showErrors = false) {
  const el = document.getElementById("children-list");
  try {
    const { data: links, error } = await supabase
      .from("guardians")
      .select("student_id, profiles!guardians_student_id_fkey(full_name)")
      .eq("parent_id", profile.id);
    if (error) throw error;

    // Teachers and admins see this block only when they have a linked child; parents always do.
    const childSection = document.getElementById("children-section");
    if ((!links || links.length === 0) && !isParent) {
      childSection.style.display = "none";
      return;
    }
    childSection.style.display = "block";

    if (!links || links.length === 0) {
      el.innerHTML = `<div class="card"><div class="empty-state"><h3>No linked children yet</h3><p>Ask your school administrator to link your account to your child's profile.</p></div></div>`;
      return;
    }

    // One request for all children, limited to the last two weeks
    const { data: records, error: rErr } = await supabase
      .from("attendance_records")
      .select("id, profile_id, record_date, group_id, status, time_in, time_out")
      .in("profile_id", links.map((l) => l.student_id))
      .gte("record_date", addDaysISO(today, -CHILD_RECENT_DAYS))
      .order("record_date", { ascending: false });
    if (rErr) throw rErr;

    // Each child gets their own card and table: today first, then the most recent days
    el.innerHTML = [...links]
      .sort((a, b) => (a.profiles?.full_name || "").localeCompare(b.profiles?.full_name || "", undefined, { sensitivity: "base" }))
      .map((link) => {
        const name = link.profiles?.full_name || "Student";
        const mine = (records || []).filter((r) => r.profile_id === link.student_id);
        const rows = withToday(mergeByDate(mine)).slice(0, RECENT_COUNT);
        return `<div class="card" style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;">
            <h3 style="margin:0;">${escapeHtml(name)}</h3>
            <button type="button" class="icon-action sm child-view-btn" data-id="${link.student_id}" data-name="${escapeHtml(name)}" title="View all attendance" aria-label="View all attendance for ${escapeHtml(name)}">${EYE_ICON}</button>
          </div>
          ${historyTable(rows, false)}
        </div>`;
      })
      .join("");

    el.querySelectorAll(".child-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => openChildHistoryDialog(btn.getAttribute("data-id"), btn.getAttribute("data-name")));
    });
  } catch (err) {
    console.error(err);
    if (showErrors) {
      el.innerHTML = `<div class="card"><div class="empty-state"><h3>Attendance couldn't be loaded</h3><p>Please refresh the page.</p></div></div>`;
      showToast("Attendance couldn't be loaded.", "error");
    }
  }
}

// One child's full history, loaded only when the eye icon is tapped, shown a page at a time.
async function openChildHistoryDialog(studentId, name) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="child-hist-title">
      <h3 id="child-hist-title">${escapeHtml(name)}</h3>
      <div class="ack-list" id="child-hist-body" style="max-height:55vh;"><div class="skeleton" style="height:60px;"></div></div>
      <div id="child-hist-pager" style="display:none;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;">
        <button type="button" class="btn btn-secondary btn-sm" data-act="prev">Previous</button>
        <span class="text-muted" id="child-hist-page" style="font-size:0.85rem;"></span>
        <button type="button" class="btn btn-secondary btn-sm" data-act="next">Next</button>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  attachDialogClose(backdrop);

  const bodyEl = backdrop.querySelector("#child-hist-body");
  const pagerEl = backdrop.querySelector("#child-hist-pager");
  const pageEl = backdrop.querySelector("#child-hist-page");
  const prevBtn = backdrop.querySelector('[data-act="prev"]');
  const nextBtn = backdrop.querySelector('[data-act="next"]');

  try {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("id, record_date, group_id, status, time_in, time_out")
      .eq("profile_id", studentId)
      .order("record_date", { ascending: false })
      .limit(500);
    if (error) throw error;

    const entries = withToday(mergeByDate(data));
    const pages = Math.max(1, Math.ceil(entries.length / CHILD_PAGE_SIZE));
    let page = 0;

    const render = () => {
      bodyEl.innerHTML = historyTable(entries.slice(page * CHILD_PAGE_SIZE, (page + 1) * CHILD_PAGE_SIZE), false);
      bodyEl.scrollTop = 0;
      pageEl.textContent = `Page ${page + 1} of ${pages}`;
      prevBtn.disabled = page === 0;
      nextBtn.disabled = page >= pages - 1;
    };
    prevBtn.addEventListener("click", () => { if (page > 0) { page--; render(); } });
    nextBtn.addEventListener("click", () => { if (page < pages - 1) { page++; render(); } });
    if (pages > 1) pagerEl.style.display = "flex";
    render();
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<div class="empty-state"><h3>History couldn't be loaded</h3><p>Please try again.</p></div>`;
  }
}

// -----------------------------------------------------------------
// My history (table) + correction requests
// -----------------------------------------------------------------
function historyTable(entries, canCorrect = isStaff) {
  // canCorrect: corrections are for staff payroll reference only (children's tables pass false)
  return `
    <table class="data-table">
      <thead>
        <tr><th>Date</th><th>Time</th>${canCorrect ? `<th class="col-action">Action</th>` : ""}</tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (e) => `
          <tr>
            <td>${formatDate(e.date)}</td>
            <td>${daySummary(e)}</td>
            ${
              canCorrect
                ? `<td class="col-action">
              <button type="button" class="icon-action sm correction-btn" data-id="${e.id}" data-date="${e.date}" title="Request correction" aria-label="Request correction">${ICON.correction}</button>
            </td>`
                : ""
            }
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function wireCorrectionButtons(container) {
  container.querySelectorAll(".correction-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCorrectionDialog(btn.getAttribute("data-id"), btn.getAttribute("data-date")));
  });
}

async function loadHistory() {
  const el = document.getElementById("history-list");
  const viewBtn = document.getElementById("history-view-btn");
  try {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("id, record_date, group_id, status, time_in, break_out, break_in, time_out")
      .eq("profile_id", profile.id)
      .order("record_date", { ascending: false })
      .limit(300);
    if (error) throw error;

    allHistory = mergeByDate(data);

    if (allHistory.length === 0) {
      viewBtn.style.display = "none";
      el.innerHTML = `<div class="empty-state"><h3>No attendance records yet</h3><p>Your attendance history will show up here.</p></div>`;
      return;
    }

    el.innerHTML = historyTable(allHistory.slice(0, RECENT_COUNT));
    wireCorrectionButtons(el);
    viewBtn.style.display = "inline-flex";
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>History couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Attendance history couldn't be loaded.", "error");
  }
}

function openHistoryDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="hist-title">
      <h3 id="hist-title">Attendance history</h3>
      <div class="ack-list" style="max-height:55vh;">${historyTable(allHistory)}</div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  attachDialogClose(backdrop);
  wireCorrectionButtons(backdrop);
}

// Which punch a correction can target
const CORRECTION_FIELDS = [
  { key: "time_in", label: "Time in" },
  { key: "break_out", label: "Break out" },
  { key: "break_in", label: "Break in" },
  { key: "time_out", label: "Time out" },
];

function openCorrectionDialog(recordId, date) {
  // The day's merged record, so we can show the actual (scanner) times
  const entry = allHistory.find((e) => e.date === date) || {};

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="corr-title">
      <h3 id="corr-title">Request a correction</h3>
      <form id="corr-form">
        <div class="field">
          <label for="corr-date">Date</label>
          <input id="corr-date" type="text" value="${escapeHtml(formatDate(date))}" disabled />
        </div>
        <div class="field">
          <label for="corr-field">Requested correction for</label>
          <select id="corr-field" required>
            ${CORRECTION_FIELDS.map((f) => `<option value="${f.key}">${f.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="corr-actual" id="corr-actual-label">Actual time in</label>
          <input id="corr-actual" type="text" value="" disabled />
        </div>
        <div class="field">
          <label for="corr-new" id="corr-new-label">New time in</label>
          <input id="corr-new" type="time" required />
        </div>
        <div class="field">
          <label for="corr-reason">Reason</label>
          <textarea id="corr-reason" rows="3" required></textarea>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="corr-submit">Submit request</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);
  const close = attachDialogClose(backdrop);

  const fieldSel = backdrop.querySelector("#corr-field");
  const selectedField = () => CORRECTION_FIELDS.find((f) => f.key === fieldSel.value);

  // Keep the labels and the "actual" value in step with the chosen punch
  function syncField() {
    const f = selectedField();
    backdrop.querySelector("#corr-actual-label").textContent = `Actual ${f.label.toLowerCase()}`;
    backdrop.querySelector("#corr-new-label").textContent = `New ${f.label.toLowerCase()}`;
    backdrop.querySelector("#corr-actual").value = fmtTime(entry[f.key]) || ""; // blank when there is no record
  }
  fieldSel.addEventListener("change", syncField);
  syncField();
  fieldSel.focus();

  backdrop.querySelector("#corr-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = selectedField();
    const current = entry[f.key] || null;

    // Combine the record's date with the chosen time, as Philippine time
    const newTime = backdrop.querySelector("#corr-new").value; // "HH:MM"
    const requested = momentPH(date, newTime);
    if (!newTime || isNaN(requested)) {
      showToast("Please choose a valid time.", "error");
      return;
    }
    if (current && Math.abs(new Date(current) - requested) < 60000) {
      showToast(`That is already your recorded ${f.label.toLowerCase()}.`, "error");
      return;
    }

    const submit = backdrop.querySelector("#corr-submit");
    submit.disabled = true;
    try {
      const { error } = await supabase.from("attendance_corrections").insert({
        organization_id: profile.organization_id,
        attendance_record_id: recordId && recordId !== "null" ? recordId : null,
        profile_id: profile.id,
        record_date: date,
        // Human-readable summary (what the admin sees in the review pop-up)
        requested_change: `${f.label}: ${current ? fmtTime(current) : "no record"} → ${fmtTime(requested.toISOString())}`,
        // Structured values: applied to the attendance record when an admin approves
        field: f.key,
        current_value: current,
        requested_value: requested.toISOString(),
        reason: backdrop.querySelector("#corr-reason").value.trim(),
      });
      if (error) throw error;
      close();
      showToast("Correction request submitted.", "success");
      loadCorrections();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to submit your correction request. Please try again."), "error");
      submit.disabled = false;
    }
  });
}

// -----------------------------------------------------------------
// Attendance corrections: pending requests + full list in a pop-up
// -----------------------------------------------------------------
const isAdmin = profile.role === "admin";
let allCorrections = [];
let refreshAllModal = null; // set while the "all requests" pop-up is open

// "Time in: 4:42 PM → 3:33 PM"  ->  { field: "Time in", detail: "4:42 PM → 3:33 PM" }
function splitChange(text) {
  const t = String(text || "");
  const i = t.indexOf(": ");
  return i < 0 ? { field: "", detail: t } : { field: t.slice(0, i), detail: t.slice(i + 2) };
}

function monthLabel(dateStr) {
  const [y, m] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }).toUpperCase();
}

function correctionCard(c, clickable) {
  const { field, detail } = splitChange(c.requested_change);
  const kind = c.status === "approved" ? "approved" : c.status === "rejected" ? "rejected" : "pending";
  const muted = "font-size:0.85rem;margin-top:2px;overflow-wrap:anywhere;";
  return `
    <div class="correction-card" data-id="${c.id}" ${clickable ? `role="button" tabindex="0"` : ""}
      style="padding:12px 0;border-bottom:1px solid var(--border);${clickable ? "cursor:pointer;" : ""}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-weight:600;min-width:0;">${escapeHtml(c.name)}</div>
        <span class="tag tag-${kind}">${escapeHtml(c.status || "pending")}</span>
      </div>
      <div class="text-muted" style="${muted}">${field ? `${escapeHtml(field)} · ` : ""}${escapeHtml(formatDate(c.record_date))}</div>
      <div class="text-muted" style="${muted}">Changes: ${escapeHtml(detail)}</div>
      <div class="text-muted" style="${muted}">Reason: ${escapeHtml(c.reason || "—")}</div>
    </div>`;
}

// Admins can tap a pending request to review it
function wireCorrectionCards(container) {
  if (!isAdmin) return;
  container.querySelectorAll(".correction-card[role=\"button\"]").forEach((card) => {
    const open = () => {
      const c = allCorrections.find((x) => x.id === card.getAttribute("data-id"));
      if (c && c.status === "pending") openReviewDialog(c);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

async function loadCorrections() {
  const el = document.getElementById("corrections-list");
  const viewBtn = document.getElementById("corrections-view-btn");
  try {
    let q = supabase
      .from("attendance_corrections")
      .select("id, profile_id, record_date, requested_change, reason, status, reviewer_remarks, created_at")
      .eq("organization_id", profile.organization_id)
      .order("created_at", { ascending: false })
      .limit(300);
    if (!isAdmin) q = q.eq("profile_id", profile.id); // everyone else only sees their own requests
    const { data, error } = await q;
    if (error) throw error;

    // Look up the requesters' names
    const names = { [profile.id]: profile.full_name };
    const missing = [...new Set((data || []).map((c) => c.profile_id))].filter((id) => !names[id]);
    if (missing.length) {
      const { data: people, error: pErr } = await supabase.from("profiles").select("id, full_name").in("id", missing);
      if (pErr) console.error(pErr);
      (people || []).forEach((p) => (names[p.id] = p.full_name));
    }

    allCorrections = (data || []).map((c) => ({ ...c, name: names[c.profile_id] || "Unknown" }));
    const pending = allCorrections.filter((c) => c.status === "pending");

    viewBtn.style.display = allCorrections.length ? "inline-flex" : "none";
    el.innerHTML = pending.length
      ? pending.map((c) => correctionCard(c, isAdmin)).join("")
      : `<div class="empty-state"><h3>No pending requests</h3><p>${isAdmin ? "Correction requests waiting for review will show up here." : "Your pending correction requests will show up here."}</p></div>`;
    wireCorrectionCards(el);
    if (refreshAllModal) refreshAllModal();
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty-state"><h3>Requests couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
  }
}

// Pop-up with every request (pending, approved, rejected), grouped by month
function openAllCorrectionsDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="allcorr-title">
      <h3 id="allcorr-title">All correction requests</h3>
      <div class="ack-list" id="allcorr-list" style="max-height:60vh;"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  attachDialogClose(backdrop); // Escape, click-outside and the Close button

  const listEl = backdrop.querySelector("#allcorr-list");
  function renderList() {
    if (!allCorrections.length) {
      listEl.innerHTML = `<p class="text-muted" style="margin:0;">No correction requests yet.</p>`;
      return;
    }
    const sorted = [...allCorrections].sort(
      (a, b) => b.record_date.localeCompare(a.record_date) || String(b.created_at).localeCompare(String(a.created_at))
    );
    let html = "";
    let current = "";
    for (const c of sorted) {
      const label = monthLabel(c.record_date);
      if (label !== current) {
        current = label;
        html += `<div style="font-size:0.72rem;font-weight:700;letter-spacing:0.06em;opacity:0.65;padding:14px 0 2px;">${label}</div>`;
      }
      html += correctionCard(c, isAdmin && c.status === "pending");
    }
    listEl.innerHTML = html;
    wireCorrectionCards(listEl);
  }
  refreshAllModal = () => {
    if (document.body.contains(backdrop)) renderList();
    else refreshAllModal = null;
  };
  renderList();
}

// Admin: approve or reject one pending request
function openReviewDialog(c) {
  const { field, detail } = splitChange(c.requested_change);
  const hasParts = detail.includes("→");
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="rev-title">
      <h3 id="rev-title" style="margin-bottom:16px;">Correction request</h3>
      <p><strong>Name:</strong> ${escapeHtml(c.name)}</p>
      <p><strong>Date to Adjust:</strong> ${escapeHtml(formatDate(c.record_date))}</p>
      ${
        hasParts
          ? `<p><strong>Requested Change:</strong> ${escapeHtml(field)}</p><p><strong>Changes:</strong> ${escapeHtml(detail)}</p>`
          : `<p><strong>Requested Change:</strong> ${escapeHtml(c.requested_change)}</p>`
      }
      <p><strong>Reason:</strong> ${escapeHtml(c.reason || "—")}</p>
      <div class="field">
        <label for="rev-remarks">Remarks (optional)</label>
        <textarea id="rev-remarks" rows="2"></textarea>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" style="background:var(--error);border-color:var(--error);color:#fff;" data-act="reject">Reject</button>
        <button type="button" class="btn btn-primary" data-act="approve">Approve</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = attachDialogClose(backdrop);
  const approveBtn = backdrop.querySelector('[data-act="approve"]');
  const rejectBtn = backdrop.querySelector('[data-act="reject"]');

  async function review(approve) {
    const remarks = backdrop.querySelector("#rev-remarks").value.trim() || null;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      const { error } = await supabase.rpc("review_attendance_correction", {
        p_correction_id: c.id,
        p_approve: approve,
        p_remarks: remarks,
      });
      if (error) throw error;
      await logAudit({
        action: approve ? "attendance.correction_approved" : "attendance.correction_rejected",
        recordType: "attendance_correction",
        recordId: c.id,
        details: { student: c.name, date: c.record_date },
      });
      showToast(approve ? "Correction approved." : "Correction rejected.", "success");
      close();
      await loadCorrections();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to save this decision."), "error");
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  }
  approveBtn.addEventListener("click", () => review(true));
  rejectBtn.addEventListener("click", () => review(false));
}

// -----------------------------------------------------------------
// Start
// -----------------------------------------------------------------
if (isStaff) {
  document.getElementById("clock-section").style.display = "block";
  loadStaffToday(true);

  document.getElementById("rollcall-section").style.display = "block";
  initRollcall();
}
// Parents always see "Your children"; teachers and admins see it when they have a linked child.
if (isParent) document.getElementById("children-section").style.display = "block";
loadChildren(isParent);

// Parents have no attendance of their own; they see "Your children" instead.
if (isParent) {
  document.getElementById("history-section").style.display = "none";
} else {
  document.getElementById("history-view-btn").addEventListener("click", openHistoryDialog);
  loadHistory();
}

// Corrections are staff-only (payroll reference).
if (isStaff) {
  document.getElementById("corrections-view-btn").addEventListener("click", openAllCorrectionsDialog);
  loadCorrections().then(() => {
    // Arriving from a notification (attendance.html#corrections): bring the block into view
    if (location.hash === "#corrections") document.getElementById("corrections-section").scrollIntoView({ behavior: "smooth", block: "start" });
  });
} else {
  document.getElementById("corrections-section").style.display = "none";
}

// Instead of asking the server every minute, refresh when something actually happens:
//  - a push arrives (a child scanned in or out, a correction was filed or decided), or
//  - the person comes back to this screen after more than a minute away.
let lastRefreshAt = Date.now();
function refreshLive() {
  if (document.querySelector(".dialog-backdrop")) return;
  lastRefreshAt = Date.now();
  if (isStaff) loadStaffToday();
  loadChildren();
  if (isAdmin) loadCorrections();
}
window.addEventListener("onecore:push", (e) => {
  const t = e.detail?.related_type;
  if (e.detail?.forThisAcademy && (t === "attendance" || t === "attendance_correction")) refreshLive();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastRefreshAt > 60000) refreshLive();
});