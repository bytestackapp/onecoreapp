import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "attendance", pageTitle: "Attendance" });
if (!profile) throw new Error("redirecting");

const today = new Date().toISOString().slice(0, 10);
const isStaff = profile.role === "admin" || profile.role === "teacher";

if (isStaff) {
  document.getElementById("clock-section").style.display = "block";
  initClock();
}
if (profile.role === "teacher" || profile.role === "admin") {
  document.getElementById("rollcall-section").style.display = "block";
  initRollcall();
}
if (profile.role === "parent") {
  document.getElementById("children-section").style.display = "block";
  loadChildren();
}

loadHistory();
initCorrectionModal();

// -----------------------------------------------------------------
// Staff time clock
// -----------------------------------------------------------------
let clockRecord = null;

async function fetchTodayClockRecord() {
  const { data, error } = await supabase
    .from("attendance_records")
    .select("*")
    .eq("profile_id", profile.id)
    .eq("record_date", today)
    .is("group_id", null)
    .maybeSingle();
  if (error) console.error(error);
  return data;
}

function statusTile(label, value) {
  return `<div class="card stat-tile" style="padding:12px;"><div style="font-weight:600;">${value || "—"}</div><div class="stat-label">${label}</div></div>`;
}

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function renderClock() {
  const el = document.getElementById("clock-status");
  el.innerHTML =
    statusTile("Time in", fmtTime(clockRecord?.time_in)) +
    statusTile("Break out", fmtTime(clockRecord?.break_out)) +
    statusTile("Break in", fmtTime(clockRecord?.break_in)) +
    statusTile("Time out", fmtTime(clockRecord?.time_out));

  document.getElementById("btn-time-in").disabled = !!clockRecord?.time_in;
  document.getElementById("btn-break-out").disabled = !clockRecord?.time_in || !!clockRecord?.break_out || !!clockRecord?.time_out;
  document.getElementById("btn-break-in").disabled = !clockRecord?.break_out || !!clockRecord?.break_in;
  document.getElementById("btn-time-out").disabled = !clockRecord?.time_in || !!clockRecord?.time_out || (!!clockRecord?.break_out && !clockRecord?.break_in);
}

async function initClock() {
  clockRecord = await fetchTodayClockRecord();
  renderClock();

  const fields = { "btn-time-in": "time_in", "btn-break-out": "break_out", "btn-break-in": "break_in", "btn-time-out": "time_out" };
  Object.entries(fields).forEach(([btnId, field]) => {
    document.getElementById(btnId).addEventListener("click", async () => {
      const btn = document.getElementById(btnId);
      btn.disabled = true;
      try {
        const now = new Date().toISOString();
        if (clockRecord) {
          const { data, error } = await supabase
            .from("attendance_records")
            .update({ [field]: now, updated_at: now })
            .eq("id", clockRecord.id)
            .select()
            .single();
          if (error) throw error;
          clockRecord = data;
        } else {
          const { data, error } = await supabase
            .from("attendance_records")
            .insert({
              organization_id: profile.organization_id,
              profile_id: profile.id,
              record_date: today,
              [field]: now,
              source: "web",
            })
            .select()
            .single();
          if (error) throw error;
          clockRecord = data;
        }
        renderClock();
        loadHistory();
      } catch (err) {
        console.error(err);
        showToast(friendlyError(err, "Attendance could not be recorded."), "error");
        renderClock();
      }
    });
  });
}

