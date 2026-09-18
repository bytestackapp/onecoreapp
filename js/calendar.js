import { mountLayout } from "./layout.js";
import { supabase, formatDate } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "calendar", pageTitle: "Calendar" });
if (!profile) throw new Error("redirecting");

let cursor = new Date();
cursor.setDate(1);
let currentView = "month";
let eventsCache = [];

document.querySelectorAll(".cal-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".cal-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentView = tab.getAttribute("data-view");
    document.getElementById("month-view").style.display = currentView === "month" ? "block" : "none";
    document.getElementById("agenda-view").style.display = currentView === "agenda" ? "block" : "none";
    document.getElementById("month-nav").style.display = currentView === "month" ? "flex" : "none";
    if (currentView === "agenda") renderAgenda();
  });
});

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
    .select("id, title, event_date, start_time")
    .neq("status", "cancelled")
    .gte("event_date", fromDate)
    .lte("event_date", toDate)
    .order("event_date", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
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

  const events = await fetchEvents(iso(gridStart), iso(gridEnd));
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
    cells += `
      <div class="cal-day ${isOtherMonth ? "other-month" : ""} ${dIso === todayIso ? "today" : ""} ${dayEvents.length ? "has-events" : ""}">
        <span class="cal-day-num">${d.getDate()}</span>
        ${dayEvents
          .slice(0, 3)
          .map((e) => `<span class="cal-event-dot" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</span>`)
          .join("")}
        ${dayEvents.length > 3 ? `<span class="cal-event-dot">+${dayEvents.length - 3} more</span>` : ""}
      </div>`;
    d.setDate(d.getDate() + 1);
  }

  document.getElementById("month-view").innerHTML = `<div class="cal-grid">${dowRow}${cells}</div>`;
}

async function renderAgenda() {
  const el = document.getElementById("agenda-view");
  el.innerHTML = `<div class="skeleton" style="height:60px;"></div>`;
  const from = iso(new Date());
  const to = iso(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
  const events = await fetchEvents(from, to);

  if (events.length === 0) {
    el.innerHTML = `<div class="card empty-state"><h3>Nothing on the calendar</h3><p>Upcoming events for the next two months will appear here.</p></div>`;
    return;
  }

  el.innerHTML = `<div class="card">${events
    .map(
      (e) => `<div class="list-row"><div style="flex:1;">${escapeHtml(e.title)}</div><div class="text-muted">${formatDate(e.event_date)}${e.start_time ? " · " + e.start_time.slice(0, 5) : ""}</div></div>`
    )
    .join("")}</div>`;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadAndRenderMonth();
