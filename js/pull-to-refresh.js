// Pull-to-refresh for the mobile layout.
// Pull down from the very top of a page and release to reload it.
// Imported once from layout.js, so it covers every page that uses the app
// shell. The scanner and login pages don't use layout.js, so they're untouched.

const MOBILE_QUERY = "(max-width: 880px)"; // same breakpoint as the bottom nav
const INSTALLED_APP_ONLY = false; // true = only when installed to the home screen
const TRIGGER = 56; // how far (px) the indicator must travel to count as a refresh
const MAX_PULL = 90; // furthest the indicator travels
const RESISTANCE = 0.6; // finger distance -> indicator distance

function isInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function initPullToRefresh() {
  if (window.__pullToRefreshReady) return;
  window.__pullToRefreshReady = true;
  if (!("ontouchstart" in window) && !navigator.maxTouchPoints) return; // no touch screen

  const style = document.createElement("style");
  style.textContent = `
    @media ${MOBILE_QUERY} { html, body { overscroll-behavior-y: contain; } }
    #ptr-indicator {
      position: fixed; left: 50%; z-index: 25;
      top: calc(var(--topbar-h, 64px) + env(safe-area-inset-top, 0px));
      width: 38px; height: 38px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: var(--card, #fff); border: 1px solid var(--border, #e2e8f0);
      box-shadow: var(--shadow-pop, 0 4px 14px rgba(15,23,42,.15));
      color: var(--text-muted, #94a3b8);
      opacity: 0; pointer-events: none; transform: translate(-50%, -48px);
    }
    #ptr-indicator.snap { transition: transform .2s var(--ease, ease), opacity .2s; }
    #ptr-indicator.ready { color: var(--primary, #4f46e5); }
    #ptr-indicator svg { width: 20px; height: 20px; }
    #ptr-indicator.spinning svg { animation: ptr-spin .8s linear infinite; }
    @keyframes ptr-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);

  const indicator = document.createElement("div");
  indicator.id = "ptr-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.85-3.36L23 10M1 14l4.65 4.36A9 9 0 0020.5 15"/></svg>`;
  document.body.appendChild(indicator);
  const icon = indicator.querySelector("svg");

  let startY = 0;
  let pull = 0;
  let tracking = false;
  let refreshing = false;

  function canStart(e) {
    if (refreshing) return false;
    if (!window.matchMedia(MOBILE_QUERY).matches) return false;
    if (INSTALLED_APP_ONLY && !isInstalledApp()) return false;
    if ((document.scrollingElement?.scrollTop ?? window.scrollY) > 0) return false;
    // Not while a dialog or the "More" sheet is open, or while typing
    if (document.querySelector(".dialog-backdrop, .more-sheet.open")) return false;
    if (e.target.closest("input, textarea, select, [data-no-ptr]")) return false;
    return true;
  }

  function render(distance) {
    indicator.style.opacity = String(Math.min(1, distance / TRIGGER));
    indicator.style.transform = `translate(-50%, ${distance - 48}px)`;
    icon.style.transform = `rotate(${distance * 4}deg)`;
    indicator.classList.toggle("ready", distance >= TRIGGER);
  }

  function reset() {
    indicator.classList.add("snap");
    indicator.style.opacity = "0";
    indicator.style.transform = "translate(-50%, -48px)";
    indicator.classList.remove("ready");
    setTimeout(() => indicator.classList.remove("snap"), 220);
    pull = 0;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || !canStart(e)) return;
      tracking = true;
      startY = e.touches[0].clientY;
      pull = 0;
      indicator.classList.remove("snap");
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        // finger moved back up: this is a normal scroll, stop tracking
        tracking = false;
        if (pull > 0) reset();
        return;
      }
      if (e.cancelable) e.preventDefault(); // stop the browser's own overscroll
      pull = Math.min(dy * RESISTANCE, MAX_PULL);
      render(pull);
    },
    { passive: false }
  );

  function release() {
    if (!tracking) return;
    tracking = false;
    if (pull >= TRIGGER) {
      refreshing = true;
      icon.style.transform = "";
      indicator.classList.add("snap", "spinning");
      indicator.style.opacity = "1";
      indicator.style.transform = `translate(-50%, ${TRIGGER - 48}px)`;
      setTimeout(() => window.location.reload(), 350);
    } else {
      reset();
    }
  }
  document.addEventListener("touchend", release);
  document.addEventListener("touchcancel", release);
}

initPullToRefresh();
