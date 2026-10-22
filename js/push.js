// Push notification registration. Only does anything when running inside
// the native Capacitor shell — on the plain web version, window.Capacitor
// doesn't exist, so this silently no-ops.
//
// Uses window.Capacitor.Plugins.PushNotifications directly (rather than
// `import { PushNotifications } from "@capacitor/push-notifications"`) so
// no bundler is required — Capacitor's native runtime injects the plugin
// onto window.Capacitor.Plugins automatically once it's installed and
// `npx cap sync` has been run.

import { supabase } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { registerChildDevice } from "./find-my-child.js";

export async function initPushNotifications(profile) {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return; // plain web/PWA: nothing to do

  const { PushNotifications } = capacitor.Plugins || {};
  if (!PushNotifications) {
    console.warn("Push notifications: plugin missing. Run `npx cap sync android`, then rebuild the app.");
    return;
  }

  try {
    let permission = await PushNotifications.checkPermissions();

    // Android 13+ reports "prompt-with-rationale" after a first refusal. It has to be
    // asked again too — checking only for "prompt" left the phone silently unregistered.
    if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== "granted") return; // user declined — respect it, don't ask again this session

    PushNotifications.addListener("registration", async (token) => {
      try {
        // Moves this phone's token to whoever is signed in now (see register-push-token.sql).
        // The server is only told when the token is new or belongs to a different profile.
        const savedKey = `onecore_push_saved_${profile.id}`;
        if (localStorage.getItem(savedKey) !== token.value) {
          const { error } = await supabase.rpc("register_push_token", {
            p_token: token.value,
            p_platform: capacitor.getPlatform(), // "android" or "ios"
          });
          if (error) throw error;
          localStorage.setItem(savedKey, token.value);
        }
        if (profile.role === "student") registerChildDevice(token.value);
      } catch (err) {
        console.error("Failed to save push token:", err);
      }
    });

    PushNotifications.addListener("registrationError", (err) => {
      console.error("Push registration error:", err);
    });

    // A push that arrives while the app is open: tell the page, so it can refresh just what changed
    // (see the "onecore:push" listeners in the page scripts and in layout.js).
    PushNotifications.addListener("pushNotificationReceived", (n) => {
      const data = n.data || {};
      const forThisAcademy = !data.profile_id || data.profile_id === profile.id;
      // The notification list and bell only cover the academy I'm in, so tell her about the other one here.
      if (!forThisAcademy) showToast(n.title || "New notification in another academy", "info");
      window.dispatchEvent(
        new CustomEvent("onecore:push", {
          detail: {
            related_type: data.related_type || "",
            related_id: data.related_id || "",
            forThisAcademy,
          },
        })
      );
    });

    // Tapping a notification while the app is backgrounded/closed lands here.
    // A notification for one of my other academies opens the "Switch academy" picker (layout.js listens
    // for this event), where the academy with unread notifications is marked. Nothing switches by itself.
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const data = action.notification?.data || {};
      if (data.profile_id && data.profile_id !== profile.id) {
        window.dispatchEvent(new CustomEvent("onecore:open-academy-switcher"));
        return;
      }
      const relatedPage = {
        announcement: "announcements.html",
        event: "events.html",
        leave_request: "leave.html",
        attendance_correction: "attendance.html",
        signup: "admin-users.html",
		attendance: "attendance.html",
      }[data.related_type];
      if (relatedPage) window.location.href = relatedPage;
    });

    // Android 8+ needs the channel the server names ("default") to exist, otherwise
    // notifications land in a silent fallback channel with no pop-up.
    if (capacitor.getPlatform() === "android") {
      try {
        await PushNotifications.createChannel({
          id: "default",
          name: "OneCore notifications",
          description: "Leave, attendance, announcements, events and requests",
          importance: 5, // pop-up banner + sound
          visibility: 1,
          vibration: true,
        });
      } catch (err) {
        console.warn("Could not create notification channel:", err);
      }
    }

    // Ask Firebase for the phone's address once per app launch (and once per academy),
    // not on every page.
    const askedKey = `onecore_push_asked_${profile.id}`;
    if (!sessionStorage.getItem(askedKey)) {
      sessionStorage.setItem(askedKey, "1");
      await PushNotifications.register();
    }
  } catch (err) {
    console.error("initPushNotifications failed:", err);
  }
}
