// Push notification registration. Only does anything when running inside
// the native Capacitor shell — on the plain web version, window.Capacitor
// doesn't exist, so this silently no-ops.
//
// Uses window.Capacitor.Plugins.PushNotifications directly (rather than
// `import { PushNotifications } from "@capacitor/push-notifications"`) so
// no bundler is required — Capacitor's native runtime injects the plugin
// onto window.Capacitor.Plugins automatically once it's installed and
// `npx cap sync` has been run. See PUSH-NOTIFICATIONS.md.

import { supabase } from "./supabase-client.js";

export async function initPushNotifications(profile) {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return; // plain web/PWA: nothing to do

  const { PushNotifications } = capacitor.Plugins || {};
  if (!PushNotifications) {
    console.warn("PushNotifications plugin not found — did you run `npx cap sync` after installing it?");
    return;
  }

  try {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt") {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== "granted") return; // user declined — respect it, don't ask again this session

    PushNotifications.addListener("registration", async (token) => {
      try {
        await supabase.from("device_push_tokens").upsert(
          {
            profile_id: profile.id,
            token: token.value,
            platform: capacitor.getPlatform(), // "android" or "ios"
            updated_at: new Date().toISOString(),
          },
          { onConflict: "token" }
        );
      } catch (err) {
        console.error("Failed to save push token:", err);
      }
    });

    PushNotifications.addListener("registrationError", (err) => {
      console.error("Push registration error:", err);
    });

    // Tapping a notification while the app is backgrounded/closed lands
    // here — route to the relevant page the same way notifications.html does.
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const relatedType = action.notification?.data?.related_type;
      const relatedPage = { announcement: "announcements.html", event: "events.html", leave_request: "leave.html", attendance_correction: "attendance.html" }[relatedType];
      if (relatedPage) window.location.href = relatedPage;
    });

    await PushNotifications.register();
  } catch (err) {
    console.error("initPushNotifications failed:", err);
  }
}
