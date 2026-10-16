import { mountLayout } from "./layout.js";
import { supabase, initials } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "people", pageTitle: "People" });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("people-list");
const searchInput = document.getElementById("search");
const roleFilter = document.getElementById("role-filter");

// The directory is read from the database one page at a time and never cached,
// so what you see is always current.
const PAGE_SIZE = 20;
const STAFF_ROLES = ["admin", "teacher"];           // shown first: page 1
const OTHER_ROLES = ["student", "parent", "guest"]; // page 2 onwards, in this order
const COLS = "id, full_name, email, phone, role, contact_hidden";
const ROLE_RANK = { admin: 0, teacher: 1 };

let state = { page: 1, rows: [], total: 0, pages: 1, counts: null };
let requestSeq = 0;
let searchTimer;

function baseQuery(opts) {
  return supabase
    .from("people_directory")
    .select(COLS, opts)
    .eq("organization_id", profile.organization_id)
    .eq("is_active", true);
}

// Search text -> PostgREST "or" filter (characters that could break the filter are removed)
function searchClause() {
  const s = searchInput.value.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();
  return s ? `full_name.ilike.%${s}%,email.ilike.%${s}%` : "";
}

// Which rows of the "others" group (students, then parents, then guests) fall on one page
function pageSegments(offset, limit, counts) {
  const segs = [];
  let start = 0; // position in the whole group where this role begins
  for (const role of OTHER_ROLES) {
    const n = counts[role] || 0;
    const from = Math.max(offset, start) - start;
    const to = Math.min(offset + limit, start + n) - start; // exclusive
    if (to > from) segs.push({ role, from, to: to - 1 });
    start += n;
  }
  return segs;
}

// Head-only count queries (no rows are downloaded)
async function fetchCounts() {
  const results = await Promise.all([
    baseQuery({ count: "exact", head: true }).in("role", STAFF_ROLES),
    ...OTHER_ROLES.map((r) => baseQuery({ count: "exact", head: true }).eq("role", r)),
  ]);
  for (const r of results) if (r.error) throw r.error;
  const counts = { staff: results[0].count || 0 };
  OTHER_ROLES.forEach((r, i) => (counts[r] = results[i + 1].count || 0));
  return counts;
}

// Reads one page. Returns { rows, total, pages, page, counts }.
async function fetchPage() {
  const role = roleFilter.value;
  const clause = searchClause();
  const filtered = Boolean(role || clause);
  let page = state.page;
  let rows = [];
  let total = 0;
  let pages = 1;
  let counts = state.counts;

  if (!filtered) {
    // Page 1 = admins and teachers. Page 2 onwards = students, then parents, then guests.
    if (!counts) counts = await fetchCounts();
    const othersTotal = OTHER_ROLES.reduce((sum, r) => sum + counts[r], 0);
    total = counts.staff + othersTotal;
    pages = 1 + Math.ceil(othersTotal / PAGE_SIZE);
    page = Math.min(Math.max(page, 1), pages);
    if (page === 1) {
      const { data, error } = await baseQuery().in("role", STAFF_ROLES).order("full_name").order("id").limit(200);
      if (error) throw error;
      rows = (data || []).sort(
        (a, b) => (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99) || a.full_name.localeCompare(b.full_name)
      );
    } else {
      const segs = pageSegments((page - 2) * PAGE_SIZE, PAGE_SIZE, counts);
      const parts = await Promise.all(
        segs.map(async (s) => {
          const { data, error } = await baseQuery().eq("role", s.role).order("full_name").order("id").range(s.from, s.to);
          if (error) throw error;
          return data || [];
        })
      );
      rows = parts.flat();
    }
  } else {
    // Searching / filtering: one query, sorted by name
    counts = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const from = (page - 1) * PAGE_SIZE;
      let q = baseQuery({ count: "exact" });
      if (role) q = q.eq("role", role);
      if (clause) q = q.or(clause);
      const { data, count, error } = await q.order("full_name").order("id").range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      total = count || 0;
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      rows = data || [];
      if (page <= pages) break;
      page = pages;
    }
  }
  return { rows, total, pages, page, counts };
}

