// Central place for product name/tagline/logo AND per-client (academy) branding.
//
// How it works
//   - Before login (splash, login page): the brand is looked up from the web
//     address (school.onecore.app, a custom domain, or ?school=slug) through
//     the public get_public_brand() function, and remembered on the device
//     so the next visit paints instantly.
//   - After login (layout.js): the brand comes from the signed-in academy's
//     organizations row, so switching academy switches the brand.
//   - No brand set -> the normal OneCore look, exactly as before.

import { supabase } from "./supabase-client.js";

export const APP_NAME = "OneCore";
export const APP_TAGLINE = "One Core. Everything Connected.";

// Abstract mark: three connected nodes suggesting a network / organization,
// deliberately not education-specific (no cap, no book) since OneCore also
// targets companies, clubs, and associations.
export const LOGO_MARK = `
<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M7 23V9.5L21 22V8" stroke="#4F46E5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="7" cy="23" r="2.6" fill="#4F46E5"/>
  <circle cx="7" cy="9.5" r="2.6" fill="#4F46E5"/>
  <circle cx="21" cy="22" r="2.6" fill="#0D9488"/>
  <circle cx="21" cy="8" r="2.6" fill="#0D9488"/>
</svg>`;

export const DEFAULT_BRAND = {
  custom: false,
  name: APP_NAME,
  tagline: APP_TAGLINE,
  color: null,
  logoHoriz: null,
  logoVert: null,
};

// ---------------------------------------------------------------------
// Turning a database row into a brand
// ---------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

/** Accepts an organizations row (from the profile) or a get_public_brand() row. */
export function brandFromOrg(org) {
  if (!org) return DEFAULT_BRAND;
  const color = HEX.test(org.primary_color || "") ? org.primary_color : null;
  const logoHoriz = safeUrl(org.logo_horiz_url);
  const logoVert = safeUrl(org.logo_vert_url);
  const brandName = (org.brand_name || "").trim();
  // An academy with nothing configured keeps the normal OneCore look.
  if (!brandName && !color && !logoHoriz && !logoVert) return DEFAULT_BRAND;
  return {
    custom: true,
    name: brandName || org.name || APP_NAME,
    tagline: (org.tagline || "").trim() || null,
    color,
    logoHoriz,
    logoVert,
  };
}

/**
 * Picks the logo to show. "horiz" = sidebar, "vert" = login/splash.
 * OneCore brand -> the bundled default image. Custom brand with no logo
 * uploaded -> null (callers show the brand name as text instead).
 */
export function brandLogo(brand, kind, defaultSrc) {
  if (!brand.custom) return defaultSrc;
  return (kind === "horiz" ? brand.logoHoriz || brand.logoVert : brand.logoVert || brand.logoHoriz) || null;
}

// ---------------------------------------------------------------------
// Colors: one client color -> the whole set of --primary tokens
// ---------------------------------------------------------------------

const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (rgb, target, t) => rgb.map((v, i) => v + (target[i] - v) * t);
const luminance = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

function brandCss(color) {
  let base = toRgb(color);
  // Buttons carry white text: if the client's color is too light, darken it until it is readable.
  while (luminance(base) > 0.28) base = mix(base, [0, 0, 0], 0.15);
  const solid = toHex(base);
  const hover = toHex(mix(base, [0, 0, 0], 0.15));
  const [r, g, b] = base.map(Math.round);
  const lightText = toHex(mix(base, [255, 255, 255], 0.45)); // readable on dark backgrounds
  const lightHover = toHex(mix(base, [255, 255, 255], 0.65));
  const tint = (t) => toHex(mix(base, [255, 255, 255], t));
  // Colors for the splash screen (wave, bar, corner circle), all from the same primary color.
  const splash = `--splash-a:${solid};--splash-b:${tint(0.45)};--splash-soft:${tint(0.8)};--splash-decor-a:${tint(0.78)};--splash-decor-b:${tint(0.9)};--splash-track:rgba(${r},${g},${b},.15);--loader-decor-a:${tint(0.78)};--loader-decor-b:${tint(0.9)};--loader-wave:${tint(0.8)}`;
  const dk = (t) => toHex(mix(base, [11, 18, 32], t)); // tints for the dark loading screen
  const darkLoader = `--loader-decor-a:${dk(0.72)};--loader-decor-b:${dk(0.84)};--loader-wave:${dk(0.8)};--loader-wave-a:${dk(0.35)};--loader-wave-b:${dk(0.6)}`;
  return `
:root{${splash};--primary:${solid};--primary-hover:${hover};--primary-light:rgba(${r},${g},${b},.1);--primary-solid:${solid};--primary-solid-hover:${hover}}
:root[data-theme="dark"]{${darkLoader};--primary:${lightText};--primary-hover:${lightHover};--primary-light:rgba(${r},${g},${b},.22);--primary-solid:${solid};--primary-solid-hover:${toHex(mix(base, [255, 255, 255], 0.2))}}`;
}

// ---------------------------------------------------------------------
// Applying a brand to the current page
// ---------------------------------------------------------------------

let currentBrand = DEFAULT_BRAND;

