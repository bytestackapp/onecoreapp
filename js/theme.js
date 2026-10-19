// Appearance preference: "default" (the normal light look) or "dark".
// Saved on this device only (localStorage), so it stays after the app is closed
// and there are no database calls. It changes only when the person switches it.
// Applied as <html data-theme="dark">; with no attribute the page is light.
// The device's own dark-mode setting is ignored on purpose.
// A page can opt out by putting data-theme-lock on <html> (the print pages do this).
//
// Logos: while Dark Mode is on, any <img> that uses images/logo.png, logo-horiz.png or
// logo-vert.png is switched to logo-dark.png, logo-horiz-dark.png or logo-vert-dark.png
// (same folder). Back in Light it returns to the original. If a dark file is missing,
// the normal logo is shown instead of a broken image.

const KEY = "onecore:theme";
export const THEME_LABELS = { default: "Light", dark: "Dark" };
const root = document.documentElement;

export function getThemePref() {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "default"; // anything else (e.g. an old "light") = default
  } catch {
    return "default"; // storage blocked
  }
}

// Keeps the browser / app chrome colour in step with the page
function syncMetaColor() {
  const card = getComputedStyle(root).getPropertyValue("--card").trim();
  if (!card) return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = card;
}

// Android app: match the status bar icons (clock, battery) to the theme
function syncStatusBar() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const SB = cap.Plugins && cap.Plugins.StatusBar;
  if (!SB) return;
  const dark = root.getAttribute("data-theme") === "dark";
  const card = getComputedStyle(root).getPropertyValue("--card").trim();
  // DARK = light icons (for dark backgrounds), LIGHT = dark icons (for light backgrounds)
  SB.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
  if (card) SB.setBackgroundColor({ color: card }).catch(() => {});
}

// ---------- logos ----------
const LOGO_RE = /(^|\/)(logo|logo-horiz|logo-vert)\.png(?=$|[?#])/;

function syncLogos(scope = document) {
  const dark = root.getAttribute("data-theme") === "dark";
  const imgs = scope.nodeType === 1 && scope.tagName === "IMG" ? [scope] : scope.querySelectorAll ? scope.querySelectorAll("img") : [];
  imgs.forEach((img) => {
    const light = img.getAttribute("data-logo-light");
    if (dark) {
      if (light || img.hasAttribute("data-logo-failed")) return;
      const src = img.getAttribute("src") || "";
      if (!LOGO_RE.test(src)) return;
      img.setAttribute("data-logo-light", src);
      img.addEventListener(
        "error",
        () => {
          // the dark file is missing: go back to the normal logo and don't try again
          const original = img.getAttribute("data-logo-light");
          if (!original) return;
          img.setAttribute("data-logo-failed", "");
          img.removeAttribute("data-logo-light");
          img.setAttribute("src", original);
        },
        { once: true }
      );
      img.setAttribute("src", src.replace(LOGO_RE, "$1$2-dark.png"));
    } else if (light) {
      img.setAttribute("src", light);
      img.removeAttribute("data-logo-light");
    }
  });
}

export function applyTheme(pref = getThemePref()) {
  if (root.hasAttribute("data-theme-lock")) return;
  if (pref === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  syncMetaColor();
  syncStatusBar();
  syncLogos();
}

export function setThemePref(pref) {
  try {
    if (pref === "dark") localStorage.setItem(KEY, "dark");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the choice lasts until the page is closed */
  }
  applyTheme(pref);
}

applyTheme();

// Logos added later (the sidebar and login screen are built by script) get switched too
if (!root.hasAttribute("data-theme-lock")) {
  new MutationObserver((mutations) => {
    if (root.getAttribute("data-theme") !== "dark") return;
    // only the parts of the page that were just added, not the whole page every time
    for (const m of mutations) m.addedNodes.forEach((n) => { if (n.nodeType === 1) syncLogos(n); });
  }).observe(root, { childList: true, subtree: true });
}
