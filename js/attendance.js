import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "attendance", pageTitle: "Attendance" });
if (!profile) throw new Error("redirecting");

// Local calendar date as YYYY-MM-DD. (toISOString() returns the UTC date, which is
// still "yesterday" during the first hours of the morning in UTC+8.)
function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const today = localDate();
const isStaff = profile.role === "admin" || profile.role === "teacher";
const REFRESH_MS = 60000;
const RECENT_COUNT = 5; // rows shown in the history table before "view all"

let allHistory = [];

const ICON = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  correction: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
};

// -----------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

// Runs fn every ms while the tab is visible.
function every(ms, fn) {
  setInterval(() => {
    if (document.visibilityState === "visible") fn();
  }, ms);
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
    const { data, error } = await supabase.from("groups").select("id, name").order("name");
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
          tag = `<span class="tag tag-pending">Not yet in</span>`;
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
async function loadChildren(showErrors = false) {
  const el = document.getElementById("children-list");
  try {
    const { data: links, error } = await supabase
      .from("guardians")
      .select("student_id, profiles!guardians_student_id_fkey(full_name)")
      .eq("parent_id", profile.id);
    if (error) throw error;

    if (!links || links.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No linked children yet</h3><p>Ask your school administrator to link your account to your child's profile.</p></div>`;
      return;
    }

    const blocks = await Promise.all(
      links.map(async (link) => {
        const { data: records, error: rErr } = await supabase
          .from("attendance_records")
          .select("id, record_date, group_id, status, time_in, time_out")
          .eq("profile_id", link.student_id)
          .order("record_date", { ascending: false })
          .limit(30);
        if (rErr) throw rErr;

        const days = mergeByDate(records);
        const todayEntry = days.find((d) => d.date === today);
        let headline;
        if (todayEntry?.time_out) headline = `<span class="tag tag-normal">Left school ${fmtTime(todayEntry.time_out)}</span>`;
        else if (todayEntry?.time_in) headline = `<span class="tag tag-approved">In school since ${fmtTime(todayEntry.time_in)}</span>`;
        else headline = `<span class="tag tag-pending">Not yet checked in today</span>`;

        const rows = days
          .slice(0, 7)
          .map((d) => `<div class="list-row" style="align-items:center;"><span>${formatDate(d.date)}</span><span style="margin-left:auto;">${daySummary(d)}</span></div>`)
          .join("");

        return `<div style="margin-bottom:18px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;">
            <h3 style="margin:0;">${escapeHtml(link.profiles?.full_name || "Student")}</h3>
            ${headline}
          </div>
          ${rows || `<p class="text-muted">No attendance records yet.</p>`}
        </div>`;
      })
    );
    el.innerHTML = blocks.join("");
  } catch (err) {
    console.error(err);
    if (showErrors) {
      el.innerHTML = `<div class="empty-state"><h3>Attendance couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
      showToast("Attendance couldn't be loaded.", "error");
    }
  }
}

// -----------------------------------------------------------------
// My history (table) + correction requests
// -----------------------------------------------------------------
function historyTable(entries) {
  return `
    <table class="data-table">
      <thead>
        <tr><th>Date</th><th>Time</th><th class="col-action">Action</th></tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (e) => `
          <tr>
            <td>${formatDate(e.date)}</td>
            <td>${daySummary(e)}</td>
            <td class="col-action">
              <button type="button" class="icon-action sm correction-btn" data-id="${e.id}" data-date="${e.date}" title="Request correction" aria-label="Request correction">${ICON.correction}</button>
            </td>
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

    // Combine the record's date with the chosen time, in the browser's local time zone
    const newTime = backdrop.querySelector("#corr-new").value; // "HH:MM"
    const requested = new Date(`${date}T${newTime}:00`);
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
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to submit your correction request. Please try again."), "error");
      submit.disabled = false;
    }
  });
}

// -----------------------------------------------------------------
// Start
// -----------------------------------------------------------------
if (isStaff) {
  document.getElementById("clock-section").style.display = "block";
  loadStaffToday(true);
  every(REFRESH_MS, () => loadStaffToday());

  document.getElementById("rollcall-section").style.display = "block";
  initRollcall();
}
if (profile.role === "parent") {
  document.getElementById("children-section").style.display = "block";
  loadChildren(true);
  every(REFRESH_MS, () => loadChildren());
}

document.getElementById("history-view-btn").addEventListener("click", openHistoryDialog);
loadHistory();
