// =====================================================================
// Shared layout. Each page keeps only its own unique content inside a
// <div id="page-content"> and calls mountLayout({...}) — the sidebar,
// topbar and mobile bottom nav are built once, here, so they never need
// to be copy-pasted across pages. All pages live as siblings in /pages/,
// so page-to-page links are plain filenames with no path juggling.
// =====================================================================

import "./register-sw.js";
import { supabase, requireAuth, signOut, initials, isPlatformOwner, myAcademies, clearProfileCache, switchToProfile } from "./supabase-client.js";
import { openAcademySwitcher } from "./academy-switcher.js";
import { brandFromOrg, applyBrand, brandLogo, rememberBrand, forgetBrand, applyRememberedBrand } from "./brand.js";

applyRememberedBrand(); // color the loading screen right away, before the academy is known
import { initPushNotifications } from "./push.js";
import { checkForUpdate } from "./version-check.js";
import "./pull-to-refresh.js";
import "./modal.js";
import { getThemePref, setThemePref, THEME_LABELS } from "./theme.js";
import "./picker.js";
import { escapeHtml as esc } from "./utils.js";


const themeMeta = document.querySelector('meta[name="theme-color"]');
function syncThemeColor() {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
  if (themeMeta && c) themeMeta.setAttribute("content", c);
}
new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
syncThemeColor();

// Makes text safe to show inside the page
const ICONS = {
  dashboard:  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  bell:       `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>`,
  megaphone:  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11v2a2 2 0 002 2h1l3.5 5v-14L6 11H5a2 2 0 00-2 2z"/><path d="M13 8.5v7a4 4 0 004-1v-5a4 4 0 00-4-1z"/></svg>`,
  calendar:   `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>`,
  event:      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
  attendance: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  leave:      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19h16M6 19V9a2 2 0 012-2h4l6 6v6"/><path d="M12 7v6h6"/></svg>`,
  groups:     `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.6"/><path d="M2.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6M14 20c0-2.6 1.8-4.8 4-5.6"/></svg>`,
  people:     `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 3.8-5.8 7-5.8s5.8 2 7 5.8"/></svg>`,
  profile:    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.3-3.7 4.3-5.8 7.5-5.8s6.2 2.1 7.5 5.8"/></svg>`,
  reports:    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
  users:      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9" r="2.4"/><path d="M2.5 20c0-3.3 2.6-6 6.5-6s6.5 2.7 6.5 6M15 20c0-2.4 1.6-4.5 3.6-5.4"/></svg>`,
  settings:   `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3h-6l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.7 7.7 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1L9 21h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4z"/></svg>`,
  owner:      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
  switch:     `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 7h13M16 3l4 4-4 4"/><path d="M17 17H4M8 13l-4 4 4 4"/></svg>`,
  logout:     `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>`,
  more:       `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  chevron:    `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`,
  theme:      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 000-18z" fill="currentColor"/></svg>`,
};

// All pages are siblings inside /pages/, so hrefs are plain filenames.
// `guestBottom: true` puts a guest-visible item in the mobile bottom bar;
// other guest-visible items (e.g. Announcements) go under "More".
const NAV_ITEMS = [
  { key: "dashboard", href: "dashboard.html", label: "Dashboard", mobileLabel: "Home", icon: ICONS.dashboard, roles: ["admin", "teacher", "student", "parent", "guest"], bottomNav: true, guestBottom: true },
  { key: "announcements", href: "announcements.html", label: "Announcements", icon: ICONS.megaphone, roles: ["admin", "teacher", "student", "parent", "guest"] },
  { key: "notifications", href: "notifications.html", label: "Notifications", icon: ICONS.bell, roles: ["admin", "teacher", "student", "parent", "guest"], bottomNav: true, guestBottom: true },
  { key: "calendar", href: "calendar.html", label: "Calendar", icon: ICONS.calendar, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "events", href: "events.html", label: "Events", icon: ICONS.event, roles: ["admin", "teacher", "student", "parent", "guest"], guestBottom: true },
  { key: "groups", href: "groups.html", label: "Groups", icon: ICONS.groups, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "people", href: "people.html", label: "People", icon: ICONS.people, roles: ["admin", "teacher", "student", "parent"] },
  { key: "attendance", href: "attendance.html", label: "Attendance", icon: ICONS.attendance, roles: ["admin", "teacher", "student", "parent"] },
  { key: "leave", href: "leave.html", label: "Leave", icon: ICONS.leave, roles: ["admin", "teacher"] },
  { key: "profile", href: "profile.html", label: "Profile", icon: ICONS.profile, roles: ["admin", "teacher", "student", "parent", "guest"], guestBottom: true },
];

