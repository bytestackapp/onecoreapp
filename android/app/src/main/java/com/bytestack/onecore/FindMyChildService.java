package com.bytestack.onecore;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Started by OneCoreMessagingService for ONE "Find My Child" request.
 * Takes a single fresh location fix (never continuous tracking), posts it to the
 * submit-child-location edge function with the one-time code from the push, then
 * stops itself. While it runs, Android shows a small notification on the phone.
 */
public class FindMyChildService extends Service {
    private static final String TAG = "FindMyChild";
    private static final String CHANNEL_ID = "find_my_child";
    private static final int NOTIFICATION_ID = 4107;
    private static final long WATCHDOG_MS = 45_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private int activeJobs = 0; // touched on the main thread only

    /** One request. */
    private static final class Job {
        final String requestId, deviceId, nonce, url;
        final AtomicBoolean reported = new AtomicBoolean(false);

        Job(String requestId, String deviceId, String nonce, String url) {
            this.requestId = requestId;
            this.deviceId = deviceId;
            this.nonce = nonce;
            this.url = url;
        }

        static Job from(Intent i) {
            if (i == null) return null;
            String r = i.getStringExtra("request_id");
            String d = i.getStringExtra("device_id");
            String n = i.getStringExtra("nonce");
            String u = i.getStringExtra("submit_url");
            if (r == null || d == null || n == null || !isAllowedUrl(u)) return null;
            return new Job(r, d, n, u);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final Job job = Job.from(intent);

        // Android requires startForeground() within a few seconds of startForegroundService().
        final boolean foreground = startInForeground();

        if (job == null) {
            if (activeJobs == 0) finish();
            return START_NOT_STICKY;
        }

        activeJobs++;
        if (!foreground) {
            report(job, false, "permission", null);
            return START_NOT_STICKY;
        }

        // Never run longer than this, whatever happens.
        main.postDelayed(() -> report(job, false, "timeout", null), WATCHDOG_MS);
        capture(job);
        return START_NOT_STICKY;
    }

    private boolean startInForeground() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Find My Child", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Shown briefly while this phone shares its current location with a parent who asked for it.");
                nm.createNotificationChannel(channel);
            }
            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                    .setContentTitle("OneCore")
                    .setContentText("A parent asked for this phone's current location.")
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setOngoing(true)
                    .build();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Could not start in foreground", e);
            return false;
        }
    }

    private void capture(final Job job) {
        if (!granted(this, Manifest.permission.ACCESS_FINE_LOCATION) && !granted(this, Manifest.permission.ACCESS_COARSE_LOCATION)) {
            report(job, false, "permission", null);
            return;
        }
        final boolean fine = granted(this, Manifest.permission.ACCESS_FINE_LOCATION);
        try {
            FusedLocationProviderClient client = LocationServices.getFusedLocationProviderClient(this);
            CancellationTokenSource cancel = new CancellationTokenSource();
            CurrentLocationRequest request = new CurrentLocationRequest.Builder()
                    .setPriority(fine ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY)
                    .setMaxUpdateAgeMillis(0)      // always a new fix, never a cached one
                    .setDurationMillis(20_000)
                    .build();
            client.getCurrentLocation(request, cancel.getToken())
                    .addOnSuccessListener(location -> {
                        if (location == null) {
                            report(job, false, isLocationEnabled(this) ? "timeout" : "location_off", null);
                        } else {
                            report(job, true, null, location);
                        }
                    })
                    .addOnFailureListener(e -> {
                        Log.w(TAG, "getCurrentLocation failed", e);
                        report(job, false, e instanceof SecurityException ? "permission" : "error", null);
                    });
        } catch (SecurityException e) {
            report(job, false, "permission", null);
        } catch (Exception e) {
            Log.e(TAG, "capture failed", e);
            report(job, false, "error", null);
        }
    }

    /** Sends the outcome once (later calls for the same job are ignored), then winds down. */
    private void report(final Job job, final boolean ok, final String reason, final Location location) {
        if (!job.reported.compareAndSet(false, true)) return;
        final String permission = permissionState(this);

        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("requestId", job.requestId);
                body.put("deviceId", job.deviceId);
                body.put("nonce", job.nonce);
                body.put("ok", ok && location != null);
                body.put("permission", permission);
                if (ok && location != null) {
                    body.put("latitude", location.getLatitude());
                    body.put("longitude", location.getLongitude());
                    body.put("accuracy", location.getAccuracy());
                    // Age is measured on the phone, so a wrong phone clock cannot fake "current".
                    long ageMs = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L;
                    body.put("ageMs", Math.max(0L, ageMs));
                } else {
                    body.put("reason", reason == null ? "error" : reason);
                }
                if (!post(job.url, body)) {
                    Thread.sleep(2000);
                    post(job.url, body); // one retry
                }
            } catch (Exception e) {
                Log.w(TAG, "report failed", e);
            } finally {
                main.post(this::jobDone);
            }
        });
    }

    private void jobDone() {
        activeJobs--;
        if (activeJobs <= 0) finish();
    }

    private void finish() {
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        executor.shutdown();
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // Helpers shared with the messaging service and the Capacitor plugin
    // ------------------------------------------------------------------

    static boolean isAllowedUrl(String url) {
        return url != null && url.startsWith("https://") && url.endsWith("/functions/v1/submit-child-location");
    }

    static boolean granted(Context c, String permission) {
        return ContextCompat.checkSelfPermission(c, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** "always" | "while_in_use" | "denied" (same words the database stores). */
    static String permissionState(Context c) {
        boolean fine = granted(c, Manifest.permission.ACCESS_FINE_LOCATION);
        boolean coarse = granted(c, Manifest.permission.ACCESS_COARSE_LOCATION);
        if (!fine && !coarse) return "denied";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !granted(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            return "while_in_use";
        }
        return "always";
    }

    static boolean isLocationEnabled(Context c) {
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    /** POSTs JSON. Returns true when the server answered (even with an error code below 500). */
    static boolean post(String urlString, JSONObject body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(urlString).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            int code = connection.getResponseCode();
            return code < 500;
        } catch (Exception e) {
            Log.w(TAG, "post failed", e);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Used when the service itself could not start: tells the server "no answer possible". */
    static void postFailure(String requestId, String deviceId, String nonce, String url, String reason, Context c) {
        if (requestId == null || deviceId == null || nonce == null || !isAllowedUrl(url)) return;
        try {
            JSONObject body = new JSONObject();
            body.put("requestId", requestId);
            body.put("deviceId", deviceId);
            body.put("nonce", nonce);
            body.put("ok", false);
            body.put("reason", reason);
            body.put("permission", permissionState(c));
            post(url, body);
        } catch (Exception e) {
            Log.w(TAG, "postFailure failed", e);
        }
    }
}
