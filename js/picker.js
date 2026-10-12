// Dark-mode date and time pickers.
//
// Phones draw their own date / time pop-ups (iOS and Android), and those stay light
// whatever the page does. While Dark Mode is on, date and time fields use the in-app
// pickers below instead, which follow the theme. In Default mode nothing changes:
// the phone's own pickers are used exactly as before.
//
// The field itself is kept. Its value is still "YYYY-MM-DD" or "HH:MM", it still fires
// normal "input" and "change" events, and "required" still works, so page code is unaffected.
//
// iOS home-screen apps ignore inputmode="none", so enhanced fields are also made readonly
// (iOS never raises the keyboard for those), are blurred when the picker opens, and use a
// 16px font so iOS does not zoom the page on focus.

const MARK = "data-native-type";
const RO_MARK = "data-picker-ro"; // set only when this script made the field readonly
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based
const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(v || "");
  return m ? { h: +m[1], mi: +m[2] } : null;
}

// ---------- swap native fields for pickable text fields (Dark Mode only) ----------
function enhance(el) {
  if (el.hasAttribute(MARK)) return;
  const t = el.type;
  if (t !== "date" && t !== "time") return;
  const v = el.value;
  el.setAttribute(MARK, t);
  el.type = "text";
  el.value = v;
  if (!el.readOnly) {
    el.readOnly = true; // iOS never shows a keyboard for readonly fields
    el.setAttribute(RO_MARK, "");
  }
  el.setAttribute("inputmode", "none"); // no keyboard (Android)
  el.setAttribute("autocomplete", "off");
  el.placeholder = t === "date" ? "Select date" : "Select time";
  el.style.cursor = "pointer";
}
function restore(el) {
  const t = el.getAttribute(MARK);
  if (!t) return;
  const v = el.value;
  el.type = t;
  el.value = v;
  el.removeAttribute(MARK);
  if (el.hasAttribute(RO_MARK)) {
    el.readOnly = false;
    el.removeAttribute(RO_MARK);
  }
  el.removeAttribute("inputmode");
  el.removeAttribute("autocomplete");
  el.removeAttribute("placeholder");
  el.style.cursor = "";
}
function sync() {
  if (isDark()) document.querySelectorAll('input[type="date"], input[type="time"]').forEach(enhance);
  else document.querySelectorAll(`input[${MARK}]`).forEach(restore);
}

// ---------- styles ----------
// Injected up front (not on first open) because the 16px rule must already apply when a field is tapped.
let styled = false;
function addStyles() {
  if (styled) return;
  styled = true;
  const st = document.createElement("style");
  st.textContent = `
    /* 16px stops iOS zooming the page when a field is focused */
    input[${MARK}] { font-size:16px; }
    .dm-head { display:flex; align-items:center; justify-content:space-between; gap:4px; margin-bottom:10px; }
    .dm-head strong { flex:1; text-align:center; font-size:0.95rem; }
    .dm-nav { width:34px; height:34px; border-radius:50%; border:1px solid var(--border); background:var(--input-bg); color:var(--text); font:inherit; cursor:pointer; padding:0; }
    .dm-grid { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:4px; text-align:center; }
    .dm-dow { font-size:0.72rem; color:var(--text-muted); padding:4px 0; }
    .dm-day { height:36px; border-radius:50%; border:1.5px solid transparent; background:none; color:var(--text); font:inherit; cursor:pointer; padding:0; }
    .dm-day.today { border-color:var(--primary); }
    .dm-day.sel { background:var(--primary-solid); border-color:var(--primary-solid); color:#fff; }
    .dm-day:disabled { opacity:0.3; cursor:default; }
    .dm-label { font-size:0.75rem; color:var(--text-muted); margin:12px 0 6px; }
    .dm-time { display:grid; grid-template-columns:repeat(6, minmax(0, 1fr)); gap:6px; }
    .dm-time button { height:36px; border-radius:10px; border:1px solid var(--border); background:var(--input-bg); color:var(--text); font:inherit; cursor:pointer; padding:0; }
    .dm-time button.sel { background:var(--primary-solid); border-color:var(--primary-solid); color:#fff; }
    .dm-big { text-align:center; font-size:1.6rem; font-weight:700; margin-bottom:4px; }`;
  document.head.appendChild(st);
}

// ---------- shared dialog shell ----------
function openShell(html) {
  addStyles();
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `<div class="dialog-modal" role="dialog" aria-modal="true" style="max-width:340px;">${html}</div>`;
  document.body.appendChild(backdrop);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopImmediatePropagation(); // close only the picker, not the dialog under it
      e.preventDefault();
      close();
    }
  };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  return { modal: backdrop.firstElementChild, close };
}

