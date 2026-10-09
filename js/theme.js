// Appearance preference: "default" (the normal light look) or "dark".
// Saved on this device only (localStorage), so it stays after the app is closed
// and there are no database calls. It changes only when the person switches it.
// Applied as <html data-theme="dark">; with no attribute the page is light.
// The device's own dark-mode setting is ignored on purpose.
// A page can opt out by putting data-theme-lock on <html> (the print pages do this).

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

export function applyTheme(pref = getThemePref()) {
  if (root.hasAttribute("data-theme-lock")) return;
  if (pref === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  syncMetaColor();
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
