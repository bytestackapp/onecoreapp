// Runs first on every signed-in page (and the password pages), before anything is drawn.
//  1. Dark mode: applies the saved appearance so there is no white flash.
//  2. Academy colours: applies the last academy's brand colours the same way.
//  3. Loading screen: pages that load with  data-loader  get the OneCore loading screen straight away.
//     layout.js removes it when the page is ready.
// It lives here once instead of being copied into every page.
(function () {
  try {
    var t = localStorage.getItem("onecore:theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: normal light look */ }

  try {
    var b = JSON.parse(localStorage.getItem("onecore_saved_brand_last") || "null");
    if (b && b.css && !/<|url\(|@import/i.test(b.css)) {
      var s = document.createElement("style");
      s.id = "brand-theme";
      s.textContent = b.css;
      document.head.appendChild(s);
    }
  } catch (e) { /* no saved colours */ }

  var me = document.currentScript;
  if (!me || !me.hasAttribute("data-loader")) return;

  var LOADER = `<div id="page-loader" class="page-loader">
  <div class="page-loader-decor-top"></div>
  <svg class="page-loader-ring" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="loaderGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#2952e3" />
        <stop offset="100%" stop-color="#1fc6c6" />
      </linearGradient>
    </defs>
    <circle cx="25" cy="25" r="20" fill="none" stroke="url(#loaderGradient)" stroke-width="4" stroke-linecap="round" stroke-dasharray="90 40" />
  </svg>
  <div class="page-loader-text">LOADING&hellip;</div>
  <div class="page-loader-wave">
    <svg viewBox="0 0 1440 260" preserveAspectRatio="none" width="100%" height="150" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="loaderWaveGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#1f4fe0" />
          <stop offset="100%" stop-color="#22c9c9" />
        </linearGradient>
      </defs>
      <path d="M0,140 C240,40 420,220 720,120 C1000,30 1200,200 1440,90 L1440,260 L0,260 Z" fill="#cfe0ff" />
      <path d="M0,180 C260,100 460,240 760,150 C1040,70 1220,220 1440,140 L1440,260 L0,260 Z" fill="url(#loaderWaveGradient)" />
    </svg>
  </div>
</div>`;

  // The page body does not exist yet while this script runs in the head: add the loader the moment it appears.
  var insert = function () {
    if (!document.body) return false;
    document.body.insertAdjacentHTML("afterbegin", LOADER);
    return true;
  };
  if (!insert()) {
    var watch = new MutationObserver(function () { if (insert()) watch.disconnect(); });
    watch.observe(document.documentElement, { childList: true });
  }
})();
