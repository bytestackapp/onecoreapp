// Standalone scanner page. No login — authenticates as a DEVICE via the
// device token stored on activation, not a person. See record_attendance_scan,
// activate_scanner_device, and scanner_download_roster in the database.
import { supabase } from "./supabase-client.js";
import { showToast } from "./toast.js";

const STORAGE_DEVICE = "onecore_scanner_device";
const STORAGE_ROSTER = "onecore_scanner_roster";
const STORAGE_ROSTER_SYNCED_AT = "onecore_scanner_roster_synced_at";
const STORAGE_QUEUE = "onecore_scanner_queue";
const STORAGE_TODAY = "onecore_scanner_today";
const STORAGE_REJECTED = "onecore_scanner_rejected";
const RESCAN_COOLDOWN_MS = 4000; // ignore the same code again this soon
const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours (only fetches added/changed people)
const QUEUE_RETRY_INTERVAL_MS = 15000;
const MAX_ATTEMPTS = 5; // server errors before a queued scan is moved to the rejected log
const MODE_LABEL = { time_in: "Time In", break_out: "Break Out", break_in: "Break In", time_out: "Time Out" };

let device = null; // { token, name }
let roster = {}; // qr_token -> { full_name, role }
let currentMode = "time_in";
let lastScan = { code: null, at: 0 };
let html5Qrcode = null;
let resetTimer = null;
let timersStarted = false;

const setupView = document.getElementById("setup-view");
const scanView = document.getElementById("scan-view");
const resultEl = document.getElementById("scanner-result");
const queueStatusEl = document.getElementById("queue-status");

// -----------------------------------------------------------------
// Local storage helpers
// -----------------------------------------------------------------
function loadDevice() {
  try {
    const raw = localStorage.getItem(STORAGE_DEVICE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDevice(d) {
  localStorage.setItem(STORAGE_DEVICE, JSON.stringify(d));
}
function clearDevice() {
  localStorage.removeItem(STORAGE_DEVICE);
  localStorage.removeItem(STORAGE_ROSTER);
  localStorage.removeItem(STORAGE_ROSTER_SYNCED_AT);
  localStorage.removeItem(STORAGE_TODAY);
  localStorage.removeItem(STORAGE_REJECTED);
}

function loadRoster() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_ROSTER) || "{}");
  } catch {
    return {};
  }
}
function saveRoster(r) {
  localStorage.setItem(STORAGE_ROSTER, JSON.stringify(r));
}

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_QUEUE) || "[]");
  } catch {
    return [];
  }
}
function saveQueue(q) {
  localStorage.setItem(STORAGE_QUEUE, JSON.stringify(q));
}

function loadRejected() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_REJECTED) || "[]");
  } catch {
    return [];
  }
}
function saveRejected(r) {
  localStorage.setItem(STORAGE_REJECTED, JSON.stringify(r.slice(-50)));
}

function updateFooter() {
  const rosterCount = Object.keys(loadRoster()).length;
  const queueCount = loadQueue().length;
  const rejected = loadRejected().length;
  queueStatusEl.textContent = `Roster: ${rosterCount} · Queue: ${queueCount}` + (rejected ? ` · Rejected: ${rejected}` : "");
}

function showResult(kind, lines) {
  resultEl.className = `scanner-result ${kind}`;
  resultEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -----------------------------------------------------------------
// Setup / activation
// -----------------------------------------------------------------
document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById("setup-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";

  const deviceCode = document.getElementById("setup-code").value.trim().toUpperCase();
  const passcode = document.getElementById("setup-passcode").value;

  try {
    const { data, error } = await supabase.rpc("activate_scanner_device", {
      p_device_code: deviceCode,
      p_passcode: passcode,
    });
    const activated = data?.[0];
    if (error || !activated) throw error || new Error("not activated");

    saveDevice({ token: activated.device_token, name: activated.device_name });
    startScannerView();
  } catch (err) {
    console.error(err);
    showToast("Invalid device code or passcode.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Activate";
  }
});

// -----------------------------------------------------------------
// Close scanner modal
// -----------------------------------------------------------------
const deactivateBtn = document.getElementById("deactivate-btn");
const deactivateModal = document.getElementById("deactivate-modal");
const deactivateCancelBtn = document.getElementById("deactivate-cancel-btn");
const deactivateConfirmBtn = document.getElementById("deactivate-confirm-btn");
const deactivateQueueNote = document.getElementById("deactivate-queue-note");

let closing = false; // true while "Close scanner" is waiting for queued scans to be sent

function openDeactivateModal() {
  setMenu(false);
  const queued = loadQueue().length;
  if (queued > 0) {
    deactivateQueueNote.textContent = `${queued} scan${queued === 1 ? "" : "s"} still waiting to be sent. They will be sent first, then the scanner closes.`;
    deactivateQueueNote.style.display = "flex";
  } else {
    deactivateQueueNote.style.display = "none";
  }
  deactivateModal.style.display = "flex";
  deactivateCancelBtn.focus();
}

async function closeDeactivateModal() {
  deactivateModal.style.display = "none";
  deactivateBtn.focus();
  if (closing) {
    // Cancelled while still sending: go back to scanning.
    closing = false;
    deactivateConfirmBtn.disabled = false;
    deactivateConfirmBtn.textContent = "Close scanner";
    await startCamera();
  }
}

deactivateBtn.addEventListener("click", openDeactivateModal);
deactivateCancelBtn.addEventListener("click", closeDeactivateModal);
deactivateModal.addEventListener("click", (e) => {
  if (e.target === deactivateModal) closeDeactivateModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && deactivateModal.style.display !== "none") closeDeactivateModal();
});

