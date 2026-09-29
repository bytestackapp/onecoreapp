import { supabase } from "./supabase-client.js";
import { APP_VERSION, currentPlatform } from "./version.js";

const DIALOG_ID = "onecore-update-dialog";

/* ---------- Version comparison ---------- */

// Parses "v1.2.3", "1.2.3-beta.1", "1.2" into { nums: [1,2,3], pre: "beta.1" | "" }
function parseVersion(v) {
  const clean = String(v ?? "").trim().replace(/^v/i, "");
  const dash = clean.indexOf("-");
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? "" : clean.slice(dash + 1);
  const nums = core.split(".").map((p) => parseInt(p, 10) || 0);
  return { nums, pre };
}

// Returns -1, 0, or 1. A pre-release (1.2.3-beta) is lower than 1.2.3.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) < 0 ? -1 : 1;
}

/* ---------- Helpers ---------- */

function dismissedKey(version) {
  return `onecore_update_dismissed_${version}`;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function domReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

// Opens an external link. Prefers Capacitor's in-app browser, falls back to window.open.
async function openExternal(url) {
  try {
    const Browser = window.Capacitor?.Plugins?.Browser;
    if (Browser?.open) {
      await Browser.open({ url });
      return;
    }
  } catch (err) {
    console.warn("Capacitor Browser failed, falling back to window.open:", err);
  }
  window.open(url, "_blank", "noopener");
}

// Web update: clear service workers + caches, then reload with a cache-busting param
// so the browser fetches a fresh index.html (and therefore the new JS bundle).
async function hardReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn("Cache clear failed, reloading anyway:", err);
  }
  const url = new URL(window.location.href);
  url.searchParams.set("_v", String(Date.now()));
  window.location.replace(url.toString());
}

/* ---------- Dialog ---------- */

/* ---------- "What's new" modal ---------- */

const CHANGELOG_ID = "onecore-changelog-dialog";

// Opens on top of the update dialog. Closing it returns to the update dialog.
function showChangelogModal({ version, changelog }) {
  if (document.getElementById(CHANGELOG_ID)) return;

  const backdrop = document.createElement("div");
  backdrop.id = CHANGELOG_ID;
  backdrop.className = "dialog-backdrop";
  backdrop.style.zIndex = "10001"; // above the update dialog
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="chg-title">
      <h3 id="chg-title" style="margin-top:0;">What's new in ${escapeHtml(version)}</h3>
      <div class="text-muted" style="font-size:0.9rem;white-space:pre-wrap;max-height:50vh;overflow-y:auto;">${escapeHtml(changelog)}</div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close-changelog">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  backdrop.querySelector('[data-act="close-changelog"]').addEventListener("click", close);
  // Clicking the dimmed area outside the modal also closes it.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
}

/* ---------- Update dialog ---------- */

function showUpdateDialog({ latestVersion, minimumVersion, changelog, downloadUrl, forced }) {
  if (document.getElementById(DIALOG_ID)) return; // never stack dialogs

  const platform = currentPlatform();
  const isNative = platform !== "web";
  const hasValidUrl = isValidHttpUrl(downloadUrl);
  // On native there is nowhere to send them without a URL.
  const canUpdate = !isNative || hasValidUrl;

  const targetVersion = forced ? minimumVersion || latestVersion : latestVersion;
  const message = forced
    ? `App version no longer supported. Please update to continue.`
    : `A new app version is available.`;

  // If we just reloaded to update and we're still outdated, the browser is probably serving cached files.
  const justReloaded = !isNative && new URLSearchParams(window.location.search).has("_v");

  const backdrop = document.createElement("div");
  backdrop.id = DIALOG_ID;
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="upd-title">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <h3 id="upd-title" style="margin:0;">${forced ? "Update required" : "Update available"}</h3>
        ${
          changelog
            ? `<button type="button" data-act="info" aria-label="What's new" aria-haspopup="dialog" title="What's new"
                style="background:none;border:none;padding:4px;cursor:pointer;color:inherit;line-height:0;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>`
            : ""
        }
      </div>
      <p>${message}</p>
      ${justReloaded ? `<p class="text-muted" style="font-size:0.8rem;">Still seeing this after updating? Your browser may be using old cached files. Try closing this tab and opening the app again.</p>` : ""}
      ${!canUpdate ? `<p class="text-muted" style="font-size:0.85rem;">The download link isn't available right now. Please contact support.</p>` : ""}
      <div class="dialog-actions">
        ${forced ? "" : `<button type="button" class="btn btn-secondary" data-act="later">Later</button>`}
        ${canUpdate ? `<button type="button" class="btn btn-primary" data-act="update">Update</button>` : ""}
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();

  // Info icon opens the separate "What's new" modal.
  const infoBtn = backdrop.querySelector('[data-act="info"]');
  if (infoBtn) {
    infoBtn.addEventListener("click", () => showChangelogModal({ version: latestVersion, changelog }));
  }

  // Forced dialogs can't be dismissed by clicking the backdrop or pressing Escape.
  if (!forced) {
    backdrop.querySelector('[data-act="later"]').addEventListener("click", () => {
      try {
        sessionStorage.setItem(dismissedKey(latestVersion), "1");
      } catch {
        // storage disabled — will just ask again next load
      }
      close();
    });
  }

  const updateBtn = backdrop.querySelector('[data-act="update"]');
  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      if (isNative) {
        await openExternal(downloadUrl);
        updateBtn.disabled = false; // let them retry if the browser didn't open
      } else {
        updateBtn.textContent = "Updating…";
        await hardReload();
      }
    });
  }
}

/* ---------- Main check ---------- */

/** Call once per app load. Fire-and-forget — never blocks page render. */
export async function checkForUpdate() {
  try {
    await domReady();
    const platform = currentPlatform();

    // limit(1) instead of maybeSingle(): a duplicate row won't break the check.
    const { data: rows, error } = await supabase.from("app_versions").select("*").eq("platform", platform).limit(1);

    if (error) {
      console.warn("Version check: could not read app_versions:", error.message);
      return;
    }
    const data = rows?.[0];
    if (!data) {
      console.warn(`Version check: no app_versions row for platform "${platform}".`);
      return;
    }

    const payload = {
      latestVersion: data.latest_version,
      minimumVersion: data.minimum_version,
      changelog: data.changelog,
      downloadUrl: data.download_url,
    };

    // 1. Forced update
    if (data.minimum_version && compareVersions(APP_VERSION, data.minimum_version) < 0) {
      showUpdateDialog({ ...payload, forced: true });
      return;
    }

    // 2. Optional update
    if (!data.latest_version || compareVersions(APP_VERSION, data.latest_version) >= 0) return;

    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(dismissedKey(data.latest_version)) === "1";
    } catch {
      // storage unavailable — just show it
    }
    if (dismissed) return;

    showUpdateDialog({ ...payload, forced: false });
  } catch (err) {
    console.error("checkForUpdate failed:", err);
    // Never let a failed version check block the app.
  }
}
