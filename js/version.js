// Bump this on every release. This is the only place the number lives —
// the version-check widget compares this against `app_versions` in the
// database to decide whether to prompt the person to update.
export const APP_VERSION = "1.0.0";

/**
 * Returns "android", "ios", or "web".
 * Uses Capacitor.getPlatform() so iOS is no longer mislabeled as Android.
 */
export function currentPlatform() {
  try {
    const p = window.Capacitor?.getPlatform?.();
    if (p === "android" || p === "ios") return p;
  } catch {
    // fall through to web
  }
  return "web";
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;