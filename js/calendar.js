import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { todayPH } from "./time.js";
import { escapeHtml } from "./utils.js";

const profile = await mountLayout({ activeKey: "calendar", pageTitle: "Calendar", allowedRoles: ["admin", "teacher", "student", "parent"] });
if (!profile) throw new Error("redirecting");

// ---------------------------------------------------------------------------
// Role rules
//  - Leave: admin and teacher only
//  - Present / absent date colors: everyone except parents
// ---------------------------------------------------------------------------
const isParent = profile.role === "parent";
const showLeave = profile.role === "admin" || profile.role === "teacher";
const showAttendance = !isParent;

const VIEW_KEY = "onecore_calendar_view";
const VIEW_NAMES = { month: "Month view", week: "Week view", agenda: "Agenda" };
const PLATFORM_NAMES = { zoom: "Zoom", meet: "Google Meet", teams: "Microsoft Teams", webex: "Webex", other: "Meeting" };
const SKELETON = `<div class="skeleton" style="height:320px;"></div>`;

const svg = (path, extra = "") =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
const ICON = {
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 118 0v3"/>', 'width="12" height="12"'),
};

const $ = (id) => document.getElementById(id);
const viewEl = $("cal-view");
const legendEl = $("legend");
const viewNameEl = $("view-name");
const menuEl = $("view-menu");
const gearBtn = $("gear-btn");