// Injects (or removes) the color overrides: buttons/links, splash and the page loading screen.
function setBrandStyle(color) {
  let style = document.getElementById("brand-theme");
  if (color) {
    if (!style) {
      style = document.createElement("style");
      style.id = "brand-theme";
    }
    style.textContent = brandCss(color);
    document.head.appendChild(style); // last in <head>, so it wins over global.css
  } else if (style) {
    style.remove();
  }
}

// The signed-in pages show a loading screen BEFORE the academy is known, so the last academy
// color is also kept in LAST_KEY (wiped on sign-out with the other saved data).
const LAST_KEY = "onecore_saved_brand_last";

// The last academy this DEVICE was used in. It deliberately survives sign-out, so the splash and
// login page of the installed app show that academy. Platform owners never leave anything here.
const DEVICE_KEY = "onecore_device_brand";

/** Saves the academy the person is working in as the device's brand (or clears it if that academy has no brand). */
export function rememberBrand(brand) {
  try {
    if (brand?.custom) {
      // The ready-made CSS is saved too, so tiny inline scripts in each page's <head> can color the page before its first paint.
      const css = brand.color ? brandCss(brand.color) : null;
      localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...brand, css }));
      if (css) localStorage.setItem(LAST_KEY, JSON.stringify({ color: brand.color, css }));
      else localStorage.removeItem(LAST_KEY);
    } else {
      forgetBrand();
    }
  } catch {
    // storage blocked: the splash just stays OneCore
  }
}

/** Forgets the device's brand: splash and login go back to OneCore. Used for platform owners. */
export function forgetBrand() {
  try {
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem(LAST_KEY);
  } catch {
    // ignore
  }
}

export function applyRememberedBrand() {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
    if (last && HEX.test(last.color || "")) setBrandStyle(last.color);
  } catch {
    // ignore
  }
}
export const getBrand = () => currentBrand;

/**
 * Sets the colors and fills any element marked with:
 *   data-brand-name     -> the brand name
 *   data-brand-tagline  -> the tagline (left alone if the brand has none)
 */
export function applyBrand(brand = DEFAULT_BRAND) {
  currentBrand = brand;
  setBrandStyle(brand.color);

  document.querySelectorAll("[data-brand-name]").forEach((el) => (el.textContent = brand.name));
  if (brand.tagline) document.querySelectorAll("[data-brand-tagline]").forEach((el) => (el.textContent = brand.tagline));
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", brand.name);
}

// ---------------------------------------------------------------------
// Before login: find the brand from the web address
// ---------------------------------------------------------------------

const CACHE_PREFIX = "onecore_brand_v1:";
const OVERRIDE_KEY = "onecore_school_override";

// Which client is this? school.onecore.app -> "school"; a custom domain matches as a whole;
// "?school=slug" works anywhere (handy for testing on localhost or Vercel preview links).
function resolveTenant() {
  const host = location.hostname.toLowerCase();
  let slug = null;
  try {
    const q = new URLSearchParams(location.search).get("school");
    if (q) sessionStorage.setItem(OVERRIDE_KEY, q.trim().toLowerCase());
    slug = sessionStorage.getItem(OVERRIDE_KEY);
  } catch {
    // storage blocked: the address alone decides
  }
  const labels = host.split(".");
  if (!slug && labels.length >= 3 && labels[0] !== "www") slug = labels[0];
  if (slug && !/^[a-z0-9-]{2,40}$/.test(slug)) slug = null;
  return { host, slug, key: CACHE_PREFIX + host + "|" + (slug || "") };
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

/**
 * The brand to show right now without waiting for the network:
 *   1. the school this web address belongs to (school.onecore.app, custom domain, ?school=), else
 *   2. the academy this device was last used in (installed app: there is no school in the address), else
 *   3. OneCore.
 * Returns null only if nothing has ever been saved (very first visit).
 */
export function getCachedBrand() {
  const addr = readJson(resolveTenant().key);
  if (addr && addr.matched) return { ...DEFAULT_BRAND, ...addr };
  const device = readJson(DEVICE_KEY);
  if (device) return { ...DEFAULT_BRAND, ...device };
  return addr ? { ...DEFAULT_BRAND } : null;
}

/** Asks the server which brand belongs to this address. Never throws; falls back to the saved/default brand. */
export async function loadPublicBrand() {
  const { host, slug, key } = resolveTenant();
  try {
    const call = supabase.rpc("get_public_brand", { p_host: host, p_slug: slug });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("brand lookup timed out")), 3000));
    const { data, error } = await Promise.race([call, timeout]);
    if (error) throw error;
    const row = data?.[0];
    try {
      // "matched" tells the inline <head> scripts whether this address is a school (use its CSS) or not (use the device's).
      const brand = brandFromOrg(row);
      localStorage.setItem(key, JSON.stringify({ ...brand, matched: !!row, css: row && brand.color ? brandCss(brand.color) : null }));
    } catch {
      // storage full or blocked: fine
    }
    if (row) return brandFromOrg(row);
    // No school in this address (the installed app opens one plain address): use the academy this device used last.
    const device = readJson(DEVICE_KEY);
    return device ? { ...DEFAULT_BRAND, ...device } : DEFAULT_BRAND;
  } catch (err) {
    console.warn("loadPublicBrand:", err);
    return getCachedBrand() || DEFAULT_BRAND;
  }
}
