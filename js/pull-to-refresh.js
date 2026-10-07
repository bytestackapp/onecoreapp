// Pull-to-refresh for the mobile layout.
// Pull down from the very top of a page: the page slides down like a sheet
// with rounded top corners, revealing a brand-coloured area with a white
// refresh circle. Release past the mark to reload.
// Imported once from layout.js, so it covers every page that uses the app
// shell. The scanner and login pages don't use layout.js, so they're untouched.

const MOBILE_QUERY = "(max-width: 880px)"; // same breakpoint as the bottom nav
const INSTALLED_APP_ONLY = false; // true = only when installed to the home screen
const TRIGGER = 64; // how far (px) the page must be pulled to count as a refresh
const HOLD = 70; // where the page rests while it reloads
const MAX_PULL = 120; // furthest the page can be pulled
const RESISTANCE = 0.55; // finger distance -> page distance
const RADIUS = 22; // rounded top corners of the sliding page (px)

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

    /* The coloured area revealed above the sliding page */
    #ptr-reveal {
      position: fixed; left: 0; right: 0; z-index: 0;
      top: calc(var(--topbar-h, 64px) + env(safe-area-inset-top, 0px));
      height: 0; overflow: hidden; box-sizing: border-box;
      padding-bottom: ${RADIUS}px; /* keeps the circle centred in the visible gap only */
      display: none; /* shown only while pulling (class "on") */
      align-items: center; justify-content: center;
      background: linear-gradient(135deg, #2952e3 0%, #1fc6c6 100%);
      pointer-events: none;
    }
    #ptr-reveal.on { display: flex; }
    #ptr-reveal.snap { transition: height .2s ease; }
    #ptr-circle {
      flex-shrink: 0; width: 42px; height: 42px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: #fff; color: #2952e3;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.22);
      opacity: 0; transform: scale(.6);
      transition: transform .22s ease, opacity .22s ease;
    }
    #ptr-reveal.ready #ptr-circle { opacity: 1; transform: scale(1); }
	#ptr-reveal.spinning #ptr-circle { transform: scale(.72); }
    #ptr-circle svg { width: 28px; height: 28px; }
    #ptr-reveal.spinning #ptr-circle svg { animation: ptr-spin .8s linear infinite; }
    @keyframes ptr-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);

  const reveal = document.createElement("div");
  reveal.id = "ptr-reveal";
  reveal.setAttribute("aria-hidden", "true");
  reveal.innerHTML = `<div id="ptr-circle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">  <path d="M 12 3 C 14.52 3 16.93 4 18.74 5.74" /><path d="M 18.74 5.74 L 21 8" /><path d="M16.5 19.789 A9 9 0 1 1 12 3" /><path d="M21 3v5h-5" /></svg></div>`;

  function attachReveal() {
    if (reveal.isConnected) return;
    (document.getElementById("app-main") || document.body).appendChild(reveal);
  }
  const circle = reveal.querySelector("#ptr-circle");
  const icon = circle.querySelector("svg");
  const content = () => document.getElementById("app-content");

  let startY = 0;
  let pull = 0;
  let tracking = false;
  let refreshing = false;

  function canStart(e) {
    if (refreshing) return false;
    if (!window.matchMedia(MOBILE_QUERY).matches) return false;
    if (INSTALLED_APP_ONLY && !isInstalledApp()) return false;
    if ((document.scrollingElement?.scrollTop ?? window.scrollY) > 1) return false;
    // Not while a dialog or the "More" sheet is open, or while typing
    if (document.querySelector(".dialog-backdrop, .more-sheet.open")) return false;
    if (e.target.closest && e.target.closest("input, textarea, select, [data-no-ptr]")) return false;
    return true;
  }

  // The page becomes a rounded "sheet" that slides over the coloured area.
  function prepareSheet() {
    const el = content();
    if (!el) return;
    el.style.transition = "none";
    el.style.willChange = "transform";
    el.style.position = "relative";
    el.style.zIndex = "1";
    el.style.background = "var(--bg)";
    el.style.borderRadius = `${RADIUS}px ${RADIUS}px 0 0`;
  }

  function clearSheet() {
    const el = content();
    if (!el) return;
    ["transition", "willChange", "position", "zIndex", "background", "borderRadius", "transform"].forEach((p) => (el.style[p] = ""));
  }

  // Move the page, the coloured area and the circle to `distance` px.
  function render(distance) {
    const el = content();
    if (el) el.style.transform = `translateY(${distance}px)`;
    reveal.classList.add("on");
    reveal.style.height = `${distance + RADIUS}px`;
    icon.style.transform = `rotate(${distance * 5}deg)`;
    reveal.classList.toggle("ready", distance >= TRIGGER);
  }

  function reset() {
    const el = content();
    if (el) {
      el.style.transition = "transform .2s ease";
      el.style.transform = "";
      setTimeout(clearSheet, 220);
    }
    reveal.classList.add("snap");
    circle.classList.add("snap");
    reveal.style.height = "0";
    reveal.classList.remove("ready");
    setTimeout(() => {
      reveal.classList.remove("snap", "on");
      circle.classList.remove("snap");
    }, 220);
    pull = 0;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || !canStart(e)) return;
      tracking = true;
      startY = e.touches[0].clientY;
      pull = 0;
      reveal.classList.remove("snap");
      circle.classList.remove("snap");
	  attachReveal();
      prepareSheet();
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
        else clearSheet();
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
      const el = content();
      if (el) {
        el.style.transition = "transform .2s ease";
        el.style.transform = `translateY(${HOLD}px)`;
      }
      reveal.classList.add("snap", "ready", "spinning");
      circle.classList.add("snap");
      reveal.style.height = `${HOLD + RADIUS}px`;
      icon.style.transform = "";
      try {
        Object.keys(sessionStorage).filter((k) => k.startsWith("onecore_seen_") || k === "onecore_app_version_row").forEach((k) => sessionStorage.removeItem(k));
      } catch { /* ignore */ }
      setTimeout(() => window.location.reload(), 500);
    } else if (pull > 0) {
      reset();
    } else {
      clearSheet();
    }
  }
  document.addEventListener("touchend", release);
  document.addEventListener("touchcancel", release);
}

initPullToRefresh();
