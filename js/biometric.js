// =====================================================================
// Fingerprint / face unlock for the Android app.
//
// How it works: the person stays signed in as before (the session is kept on the phone). When they turn
// this on in Profile, every time the app is opened (or comes back after a couple of minutes away) it
// shows a lock screen and asks the phone to confirm it is the owner. The phone itself does the matching;
// no fingerprint or face data ever reaches this app or the server. "Sign out" is always on the lock screen.
//
// Uses window.Capacitor.Plugins.NativeBiometric directly (like push.js) so no bundler is needed. It does
// nothing on the plain web/PWA version, where there is no such plugin.
//
// This file imports nothing at load time (supabase-client.js imports it), so there is no import cycle.
// =====================================================================

const ENABLED_KEY = "onecore_biometric_user"; // localStorage: id of the login that turned it on, on this phone
const UNLOCKED_KEY = "onecore_unlocked";      // sessionStorage: this app launch already passed the check
const LEFT_KEY = "onecore_left_at";           // localStorage: when the app last went to the background
const NAME_KEY = "onecore_biometric_name";    // localStorage: the person's name, shown on the lock screen
const RELOCK_AFTER_MS = 2 * 60 * 1000;        // lock again after this long in the background

// Plugin error codes (BiometricAuthError in @capgo/capacitor-native-biometric)
const ERR = { LOCKOUT: 2, TEMP_LOCKOUT: 4, FAILED: 10, USER_CANCEL: 16 };

function plugin() {
  const c = window.Capacitor;
  if (!c?.isNativePlatform?.()) return null;
  return c.Plugins?.NativeBiometric || null;
}

const store = {
  get: (area, key) => { try { return window[area].getItem(key); } catch { return null; } },
  set: (area, key, v) => { try { window[area].setItem(key, v); } catch { /* ignore */ } },
  del: (area, key) => { try { window[area].removeItem(key); } catch { /* ignore */ } },
};

/** True when this phone can check a fingerprint or face right now (and we are inside the Android app). */
export async function biometricSupported() {
  const p = plugin();
  if (!p) return false;
  try {
    const r = await p.isAvailable({ useFallback: false });
    return r?.isAvailable === true;
  } catch {
    return false;
  }
}

export function biometricEnabledFor(userId) {
  return !!userId && store.get("localStorage", ENABLED_KEY) === userId;
}

/** Asks the phone to confirm the owner. Resolves { ok: true } or { ok: false, code, message }. */
async function verify(reason) {
  const p = plugin();
  if (!p) return { ok: false, code: -1, message: "Not available on this device." };
  try {
    await p.verifyIdentity({
      reason,
      title: "Unlock OneCore",
      subtitle: "Confirm it's you",
      negativeButtonText: "Cancel",
      maxAttempts: 3,
    });
    return { ok: true };
  } catch (err) {
    const code = Number(err?.code);
    let message = "Couldn't verify. Please try again.";
    if (code === ERR.USER_CANCEL) message = "Cancelled.";
    else if (code === ERR.LOCKOUT || code === ERR.TEMP_LOCKOUT) message = "Too many attempts. Wait a moment and try again, or sign out and use your password.";
    return { ok: false, code, message };
  }
}

/** Turn it on for this login. The phone is asked first, so it is proven to work before anything is saved. */
export async function enableBiometric(userId, fullName = "") {
  if (!userId) return { ok: false, message: "Please sign in again." };
  if (!(await biometricSupported())) {
    return { ok: false, message: "Set up a fingerprint or face unlock in your phone's settings first." };
  }
  const r = await verify("Turn on fingerprint / face unlock");
  if (!r.ok) return r;
  store.set("localStorage", ENABLED_KEY, userId);
  rememberBiometricName(userId, fullName);
  store.set("sessionStorage", UNLOCKED_KEY, "1"); // just confirmed: no second prompt on this launch
  return { ok: true };
}

/** Keeps the name on the lock screen up to date (only does anything while unlock is on for this login). */
export function rememberBiometricName(userId, fullName) {
  if (fullName && biometricEnabledFor(userId)) store.set("localStorage", NAME_KEY, String(fullName));
}

export function disableBiometric() {
  store.del("localStorage", NAME_KEY);
  store.del("localStorage", ENABLED_KEY);
  store.del("sessionStorage", UNLOCKED_KEY);
  store.del("localStorage", LEFT_KEY);
}

/** Signing out (or an expired session) always removes the setting, so the next sign-in is by password. */
export const forgetBiometric = disableBiometric;

// ---------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------

let liveUserId = null;
let liveEmail = "";
let lockPromise = null;

