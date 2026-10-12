import { mountLayout } from "./layout.js";
import { supabase, initials } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "people", pageTitle: "People" });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("people-list");
const searchInput = document.getElementById("search");
const roleFilter = document.getElementById("role-filter");

let people = [];

const PAGE_SIZE = 20; // people shown per page
const CACHE_TTL_MS = 5 * 60 * 1000; // reuse the loaded directory for 5 minutes
const CACHE_KEY = `onecore:people:${profile.organization_id}:${profile.id}`;
const ROLE_ORDER = { admin: 0, teacher: 1, student: 2, parent: 3, guest: 4 };
let currentPage = 1;

function sortPeople(list) {
  return [...list].sort(
    (a, b) =>
      (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99) ||
      a.full_name.localeCompare(b.full_name)
  );
}

function readCache() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    if (raw && Array.isArray(raw.d) && Date.now() - raw.t < CACHE_TTL_MS) return raw.d;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(list) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: list }));
  } catch {
    /* ignore */
  }
}

async function load() {
  const cached = readCache();
  if (cached) {
    people = cached;
    render();
    return;
  }
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    // Supabase returns at most 1000 rows per request, so read the directory page by page.
    const PAGE = 1000;
    const all = [];
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, phone, role")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("full_name")
        .order("id")
        .range(start, start + PAGE - 1);
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    people = sortPeople(all);
    writeCache(people);
    render();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">The directory couldn't be loaded. Please refresh the page.</div>`;
  }
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const role = roleFilter.value;

  const filtered = people.filter((p) => {
    const matchesQuery = !q || p.full_name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
    const matchesRole = !role || p.role === role;
    return matchesQuery && matchesRole;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="card empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 3.8-5.8 7-5.8s5.8 2 7 5.8"/></svg>
      <h3>No matches</h3><p>Try a different search or role filter.</p>
    </div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(startIdx, startIdx + PAGE_SIZE);

  const pager =
    totalPages > 1
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;">
          <button type="button" class="btn btn-secondary" id="pg-prev" ${currentPage === 1 ? "disabled" : ""}>Previous</button>
          <span class="text-muted" style="font-size:0.85rem;text-align:center;">${startIdx + 1}–${startIdx + pageItems.length} of ${filtered.length}</span>
          <button type="button" class="btn btn-secondary" id="pg-next" ${currentPage === totalPages ? "disabled" : ""}>Next</button>
        </div>`
      : "";

  listEl.innerHTML = `<div class="card">${pageItems
    .map(
      (p) => `
    <div class="list-row">
      <div class="avatar">${initials(p.full_name)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</div>
        <div class="text-muted" style="font-size:0.82rem;">${escapeHtml(p.email)}</div>
        <div class="text-muted" style="font-size:0.82rem;">${p.phone ? escapeHtml(p.phone) : "no contact info provided"}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;align-self:stretch;gap:8px;flex-shrink:0;">
        <span class="tag tag-role-${escapeHtml(p.role)}">${escapeHtml(p.role)}</span>
        ${contactActions(p)}
      </div>
    </div>`
    )
    .join("")}</div>${pager}`;

  listEl.querySelector("#pg-prev")?.addEventListener("click", () => {
    currentPage--;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  listEl.querySelector("#pg-next")?.addEventListener("click", () => {
    currentPage++;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

searchInput.addEventListener("input", () => {
  currentPage = 1;
  render();
});
roleFilter.addEventListener("change", () => {
  currentPage = 1;
  render();
});

// Call / text buttons: open the phone's own dialer or messaging app
function contactActions(p) {
  if (!p.phone || p.id === profile.id) return "";
  // keep digits and a leading "+", drop spaces, dashes, brackets, dots
  const num = String(p.phone).trim().replace(/(?!^\+)\D/g, "");
  if (num.length < 3) return "";
  const name = escapeHtml(p.full_name);
  const btn = "text-decoration:none;display:inline-flex;align-items:center;justify-content:center;";
  return `<span style="display:flex;gap:6px;flex-shrink:0;">
    <a class="icon-action sm" href="tel:${num}" title="Call" aria-label="Call ${name}" style="${btn}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg></a>
    <a class="icon-action sm" href="sms:${num}" title="Text" aria-label="Text ${name}" style="${btn}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></a>
  </span>`;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

load();
