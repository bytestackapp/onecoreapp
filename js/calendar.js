import { mountLayout } from "./layout.js";
import { supabase, formatDate } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "calendar", pageTitle: "Calendar" });
if (!profile) throw new Error("redirecting");

let cursor = new Date();
cursor.setDate(1);
let currentView = "month";

const monthNav = document.getElementById("month-nav");
const agendaLabel = document.getElementById("agenda-label");
const agendaBtn = document.getElementById("agenda-btn");
const backBtn = document.getElementById("back-btn");
const monthViewEl = document.getElementById("month-view");
const agendaViewEl = document.getElementById("agenda-view");

function setView(view) {
  currentView = view;
  const isAgenda = view === "agenda";
  monthNav.style.display = isAgenda ? "none" : "flex";
  agendaLabel.style.display = isAgenda ? "block" : "none";
  agendaBtn.style.display = isAgenda ? "none" : "inline-flex";
  backBtn.style.display = isAgenda ? "inline-flex" : "none";
  monthViewEl.style.display = isAgenda ? "none" : "block";
  agendaViewEl.style.display = isAgenda ? "block" : "none";
  if (isAgenda) renderAgenda();
}

agendaBtn.addEventListener("click", () => setView("agenda"));
backBtn.addEventListener("click", () => setView("month"));

document.getElementById("prev-month").addEventListener("click", () => {
  cursor.setMonth(cursor.getMonth() - 1);
  loadAndRenderMonth();
});
document.getElementById("next-month").addEventListener("click", () => {
  cursor.setMonth(cursor.getMonth() + 1);
  loadAndRenderMonth();
});

async function fetchEvents(fromDate, toDate) {
  const { data, error } = await supabase
    .from("events")
    .select("id, title, event_date, start_time, end_time, location")
    .neq("status", "cancelled")
    .gte("event_date", fromDate)
    .lte("event_date", toDate)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

// Own attendance for the visible range: a date counts "present" if any
// record that day has a time-in scan or a present/late class status.
async function fetchPresentDates(fromDate, toDate) {
  const { data, error } = await supabase
    .from("attendance_records")
    .select("record_date, status, time_in")
    .eq("profile_id", profile.id)
    .gte("record_date", fromDate)
    .lte("record_date", toDate);
  if (error) {
    console.error(error);
    return new Set();
  }
  const set = new Set();
  (data || []).forEach((r) => {
    if (r.time_in || r.status === "present" || r.status === "late") set.add(r.record_date);
  });
  return set;
}

// Own approved leave for the visible range, expanded into individual dates.
async function fetchLeaveDates(fromDate, toDate) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("start_date, end_date")
    .eq("profile_id", profile.id)
    .eq("status", "approved")
    .lte("start_date", toDate)
    .gte("end_date", fromDate);
  if (error) {
    console.error(error);
    return new Set();
  }
  const set = new Set();
  (data || []).forEach((r) => {
    const d = new Date(r.start_date + "T00:00:00");
    const end = new Date(r.end_date + "T00:00:00");
    while (d <= end) {
      set.add(iso(d));
      d.setDate(d.getDate() + 1);
    }
  });
  return set;
}

async function loadAndRenderMonth() {
  const label = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  document.getElementById("month-label").textContent = label;

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const fromIso = iso(gridStart);
  const toIso = iso(gridEnd);

  const [events, presentDates, leaveDates] = await Promise.all([
    fetchEvents(fromIso, toIso),
    fetchPresentDates(fromIso, toIso),
    fetchLeaveDates(fromIso, toIso),
  ]);
  const byDate = {};
  events.forEach((e) => {
    (byDate[e.event_date] = byDate[e.event_date] || []).push(e);
  });

  const dowRow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("");

  let cells = "";
  const todayIso = iso(new Date());
  const d = new Date(gridStart);
  while (d <= gridEnd) {
    const dIso = iso(d);
    const isOtherMonth = d.getMonth() !== cursor.getMonth();
    const dayEvents = byDate[dIso] || [];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const isPast = dIso < todayIso;
    const onLeave = leaveDates.has(dIso);
    const isPresent = presentDates.has(dIso);
    // No RSVP system exists yet to know if an invite was accepted, so leave
    // wins whenever both occur on the same day. Swap this line once event
    // responses exist, e.g. `const scheduleClass = accepted ? "has-events" : onLeave ? "has-leave" : ...`.
    const scheduleClass = onLeave ? "has-leave" : dayEvents.length ? "has-events" : "";
    const isAbsent = !isWeekend && isPast && !isPresent && !onLeave;
    const numClass = isPresent ? "att-present" : isAbsent ? "att-absent" : "";

    cells += `
      <div class="cal-day ${isOtherMonth ? "other-month" : ""} ${dIso === todayIso ? "today" : ""} ${scheduleClass}">
        ${dayEvents.length ? `<span class="cal-day-count">${dayEvents.length}</span>` : ""}
        <span class="cal-day-num ${numClass}">${d.getDate()}</span>
        ${dayEvents
          .slice(0, 3)
          .map((e) => `<span class="cal-event-dot" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</span>`)
          .join("")}
        ${dayEvents.length > 3 ? `<span class="cal-event-dot">+${dayEvents.length - 3} more</span>` : ""}
      </div>`;
    d.setDate(d.getDate() + 1);
  }

  monthViewEl.innerHTML = `<div class="cal-grid">${dowRow}${cells}</div>`;
}

async function renderAgenda() {
  agendaViewEl.innerHTML = `<div class="skeleton" style="height:60px;"></div>`;
  const from = iso(new Date());
  const to = iso(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
  const events = await fetchEvents(from, to);

  if (events.length === 0) {
    agendaViewEl.innerHTML = `<div class="card empty-state"><h3>Nothing on the calendar</h3><p>Upcoming events for the next two months will appear here.</p></div>`;
    return;
  }

  agendaViewEl.innerHTML = `<div class="card">${events.map((e) => agendaRow(e)).join("")}</div>`;
}

function agendaRow(e) {
  const timeRange = e.start_time ? fmtTimeStr(e.start_time) + (e.end_time ? ` – ${fmtTimeStr(e.end_time)}` : "") : "";
  return `
    <div class="list-row" style="align-items:flex-start;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(e.title)}</div>
        ${
          e.location
            ? `<div class="text-muted" style="font-size:0.82rem;display:flex;align-items:center;gap:4px;margin-top:2px;">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M12 21s7-7.5 7-12a7 7 0 10-14 0c0 4.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>
                <span>${escapeHtml(e.location)}</span>
              </div>`
            : ""
        }
      </div>
      <div class="text-muted" style="text-align:right;font-size:0.82rem;white-space:nowrap;flex-shrink:0;">
        <div>${formatDate(e.event_date)}</div>
        ${timeRange ? `<div>${timeRange}</div>` : ""}
      </div>
    </div>`;
}

function fmtTimeStr(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Local calendar date as YYYY-MM-DD, without the UTC shift toISOString() causes.
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadAndRenderMonth();