function injectStyle() {
  if (document.getElementById("bio-lock-style")) return;
  const s = document.createElement("style");
  s.id = "bio-lock-style";
  s.textContent = `
  #bio-lock{position:fixed;inset:0;z-index:10001;background:var(--bg,#f8fafc);color:var(--text,#1e293b);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;animation:bioIn .2s ease-out;}
  #bio-lock .bio-icon{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--card,#fff);border:1px solid var(--border,#e2e8f0);color:var(--primary,#4f46e5);}
  #bio-lock .bio-icon svg{width:38px;height:38px;}
  #bio-lock h2{margin:8px 0 0;}
  #bio-lock p{margin:0;max-width:300px;color:var(--text-secondary,#64748b);min-height:1.4em;}
  #bio-lock .bio-who{margin:2px 0 4px;color:var(--text-secondary,#64748b);font-size:.92rem;overflow-wrap:anywhere;}
  #bio-lock .bio-who strong{display:block;color:var(--text,#1e293b);font-size:1.05rem;}
  #bio-lock .bio-who span{display:block;font-size:.85rem;}
  #bio-lock .bio-actions{display:flex;flex-direction:column;gap:8px;width:100%;max-width:260px;margin-top:8px;}
  @keyframes bioIn{from{opacity:0}to{opacity:1}}
  @media (prefers-reduced-motion:reduce){#bio-lock{animation:none}}`;
  document.head.appendChild(s);
}

function showLock() {
  if (lockPromise) return lockPromise;
  const email = liveEmail;
  lockPromise = new Promise((resolve) => {
    injectStyle();
    const el = document.createElement("div");
    el.id = "bio-lock";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "OneCore is locked");
    el.innerHTML = `
      <div class="bio-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11c0 3-.5 5.5-2 8M8.5 8.5A4.5 4.5 0 0116.5 11c0 1.6-.1 3-.5 4.5M5 11a7 7 0 0112-5M19 11c0 2.5-.3 4.5-1 6.5M12 11v.01"/></svg></div>
      <h2>OneCore is locked</h2>
      <div class="bio-who" id="bio-who" hidden>Logging in as <strong id="bio-name"></strong><span id="bio-email"></span></div>
      <p id="bio-msg">Confirm it's you to continue.</p>
      <div class="bio-actions">
        <button type="button" class="btn btn-primary" id="bio-unlock">Unlock</button>
        <button type="button" class="btn btn-secondary" id="bio-signout">Sign out</button>
      </div>`;
    document.body.appendChild(el);

    // Who is signed in: the saved name, and the login email underneath (set with textContent, never as HTML).
    const name = store.get("localStorage", NAME_KEY) || "";
    if (name || email) {
      el.querySelector("#bio-name").textContent = name || email;
      el.querySelector("#bio-email").textContent = name ? email : "";
      el.querySelector("#bio-who").hidden = false;
    }

    const msg = el.querySelector("#bio-msg");
    const unlockBtn = el.querySelector("#bio-unlock");

    async function attempt() {
      unlockBtn.disabled = true;
      const r = await verify("Unlock OneCore");
      if (r.ok) {
        store.set("sessionStorage", UNLOCKED_KEY, "1");
        store.del("localStorage", LEFT_KEY);
        el.remove();
        lockPromise = null;
        resolve();
        return;
      }
      msg.textContent = r.code === ERR.USER_CANCEL ? "Tap Unlock to try again." : r.message;
      unlockBtn.disabled = false;
    }

    unlockBtn.addEventListener("click", attempt);
    el.querySelector("#bio-signout").addEventListener("click", async () => {
      const { signOut } = await import("./supabase-client.js");
      signOut();
    });
    attempt(); // ask straight away; the buttons are there if it is cancelled
  });
  return lockPromise;
}

function isUnlocked() {
  return store.get("sessionStorage", UNLOCKED_KEY) === "1";
}

// Came back after a while away: ask again.
function relockIfAway() {
  const left = Number(store.get("localStorage", LEFT_KEY) || 0);
  store.del("localStorage", LEFT_KEY);
  if (!left || Date.now() - left <= RELOCK_AFTER_MS) return;
  store.del("sessionStorage", UNLOCKED_KEY);
  if (liveUserId && biometricEnabledFor(liveUserId)) showLock();
}

document.addEventListener("visibilitychange", () => {
  if (!plugin()) return;
  if (document.visibilityState === "hidden") store.set("localStorage", LEFT_KEY, String(Date.now()));
  else relockIfAway();
});
if (plugin()) relockIfAway(); // a page that loads after a long time away (checked before the first guard)

/**
 * Call once the signed-in user is known and before showing anything private. Resolves straight away when
 * fingerprint/face unlock is off or already passed on this launch; otherwise it waits behind the lock screen.
 */
export async function ensureUnlocked(userId, email = "") {
  liveUserId = userId || null;
  liveEmail = email || "";
  if (!plugin() || !biometricEnabledFor(userId) || isUnlocked()) return;
  // The phone can no longer do it (fingerprints removed...): drop the setting rather than lock the person out.
  if (!(await biometricSupported())) {
    disableBiometric();
    return;
  }
  await showLock();
}
