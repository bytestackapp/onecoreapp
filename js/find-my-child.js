// =====================================================================
// Find My Child - web side.
//
//  CHILD'S PHONE (Android app, student account)
//    registerChildDevice()   registers this phone with the server (called from push.js)
//    initChildDeviceCard()   the "Find My Child" status/setup card on the Profile page
//
//  PARENT
//    openFindMyChild()       the popup opened by the "Find My Child" button: sends the
//                            request, waits for the phone's answer, shows the map
//
// Nothing here tracks anyone. A location only exists because a parent tapped the button.
// =====================================================================

import { supabase } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { sectionHead } from "./layout.js";
import { timePH } from "./time.js";
import { openShell } from "./modal.js";
import { escapeHtml as esc } from "./utils.js";

const svg = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
export const FMC_ICON = svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>');

const PIN_SVG =
  '<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg"><path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 25 15 25s15-14 15-25C30 6.7 23.3 0 15 0z" fill="#dc2626"/><circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>';

const LEAFLET_CSS = new URL("./vendor/leaflet/leaflet.min.css", import.meta.url).href; // hosted with the app
const LEAFLET_JS = new URL("./vendor/leaflet/leaflet.min.js", import.meta.url).href; // hosted with the app

const REQ_COLS = "id, status, failure_reason, latitude, longitude, accuracy_m, located_at, completed_at, created_at";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Styles (injected once, so global.css does not need to change)
// ---------------------------------------------------------------------
const STYLES = `
.fmc-intro { margin: 0 0 10px; font-size: 0.88rem; color: var(--text-secondary); }
.fmc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 0.92rem; }
.fmc-state.ok { color: var(--success); font-weight: 600; }
.fmc-state.bad { color: var(--error); font-weight: 600; }
.fmc-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.fmc-actions .btn { flex: 1 1 auto; text-align: center; justify-content: center; }
.fmc-steps { margin: 12px 0 0; font-size: 0.82rem; color: var(--text-secondary); }
.fmc-btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.fmc-btn svg { width: 16px; height: 16px; }
.dialog-modal.fmc-modal { max-width: 440px; }
.fmc-child { font-weight: 600; margin: -6px 0 12px; }
.fmc-loading { display: flex; align-items: center; gap: 12px; padding: 18px 0; color: var(--text-secondary); }
.fmc-spinner { width: 22px; height: 22px; flex: none; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--primary); animation: fmc-spin 0.8s linear infinite; }
@keyframes fmc-spin { to { transform: rotate(360deg); } }
.fmc-label { display: flex; align-items: center; gap: 6px; font-weight: 700; margin: 4px 0 2px; }
.fmc-label svg { width: 18px; height: 18px; flex: none; }
.fmc-label.fmc-current { color: var(--success); }
.fmc-label.fmc-old { color: var(--warning); }
.fmc-meta { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px; }
.fmc-hint { font-size: 0.88rem; margin: 0 0 12px; }
.fmc-map { height: 240px; border-radius: var(--radius-input); overflow: hidden; border: 1px solid var(--border); background: var(--bg); }
.fmc-map-fallback { height: 100%; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 0.85rem; color: var(--text-secondary); padding: 12px; }
.fmc-pin svg { width: 30px; height: 40px; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.3)); }
`;
function injectStyles() {
  if (document.getElementById("fmc-styles")) return;
  const style = document.createElement("style");
  style.id = "fmc-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}
injectStyles();

// ---------------------------------------------------------------------
// Small dialog helpers (same look as the rest of the app)
// ---------------------------------------------------------------------
function confirmDialog({ title, bodyHtml, okLabel }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const { backdrop, close } = openShell(
      `<div class="dialog-modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${bodyHtml}
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="no">Not now</button>
          <button type="button" class="btn btn-primary" data-act="yes">${esc(okLabel)}</button>
        </div>
      </div>`,
      () => done(false)
    );
    backdrop.querySelector('[data-act="no"]').addEventListener("click", close);
    backdrop.querySelector('[data-act="yes"]').addEventListener("click", () => { done(true); close(); });
  });
}

// =====================================================================
// CHILD'S PHONE
// =====================================================================