// Confirming sends every queued scan first, then deactivates and returns to the
// scanner login screen. Offline: keeps trying every few seconds and closes by itself
// once the queue is empty. "Keep scanning" cancels (see closeDeactivateModal).
deactivateConfirmBtn.addEventListener("click", async () => {
  closing = true;
  deactivateConfirmBtn.disabled = true;
  deactivateConfirmBtn.textContent = "Closing…";
  await stopCamera();

  while (loadQueue().length > 0) {
    const n = loadQueue().length;
    deactivateQueueNote.textContent = navigator.onLine
      ? `Sending ${n} saved scan${n === 1 ? "" : "s"} before closing…`
      : `${n} saved scan${n === 1 ? "" : "s"} still waiting. Connect to the internet. The scanner will close itself once they are sent.`;
    deactivateQueueNote.style.display = "flex";

    await drainQueue();
    if (!closing) return; // cancelled
    if (loadQueue().length === 0) break;

    await new Promise((r) => setTimeout(r, 3000));
    if (!closing) return; // cancelled
  }

  clearDevice();
  location.reload();
});

// -----------------------------------------------------------------
// Settings menu (gear icon): Sync roster now / Refresh data now
// -----------------------------------------------------------------
const settingsBtn = document.getElementById("settings-btn");
const settingsMenu = document.getElementById("settings-menu");
const syncNowBtn = document.getElementById("sync-now-btn");
const refreshDataBtn = document.getElementById("refresh-data-btn");

function setMenu(open) {
  settingsMenu.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", String(open));
}

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(settingsMenu.hidden);
});
document.addEventListener("click", (e) => {
  if (!settingsMenu.hidden && !settingsMenu.contains(e.target)) setMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsMenu.hidden) {
    setMenu(false);
    settingsBtn.focus();
  }
});

async function runSync(full) {
  setMenu(false);
  syncNowBtn.disabled = true;
  refreshDataBtn.disabled = true;
  try {
    await syncRoster({ full, feedback: true });
  } finally {
    syncNowBtn.disabled = false;
    refreshDataBtn.disabled = false;
  }
}
syncNowBtn.addEventListener("click", () => runSync(false));
refreshDataBtn.addEventListener("click", () => runSync(true));

// -----------------------------------------------------------------
// Roster sync
//   incremental (default): only people added or changed since the last sync are
//                          downloaded and merged into the saved roster.
//   full (Refresh data now): the whole roster is downloaded and REPLACES the saved
//                          one — new QR codes arrive, retired ones and deactivated
//                          people disappear. The saved roster is only replaced if the
//                          download succeeds, so being offline never empties it.
// -----------------------------------------------------------------
let syncing = false;

// Newest updated_at among the rows, kept as the server's own string so clock
// differences between this phone and the server can't cause missed changes.
function latestUpdatedAt(rows, fallback) {
  let best = fallback;
  let bestMs = fallback ? new Date(fallback).getTime() : -Infinity;
  for (const p of rows) {
    const ms = new Date(p.updated_at).getTime();
    if (ms >= bestMs) {
      best = p.updated_at;
      bestMs = ms;
    }
  }
  return best;
}

