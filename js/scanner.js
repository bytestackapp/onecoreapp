// Standalone scanner page. No login — authenticates as a DEVICE via the
// device token stored on activation, not a person. See record_attendance_scan,
// activate_scanner_device, and scanner_download_roster in the database.
import { supabase } from "./supabase-client.js";
import { showToast } from "./toast.js";

const STORAGE_DEVICE = "onecore_scanner_device";
const STORAGE_ROSTER = "onecore_scanner_roster";
const STORAGE_ROSTER_SYNCED_AT = "onecore_scanner_roster_synced_at";
const STORAGE_QUEUE = "onecore_scanner_queue";

const RESCAN_COOLDOWN_MS = 4000; // ignore the same code again this soon
const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const QUEUE_RETRY_INTERVAL_MS = 15000;

let device = null; // { token, name }
let roster = {}; // qr_token -> { full_name, role }
let currentMode = "time_in";
let lastScan = { code: null, at: 0 };
let html5Qrcode = null;

const setupView = document.getElementById("setup-view");
const scanView = document.getElementById("scan-view");
const resultEl = document.getElementById("scanner-result");
const queueStatusEl = document.getElementById("queue-status");

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

function updateFooter() {
  const roster = loadRoster();
  const queue = loadQueue();
  const rosterCount = Object.keys(roster).length;
  queueStatusEl.textContent = `Roster: ${rosterCount} · Queue: ${queue.length}`;
}

function showResult(kind, lines) {
  resultEl.className = `scanner-result ${kind}`;
  resultEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
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

const deactivateBtn = document.getElementById("deactivate-btn");
const deactivateModal = document.getElementById("deactivate-modal");
const deactivateCancelBtn = document.getElementById("deactivate-cancel-btn");
const deactivateConfirmBtn = document.getElementById("deactivate-confirm-btn");
const deactivateQueueNote = document.getElementById("deactivate-queue-note");

function openDeactivateModal() {
  const queued = loadQueue().length;
  if (queued > 0) {
    deactivateQueueNote.textContent = `${queued} queued scan${queued === 1 ? "" : "s"} will stay saved on this device and send once it is activated again.`;
    deactivateQueueNote.style.display = "flex";
  } else {
    deactivateQueueNote.style.display = "none";
  }
  deactivateModal.style.display = "flex";
  deactivateCancelBtn.focus();
}

function closeDeactivateModal() {
  deactivateModal.style.display = "none";
  deactivateBtn.focus();
}

deactivateBtn.addEventListener("click", openDeactivateModal);
deactivateCancelBtn.addEventListener("click", closeDeactivateModal);
deactivateModal.addEventListener("click", (e) => {
  if (e.target === deactivateModal) closeDeactivateModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && deactivateModal.style.display !== "none") closeDeactivateModal();
});

// Confirming deactivates immediately and returns to the scanner login screen.
deactivateConfirmBtn.addEventListener("click", async () => {
  deactivateConfirmBtn.disabled = true;
  deactivateCancelBtn.disabled = true;
  deactivateConfirmBtn.textContent = "Closing…";
  await stopCamera();
  clearDevice();
  location.reload();
});

// -----------------------------------------------------------------
// Roster sync
// -----------------------------------------------------------------
async function syncRoster(showFeedback = false) {
  if (!device) return;
  try {
    const since = localStorage.getItem(STORAGE_ROSTER_SYNCED_AT) || null;
    const { data, error } = await supabase.rpc("scanner_download_roster", {
      p_device_token: device.token,
      p_since: since,
    });
    if (error) throw error;

    const current = loadRoster();
    (data || []).forEach((p) => {
      current[p.qr_token] = { full_name: p.full_name, role: p.role };
    });
    saveRoster(current);
    localStorage.setItem(STORAGE_ROSTER_SYNCED_AT, new Date().toISOString());
    roster = current;
    updateFooter();
    if (showFeedback) showToast(`Roster synced (${data?.length ?? 0} updated).`, "success");
  } catch (err) {
    console.error("Roster sync failed:", err);
    if (showFeedback) showToast("Unable to sync roster right now.", "error");
    if (err?.message?.toLowerCase().includes("revoked") || err?.message?.toLowerCase().includes("not recognized")) {
      deviceRevoked();
    }
  }
}

