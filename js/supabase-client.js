// =====================================================================
// Supabase client + shared helpers.
// Loaded as a plain <script type="module"> on every page.
//
// IMPORTANT: the Supabase "anon" public key is SAFE to ship in frontend
// code — it's designed for that, and Row Level Security (see
// supabase/schema.sql) is what actually protects your data. Never put
// your service_role key in any file that reaches the browser.
//
// The actual URL/key values live in ./env-config.js, which is generated
// at build time from Vercel Environment Variables (see
// scripts/generate-env.js and the README) so they aren't hardcoded here
// or committed to Git. For local development, copy env-config.example.js
// to env-config.js and fill in your own project's values.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./env-config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------------------------------------------------------------------
// Session / profile helpers
// ---------------------------------------------------------------------

let cachedProfile = null;

/** Returns the current auth user, or null if signed out. */
export async function getSessionUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error("getSessionUser error:", error);
    return null;
  }
  return data.session?.user ?? null;
}

/**
 * Loads (and caches) the app-level profile row for the signed-in user,
 * which carries role/organization_id — the two things every page needs
 * to decide what to show.
 */
function activeProfileIdFromToken(session) {
  try {
    const payload = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).active_profile_id || null;
  } catch {
    return null;
  }
}

export async function getCurrentProfile({ force = false } = {}) {
  if (cachedProfile && !force) return cachedProfile;

  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) return null;

  const profileId = activeProfileIdFromToken(session) || session.user.id;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, organization_id, full_name, email, avatar_url, phone, role, is_active, is_approved, auth_user_id, guest_until, created_at, updated_at, organizations(name, logo_url)")
    .eq("id", profileId)
    .single();

  if (error) {
    console.error("getCurrentProfile error:", error);
    return null;
  }

  cachedProfile = data;
  return data;
}

export function clearProfileCache() {
  cachedProfile = null;
  cachedIsOwner = null;
}

let cachedIsOwner = null;

/** True if the signed-in login is a platform owner (see platform_owners table). Cached. */
export async function isPlatformOwner() {
  if (cachedIsOwner !== null) return cachedIsOwner;
  try {
    const { data, error } = await supabase.rpc("is_owner");
    if (error) throw error;
    cachedIsOwner = data === true;
  } catch (err) {
    console.error("isPlatformOwner error:", err);
    cachedIsOwner = false;
  }
  return cachedIsOwner;
}

/**
 * Guard for every authenticated page. Redirects to login if there's no
 * session, and to the account-setup notice if the profile row hasn't
 * been created yet. Call this first, before rendering the layout.
 */
/** All of the signed-in login's profiles (one per academy), with unread counts. */
export async function myAcademies() {
  const { data, error } = await supabase.rpc("my_academies");
  if (error) {
    console.error("myAcademies error:", error);
    return [];
  }
  return data || [];
}

/** Can this academy profile be signed in to right now? */
export function isUsableAcademy(a) {
  if (a.is_active === false) return false;
  if (a.role === "guest" && a.guest_until && a.guest_until < new Date().toLocaleDateString("en-CA")) return false;
  return true;
}

/** Makes profileId the active academy and refreshes the token. Throws on failure. */
export async function switchToProfile(profileId) {
  const { error } = await supabase.rpc("switch_academy", { p_profile_id: profileId });
  if (error) throw error;
  const { error: rErr } = await supabase.auth.refreshSession();
  if (rErr) throw rErr;
  clearProfileCache();
}

// If the active academy became unusable (deactivated, guest expired…) but the
// person has another academy they can use, move them there instead of signing out.
async function tryFallbackAcademy(currentId) {
  try {
    const list = await myAcademies();
    const other = list.find((a) => a.profile_id !== currentId && isUsableAcademy(a));
    if (!other) return false;
    await switchToProfile(other.profile_id);
    window.location.href = "dashboard.html";
    return true;
  } catch (err) {
    console.error("tryFallbackAcademy error:", err);
    return false;
  }
}

export async function requireAuth() {
  const user = await getSessionUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  const profile = await getCurrentProfile();
  if (!profile || !profile.organization_id) {
    if (await tryFallbackAcademy(profile?.id ?? null)) return null;
    // Signed in with Supabase Auth, but no matching (or unassigned)
    // profiles row yet. This normally means an admin still needs to
    // finish setting the account up — see README.md.
    await supabase.auth.signOut();
    window.location.href = "login.html?setup=1";
    return null;
  }
  if (profile.is_active === false) {
    if (await tryFallbackAcademy(profile.id)) return null;
    await supabase.auth.signOut();
    window.location.href = profile.is_approved
      ? "login.html?deactivated=1"
      : "login.html?pending=1";
    return null;
  }
  // Guests can have an end date; after it passes they're treated as deactivated.
  if (profile.role === "guest" && profile.guest_until && profile.guest_until < new Date().toLocaleDateString("en-CA")) {
    if (await tryFallbackAcademy(profile.id)) return null;
    await supabase.auth.signOut();
    window.location.href = "login.html?deactivated=1";
    return null;
  }
  return profile;
}

export async function signOut() {
  await supabase.auth.signOut();
  clearProfileCache();
  window.location.href = "login.html";
}

// ---------------------------------------------------------------------
// Small shared utilities used across pages
// ---------------------------------------------------------------------

export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + (dateStr.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const steps = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.34524, "w"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let value = seconds;
  for (const [div, unit] of steps) {
    if (value < div) return `${Math.max(1, Math.floor(value))}${unit} ago`;
    value /= div;
  }
  return "";
}

export function priorityLabel(priority) {
  return (
    {
      normal: "Normal",
      important: "Important",
      action_required: "Action required",
      urgent: "Urgent",
    }[priority] || priority
  );
}

/** Logs an admin/system action to audit_logs. Never throws. */
export async function logAudit({ action, recordType, recordId, details }) {
  try {
    const profile = await getCurrentProfile();
    if (!profile) return;
    await supabase.from("audit_logs").insert({
      organization_id: profile.organization_id,
      actor_id: profile.id,
      action,
      record_type: recordType ?? null,
      record_id: recordId ?? null,
      details: details ?? null,
    });
  } catch (err) {
    console.error("logAudit failed:", err);
  }
}

/** Shows a plain-language error instead of a raw JS/Postgres error. */
export function friendlyError(error, fallback = "Something went wrong. Please try again.") {
  if (!error) return fallback;
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("jwt") || msg.includes("session")) {
    return "Your session has expired. Please sign in again.";
  }
  if (msg.includes("permission") || msg.includes("row-level security")) {
    return "You don't have permission to do that.";
  }
  if (msg.includes("network")) {
    return "Network error. Check your connection and try again.";
  }
  return fallback;
}