async function syncRoster({ full = false, feedback = false } = {}) {
  if (!device || syncing) return;
  syncing = true;
  try {
    const since = full ? null : localStorage.getItem(STORAGE_ROSTER_SYNCED_AT) || null;
    const { data, error } = await supabase.rpc("scanner_download_roster", {
      p_device_token: device.token,
      p_since: since,
    });
    if (error) throw error;

    const rows = data || [];
    const next = full ? {} : loadRoster();
    rows.forEach((p) => {
      next[p.qr_token] = { full_name: p.full_name, role: p.role };
    });
    saveRoster(next);
    localStorage.setItem(STORAGE_ROSTER_SYNCED_AT, latestUpdatedAt(rows, since) || new Date().toISOString());
    roster = next;
    updateFooter();

    if (feedback) {
      showToast(full ? `Data refreshed (${rows.length} people).` : `Roster synced (${rows.length} updated).`, "success");
    }
  } catch (err) {
    console.error("Roster sync failed:", err);
    if (feedback) showToast(full ? "Unable to refresh data. The saved roster was kept." : "Unable to sync roster right now.", "error");
    const msg = (err?.message || "").toLowerCase();
    if (msg.includes("revoked") || msg.includes("not recognized")) deviceRevoked();
  } finally {
    syncing = false;
  }
}

function deviceRevoked() {
  showToast("This device has been deactivated by an administrator.", "error");
  clearDevice();
  setTimeout(() => location.reload(), 1500);
}

// -----------------------------------------------------------------
// Today's scans made on this phone — used for the instant duplicate checks.
// Same rules as record_attendance_scan; the server stays the final authority.
// -----------------------------------------------------------------
function manilaDate(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
}
function loadToday() {
  try {
    const t = JSON.parse(localStorage.getItem(STORAGE_TODAY) || "null");
    if (t && t.date === manilaDate()) return t;
  } catch {
    // fall through to a fresh day
  }
  return { date: manilaDate(), people: {} };
}
function markLocal(qrToken, mode, at) {
  const t = loadToday();
  t.people[qrToken] = { ...(t.people[qrToken] || {}), [mode]: at };
  localStorage.setItem(STORAGE_TODAY, JSON.stringify(t));
}
function localCheck(qrToken, mode) {
  const rec = loadToday().people[qrToken] || {};
  if (mode === "time_in" && rec.time_in) return "Already timed in today.";
  if (mode === "break_out") {
    if (!rec.time_in) return "Time in first.";
    if (rec.break_out) return "Break already recorded today.";
  }
  if (mode === "break_in") {
    if (!rec.break_out) return "No break in progress.";
    if (rec.break_in) return "Break already completed today.";
  }
  if (mode === "time_out") {
  if (!rec.time_in) return "Time in first.";
  if (rec.time_out) return "Already timed out today.";
}
  return null;
}

// -----------------------------------------------------------------
// Upload queue — scans wait here with their real timestamp and are sent in
// order. A scan the server rejects (already timed in, retired ID, etc.) is
// moved to the rejected log instead of being dropped silently.
// -----------------------------------------------------------------
function enqueueScan(qrToken, scanType, scannedAt) {
  const queue = loadQueue();
  queue.push({ id: crypto.randomUUID(), qr_token: qrToken, scan_type: scanType, scanned_at: scannedAt, attempts: 0 });
  saveQueue(queue);
  updateFooter();
}

let draining = false;
async function drainQueue() {
  if (draining || !device || !navigator.onLine) return;
  const snapshot = loadQueue();
  if (snapshot.length === 0) return;

  draining = true;
  try {
    const remaining = [];
    const rejected = loadRejected();

    for (const item of snapshot) {
      try {
        const { data, error } = await supabase.rpc("record_attendance_scan", {
          p_device_token: device.token,
          p_qr_token: item.qr_token,
          p_scan_type: item.scan_type,
          p_scanned_at: item.scanned_at,
        });
        if (error) throw error;
        if (data?.ok === false) {
          rejected.push({ ...item, name: data.name || null, message: data.message || "Rejected by the server." });
        }
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        if (err?.code && item.attempts >= MAX_ATTEMPTS) {
          rejected.push({ ...item, message: `${err.code} ${err.message}` });
        } else {
          remaining.push(item); // network trouble or a server error worth retrying
        }
      }
    }

    // Scans made while this loop was running must not be lost.
    const handled = new Set(snapshot.map((i) => i.id));
    const addedMeanwhile = loadQueue().filter((i) => !handled.has(i.id));
    saveQueue([...remaining, ...addedMeanwhile]);
    saveRejected(rejected);
    updateFooter();
  } finally {
    draining = false;
  }
}

