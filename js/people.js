import { mountLayout } from "./layout.js";
import { supabase, initials } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "people", pageTitle: "People" });
if (!profile) throw new Error("redirecting");

const listEl = document.getElementById("people-list");
const searchInput = document.getElementById("search");
const roleFilter = document.getElementById("role-filter");

let people = [];

async function load() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role")
      .eq("is_active", true)
      .order("full_name");
    if (error) throw error;
    people = data || [];
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

  listEl.innerHTML = `<div class="card">${filtered
    .map(
      (p) => `
    <div class="list-row">
      <div class="avatar">${initials(p.full_name)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</div>
        <div class="text-muted" style="font-size:0.82rem;">${escapeHtml(p.email)}</div>
        <div class="text-muted" style="font-size:0.82rem;">${p.phone ? escapeHtml(p.phone) : "not yet provided"}</div>
      </div>
      <span class="tag tag-normal">${p.role}</span>
    </div>`
    )
    .join("")}</div>`;
}

searchInput.addEventListener("input", render);
roleFilter.addEventListener("change", render);

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

load();