// -----------------------------------------------------------------
// Class roll call (teacher/admin)
// -----------------------------------------------------------------
async function initRollcall() {
  const groupSelect = document.getElementById("rollcall-group");
  const dateInput = document.getElementById("rollcall-date");
  const studentsEl = document.getElementById("rollcall-students");
  const submitBtn = document.getElementById("rollcall-submit");
  dateInput.value = today;

  let groups = [];
  if (profile.role === "admin") {
    const { data } = await supabase.from("groups").select("id, name").order("name");
    groups = data || [];
  } else {
    const { data } = await supabase
      .from("group_members")
      .select("group_id, member_role, groups(id, name)")
      .eq("profile_id", profile.id)
      .in("member_role", ["adviser", "lead"]);
    groups = (data || []).map((r) => r.groups).filter(Boolean);
  }

  if (groups.length === 0) {
    studentsEl.innerHTML = `<p class="text-muted">You aren't set as the adviser of any class yet.</p>`;
    groupSelect.innerHTML = `<option>No classes assigned</option>`;
    groupSelect.disabled = true;
    return;
  }

  groupSelect.innerHTML = groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");

  async function loadStudents() {
    const groupId = groupSelect.value;
    const date = dateInput.value;
    studentsEl.innerHTML = `<div class="skeleton" style="height:40px;"></div>`;

    const { data: members, error: mErr } = await supabase
      .from("group_members")
      .select("profile_id, profiles(full_name)")
      .eq("group_id", groupId)
      .eq("member_role", "member");
    if (mErr) {
      studentsEl.innerHTML = `<div class="banner banner-error">Unable to load the class roster.</div>`;
      return;
    }

    const { data: existing } = await supabase
      .from("attendance_records")
      .select("id, profile_id, status")
      .eq("group_id", groupId)
      .eq("record_date", date);
    const existingMap = {};
    (existing || []).forEach((r) => (existingMap[r.profile_id] = r));

    if (!members || members.length === 0) {
      studentsEl.innerHTML = `<p class="text-muted">This class has no students yet.</p>`;
      submitBtn.style.display = "none";
      return;
    }

    const statuses = ["present", "late", "absent", "excused"];
    studentsEl.innerHTML = members
      .map((m) => {
        const current = existingMap[m.profile_id]?.status || "present";
        return `
        <div class="list-row" data-student="${m.profile_id}">
          <div style="flex:1;">${escapeHtml(m.profiles?.full_name || "Unknown")}</div>
          <div style="display:flex;gap:6px;">
            ${statuses
              .map(
                (s) => `<button type="button" class="btn btn-sm ${current === s ? "btn-primary" : "btn-secondary"} status-btn" data-status="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</button>`
              )
              .join("")}
          </div>
        </div>`;
      })
      .join("");

    studentsEl.querySelectorAll(".list-row").forEach((row) => {
      row.querySelectorAll(".status-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          row.querySelectorAll(".status-btn").forEach((b) => b.classList.replace("btn-primary", "btn-secondary"));
          btn.classList.replace("btn-secondary", "btn-primary");
        });
      });
    });

    submitBtn.style.display = "inline-flex";
    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      try {
        const rows = [...studentsEl.querySelectorAll(".list-row")].map((row) => ({
          studentId: row.getAttribute("data-student"),
          status: row.querySelector(".btn-primary").getAttribute("data-status"),
        }));

        for (const row of rows) {
          const existingRow = existingMap[row.studentId];
          if (existingRow) {
            await supabase.from("attendance_records").update({ status: row.status, updated_at: new Date().toISOString() }).eq("id", existingRow.id);
          } else {
            await supabase.from("attendance_records").insert({
              organization_id: profile.organization_id,
              profile_id: row.studentId,
              group_id: groupId,
              record_date: date,
              status: row.status,
              source: "web",
              recorded_by: profile.id,
            });
          }
        }
        await logAudit({ action: "attendance.rollcall_submitted", recordType: "group", recordId: groupId, details: { date } });
        submitBtn.textContent = "Saved";
        setTimeout(() => {
          submitBtn.textContent = "Save attendance";
          submitBtn.disabled = false;
        }, 1200);
        loadStudents();
      } catch (err) {
        console.error(err);
        showToast(friendlyError(err, "Attendance could not be recorded."), "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Save attendance";
      }
    };
  }

  groupSelect.addEventListener("change", loadStudents);
  dateInput.addEventListener("change", loadStudents);
  loadStudents();
}

// -----------------------------------------------------------------
// Parent: children's attendance
// -----------------------------------------------------------------
async function loadChildren() {
  const el = document.getElementById("children-list");
  try {
    const { data: links, error } = await supabase.from("guardians").select("student_id, profiles!guardians_student_id_fkey(full_name)").eq("parent_id", profile.id);
    if (error) throw error;

    if (!links || links.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No linked children yet</h3><p>Ask your school administrator to link your account to your child's profile.</p></div>`;
      return;
    }

    const blocks = await Promise.all(
      links.map(async (link) => {
        const { data: records } = await supabase
          .from("attendance_records")
          .select("record_date, status")
          .eq("profile_id", link.student_id)
          .order("record_date", { ascending: false })
          .limit(5);

        const rows = (records || [])
          .map((r) => `<div class="list-row"><span>${formatDate(r.record_date)}</span><span class="tag tag-${r.status === "present" ? "approved" : r.status === "absent" ? "rejected" : "pending"}" style="margin-left:auto;">${r.status || "—"}</span></div>`)
          .join("");

        return `<div style="margin-bottom:18px;">
          <h3>${escapeHtml(link.profiles?.full_name || "Student")}</h3>
          ${rows || `<p class="text-muted">No attendance records yet.</p>`}
        </div>`;
      })
    );
    el.innerHTML = blocks.join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Unable to load attendance right now.</div>`;
  }
}

// -----------------------------------------------------------------
// My history + correction requests
// -----------------------------------------------------------------
async function loadHistory() {
  const el = document.getElementById("history-list");
  try {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("id, record_date, status, time_in, time_out")
      .eq("profile_id", profile.id)
      .order("record_date", { ascending: false })
      .limit(15);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No attendance records yet</h3><p>Your attendance history will show up here.</p></div>`;
      return;
    }

    el.innerHTML = data
      .map((r) => {
        const summary = r.status ? `<span class="tag tag-${r.status === "present" ? "approved" : r.status === "absent" ? "rejected" : "pending"}">${r.status}</span>` : r.time_in
          ? `${fmtTime(r.time_in)} – ${fmtTime(r.time_out) || "…"}`
          : `<span class="text-muted">Missing record</span>`;
        return `
        <div class="list-row">
          <div style="flex:1;">${formatDate(r.record_date)}</div>
          <div>${summary}</div>
          <button class="btn btn-sm btn-secondary correction-btn" data-id="${r.id}" data-date="${r.record_date}">Request correction</button>
        </div>`;
      })
      .join("");

    el.querySelectorAll(".correction-btn").forEach((btn) => {
      btn.addEventListener("click", () => openCorrectionModal(btn.getAttribute("data-id"), btn.getAttribute("data-date")));
    });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Attendance history couldn't be loaded.</div>`;
  }
}