// -----------------------------------------------------------------
// Mode selector
// -----------------------------------------------------------------
document.getElementById("mode-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest(".scanner-mode-btn");
  if (!btn) return;
  currentMode = btn.getAttribute("data-mode");
  document.querySelectorAll(".scanner-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
});

// -----------------------------------------------------------------
// Sound — short tones generated in the browser, no audio files needed
// -----------------------------------------------------------------
let audioCtx = null;

// Browsers only allow sound after the person has touched the page once.
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    // no audio support — scanning still works silently
  }
}
["pointerdown", "touchend", "click", "keydown"].forEach((evt) =>
  document.addEventListener(evt, unlockAudio, { passive: true })
);

function tone(freq, start, duration, type = "sine", volume = 0.35) {
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function beep(kind) {
  if (!audioCtx || audioCtx.state !== "running") return;
  if (kind === "ok") {
    tone(1200, 0, 0.12); // one short, high beep
  } else {
    tone(220, 0, 0.18, "square", 0.25); // two low buzzes
    tone(220, 0.24, 0.18, "square", 0.25);
  }
}

// -----------------------------------------------------------------
// Camera scanning
// -----------------------------------------------------------------
async function onDecoded(decodedText) {
  if (closing) return;
  const qrToken = decodedText.trim();
  const now = Date.now();
  if (lastScan.code === qrToken && now - lastScan.at < RESCAN_COOLDOWN_MS) return;
  lastScan = { code: qrToken, at: now };

  const label = MODE_LABEL[currentMode];
  const scannedAt = new Date().toISOString();
  const person = roster[qrToken];

  if (!person) {
    showResult("error", ["Not in roster", "Sync roster, then scan again"]);
    beep("error");
  } else {
    const problem = localCheck(qrToken, currentMode);
    if (problem) {
      showResult("error", [escapeHtml(person.full_name), problem]);
      beep("error");
    } else {
      markLocal(qrToken, currentMode, scannedAt);
      enqueueScan(qrToken, currentMode, scannedAt);
      showResult("ok", [escapeHtml(person.full_name), `${label} recorded`]);
      beep("ok");
      drainQueue();
    }
  }

  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => showResult("idle", ["Point the camera at a QR code"]), 2500);
}

// Size the camera to the biggest square that fits the space left on screen, so the
// whole page fits without scrolling and the feed is never cropped.
function sizeCamera() {
  const card = document.getElementById("camera-card");
  const reader = document.getElementById("qr-reader");
  reader.style.width = "0px"; // measure the card without the old camera in it
  const cs = getComputedStyle(card);
  const w = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const size = Math.max(160, Math.floor(Math.min(w, h, 480)));
  reader.style.width = `${size}px`;
}

async function startCamera() {
  sizeCamera();
  html5Qrcode = new Html5Qrcode("qr-reader");
  try {
    await html5Qrcode.start(
      { facingMode: "environment" },
      {
        fps: 10,
        aspectRatio: 1,
        qrbox: (w, h) => {
          const size = Math.floor(Math.min(w, h) * 0.85);
          return { width: size, height: size };
        },
      },
      (decodedText) => onDecoded(decodedText),
      () => {} // per-frame "no code found" — ignored, not an error
    );
  } catch (err) {
    console.error("Camera start failed:", err);
    showResult("error", ["Camera unavailable", "Check camera permission for this browser."]);
  }
}

async function stopCamera() {
  if (html5Qrcode) {
    try {
      await html5Qrcode.stop();
    } catch {
      // already stopped
    }
    try {
      html5Qrcode.clear();
    } catch {
      // nothing to clear
    }
  }
}

let rotateTimer = null;
window.addEventListener("orientationchange", () => {
  clearTimeout(rotateTimer);
  rotateTimer = setTimeout(async () => {
    if (!device) return;
    await stopCamera();
    await startCamera();
  }, 400);
});

// -----------------------------------------------------------------
// Boot
// -----------------------------------------------------------------
function startScannerView() {
  device = loadDevice();
  if (!device) {
    setupView.style.display = "block";
    scanView.style.display = "none";
    return;
  }

  setupView.style.display = "none";
  scanView.style.display = "flex";
  document.getElementById("device-name-label").textContent = device.name;

  roster = loadRoster();
  updateFooter();
  syncRoster();
  startCamera();
  drainQueue();

  if (!timersStarted) {
    timersStarted = true;
    setInterval(drainQueue, QUEUE_RETRY_INTERVAL_MS);
    setInterval(() => syncRoster(), AUTO_SYNC_INTERVAL_MS);
    window.addEventListener("online", () => {
      drainQueue();
      syncRoster();
    });
  }
}

startScannerView();