// Re-read the directory and redraw it
async function load() {
  const seq = ++requestSeq;
  if (!state.rows.length) listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  else listEl.style.opacity = "0.5";
  try {
    const res = await fetchPage();
    if (seq !== requestSeq) return; // a newer request replaced this one
    state = res;
    listEl.style.opacity = "";
    render();
  } catch (err) {
    if (seq !== requestSeq) return;
    console.error(err);
    listEl.style.opacity = "";
    listEl.innerHTML = `<div class="banner banner-error">The directory couldn't be loaded. Please refresh the page.</div>`;
  }
}

function render() {
  const { rows, pages, page } = state;

  if (rows.length === 0) {
    listEl.innerHTML = `<div class="card empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 3.8-5.8 7-5.8s5.8 2 7 5.8"/></svg>
      <h3>No matches</h3><p>Try a different search or role filter.</p>
    </div>`;
    return;
  }

  const pager = pagerHtml(page, pages);

  listEl.innerHTML = `<div class="card">${rows
    .map(
      (p) => `
    <div class="list-row">
      <div class="avatar">${escapeHtml(initials(p.full_name))}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</div>
        ${
          p.contact_hidden
            ? `<div class="text-muted" style="font-size:0.82rem;">Contact details are hidden</div>`
            : `<div class="text-muted" style="font-size:0.82rem;">${p.email ? escapeHtml(p.email) : "no email on file"}</div>
        <div class="text-muted" style="font-size:0.82rem;">${p.phone ? escapeHtml(p.phone) : "no contact info provided"}</div>`
        }
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;align-self:stretch;gap:8px;flex-shrink:0;">
        <span class="tag tag-role-${escapeHtml(p.role)}">${escapeHtml(p.role)}</span>
        ${contactActions(p)}
      </div>
    </div>`
    )
    .join("")}</div>${pager}`;

bindPager(listEl, page, pages, (n) => {
    state.page = n;
    load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

searchInput.addEventListener("input", () => {
  state.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 300); // wait until typing pauses
});
roleFilter.addEventListener("change", () => {
  state.page = 1;
  load();
});

// Pager: first, previous, "Page [select] of N", next, last
function pagerHtml(page, pages) {
  if (pages <= 1) return "";
  const btn = (act, label, path, off) =>
    `<button type="button" class="icon-action sm" data-pg="${act}" title="${label}" aria-label="${label}" ${off ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></button>`;
  const options = Array.from({ length: pages }, (_, i) => `<option value="${i + 1}" ${i + 1 === page ? "selected" : ""}>${i + 1}</option>`).join("");
  return `<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;">
    ${btn("first", "First page", "M11 17l-5-5 5-5M18 17l-5-5 5-5", page <= 1)}
    ${btn("prev", "Previous page", "M15 18l-6-6 6-6", page <= 1)}
    <span class="text-muted" style="font-size:0.85rem;display:flex;align-items:center;gap:6px;white-space:nowrap;">Page
      <select data-pg="select" aria-label="Go to page" style="width:auto;min-width:0;padding:4px 24px 4px 8px;">${options}</select>
      of ${pages}</span>
    ${btn("next", "Next page", "M9 18l6-6-6-6", page >= pages)}
    ${btn("last", "Last page", "M13 17l5-5-5-5M6 17l5-5-5-5", page >= pages)}
  </div>`;
}

function bindPager(container, page, pages, goTo) {
  container.querySelector('[data-pg="first"]')?.addEventListener("click", () => goTo(1));
  container.querySelector('[data-pg="prev"]')?.addEventListener("click", () => goTo(page - 1));
  container.querySelector('[data-pg="next"]')?.addEventListener("click", () => goTo(page + 1));
  container.querySelector('[data-pg="last"]')?.addEventListener("click", () => goTo(pages));
  container.querySelector('[data-pg="select"]')?.addEventListener("change", (e) => goTo(Number(e.target.value)));
}

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