let view = readView();
let selected = todayPH();
let cursor = monthStart(parseIso(selected));
let renderId = 0;
let monthCache = null;
let weekNotes = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function readView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (VIEW_NAMES[v]) return v;
  } catch {
    // storage unavailable
  }
  return "month";
}
function saveView(v) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // ignore
  }
}
// Local calendar date as YYYY-MM-DD, without the UTC shift toISOString() causes.
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function parseIso(s) {
  return new Date(s + "T00:00:00");
}
function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function dayLabel(s) {
  return parseIso(s).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtTimeStr(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function monthRange(c) {
  const first = monthStart(c);
  const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
  const gridStart = addDays(first, -first.getDay());
  const gridEnd = addDays(last, 6 - last.getDay());
  return { first, last, gridStart, gridEnd, from: iso(gridStart), to: iso(gridEnd) };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function fetchEvents(from, to) {
  const { data, error } = await supabase
    .from("events")
    .select("id, title, event_date, start_time, end_time, location, is_online, meeting_platform")
    .neq("status", "cancelled")
    .gte("event_date", from)
    .lte("event_date", to)
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

// A date counts "present" if any record that day has a time-in scan or a present/late class status.
async function fetchPresentDates(from, to) {
  const { data, error } = await supabase
    .from("attendance_records")
    .select("record_date, status, time_in")
    .eq("profile_id", profile.id)
    .gte("record_date", from)
    .lte("record_date", to);
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

async function fetchLeaves(from, to) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("start_date, end_date")
    .eq("profile_id", profile.id)
    .eq("status", "approved")
    .lte("start_date", to)
    .gte("end_date", from)
    .order("start_date", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

function expandLeaveDates(leaves) {
  const set = new Set();
  leaves.forEach((r) => {
    const d = parseIso(r.start_date);
    const end = parseIso(r.end_date);
    while (d <= end) {
      set.add(iso(d));
      d.setDate(d.getDate() + 1);
    }
  });
  return set;
}

async function fetchNotes(from, to) {
  const { data, error } = await supabase
    .from("calendar_notes")
    .select("id, note_date, note_time, title, body")
    .eq("profile_id", profile.id)
    .gte("note_date", from)
    .lte("note_date", to)
    .order("note_date", { ascending: true })
    .order("note_time", { ascending: true });
  if (error) {
    console.error(error);
    showToast("Couldn't load your notes.", "error");
    return [];
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Cards (two lines, colored bar, tappable)
// ---------------------------------------------------------------------------
const CHEV = `<span class="cd-chev">${ICON.right}</span>`;

function cardHtml({ tag, attrs, color, title, sub }) {
  return `<${tag} class="cd" ${attrs}>
    <span class="cd-bar" style="background:${color};"></span>
    <span class="cd-tx"><span class="cd-t">${escapeHtml(title)}</span><span class="cd-s">${escapeHtml(sub)}</span></span>
    ${CHEV}
  </${tag}>`;
}

function eventCard(e) {
  const where = e.is_online ? `Online · ${PLATFORM_NAMES[e.meeting_platform] || "Meeting"}` : e.location;
  const sub = [e.start_time ? fmtTimeStr(e.start_time) : "", where].filter(Boolean).join(" · ") || "Event";
  return cardHtml({ tag: "a", attrs: `href="events.html"`, color: "var(--info)", title: e.title, sub });
}
function leaveCard(l) {
  const range = l.start_date === l.end_date ? formatDate(l.start_date) : `${formatDate(l.start_date)} – ${formatDate(l.end_date)}`;
  return cardHtml({ tag: "a", attrs: `href="leave.html"`, color: "var(--warning)", title: "Leave request", sub: `Approved · ${range}` });
}
function noteCard(n) {
  const preview = (n.body || "").replace(/\s+/g, " ").trim();
  const sub = [fmtTimeStr(n.note_time), preview].filter(Boolean).join(" · ");
  return cardHtml({ tag: "button", attrs: `type="button" data-note="${n.id}"`, color: "var(--note)", title: n.title, sub });
}

// ---------------------------------------------------------------------------
// Chrome: legend, nav, settings menu
// ---------------------------------------------------------------------------
function legendHtml() {
  if (view === "week") return "";
  const items = [["var(--info)", "Event"]];
  if (showLeave) items.push(["var(--warning)", "Leave"]);
  if (view === "month" && showAttendance) items.push(["var(--success)", "Present"], ["var(--error)", "Absent"]);
  return items.map(([c, l]) => `<span><i style="background:${c};"></i>${l}</span>`).join("");
}

function navHtml(label, prevLabel, nextLabel) {
  return `<div class="cal-nav">
    <button type="button" class="icon-action sm" data-nav="-1" aria-label="${prevLabel}">${ICON.left}</button>
    <strong>${escapeHtml(label)}</strong>
    <button type="button" class="icon-action sm" data-nav="1" aria-label="${nextLabel}">${ICON.right}</button>
  </div>`;
}

function closeMenus() {
  document.querySelectorAll(".cal-menu.on").forEach((m) => m.classList.remove("on"));
  gearBtn.setAttribute("aria-expanded", "false");
}

function setView(v) {
  view = v;
  saveView(v);
  cursor = monthStart(parseIso(selected));
  render();
}

function navigate(step) {
  if (view === "week") {
    selected = iso(addDays(parseIso(selected), 7 * step));
    cursor = monthStart(parseIso(selected));
  } else {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + step, 1);
    const t = parseIso(todayPH());
    const inThisMonth = t.getFullYear() === cursor.getFullYear() && t.getMonth() === cursor.getMonth();
    selected = inThisMonth ? iso(t) : iso(cursor);
  }
  render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  const id = ++renderId;
  viewNameEl.textContent = VIEW_NAMES[view];
  legendEl.innerHTML = legendHtml();
  menuEl.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "month") renderMonth(id);
  else if (view === "week") renderWeek(id);
  else renderAgenda(id);
}

// ----- Month ---------------------------------------------------------------
async function renderMonth(id) {
  const r = monthRange(cursor);
  const key = `${r.from}|${r.to}`;
  if (!monthCache || monthCache.key !== key) {
    viewEl.innerHTML = SKELETON;
    const [events, present, leaves] = await Promise.all([
      fetchEvents(r.from, r.to),
      showAttendance ? fetchPresentDates(r.from, r.to) : Promise.resolve(new Set()),
      showLeave ? fetchLeaves(r.from, r.to) : Promise.resolve([]),
    ]);
    const byDate = {};
    events.forEach((e) => (byDate[e.event_date] = byDate[e.event_date] || []).push(e));
    monthCache = { key, byDate, present, leaves, leaveDates: expandLeaveDates(leaves) };
  }
  if (id !== renderId) return;
  paintMonth(r);
}

function dayCards(dIso) {
  const cards = (monthCache.byDate[dIso] || []).map(eventCard);
  monthCache.leaves.forEach((l) => {
    if (l.start_date <= dIso && dIso <= l.end_date) cards.push(leaveCard(l));
  });
  return cards;
}

function paintMonth(r) {
  const { byDate, present, leaveDates } = monthCache;
  const todayIso = todayPH();
  const dow = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="cal-dow">${d}</div>`).join("");

  let cells = "";
  for (const d = new Date(r.gridStart); d <= r.gridEnd; d.setDate(d.getDate() + 1)) {
    const dIso = iso(d);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const onLeave = leaveDates.has(dIso);
    const isPresent = present.has(dIso);
    const isAbsent = showAttendance && !isWeekend && dIso < todayIso && !isPresent && !onLeave;
    const cls = [
      d.getMonth() !== cursor.getMonth() ? "other-month" : "",
      dIso === todayIso ? "today" : "",
      dIso === selected ? "sel" : "",
      onLeave ? "has-leave" : byDate[dIso] ? "has-events" : "",
      showAttendance && isPresent ? "att-present" : "",
      isAbsent ? "att-absent" : "",
    ]
      .filter(Boolean)
      .join(" ");
    cells += `<button type="button" class="cal-cell ${cls}" data-date="${dIso}" aria-label="${escapeHtml(dayLabel(dIso))}"><span class="cal-num">${d.getDate()}</span></button>`;
  }

  const cards = dayCards(selected);
  const label = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  viewEl.innerHTML = `
    ${navHtml(label, "Previous month", "Next month")}
    <div class="cal-grid">${dow}${cells}</div>
    <div class="day-head"><span>Specials · ${escapeHtml(dayLabel(selected))}</span><small>${cards.length} ${cards.length === 1 ? "item" : "items"}</small></div>
    ${cards.join("") || `<p class="text-muted" style="font-size:0.85rem;margin:6px 0;">Nothing scheduled this day.</p>`}`;
}

// ----- Week (private notes) --------------------------------------------------
async function renderWeek(id) {
  const start = addDays(parseIso(selected), -parseIso(selected).getDay());
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  viewEl.innerHTML = SKELETON;
  const notes = await fetchNotes(iso(days[0]), iso(days[6]));
  if (id !== renderId) return;
  weekNotes = notes;

  const byDate = {};
  notes.forEach((n) => (byDate[n.note_date] = byDate[n.note_date] || []).push(n));

  const todayIso = todayPH();
  const strip = days
    .map((d) => {
      const k = iso(d);
      return `<button type="button" class="wk-pill ${k === selected ? "sel" : ""}" data-date="${k}" aria-label="${escapeHtml(dayLabel(k))}">
        <span class="wk-l">${["S", "M", "T", "W", "T", "F", "S"][d.getDay()]}</span>
        <span class="wk-dot ${byDate[k] ? "on" : ""}"></span>
        <span class="wk-n ${k === todayIso ? "today" : ""}">${d.getDate()}</span>
      </button>`;
    })
    .join("");

  const short = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const list = (byDate[selected] || []).map(noteCard).join("");

  viewEl.innerHTML = `
    ${navHtml(`${short(days[0])} – ${short(days[6])}`, "Previous week", "Next week")}
    <div class="wk-strip">${strip}</div>
    <div class="day-head">
      <span>Notes · ${escapeHtml(dayLabel(selected))}</span>
      <span class="day-actions">
        <button type="button" class="cal-pb" data-act="add">+ Add</button>
        <button type="button" class="cal-dots" data-act="clr-menu" aria-label="Clear notes">${ICON.more}</button>
        <div class="cal-menu" id="clr-menu" style="top:36px;">
          <button type="button" data-act="clear-day">Clear this day's notes</button>
          <button type="button" class="danger" data-act="clear-all">Clear all notes</button>
        </div>
      </span>
    </div>
    <div class="cal-private">${ICON.lock} Only visible to you</div>
    ${list || `<p class="text-muted" style="font-size:0.85rem;margin:6px 0;">No notes for this day. Tap Add to write one.</p>`}`;
}

// ----- Agenda (whole month) --------------------------------------------------
async function renderAgenda(id) {
  const r = monthRange(cursor);
  const from = iso(r.first);
  const to = iso(r.last);
  viewEl.innerHTML = SKELETON;
  const [events, leaves] = await Promise.all([fetchEvents(from, to), showLeave ? fetchLeaves(from, to) : Promise.resolve([])]);
  if (id !== renderId) return;

  const groups = {};
  events.forEach((e) => (groups[e.event_date] = groups[e.event_date] || []).push(eventCard(e)));
  leaves.forEach((l) => {
    const k = l.start_date < from ? from : l.start_date;
    (groups[k] = groups[k] || []).push(leaveCard(l));
  });

  const keys = Object.keys(groups).sort();
  const label = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  viewEl.innerHTML =
    navHtml(label, "Previous month", "Next month") +
    (keys.length
      ? keys.map((k) => `<div class="ag-date">${escapeHtml(dayLabel(k))}</div>${groups[k].join("")}`).join("")
      : `<div class="card empty-state"><h3>Nothing scheduled</h3><p>No events${showLeave ? " or leave" : ""} this month.</p></div>`);
}

// ---------------------------------------------------------------------------
// Modals (notes)
// ---------------------------------------------------------------------------
function openModal(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `<div class="dialog-modal" role="dialog" aria-modal="true">${html}</div>`;
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
  return { el: backdrop.firstElementChild, close };
}

function openNoteView(note) {
  const m = openModal(`
    <h3 style="margin-top:0;">${escapeHtml(note.title)}</h3>
    <p class="text-muted" style="font-size:0.85rem;margin:2px 0 10px;">${escapeHtml(dayLabel(note.note_date))} · ${escapeHtml(fmtTimeStr(note.note_time))}</p>
    <div style="white-space:pre-wrap;font-size:0.95rem;max-height:45vh;overflow-y:auto;">${note.body ? escapeHtml(note.body) : `<span class="text-muted">No details.</span>`}</div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" data-act="del" style="color:var(--error);">Delete</button>
      <button type="button" class="btn btn-secondary" data-act="edit">Edit</button>
      <button type="button" class="btn btn-primary" data-act="close">Close</button>
    </div>`);
  let armed = false;
  m.el.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") m.close();
    else if (act === "edit") {
      m.close();
      openNoteForm(note);
    } else if (act === "del") {
      const btn = e.target.closest("[data-act]");
      if (!armed) {
        armed = true;
        btn.textContent = "Tap again to delete";
        return;
      }
      btn.disabled = true;
      const { error } = await supabase.from("calendar_notes").delete().eq("id", note.id).eq("profile_id", profile.id);
      if (error) {
        showToast(friendlyError(error), "error");
        btn.disabled = false;
        return;
      }
      m.close();
      showToast("Note deleted.", "success");
      render();
    }
  });
}

function openNoteForm(note) {
  const m = openModal(`
    <h3 style="margin-top:0;">${note ? "Edit note" : "New note"}</h3>
    <div class="field"><label for="note-title">Title</label><input id="note-title" maxlength="120" value="${note ? escapeHtml(note.title) : ""}" /></div>
    <div class="field"><label for="note-time">Time</label><input id="note-time" type="time" value="${note ? escapeHtml((note.note_time || "").slice(0, 5)) : "09:00"}" /></div>
    <div class="field"><label for="note-body">Note</label><textarea id="note-body" rows="5" maxlength="4000">${note ? escapeHtml(note.body) : ""}</textarea></div>
    <div class="note-err" id="note-err"></div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save</button>
    </div>`);
  const err = m.el.querySelector("#note-err");
  m.el.querySelector("#note-title").addEventListener("input", () => (err.textContent = ""));
  m.el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "close") return m.close();
    if (btn.dataset.act !== "save") return;

    const title = m.el.querySelector("#note-title").value.trim();
    const body = m.el.querySelector("#note-body").value.trim();
    const time = m.el.querySelector("#note-time").value || "09:00";
    if (!title) {
      err.textContent = "Add a title first.";
      return;
    }
    btn.disabled = true;
    const fields = { title, body, note_time: time };
    const { error } = note
      ? await supabase
          .from("calendar_notes")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", note.id)
          .eq("profile_id", profile.id)
      : await supabase.from("calendar_notes").insert({ ...fields, note_date: selected, profile_id: profile.id });
    if (error) {
      showToast(friendlyError(error), "error");
      btn.disabled = false;
      return;
    }
    m.close();
    showToast("Note saved.", "success");
    render();
  });
  m.el.querySelector("#note-title").focus();
}

async function confirmClear(all) {
  let count;
  if (all) {
    const { count: c, error } = await supabase.from("calendar_notes").select("id", { count: "exact", head: true }).eq("profile_id", profile.id);
    if (error) {
      showToast(friendlyError(error), "error");
      return;
    }
    count = c || 0;
  } else {
    count = weekNotes.filter((n) => n.note_date === selected).length;
  }
  if (!count) {
    showToast("No notes to clear.");
    return;
  }
  const m = openModal(`
    <h3 style="margin-top:0;">${all ? "Clear all notes?" : "Clear this day's notes?"}</h3>
    <p style="font-size:0.95rem;">This removes ${count} ${count === 1 ? "note" : "notes"}${all ? " from your account" : ` for ${escapeHtml(dayLabel(selected))}`}. It can't be undone.</p>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="go" style="background:var(--error-solid);border-color:var(--error-solid);">Clear</button>
    </div>`);
  m.el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "close") return m.close();
    btn.disabled = true;
    let q = supabase.from("calendar_notes").delete().eq("profile_id", profile.id);
    if (!all) q = q.eq("note_date", selected);
    const { error } = await q;
    if (error) {
      showToast(friendlyError(error), "error");
      btn.disabled = false;
      return;
    }
    m.close();
    showToast(all ? "All notes cleared." : "Notes cleared.", "success");
    render();
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
gearBtn.addEventListener("click", () => {
  const opening = !menuEl.classList.contains("on");
  closeMenus();
  if (opening) {
    menuEl.classList.add("on");
    gearBtn.setAttribute("aria-expanded", "true");
  }
});

menuEl.addEventListener("click", (e) => {
  const item = e.target.closest("[data-view]");
  if (!item) return;
  closeMenus();
  if (item.dataset.view !== view) setView(item.dataset.view);
});

viewEl.addEventListener("click", (e) => {
  const dateBtn = e.target.closest("[data-date]");
  if (dateBtn) {
    selected = dateBtn.dataset.date;
    const sd = parseIso(selected);
    if (view === "month" && (sd.getMonth() !== cursor.getMonth() || sd.getFullYear() !== cursor.getFullYear())) cursor = monthStart(sd);
    render();
    return;
  }
  const navBtn = e.target.closest("[data-nav]");
  if (navBtn) {
    navigate(Number(navBtn.dataset.nav));
    return;
  }
  const noteBtn = e.target.closest("[data-note]");
  if (noteBtn) {
    const note = weekNotes.find((n) => String(n.id) === noteBtn.dataset.note);
    if (note) openNoteView(note);
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "add") openNoteForm(null);
  else if (act === "clr-menu") $("clr-menu")?.classList.toggle("on");
  else if (act === "clear-day") confirmClear(false);
  else if (act === "clear-all") confirmClear(true);
});

// Close any open menu when tapping elsewhere.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#gear-btn, #view-menu, [data-act='clr-menu']")) closeMenus();
});

render();