/** The native plugin, or null on the web / iOS / an app build without it. */
function plugin() {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform() !== "android") return null;
  return cap.Plugins?.FindMyChild || null;
}

let lastPushToken = null;

/**
 * Tells the server about this phone (permission status, push token).
 * Called with the token from push.js, and again (without a token) from the setup card.
 * Only students can register; call it for student profiles only.
 */
export async function registerChildDevice(pushToken = null) {
  const fmc = plugin();
  if (!fmc) return null;
  if (pushToken) lastPushToken = pushToken;

  const status = await fmc.getStatus();
  let device = null;
  try {
    const { installId } = await fmc.getInstallId();
    const { data, error } = await supabase.rpc("register_child_device", {
      p_install_id: installId,
      p_platform: "android",
      p_app_version: null,
      p_permission: status.permission,
      p_push_token: lastPushToken,
    });
    if (error) throw error;
    device = data?.[0] ?? null;
  } catch (err) {
    console.error("registerChildDevice failed:", err);
  }
  return { status, device };
}

/** The setup/status card on the Profile page (students, inside the Android app only). */
export async function initChildDeviceCard(profile) {
  if (profile.role !== "student") return;
  if (!window.Capacitor?.isNativePlatform?.()) return;

  const section = document.getElementById("fmc-device-section");
  const head = document.getElementById("fmc-head");
  const card = document.getElementById("fmc-device-card");
  if (!section || !head || !card) return;

  head.innerHTML = sectionHead({ title: "Find My Child", icon: FMC_ICON, tone: "muted" });
  section.style.display = "";

  const fmc = plugin();
  if (!fmc) {
    card.innerHTML = `<p class="text-muted" style="margin:0;">Please update the OneCore app to use Find My Child.</p>`;
    return;
  }

  function render(s, device) {
    const revoked = device?.device_status === "revoked";
    let problem = null;
    if (revoked) problem = "Find My Child was turned off for this phone by a parent or an administrator.";
    else if (!s.locationGranted) problem = "Location permission is required for Find My Child.";
    else if (!s.backgroundGranted) problem = "Background location is required. Set location to “Allow all the time”.";
    else if (!s.locationServicesOn) problem = "Location is switched off on this phone. Turn it on in Settings → Location.";
    const ready = !problem;

    const dot = (ok) => `<span class="fmc-state ${ok ? "ok" : "bad"}">● ${ok ? "Enabled" : "Not enabled"}</span>`;

    let buttons = "";
    if (!revoked) {
      if (!s.locationGranted) {
        buttons += `<button type="button" class="btn btn-primary" data-act="allow-location">Allow location access</button>`;
      } else if (!s.backgroundGranted) {
        buttons += `<button type="button" class="btn btn-primary" data-act="allow-always">Allow all the time</button>`;
        buttons += `<button type="button" class="btn btn-secondary" data-act="open-settings">Open app settings</button>`;
      }
      if (ready && !s.batteryUnrestricted) {
        buttons += `<button type="button" class="btn btn-secondary" data-act="battery">Allow background activity</button>`;
      }
    }

    card.innerHTML = `
      <p class="fmc-intro">Optional. This phone will shares its current location to linked parent once. OneCore never tracks you continuously and the shared location is deleted after 24 hours.</p>
      <div class="fmc-row"><span>Location access</span>${dot(s.locationGranted)}</div>
      <div class="fmc-row"><span>Background location</span>${dot(s.backgroundGranted)}</div>
      <div class="fmc-row" style="border-bottom:0;"><span>Status</span><span class="fmc-state ${ready ? "ok" : "bad"}">${ready ? "Ready" : "Needs attention"}</span></div>
      ${problem ? `<div class="banner banner-error" style="margin:10px 0 0;">${esc(problem)}</div>` : ""}
      ${ready && !s.batteryUnrestricted ? `<div class="banner banner-info" style="margin:10px 0 0;">Tip: some phones pause apps in the background. Tap “Allow background activity” and set OneCore to Unrestricted so requests always arrive.</div>` : ""}
      ${buttons ? `<div class="fmc-actions">${buttons}</div>` : ""}
      ${!revoked && s.locationGranted && !s.backgroundGranted ? `<p class="fmc-steps">To do it manually: Settings → Apps → OneCore → Permissions → Location → Allow all the time.</p>` : ""}
      ${!revoked && !s.locationGranted ? `<p class="fmc-steps">If the prompt does not appear: Settings → Apps → OneCore → Permissions → Location.</p>` : ""}`;
  }

  let working = false;
  async function refresh() {
    if (working) return;
    working = true;
    try {
      const result = await registerChildDevice();
      render(result.status, result.device);
    } catch (err) {
      console.error(err);
      card.innerHTML = `<p class="text-muted" style="margin:0;">Find My Child status couldn't be loaded. Please reopen the app.</p>`;
    } finally {
      working = false;
    }
  }

  card.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "allow-location") {
        const ok = await confirmDialog({
          title: "Allow location for Find My Child",
          bodyHtml: `<p>OneCore can share this phone's location with a parent linked to you, <strong>only when they tap “Find My Child”</strong>.</p>
                     <p>It takes one reading and shares only the current location. The shared location is deleted after 24 hours.</p>
                     <p>This permission is needed only for this optional feature.</p>`,
          okLabel: "Continue",
        });
        if (ok) await fmc.requestLocation();
      } else if (act === "allow-always") {
        const ok = await confirmDialog({
          title: "Allow location all the time",
          bodyHtml: `<p>For Find My Child to work while OneCore is closed, Android needs location set to <strong>“Allow all the time”</strong>.</p>
                     <p>On the next screen, open <strong>Permissions → Location</strong> and choose that option, then come back to OneCore.</p>`,
          okLabel: "Continue",
        });
        if (ok) await fmc.requestBackground();
      } else if (act === "open-settings") {
        await fmc.openAppSettings();
      } else if (act === "battery") {
        await fmc.openBatterySettings();
      }
    } catch (err) {
      console.error(err);
      showToast(err && !(err instanceof TypeError) && typeof err.message === "string" && err.message ? err.message : "Something went wrong.", "error");
    }
    await refresh();
  });

  // Coming back from Android's settings screens: re-read the permissions.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  refresh();
}