const ADMIN_ITEMS = [
  { key: "admin-users", href: "admin-users.html", label: "Users", icon: ICONS.users },
  { key: "reports", href: "reports.html", label: "Reports", icon: ICONS.reports },
  { key: "admin-settings", href: "admin-settings.html", label: "Settings", icon: ICONS.settings },
];

const OWNER_ITEM = { key: "owner", href: "owner.html", label: "Owner console", icon: ICONS.owner };

// Guests only get these pages; anything else bounces them to the dashboard.
const GUEST_KEYS = new Set(["dashboard", "announcements", "notifications", "events", "profile"]);

function navLink(item, activeKey, unread) {
  return `
    <a class="sidebar-link ${item.key === activeKey ? "active" : ""}" href="${item.href}">
      ${item.icon}
      <span>${item.label}</span>
      ${item.key === "notifications" && unread > 0 ? `<span class="badge">${unread > 9 ? "9+" : unread}</span>` : ""}
    </a>`;
}

function buildSidebar(profile, activeKey, unread, isOwner) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(profile.role));
  const brand = brandFromOrg(profile.organizations);
  const brandLogoSrc = brandLogo(brand, "horiz", "../images/logo-horiz.png");

  let adminBlock = "";
  if (profile.role === "admin") {
    adminBlock = `
      <div class="sidebar-section-label">Administration</div>
      ${ADMIN_ITEMS.map((item) => navLink(item, activeKey, unread)).join("")}
    `;
  }

  if (isOwner && profile.role === "admin") {
    adminBlock += `
      <div class="sidebar-section-label">Platform</div>
      ${navLink(OWNER_ITEM, activeKey, unread)}
    `;
  }

  const el = document.createElement("aside");
  el.id = "app-sidebar";
  el.innerHTML = `
    <div class="sidebar-brand">
      ${brandLogoSrc ? `<img src="${esc(brandLogoSrc)}" alt="${esc(brand.name)}" class="sidebar-brand-logo" />` : ""}${brand.custom ? `<span class="brand-name" style="color:var(--primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(brand.name)}</span>` : ""}
    </div>
    <nav class="sidebar-nav">
      <div class="sidebar-section-label">Workspace</div>
      ${items.map((item) => navLink(item, activeKey, unread)).join("")}
      ${adminBlock}
    </nav>
    <div class="sidebar-footer">
      <div class="avatar">${profile.avatar_url && /^https:\/\//.test(profile.avatar_url) ? `<img src="${esc(profile.avatar_url)}" alt="">` : esc(initials(profile.full_name))}</div>
      <div style="flex:1;min-width:0;">
        <div class="sidebar-user-name">${esc(profile.full_name)}</div>
        <div class="sidebar-user-role">${isOwner ? "owner" : profile.role}</div>
      </div>
      <button class="sidebar-signout" id="signout-btn" title="Sign out">${ICONS.logout}</button>
    </div>
  `;
  return el;
}

// Mobile bottom nav: Home, Calendar, Notifications, Groups, More.
function buildBottomNav(profile, activeKey, isOwner) {
  const isGuest = profile.role === "guest";
  // Guests: Home, Notifications, Events, Profile in the bar; Announcements in More.
  const primary = isGuest
    ? NAV_ITEMS.filter((i) => i.guestBottom && i.roles.includes("guest"))
    : NAV_ITEMS.filter((i) => i.bottomNav && i.roles.includes(profile.role));
  const moreItems = isGuest
    ? NAV_ITEMS.filter((i) => !i.guestBottom && i.roles.includes("guest"))
    : [
        ...NAV_ITEMS.filter((i) => !i.bottomNav && i.roles.includes(profile.role)),
        ...(profile.role === "admin" ? ADMIN_ITEMS : []),
        ...(isOwner && profile.role === "admin" ? [OWNER_ITEM] : []),
      ];

  const el = document.createElement("nav");
  el.id = "app-bottomnav";
  el.innerHTML =
    primary
      .map((item) => `<a class="bottomnav-link ${item.key === activeKey ? "active" : ""}" href="${item.href}">${item.icon}<span>${item.mobileLabel || item.label}</span></a>`)
      .join("") + `<button class="bottomnav-more" id="more-btn" type="button">${ICONS.more}<span>More</span></button>`;

  const sheetBackdrop = document.createElement("div");
  sheetBackdrop.className = "more-sheet-backdrop";
  sheetBackdrop.id = "more-backdrop";

  const sheet = document.createElement("div");
  sheet.className = "more-sheet";
  sheet.id = "more-sheet";
  sheet.innerHTML = `
    <div class="more-sheet-handle"></div>
    ${moreItems.map((item) => `<a class="sidebar-link ${item.key === activeKey ? "active" : ""}" href="${item.href}">${item.icon}<span>${item.label}</span></a>`).join("")}
    <button class="sidebar-link sidebar-signout" id="more-signout-btn" style="width:100%;color:var(--error);">${ICONS.logout}<span>Sign out</span></button>
  `;

  function openSheet() {
    sheetBackdrop.classList.add("open");
    sheet.classList.add("open");
  }
  function closeSheet() {
    sheetBackdrop.classList.remove("open");
    sheet.classList.remove("open");
  }
  sheetBackdrop.addEventListener("click", closeSheet);

  return { bottomNavEl: el, sheetBackdrop, sheet, openSheet, closeSheet };
}

function buildTopbar(profile, pageTitle, unread, brandOnMobile, isOwner, otherUnread = 0) {
  const el = document.createElement("header");
  const brand = brandFromOrg(profile.organizations);
  el.id = "app-topbar";
  el.innerHTML = `
    <h1 class="topbar-title">
      ${brandOnMobile ? `<span class="topbar-title-brand"${brand.custom ? ' style="color:var(--primary)"' : ""}>${brand.custom ? esc(brand.name) : `<span class="brand-one">ONE</span><span class="brand-core">CORE</span>`}</span>` : ""}
      <span class="topbar-title-text">${pageTitle}</span>
    </h1>
    <div class="topbar-actions">
      <a class="icon-btn" href="notifications.html" title="Notifications">
        ${ICONS.bell}
        ${unread > 0 ? `<span class="notif-dot"></span>` : ""}
      </a>
      <button class="user-menu-btn" id="user-menu-btn">
        <div class="avatar">${profile.avatar_url && /^https:\/\//.test(profile.avatar_url) ? `<img src="${esc(profile.avatar_url)}" alt="">` : esc(initials(profile.full_name))}</div>
        ${ICONS.chevron}
      </button>
      <div class="user-menu-dropdown" id="user-menu-dropdown">
        <div class="user-menu-header">
          <div class="name">${esc(profile.full_name)}</div>
          <div class="role">${isOwner ? "owner" : profile.role}</div>
          ${profile.organizations?.name ? `<div class="text-muted" style="font-size:0.78rem;">${esc(profile.organizations.name)}</div>` : ""}
        </div>
        <a class="user-menu-item" href="profile.html">${ICONS.profile}<span>Profile</span></a>
        <button class="user-menu-item" id="user-menu-theme" type="button">${ICONS.theme}<span id="user-menu-theme-label"></span></button>
        <button class="user-menu-item" id="user-menu-switch">${ICONS.switch}<span>Switch academy</span>${otherUnread > 0 ? `<span style="margin-left:auto;display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:999px;background:var(--error-solid);color:#fff;font-size:0.72rem;font-weight:700;">${otherUnread > 9 ? "9+" : otherUnread}</span>` : ""}</button>
        <button class="user-menu-item danger" id="user-menu-signout">${ICONS.logout}<span>Sign out</span></button>
      </div>
    </div>
  `;
  return el;
}

/**
 * Mounts the shared shell around a page's own content.
 * @param {Object} opts
 * @param {string} opts.activeKey - key of the current nav item (see NAV_ITEMS/ADMIN_ITEMS)
 * @param {string} opts.pageTitle - shown in the top bar
 * @param {string[]} [opts.allowedRoles] - if set, roles not listed are redirected to dashboard
 * @returns {Promise<Object|null>} the signed-in profile, or null if redirected
 */
// =====================================================================
// Select pickers. Replaces the browser's native <select> popup (ugly on
// phones) with the same modal look as the Audience picker. The real
// <select> stays in the DOM, hidden, so `.value`, "change" listeners and
// form submits keep working. Opt out with <select data-native>.
// =====================================================================

const SS_STYLES = `
.ss-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important;}
.ss-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0;flex:1 1 auto;box-sizing:border-box;text-align:left;}
.ss-btn[disabled]{opacity:.6;cursor:not-allowed;}
.ss-btn .ss-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ss-btn .ss-label.ss-placeholder{opacity:.6;}
.ss-backdrop{animation:ssFade .16s ease-out;}
.ss-modal{animation:ssRise .22s cubic-bezier(.2,.8,.2,1);}
.ss-modal .aud-row.ss-disabled{opacity:.45;pointer-events:none;}
@keyframes ssFade{from{opacity:0}to{opacity:1}}
@keyframes ssRise{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.ss-backdrop,.ss-modal{animation:none}}
`;

const ssEsc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ssNativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

function ssTitleFor(select) {
  if (select.dataset.title) return select.dataset.title;
  if (select.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
  }
  return select.getAttribute("aria-label") || "Choose an option";
}

function ssOpen(select, trigger) {
  const options = Array.from(select.options);

  const rowHtml = (o) => `
    <label class="aud-row${o.disabled ? " ss-disabled" : ""}">
      <input type="radio" name="ss-opt" data-index="${options.indexOf(o)}" ${o.selected ? "checked" : ""} ${o.disabled ? "disabled" : ""} />
      <span>${ssEsc(o.textContent.trim())}</span>
    </label>`;

  // Supports <optgroup> as well as flat option lists.
  let body = "";
  let flat = [];
  const flush = () => {
    if (flat.length) body += `<div class="aud-list">${flat.map(rowHtml).join("")}</div>`;
    flat = [];
  };
  for (const child of select.children) {
    if (child.tagName === "OPTGROUP") {
      flush();
      body += `<div class="ack-group-title">${ssEsc(child.label)}</div><div class="aud-list">${Array.from(child.children).map(rowHtml).join("")}</div>`;
    } else if (child.tagName === "OPTION") {
      flat.push(child);
    }
  }
  flush();

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop ss-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal ss-modal" role="dialog" aria-modal="true" aria-label="${ssEsc(ssTitleFor(select))}">
      <h3>${ssEsc(ssTitleFor(select))}</h3>
      <div class="aud-body">${body}</div>
    </div>`;
  document.body.appendChild(backdrop);

  let closing = false;
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  function close() {
    if (closing) return;
    closing = true;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    trigger.focus({ preventScroll: true });
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  // One tap picks the option and closes. The short delay lets the tapped
  // row show as selected first, which feels smoother than vanishing instantly.
  backdrop.addEventListener("change", (e) => {
    const input = e.target;
    if (!input.matches || !input.matches("input[data-index]")) return;
    const changed = select.selectedIndex !== Number(input.dataset.index);
    select.selectedIndex = Number(input.dataset.index);
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setTimeout(close, 120);
  });

  const current = backdrop.querySelector("input:checked");
  if (current) {
    current.closest("label").scrollIntoView({ block: "center" });
    current.focus({ preventScroll: true });
  }
}

