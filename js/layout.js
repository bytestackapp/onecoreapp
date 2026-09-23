// =====================================================================
// Shared layout. Each page keeps only its own unique content inside a
// <div id="page-content"> and calls mountLayout({...}) — the sidebar,
// topbar and mobile bottom nav are built once, here, so they never need
// to be copy-pasted across pages. All pages live as siblings in /pages/,
// so page-to-page links are plain filenames with no path juggling.
// =====================================================================

import { requireAuth, signOut, initials, supabase } from "./supabase-client.js";
import { APP_NAME, LOGO_MARK } from "./brand.js";
import { initPushNotifications } from "./push.js";

const ICONS = {
  dashboard: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  bell: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>`,
  megaphone: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11v2a2 2 0 002 2h1l3.5 5v-14L6 11H5a2 2 0 00-2 2z"/><path d="M13 8.5v7a4 4 0 004-1v-5a4 4 0 00-4-1z"/></svg>`,
  calendar: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>`,
  event: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
  attendance: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  leave: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19h16M6 19V9a2 2 0 012-2h4l6 6v6"/><path d="M12 7v6h6"/></svg>`,
  groups: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.6"/><path d="M2.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6M14 20c0-2.6 1.8-4.8 4-5.6"/></svg>`,
  people: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 3.8-5.8 7-5.8s5.8 2 7 5.8"/></svg>`,
  profile: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.3-3.7 4.3-5.8 7.5-5.8s6.2 2.1 7.5 5.8"/></svg>`,
  reports: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
  users: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9" r="2.4"/><path d="M2.5 20c0-3.3 2.6-6 6.5-6s6.5 2.7 6.5 6M15 20c0-2.4 1.6-4.5 3.6-5.4"/></svg>`,
  settings: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3h-6l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.7 7.7 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1L9 21h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4z"/></svg>`,
  logout: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>`,
  more: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  chevron: `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`,
};

// All pages are siblings inside /pages/, so hrefs are plain filenames.
const NAV_ITEMS = [
  { key: "dashboard", href: "dashboard.html", label: "Dashboard", mobileLabel: "Home", icon: ICONS.dashboard, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "announcements", href: "announcements.html", label: "Announcements", icon: ICONS.megaphone, roles: ["admin", "teacher", "student", "parent"] },
  { key: "notifications", href: "notifications.html", label: "Notifications", icon: ICONS.bell, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "calendar", href: "calendar.html", label: "Calendar", icon: ICONS.calendar, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "events", href: "events.html", label: "Events", icon: ICONS.event, roles: ["admin", "teacher", "student", "parent"] },
  { key: "groups", href: "groups.html", label: "Groups", icon: ICONS.groups, roles: ["admin", "teacher", "student", "parent"], bottomNav: true },
  { key: "people", href: "people.html", label: "People", icon: ICONS.people, roles: ["admin", "teacher", "student", "parent"] },
  { key: "attendance", href: "attendance.html", label: "Attendance", icon: ICONS.attendance, roles: ["admin", "teacher", "student", "parent"] },
  { key: "leave", href: "leave.html", label: "Leave", icon: ICONS.leave, roles: ["admin", "teacher"] },
  { key: "profile", href: "profile.html", label: "Profile", icon: ICONS.profile, roles: ["admin", "teacher", "student", "parent"] },
];

const ADMIN_ITEMS = [
  { key: "admin-users", href: "admin-users.html", label: "Users", icon: ICONS.users },
  { key: "reports", href: "reports.html", label: "Reports", icon: ICONS.reports },
  { key: "admin-settings", href: "admin-settings.html", label: "Settings", icon: ICONS.settings },
];

async function unreadNotificationCount(profileId) {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("is_read", false);
  if (error) {
    console.error("unreadNotificationCount error:", error);
    return 0;
  }
  return count ?? 0;
}

function navLink(item, activeKey, unread) {
  return `
    <a class="sidebar-link ${item.key === activeKey ? "active" : ""}" href="${item.href}">
      ${item.icon}
      <span>${item.label}</span>
      ${item.key === "notifications" && unread > 0 ? `<span class="badge">${unread > 9 ? "9+" : unread}</span>` : ""}
    </a>`;
}

function buildSidebar(profile, activeKey, unread) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(profile.role));

  let adminBlock = "";
  if (profile.role === "admin") {
    adminBlock = `
      <div class="sidebar-section-label">Administration</div>
      ${ADMIN_ITEMS.map((item) => navLink(item, activeKey, unread)).join("")}
    `;
  }

  const el = document.createElement("aside");
  el.id = "app-sidebar";
  el.innerHTML = `
    <div class="sidebar-brand">
      <img src="../images/logo-horiz.png" alt="${APP_NAME}" class="sidebar-brand-logo" />
    </div>
    <nav class="sidebar-nav">
      <div class="sidebar-section-label">Workspace</div>
      ${items.map((item) => navLink(item, activeKey, unread)).join("")}
      ${adminBlock}
    </nav>
    <div class="sidebar-footer">
      <div class="avatar">${profile.avatar_url ? `<img src="${profile.avatar_url}" alt="">` : initials(profile.full_name)}</div>
      <div style="flex:1;min-width:0;">
        <div class="sidebar-user-name">${profile.full_name}</div>
        <div class="sidebar-user-role">${profile.role}</div>
      </div>
      <button class="sidebar-signout" id="signout-btn" title="Sign out">${ICONS.logout}</button>
    </div>
  `;
  return el;
}

// Mobile bottom nav: Home, Calendar, Notifications, Groups, More.
function buildBottomNav(profile, activeKey) {
  const primary = NAV_ITEMS.filter((i) => i.bottomNav && i.roles.includes(profile.role));
  const moreItems = [
    ...NAV_ITEMS.filter((i) => !i.bottomNav && i.roles.includes(profile.role)),
    ...(profile.role === "admin" ? ADMIN_ITEMS : []),
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

function buildTopbar(profile, pageTitle, unread) {
  const el = document.createElement("header");
  el.id = "app-topbar";
  el.innerHTML = `
    <h1>${pageTitle}</h1>
    <div class="topbar-actions">
      <a class="icon-btn" href="notifications.html" title="Notifications">
        ${ICONS.bell}
        ${unread > 0 ? `<span class="notif-dot"></span>` : ""}
      </a>
      <button class="user-menu-btn" id="user-menu-btn">
        <div class="avatar">${profile.avatar_url ? `<img src="${profile.avatar_url}" alt="">` : initials(profile.full_name)}</div>
        ${ICONS.chevron}
      </button>
      <div class="user-menu-dropdown" id="user-menu-dropdown">
        <div class="user-menu-header">
          <div class="name">${profile.full_name}</div>
          <div class="role">${profile.role}</div>
        </div>
        <a class="user-menu-item" href="profile.html">${ICONS.profile}<span>Profile</span></a>
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
export async function mountLayout({ activeKey, pageTitle, allowedRoles }) {
  const profile = await requireAuth();
  if (!profile) return null;

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    window.location.href = "dashboard.html";
    return null;
  }

  const unread = await unreadNotificationCount(profile.id);

  const existingContent = document.getElementById("page-content");
  const pageContentHtml = existingContent ? existingContent.innerHTML : "";

  const shell = document.createElement("div");
  shell.id = "app-shell";

  const sidebar = buildSidebar(profile, activeKey, unread);
  const main = document.createElement("div");
  main.id = "app-main";
  const topbar = buildTopbar(profile, pageTitle, unread);
  const content = document.createElement("main");
  content.id = "app-content";
  content.innerHTML = pageContentHtml;
  main.appendChild(topbar);
  main.appendChild(content);

  const { bottomNavEl, sheetBackdrop, sheet, openSheet, closeSheet } = buildBottomNav(profile, activeKey);

  shell.appendChild(sidebar);
  shell.appendChild(main);
  shell.appendChild(bottomNavEl);
  shell.appendChild(sheetBackdrop);
  shell.appendChild(sheet);

  document.body.innerHTML = "";
  document.body.appendChild(shell);

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

  document.title = `${pageTitle} — ${APP_NAME}`;

  // No-op on the plain web version; registers this device for OS-level
  // push notifications when running inside the native (Capacitor) app.
  initPushNotifications(profile);

  return profile;
}

export { ICONS };
