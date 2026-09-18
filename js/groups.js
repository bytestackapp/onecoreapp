import { mountLayout } from "./layout.js";
import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "groups", pageTitle: "Groups" });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
const listEl = document.getElementById("groups-list");

if (isAdmin) {
  document.getElementById("new-btn").style.display = "inline-flex";
}

document.getElementById("new-btn")?.addEventListener("click", () => (document.getElementById("new-form-wrap").style.display = "block"));
document.getElementById("cancel-btn")?.addEventListener("click", () => {
  document.getElementById("new-form-wrap").style.display = "none";
  document.getElementById("new-form").reset();
});

document.getElementById("new-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("form-error");
  errorEl.style.display = "none";
  try {
    const { data, error } = await supabase
      .from("groups")
      .insert({
        organization_id: profile.organization_id,
        name: document.getElementById("name").value.trim(),
        group_type: document.getElementById("group_type").value,
        description: document.getElementById("description").value.trim() || null,
        created_by: profile.id,
      })
      .select()
      .single();
    if (error) throw error;
    await logAudit({ action: "group.created", recordType: "group", recordId: data.id });
    document.getElementById("new-form-wrap").style.display = "none";
    document.getElementById("new-form").reset();
    showToast("Group created.", "success");
    loadGroups();
  } catch (err) {
    console.error(err);
    errorEl.textContent = friendlyError(err, "Unable to create this group. Please try again.");
    errorEl.style.display = "flex";
  }
});

async function loadGroups() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    let query = supabase.from("groups").select("id, name, group_type, description, group_members(count)").order("name");
    if (!isAdmin) {
      // Non-admins only see groups they belong to.
      const { data: memberships } = await supabase.from("group_members").select("group_id").eq("profile_id", profile.id);
      const ids = (memberships || []).map((m) => m.group_id);
      if (ids.length === 0) {
        listEl.innerHTML = emptyState();
        return;
      }
      query = query.in("id", ids);
    }
    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      listEl.innerHTML = emptyState();
      return;
    }

    listEl.innerHTML = data
      .map(
        (g) => `
        <div class="card" style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <h3 style="margin:0;">${escapeHtml(g.name)}</h3>
            <span class="tag tag-normal">${g.group_type}</span>
          </div>
          ${g.description ? `<p>${escapeHtml(g.description)}</p>` : ""}
          <div class="text-muted" style="font-size:0.82rem;">${g.group_members?.[0]?.count ?? 0} member(s)</div>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">Groups couldn't be loaded. Please refresh the page.</div>`;
  }
}

function emptyState() {
  return `<div class="card empty-state"><h3>No groups yet</h3><p>${isAdmin ? "Create your first class or group to get started." : "You haven't been added to a group yet."}</p></div>`;
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadGroups();