function commit(el, value) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---------- date picker ----------
function openDatePicker(el) {
  const min = el.getAttribute("min") || "";
  const max = el.getAttribute("max") || "";
  const cur = parseDate(el.value);
  const now = new Date();
  const todayISO = iso(now.getFullYear(), now.getMonth(), now.getDate());
  let y = cur ? cur.y : now.getFullYear();
  let m = cur ? cur.m : now.getMonth();

  const { modal, close } = openShell(`<div id="dm-body"></div>`);
  const body = modal.querySelector("#dm-body");
  const allowed = (v) => !(min && v < min) && !(max && v > max);

  function draw() {
    const lead = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let cells = DOW.map((d) => `<div class="dm-dow">${d}</div>`).join("");
    for (let i = 0; i < lead; i++) cells += `<span></span>`;
    for (let d = 1; d <= days; d++) {
      const v = iso(y, m, d);
      cells += `<button type="button" class="dm-day${v === el.value ? " sel" : ""}${v === todayISO ? " today" : ""}" data-v="${v}"${allowed(v) ? "" : " disabled"}>${d}</button>`;
    }
    body.innerHTML = `
      <div class="dm-head">
        <button type="button" class="dm-nav" data-nav="-12" aria-label="Previous year">«</button>
        <button type="button" class="dm-nav" data-nav="-1" aria-label="Previous month">‹</button>
        <strong>${MONTHS[m]} ${y}</strong>
        <button type="button" class="dm-nav" data-nav="1" aria-label="Next month">›</button>
        <button type="button" class="dm-nav" data-nav="12" aria-label="Next year">»</button>
      </div>
      <div class="dm-grid">${cells}</div>
      <div class="dialog-actions">
        ${el.required ? "" : `<button type="button" class="btn btn-secondary" data-act="clear">Clear</button>`}
        ${allowed(todayISO) ? `<button type="button" class="btn btn-secondary" data-act="today">Today</button>` : ""}
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      </div>`;
    body.querySelectorAll("[data-nav]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = new Date(y, m + Number(b.getAttribute("data-nav")), 1);
        y = t.getFullYear();
        m = t.getMonth();
        draw();
      })
    );
    body.querySelectorAll(".dm-day").forEach((b) =>
      b.addEventListener("click", () => { commit(el, b.getAttribute("data-v")); close(); })
    );
    body.querySelector('[data-act="cancel"]').addEventListener("click", close);
    body.querySelector('[data-act="clear"]')?.addEventListener("click", () => { commit(el, ""); close(); });
    body.querySelector('[data-act="today"]')?.addEventListener("click", () => { commit(el, todayISO); close(); });
  }
  draw();
}

// ---------- time picker ----------
function openTimePicker(el) {
  const cur = parseTime(el.value);
  const now = new Date();
  let h = cur ? cur.h : now.getHours();
  let mi = cur ? cur.mi : Math.floor(now.getMinutes() / 5) * 5;

  const { modal, close } = openShell(`<div id="dm-body"></div>`);
  const body = modal.querySelector("#dm-body");

  function draw() {
    const hours = Array.from({ length: 24 }, (_, i) => `<button type="button" data-h="${i}"${i === h ? ' class="sel"' : ""}>${pad(i)}</button>`).join("");
    const mins = Array.from({ length: 12 }, (_, i) => `<button type="button" data-mi="${i * 5}"${i * 5 === mi ? ' class="sel"' : ""}>${pad(i * 5)}</button>`).join("");
    body.innerHTML = `
      <div class="dm-big">${pad(h)}:${pad(mi)}</div>
      <div class="dm-label">Hour</div>
      <div class="dm-time">${hours}</div>
      <div class="dm-label">Minute</div>
      <div class="dm-time">${mins}</div>
      <div class="dialog-actions">
        ${el.required ? "" : `<button type="button" class="btn btn-secondary" data-act="clear">Clear</button>`}
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="ok">OK</button>
      </div>`;
    body.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", () => { h = Number(b.getAttribute("data-h")); draw(); }));
    body.querySelectorAll("[data-mi]").forEach((b) => b.addEventListener("click", () => { mi = Number(b.getAttribute("data-mi")); draw(); }));
    body.querySelector('[data-act="cancel"]').addEventListener("click", close);
    body.querySelector('[data-act="clear"]')?.addEventListener("click", () => { commit(el, ""); close(); });
    body.querySelector('[data-act="ok"]').addEventListener("click", () => { commit(el, `${pad(h)}:${pad(mi)}`); close(); });
  }
  draw();
}

// ---------- wiring ----------
function fieldFrom(e) {
  const el = e.target?.closest?.(`input[${MARK}]`);
  return el && !el.disabled ? el : null;
}
function open(el) {
  el.blur(); // drop focus so iOS does not raise the keyboard or zoom behind the dialog
  if (el.getAttribute(MARK) === "time") openTimePicker(el);
  else openDatePicker(el);
}

document.addEventListener("click", (e) => {
  const el = fieldFrom(e);
  if (el) { e.preventDefault(); open(el); }
});
document.addEventListener("keydown", (e) => {
  const el = fieldFrom(e);
  if (!el || e.key === "Tab" || e.key === "Escape") return;
  e.preventDefault(); // no typing into a picker field
  if (e.key === "Enter" || e.key === " ") open(el);
});
document.addEventListener("paste", (e) => { if (fieldFrom(e)) e.preventDefault(); });

// Follow the theme live, and catch fields that dialogs add later
new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
new MutationObserver(() => { if (isDark()) sync(); }).observe(document.documentElement, { childList: true, subtree: true });
addStyles(); // up front, so the 16px rule is in place before the first tap
sync();
