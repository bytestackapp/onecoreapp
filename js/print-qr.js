import { supabase, requireAuth } from "./supabase-client.js";
import { escapeHtml } from "./utils.js";

const profile = await requireAuth();
if (!profile) throw new Error("redirecting");
if (profile.role !== "admin") {
  window.location.href = "dashboard.html";
  throw new Error("redirecting");
}

const orgName = profile.organizations?.name || "";
const gridEl = document.getElementById("card-grid");
const titleEl = document.getElementById("toolbar-title");

async function fetchPeople() {
  const params = new URLSearchParams(window.location.search);
  const scope = params.get("scope");

  if (scope === "role") {
    const role = params.get("role");
    titleEl.textContent = `Print QR codes — ${role ? role.charAt(0).toUpperCase() + role.slice(1) + "s" : "Role"}`;
    const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "role", p_role: role });
    if (error) throw error;
    return data || [];
  }

  if (scope === "group") {
    const groupId = params.get("id");
    const { data: group } = await supabase.from("groups").select("name").eq("id", groupId).single();
    titleEl.textContent = `Print QR codes — ${group?.name || "Group"}`;
    const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "group", p_group: groupId });
    if (error) throw error;
    return data || [];
  }

  if (scope === "people") {
    let ids = [];
    try {
      ids = JSON.parse(sessionStorage.getItem("onecore_print_qr_ids") || "[]");
    } catch {
      ids = [];
    }
    titleEl.textContent = "Print QR codes — Selected people";
    if (ids.length === 0) return [];
    const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "people", p_ids: ids });
    if (error) throw error;
    return data || [];
  }

  // scope === "all" (default)
  titleEl.textContent = "Print QR codes — Everyone active";
  const { data, error } = await supabase.rpc("admin_qr_cards", { p_scope: "all" });
  if (error) throw error;
  return data || [];
}

function renderCards(people) {
  if (people.length === 0) {
    gridEl.innerHTML = `<div class="card empty-state" style="grid-column:1/-1;"><h3>Nobody to print</h3><p>No one matched this selection.</p></div>`;
    return;
  }

  gridEl.innerHTML = people
    .map(
      (p) => `
    <div class="id-card">
      <div class="photo-placeholder">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 3.8-5.8 7-5.8s5.8 2 7 5.8"/></svg>
      </div>
      <div class="qr-box" id="qr-${p.id}"></div>
      <div class="id-name">${escapeHtml(p.full_name)}</div>
      <div class="id-org">${escapeHtml(orgName)}</div>
    </div>`
    )
    .join("");

  people.forEach((p) => {
    const el = document.getElementById(`qr-${p.id}`);
    if (el && p.qr_token && window.QRCode) {
      new QRCode(el, { text: p.qr_token, width: 110, height: 110, correctLevel: QRCode.CorrectLevel.M });
    }
  });
}

// Parents and guests don't get QR codes: drop them whatever scope was requested
async function excludeNoQrRoles(people) {
  if (people.length === 0) return people;
  const allowed = new Set();
  const ids = people.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .in("id", ids.slice(i, i + 100))
      .neq("role", "parent")
      .neq("role", "guest");
    if (error) throw error;
    (data || []).forEach((r) => allowed.add(r.id));
  }
  return people.filter((p) => allowed.has(p.id));
}

document.getElementById("print-btn").addEventListener("click", () => window.print());

try {
  const people = await excludeNoQrRoles(await fetchPeople());
  renderCards(people);
} catch (err) {
  console.error(err);
  gridEl.innerHTML = `<div class="card empty-state" style="grid-column:1/-1;"><h3>Unable to load</h3><p>Please go back and try again.</p></div>`;
}