document.getElementById("sync-now-btn").addEventListener("click", () => syncRoster(true));

function deviceRevoked() {
  showToast("This device has been deactivated by an administrator.", "error");
  clearDevice();
  setTimeout(() => location.reload(), 1500);
}

// -----------------------------------------------------------------
// Offline queue — a scan that fails to submit is queued with its real
// timestamp, and replayed in order once the connection returns.
// -----------------------------------------------------------------
async function submitScan(qrToken, scanType, scannedAt) {
  const { data, error } = await supabase.rpc("record_attendance_scan", {
    p_device_token: device.token,
    p_qr_token: qrToken,
    p_scan_type: scanType,
    p_scanned_at: scannedAt,
  });

  if (!error) return { queued: false, result: data };

  console.error("record_attendance_scan failed:", error);

  // A server-side error (has a code) is a rejection, not "offline"
  const isNetwork = !error.code && /fetch|network/i.test(error.message || "");
  if (!isNetwork) {
    return { queued: false, result: { ok: false, message: `${error.code || ""} ${error.message}`.trim() } };
  }

  const queue = loadQueue();
  queue.push({ id: crypto.randomUUID(), qr_token: qrToken, scan_type: scanType, scanned_at: scannedAt });
  saveQueue(queue);
  updateFooter();
  return { queued: true };
}

async function drainQueue() {
  if (!device || !navigator.onLine) return;
  let queue = loadQueue();
  if (queue.length === 0) return;

  const remaining = [];
  for (const item of queue) {
    try {
      const { error } = await supabase.rpc("record_attendance_scan", {
        p_device_token: device.token,
        p_qr_token: item.qr_token,
        p_scan_type: item.scan_type,
        p_scanned_at: item.scanned_at,
      });
      if (error) throw error;
      // Success or a real rejection (e.g. already timed in) both count as
      // "delivered" — either way it doesn't belong in the retry queue.
    } catch {
      remaining.push(item);
    }
  }
  saveQueue(remaining);
  updateFooter();
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
// Camera scanning
// -----------------------------------------------------------------
async function onDecoded(decodedText) {
  const qrToken = decodedText.trim();
  const now = Date.now();
  if (lastScan.code === qrToken && now - lastScan.at < RESCAN_COOLDOWN_MS) return;
  lastScan = { code: qrToken, at: now };

  const cached = roster[qrToken];
  const scannedAt = new Date().toISOString();
  const modeLabel = { time_in: "Time In", break_out: "Break Out", break_in: "Break In", time_out: "Time Out" }[currentMode];

  const outcome = await submitScan(qrToken, currentMode, scannedAt);

  if (outcome.queued) {
    showResult("queued", [cached ? escapeHtml(cached.full_name) : "Saved — will verify online", `${modeLabel} · queued (offline)`]);
    return;
  }

  const r = outcome.result;
  if (r?.ok) {
    showResult("ok", [escapeHtml(r.name), `${modeLabel} recorded`]);
  } else {
    showResult("error", [r?.name ? escapeHtml(r.name) : "Not recognized", escapeHtml(r?.message || "Unable to record this scan.")]);
  }

  setTimeout(() => {
    if (resultEl.classList.contains("ok") || resultEl.classList.contains("error") || resultEl.classList.contains("queued")) {
      showResult("idle", ["Point the camera at a QR code"]);
    }
  }, 2500);
}

async function startCamera() {
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
      () => {}
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
  }
}

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

  setInterval(drainQueue, QUEUE_RETRY_INTERVAL_MS);
  setInterval(() => syncRoster(), AUTO_SYNC_INTERVAL_MS);
  window.addEventListener("online", drainQueue);
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

startScannerView();