function ssEnhance(select) {
  if (select.dataset.ssDone || select.multiple || select.size > 1 || "native" in select.dataset) return;
  select.dataset.ssDone = "1";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "audience-btn ss-btn";
  btn.innerHTML = `<span class="ss-label"></span>`; // .audience-btn already draws its own chevron
  const labelEl = btn.querySelector(".ss-label");

  select.classList.add("ss-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.after(btn);

  function refresh() {
    const opt = select.options[select.selectedIndex];
    labelEl.textContent = opt ? opt.textContent.trim() : "Select…";
    labelEl.classList.toggle("ss-placeholder", !opt || opt.disabled || opt.hidden);
    btn.disabled = select.disabled;
    btn.style.display = select.hidden || select.style.display === "none" ? "none" : "";
  }

  // Code that sets `select.value = "x"` doesn't fire "change", so intercept it.
  Object.defineProperty(select, "value", {
    configurable: true,
    get() {
      return ssNativeValue.get.call(this);
    },
    set(v) {
      ssNativeValue.set.call(this, v);
      refresh();
    },
  });

  select.addEventListener("change", refresh);
  new MutationObserver(refresh).observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "style"],
  });

  btn.addEventListener("click", () => {
    if (!select.disabled) ssOpen(select, btn);
  });

  // Clicking the field's <label> opens the picker, like it would focus a native select.
  if (select.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    lab?.addEventListener("click", (e) => {
      e.preventDefault();
      btn.click();
    });
  }

  refresh();
}