function initCorrectionModal() {
  document.getElementById("correction-cancel").addEventListener("click", closeCorrectionModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeCorrectionModal);
  document.getElementById("correction-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("correction-error");
    errorEl.style.display = "none";
    try {
      const { error } = await supabase.from("attendance_corrections").insert({
        organization_id: profile.organization_id,
        attendance_record_id: document.getElementById("correction-record-id").value || null,
        profile_id: profile.id,
        record_date: document.getElementById("correction-date").value,
        requested_change: document.getElementById("requested-change").value.trim(),
        reason: document.getElementById("correction-reason").value.trim(),
      });
      if (error) throw error;
      closeCorrectionModal();
      showToast("Correction request submitted.", "success");
      loadHistory();
    } catch (err) {
      console.error(err);
      errorEl.textContent = friendlyError(err, "Unable to submit your correction request. Please try again.");
      errorEl.style.display = "flex";
    }
  });
}

function openCorrectionModal(recordId, date) {
  document.getElementById("correction-record-id").value = recordId;
  document.getElementById("correction-date").value = date;
  document.getElementById("correction-modal").style.display = "block";
  document.getElementById("modal-backdrop").style.display = "block";
}
function closeCorrectionModal() {
  document.getElementById("correction-modal").style.display = "none";
  document.getElementById("modal-backdrop").style.display = "none";
  document.getElementById("correction-form").reset();
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
