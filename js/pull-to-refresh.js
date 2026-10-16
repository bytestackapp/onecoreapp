// Pull-to-refresh for the mobile layout.
//
// Pull down from the very top of a page: the page slides down like a sheet with rounded top corners,
// revealing a branded area. A ring fills as you pull; at the mark it pops and the phone gives a tiny tap.
// Let go and the page reloads. Pull less and it springs back.
//
// Built to stay smooth:
//  - nothing listens to finger movement unless a pull has really started at the top of the page,
//    so normal scrolling is never slowed down;
//  - while pulling, only transforms change (no layout work), once per screen frame;
//  - sideways swipes, upward swipes and scrolling inside lists or pop-ups are left alone;
//  - the pull gets heavier the further you go, like a rubber band.
// Imported once from layout.js, so it covers every page that uses the app shell. The scanner and
// login pages don't use layout.js, so they're untouched.

const MOBILE_QUERY = "(max-width: 880px)"; // same breakpoint as the bottom nav
const INSTALLED_APP_ONLY = false; // true = only when installed to the home screen
const TRIGGER = 72; // how far (px) the page must be pulled to count as a refresh
const HOLD = 64; // where the page rests while it reloads
const MAX_PULL = 132; // furthest the page can travel
const RADIUS = 22; // rounded top corners of the sliding page (px)
const SLOP = 8; // finger travel (px) before we decide whether it is a pull
const SPRING = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const RING = 2 * Math.PI * 14; // length of the progress ring

function isInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function initPullToRefresh() {
  if (window.__pullToRefreshReady) return;
  window.__pullToRefreshReady = true;
  if (!("ontouchstart" in window) && !navigator.maxTouchPoints) return; // no touch screen

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DUR = reduced ? 0.01 : 0.34; // seconds

  const style = document.createElement("style");
  style.textContent = `
    @media ${MOBILE_QUERY} { html, body { overscroll-behavior-y: contain; } }

    /* The coloured area revealed above the sliding page (it never changes size, so it costs nothing to animate) */
    #ptr-reveal {
      position: fixed; left: 0; right: 0; z-index: 0;
      top: calc(var(--topbar-h, 64px) + env(safe-area-inset-top, 0px));
      height: ${MAX_PULL + RADIUS}px; overflow: hidden; display: none;
      background: linear-gradient(135deg, var(--splash-a, #2952e3) 0%, var(--splash-b, #1fc6c6) 100%);
      pointer-events: none;
    }
    :root[data-theme="dark"] #ptr-reveal { background: linear-gradient(135deg, var(--splash-a, #1e3fae) 0%, var(--splash-b, #138a8a) 100%); }
    #ptr-reveal.on { display: block; }
    #ptr-circle {
      position: absolute; top: 0; left: 50%; width: 44px; height: 44px; margin-left: -22px;
      border-radius: 50%; background: #fff; box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
      opacity: 0; will-change: transform, opacity;
    }
    #ptr-circle svg { display: block; width: 44px; height: 44px; }
    .ptr-track { fill: none; stroke: rgba(15, 23, 42, 0.1); stroke-width: 3; }
    .ptr-arc {
      fill: none; stroke: var(--splash-a, #2952e3); stroke-width: 3; stroke-linecap: round;
      stroke-dasharray: ${RING}; stroke-dashoffset: ${RING};
      transform: rotate(-90deg); transform-box: fill-box; transform-origin: center;
    }
    .ptr-arrow {
      fill: none; stroke: var(--splash-a, #2952e3); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
      transform-box: fill-box; transform-origin: center;
    }
    #ptr-reveal.spinning .ptr-arc { stroke-dasharray: 52 36; stroke-dashoffset: 0; animation: ptr-spin 0.8s linear infinite; }
    #ptr-reveal.spinning .ptr-arrow { opacity: 0; }
    @keyframes ptr-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }`;
  document.head.appendChild(style);

  const reveal = document.createElement("div");
  reveal.id = "ptr-reveal";
  reveal.setAttribute("aria-hidden", "true");
  reveal.innerHTML = `<div id="ptr-circle"><svg viewBox="0 0 44 44"><circle class="ptr-track" cx="22" cy="22" r="14"/><circle class="ptr-arc" cx="22" cy="22" r="14"/><path class="ptr-arrow" d="M22 15v10M17.5 21l4.5 4.5 4.5-4.5"/></svg></div>`;
  const circle = reveal.querySelector("#ptr-circle");
  const arc = reveal.querySelector(".ptr-arc");
  const arrow = reveal.querySelector(".ptr-arrow");

  function attachReveal() {
    if (reveal.isConnected) return;
    (document.getElementById("app-main") || document.body).appendChild(reveal);
  }
  const content = () => document.getElementById("app-content");

  let tracking = false;
  let decided = false; // true once the finger has clearly started a downward pull
  let startX = 0;
  let startY = 0;
  let pull = 0;
  let armed = false;
  let refreshing = false;
  let frame = 0;

  const pageScrolled = () => (document.scrollingElement?.scrollTop ?? window.scrollY) > 1;

  function canStart(e) {
    if (refreshing) return false;
    if (!window.matchMedia(MOBILE_QUERY).matches) return false;
    if (INSTALLED_APP_ONLY && !isInstalledApp()) return false;
    if (pageScrolled()) return false;
    // Not while a dialog, picker or the "More" sheet is open
    if (document.querySelector('.dialog-backdrop, .more-sheet.open, [aria-modal="true"]')) return false;
    // Not while typing, or on something that wants its own touch handling
    if (e.target.closest && e.target.closest("input, textarea, select, [data-no-ptr]")) return false;
    // Not when the finger is on a list that is itself scrolled down
    for (let el = e.target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return false;
    }
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
    circle.style.transition = "none";
  }
  function clearSheet() {
    const el = content();
    if (!el) return;
    ["transition", "willChange", "position", "zIndex", "background", "borderRadius", "transform"].forEach((p) => (el.style[p] = ""));
  }

  function paint() {
    frame = 0;
    const el = content();
    if (el) el.style.transform = `translate3d(0, ${pull}px, 0)`;
    const progress = Math.min(pull / TRIGGER, 1);
    circle.style.transform = `translate3d(0, ${pull / 2 - 22}px, 0) scale(${0.55 + 0.45 * progress})`;
    circle.style.opacity = String(Math.min(1, progress * 1.6));
    arc.style.strokeDashoffset = String(RING * (1 - progress));
    arrow.style.transform = `rotate(${progress * 180}deg)`;

    const nowArmed = pull >= TRIGGER;
    if (nowArmed && !armed) {
      armed = true;
      try { navigator.vibrate && navigator.vibrate(8); } catch { /* not supported */ }
      if (!reduced && circle.animate) circle.animate([{ scale: "1" }, { scale: "1.16" }, { scale: "1" }], { duration: 240, easing: "ease-out" });
    } else if (!nowArmed && armed) {
      armed = false;
    }
  }
  const schedulePaint = () => { if (!frame) frame = requestAnimationFrame(paint); };

  function listen(on) {
    const fn = on ? "addEventListener" : "removeEventListener";
    document[fn]("touchmove", onTouchMove, { passive: false });
    document[fn]("touchend", onTouchEnd);
    document[fn]("touchcancel", onTouchEnd);
  }

  function springBack() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    const el = content();
    if (el) {
      el.style.transition = `transform ${DUR}s ${SPRING}`;
      el.style.transform = "translate3d(0, 0, 0)";
    }
    circle.style.transition = `transform ${DUR}s ${SPRING}, opacity ${DUR}s ease`;
    circle.style.opacity = "0";
    circle.style.transform = "translate3d(0, -22px, 0) scale(0.55)";
    setTimeout(() => {
      reveal.classList.remove("on");
      clearSheet();
      circle.style.transition = "";
      pull = 0;
      armed = false;
    }, DUR * 1000 + 40);
  }

  function startRefresh() {
    refreshing = true;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    const el = content();
    if (el) {
      el.style.transition = `transform ${DUR}s ${SPRING}`;
      el.style.transform = `translate3d(0, ${HOLD}px, 0)`;
    }
    circle.style.transition = `transform ${DUR}s ${SPRING}`;
    circle.style.opacity = "1";
    circle.style.transform = `translate3d(0, ${HOLD / 2 - 22}px, 0) scale(1)`;
    arc.style.strokeDashoffset = "0";
    reveal.classList.add("spinning");
    try {
      Object.keys(sessionStorage).filter((k) => k.startsWith("onecore_seen_") || k === "onecore_app_version_row").forEach((k) => sessionStorage.removeItem(k));
    } catch { /* ignore */ }
    setTimeout(() => window.location.reload(), reduced ? 150 : 520);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1 || !canStart(e)) return;
    tracking = true;
    decided = false;
    pull = 0;
    armed = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    listen(true); // from here on (and only now) we watch the finger
  }

  function onTouchMove(e) {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!decided) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        // upward or sideways: this is normal scrolling, step aside
        tracking = false;
        listen(false);
        return;
      }
      decided = true;
      attachReveal();
      prepareSheet();
      reveal.classList.add("on");
    }

    if (pageScrolled()) {
      tracking = false;
      listen(false);
      springBack();
      return;
    }
    if (e.cancelable) e.preventDefault(); // stop the browser's own overscroll
    const raw = dy - SLOP;
    pull = MAX_PULL * (1 - Math.exp(-raw / (MAX_PULL * 1.15))); // rubber band: heavier the further you pull
    schedulePaint();
  }

  function onTouchEnd() {
    if (!tracking) return;
    tracking = false;
    listen(false);
    if (!decided) return;
    if (pull >= TRIGGER) startRefresh();
    else springBack();
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true });
}

initPullToRefresh();
