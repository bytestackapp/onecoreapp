package com.bytestack.onecore;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.UUID;

/**
 * Bridge between the OneCore web app (JavaScript) and the Android permission /
 * settings screens needed for "Find My Child".
 * From JS: window.Capacitor.Plugins.FindMyChild.getStatus() etc.
 */
@CapacitorPlugin(
        name = "FindMyChild",
        permissions = {
                @Permission(alias = "location", strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }),
                @Permission(alias = "background", strings = {
                        Manifest.permission.ACCESS_BACKGROUND_LOCATION
                })
        }
)
public class FindMyChildPlugin extends Plugin {

    /** Stable random id for this installation (what the database calls install_id). */
    @PluginMethod
    public void getInstallId(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences("onecore_find_my_child", Context.MODE_PRIVATE);
        String id = prefs.getString("install_id", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString("install_id", id).apply();
        }
        JSObject result = new JSObject();
        result.put("installId", id);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    /** Step 1 of setup: the normal "While using the app" location prompt. */
    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (!"denied".equals(FindMyChildService.permissionState(getContext()))) {
            call.resolve(buildStatus());
            return;
        }
        requestPermissionForAlias("location", call, "locationResult");
    }

    @PermissionCallback
    private void locationResult(PluginCall call) {
        call.resolve(buildStatus());
    }

    /**
     * Step 2 of setup: "Allow all the time". Android only allows this AFTER step 1,
     * and on Android 11+ it sends the person to the app's location settings page.
     * The web app re-checks getStatus() when it comes back into view.
     */
    @PluginMethod
    public void requestBackground(PluginCall call) {
        String state = FindMyChildService.permissionState(getContext());
        if ("denied".equals(state)) {
            call.reject("Allow location access first.");
            return;
        }
        if ("always".equals(state) || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(buildStatus());
            return;
        }
        requestPermissionForAlias("background", call, "backgroundResult");
    }

    @PermissionCallback
    private void backgroundResult(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings.");
        }
    }

    /** Opens Android's battery-optimization list (no special permission needed). */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open battery settings.");
        }
    }

    private JSObject buildStatus() {
        Context c = getContext();
        String permission = FindMyChildService.permissionState(c);
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);

        JSObject status = new JSObject();
        status.put("permission", permission); // "always" | "while_in_use" | "denied"
        status.put("locationGranted", !"denied".equals(permission));
        status.put("backgroundGranted", "always".equals(permission));
        status.put("locationServicesOn", FindMyChildService.isLocationEnabled(c));
        status.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        status.put("sdk", Build.VERSION.SDK_INT);
        return status;
    }
}
