package com.bytestack.onecore;

import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Replaces Capacitor's own Firebase messaging service. Android delivers each push
 * to only ONE service, so this one extends Capacitor's and hands every normal
 * notification straight back to it (announcements, leave, etc. keep working).
 *
 * The only message handled here is the silent "location_request" sent by the
 * request-child-location edge function.
 */
public class OneCoreMessagingService extends MessagingService {
    private static final String TAG = "OneCoreFCM";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        final Map<String, String> data = message.getData();

        if (!"location_request".equals(data.get("type"))) {
            super.onMessageReceived(message); // everything else: Capacitor's normal handling
            return;
        }

        final String requestId = data.get("request_id");
        final String deviceId = data.get("device_id");
        final String nonce = data.get("nonce");
        final String submitUrl = data.get("submit_url");

        try {
            Intent intent = new Intent(this, FindMyChildService.class);
            intent.putExtra("request_id", requestId);
            intent.putExtra("device_id", deviceId);
            intent.putExtra("nonce", nonce);
            intent.putExtra("submit_url", submitUrl);
            ContextCompat.startForegroundService(this, intent);
        } catch (Exception e) {
            // Android refused to start the service (restricted background start).
            // Tell the server right away so the parent sees "Unable to get current location".
            Log.e(TAG, "Could not start FindMyChildService", e);
            new Thread(() -> FindMyChildService.postFailure(requestId, deviceId, nonce, submitUrl, "error", this)).start();
        }
    }
}