// =====================================================================
// PARENT
// =====================================================================

let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = LEAFLET_JS;
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletPromise = null; reject(new Error("Map failed to load")); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

function timeText(iso) {
  return timePH(iso);
}

function agoText(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const mapsUrl = (row) => `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`;

const REASON_HINTS = {
  no_device: "This phone isn't set up for Find My Child yet. Ask your child to open OneCore and allow location access.",
  permission: "Location permission is turned off on your child's phone.",
  location_off: "Location is switched off on your child's phone.",
  rate_limited: "Too many requests in a short time. Please wait a few minutes and try again.",
  child_inactive: "This student account isn't active.",
  timeout: "The phone didn't respond. It may be switched off, offline, or limiting background activity.",
  unreachable: "The phone didn't respond. It may be switched off, offline, or limiting background activity.",
  expired: "The phone didn't respond. It may be switched off, offline, or limiting background activity.",
  push_failed: "The phone didn't respond. It may be switched off, offline, or limiting background activity.",
};
const hintFor = (reason) => REASON_HINTS[reason] || "Something went wrong. Please try again.";

async function fetchLastKnown(childId) {
  const { data } = await supabase
    .from("location_requests")
    .select(REQ_COLS)
    .eq("child_id", childId)
    .eq("status", "completed")
    .order("located_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

function locationBlock(row, current) {
  const label = current
    ? `<div class="fmc-label fmc-current">${FMC_ICON}<span>Current location</span></div>`
    : `<div class="fmc-label fmc-old">${FMC_ICON}<span>Last known location — ${esc(agoText(row.located_at))}</span></div>`;
  const accuracy = row.accuracy_m != null ? `<br>Accuracy: approximately ${Math.max(1, Math.round(row.accuracy_m))} m` : "";
  return `${label}
    <div class="fmc-meta">Updated: ${esc(timeText(row.located_at))}${accuracy}</div>
    <div class="fmc-map" id="fmc-map"></div>`;
}

function actionsHtml(row) {
  return `<div class="fmc-actions">
      <button type="button" class="btn btn-primary" data-act="refresh">Refresh Location</button>
      ${row ? `<a class="btn btn-secondary" href="${mapsUrl(row)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>` : ""}
    </div>`;
}

/** Opens the Find My Child popup for one child and immediately asks the phone for its location. */
export function openFindMyChild({ childId, childName }) {
  let cancelled = false;
  let map = null;
  let busy = false;

  const { backdrop, close } = openShell(
    `<div class="dialog-modal fmc-modal" role="dialog" aria-modal="true" aria-labelledby="fmc-title">
      <h3 id="fmc-title">Find My Child</h3>
      <div class="fmc-child">${esc(childName)}</div>
      <div id="fmc-body"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="close">Close</button>
      </div>
    </div>`,
    () => {
      cancelled = true;
      if (map) { map.remove(); map = null; }
    }
  );
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
  const body = backdrop.querySelector("#fmc-body");

  function setBody(html) {
    if (map) { map.remove(); map = null; }
    body.innerHTML = html;
    body.querySelector('[data-act="refresh"]')?.addEventListener("click", run);
  }

  async function drawMap(row) {
    const el = body.querySelector("#fmc-map");
    if (!el) return;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    const accuracy = row.accuracy_m != null ? Number(row.accuracy_m) : null;
    try {
      const L = await loadLeaflet();
      if (cancelled || !el.isConnected) return;
      const zoom = accuracy == null || accuracy > 200 ? 14 : accuracy > 50 ? 16 : 17;
      map = L.map(el).setView([lat, lon], zoom);
      L.tileLayer("https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?key=VzMUCzcwHeu1p1rEv4d5", {
        maxZoom: 19,
        attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      }).addTo(map);
      if (accuracy != null) L.circle([lat, lon], { radius: accuracy, color: "#4f46e5", weight: 1, fillOpacity: 0.12 }).addTo(map);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "fmc-pin", html: PIN_SVG, iconSize: [30, 40], iconAnchor: [15, 38] }),
      }).addTo(map);
      setTimeout(() => { if (map) map.invalidateSize(); }, 80);
    } catch (err) {
      console.warn(err);
      el.innerHTML = `<div class="fmc-map-fallback">Map unavailable.<br>${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
    }
  }

  async function showResult(row) {
    // Only a fix from the last few minutes may ever be called "current".
    const fresh = !row.completed_at || new Date(row.completed_at).getTime() - new Date(row.located_at).getTime() < 3 * 60_000;
    if (!fresh) return showUnavailable("stale");
    setBody(locationBlock(row, true) + actionsHtml(row));
    drawMap(row);
  }

  async function showUnavailable(reason) {
    const last = await fetchLastKnown(childId);
    if (cancelled) return;
    setBody(
      `<div class="banner banner-error" style="margin-bottom:10px;"><strong>Unable to get current location.</strong></div>
       <p class="fmc-hint text-muted">${esc(hintFor(reason))}</p>
       ${last ? locationBlock(last, false) : ""}
       ${actionsHtml(last)}`
    );
    if (last) drawMap(last);
  }

  async function waitForResult(requestId) {
    const deadline = Date.now() + 45_000;
    while (!cancelled && Date.now() < deadline) {
      await sleep(2000);
      const { data } = await supabase.from("location_requests").select(REQ_COLS).eq("id", requestId).maybeSingle();
      if (data?.status === "completed") return { row: data };
      if (data && data.status !== "pending") return { reason: data.failure_reason || data.status };
    }
    return { reason: "timeout" };
  }

  async function run() {
    if (busy) return;
    busy = true;
    setBody(`<div class="fmc-loading"><span class="fmc-spinner"></span><span>Asking ${esc(childName)}'s phone for its current location…</span></div>`);

    let outcome;
    try {
      const { data, error } = await supabase.functions.invoke("request-child-location", { body: { childId } });
      if (error) throw error;
      outcome = data?.ok ? await waitForResult(data.requestId) : { reason: data?.reason || "error" };
    } catch (err) {
      console.error(err);
      outcome = { reason: "error" };
    }
    busy = false;
    if (cancelled) return;
    if (outcome.row) await showResult(outcome.row);
    else await showUnavailable(outcome.reason);
  }

  run();
}