function initSelectSheets() {
  if (document.getElementById("select-sheet-style")) return; // already initialised
  const style = document.createElement("style");
  style.id = "select-sheet-style";
  style.textContent = SS_STYLES;
  document.head.appendChild(style);

  const scan = (root) => root.querySelectorAll && root.querySelectorAll("select").forEach(ssEnhance);
  scan(document);

  // Catch selects added later (e.g. inside modals built with innerHTML).
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches("select")) ssEnhance(n);
        else scan(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// If this profile no longer exists (its academy was reset, or the person was removed), the app would
// keep showing from its cache while nothing works. Confirm with the database, then move the person
// to another academy they belong to, or sign them out. Normally this costs nothing: the list of
// academies is already loaded, and the extra lookup only runs when the profile is missing from it.
async function endSessionIfProfileGone(profile, academies) {
  if (academies.some((a) => a.profile_id === profile.id)) return false;
  try {
    const { data, error } = await supabase.from("profiles").select("id").eq("id", profile.id).maybeSingle();
    if (error || data) return false; // still there, or can't tell: carry on
  } catch {
    return false;
  }
  clearProfileCache();
  const other = academies.find((a) => a.is_active !== false && a.is_approved !== false);
  if (other) {
    try {
      await switchToProfile(other.profile_id);
      window.location.href = "dashboard.html";
      return true;
    } catch (err) {
      console.error(err);
    }
  }
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token")).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
  window.location.href = "login.html";
  return true;
}

export async function mountLayout({ activeKey, pageTitle, allowedRoles, brandOnMobile }) {
  const profile = await requireAuth();
  checkForUpdate(); // fire-and-forget, never blocks the page
  if (!profile) return null;

  if (profile.role === "guest" && !GUEST_KEYS.has(activeKey)) {
    window.location.href = "dashboard.html";
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    window.location.href = "dashboard.html";
    return null;
  }

  const [isOwner, academies] = await Promise.all([isPlatformOwner(), myAcademies()]);
  if (await endSessionIfProfileGone(profile, academies)) return null;
  // The bell and badge count only the academy I am in (the Notifications page lists only that academy).
  // Unread items in my other academies show as a count on "Switch academy".
  const unread = Number(academies.find((a) => a.profile_id === profile.id)?.unread || 0);
  const otherUnread = academies.filter((a) => a.profile_id !== profile.id).reduce((n, a) => n + Number(a.unread || 0), 0);

  // Colors for this academy (logo and name are applied where the sidebar/topbar are built).
  const brandNow = brandFromOrg(profile.organizations);
  applyBrand(brandNow);
  // The device remembers the last academy (for the splash and login). Platform owners leave nothing behind.
  if (isOwner) forgetBrand();
  else rememberBrand(brandNow);

  const existingContent = document.getElementById("page-content");
  const pageContentHtml = existingContent ? existingContent.innerHTML : "";

  const shell = document.createElement("div");
  shell.id = "app-shell";

  const sidebar = buildSidebar(profile, activeKey, unread, isOwner);
  const main = document.createElement("div");
  main.id = "app-main";
  const topbar = buildTopbar(profile, pageTitle, unread, brandOnMobile, isOwner, otherUnread);
  const content = document.createElement("main");
  content.id = "app-content";
  content.innerHTML = pageContentHtml;
  main.appendChild(topbar);
  main.appendChild(content);

  const { bottomNavEl, sheetBackdrop, sheet, openSheet, closeSheet } = buildBottomNav(profile, activeKey, isOwner);

  shell.appendChild(sidebar);
  shell.appendChild(main);
  shell.appendChild(bottomNavEl);
  shell.appendChild(sheetBackdrop);
  shell.appendChild(sheet);

  document.body.innerHTML = "";
  document.body.appendChild(shell);

  // Must run after the page content has been moved into the shell above;
  // enhancing earlier would copy dead buttons into the rebuilt page.
  initSelectSheets();

  document.getElementById("signout-btn")?.addEventListener("click", signOut);
  document.getElementById("more-signout-btn")?.addEventListener("click", signOut);
  document.getElementById("more-btn")?.addEventListener("click", openSheet);

  // User menu dropdown (topbar)
  const menuBtn = document.getElementById("user-menu-btn");
  const dropdown = document.getElementById("user-menu-dropdown");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
  });
  document.addEventListener("click", () => dropdown.classList.remove("open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dropdown.classList.remove("open");
  });
  document.getElementById("user-menu-signout")?.addEventListener("click", signOut);
  // Appearance: each tap switches between Default and Dark Mode. The menu stays open so the change is visible.
  const themeLabel = document.getElementById("user-menu-theme-label");
  const showTheme = () => { themeLabel.textContent = `Theme: ${THEME_LABELS[getThemePref()]}`; };
  showTheme();
  document.getElementById("user-menu-theme")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setThemePref(getThemePref() === "dark" ? "default" : "dark");
    showTheme();
  });
  document.getElementById("user-menu-switch")?.addEventListener("click", () => openAcademySwitcher(academies, profile));
  // Tapping a push banner for another academy opens the same picker, with fresh unread counts.
  window.addEventListener("onecore:open-academy-switcher", async () => {
    if (document.querySelector(".dialog-backdrop")) return;
    let fresh = academies;
    try { fresh = await myAcademies(); } catch (err) { console.error(err); }
    openAcademySwitcher(fresh, profile);
  });

  document.title = `${pageTitle} — ${brandFromOrg(profile.organizations).name}`;

  // No-op on the plain web version; registers this device for OS-level
  // push notifications when running inside the native (Capacitor) app.
  initPushNotifications(profile);

  // A push arrived while the app is open: show the unread dot straight away, without asking the server.
  let liveUnread = unread;
  window.addEventListener("onecore:push", (e) => {
    if (!e.detail?.forThisAcademy) return; // another academy: the phone still buzzes, but this bell stays as is
    liveUnread += 1;
    const text = liveUnread > 9 ? "9+" : String(liveUnread);
    document.querySelectorAll('.sidebar-link[href="notifications.html"]').forEach((link) => {
      let badge = link.querySelector(".badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "badge";
        link.appendChild(badge);
      }
      badge.textContent = text;
    });
    const bell = document.querySelector('.icon-btn[href="notifications.html"]');
    if (bell && !bell.querySelector(".notif-dot")) {
      const dot = document.createElement("span");
      dot.className = "notif-dot";
      bell.appendChild(dot);
    }
  });

  return profile;
}

/**
 * Standard sub-header for a page section (appearance is defined globally
 * in global.css; each page only chooses its icon, tone and text).
 *
 * @param {Object}  opts
 * @param {string}  opts.title
 * @param {string}  [opts.icon]      SVG markup, chosen per page (e.g. ICONS.megaphone)
 * @param {"primary"|"success"|"warning"|"error"|"info"|"muted"} [opts.tone]
 * @param {number|string} [opts.count]  small count pill after the title
 * @param {string}  [opts.linkHtml]  right-aligned link markup, e.g. '<a class="link" href="...">View all</a>'
 */
function sectionHead({ title, icon = "", tone = "", count, linkHtml = "" }) {
  const hasCount = count !== undefined && count !== null;
  return `
    <div class="section-head ${tone ? `tone-${tone}` : ""}">
      ${icon ? `<span class="section-icon">${icon}</span>` : ""}
      <h2>${title}</h2>
      ${hasCount ? `<span class="section-count">${count}</span>` : ""}
      ${linkHtml}
    </div>`;
}

export { ICONS, sectionHead };
