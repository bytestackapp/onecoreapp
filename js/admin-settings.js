import { mountLayout } from "./layout.js";
import { supabase, timeAgo, friendlyError, getCurrentProfile } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "admin-settings", pageTitle: "Settings", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

document.getElementById("org-name").value = profile.organizations?.name || "";

document.getElementById("org-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const banner = document.getElementById("org-banner");
  banner.style.display = "none";
  try {
    const { error } = await supabase
      .from("organizations")
      .update({ name: document.getElementById("org-name").value.trim(), updated_at: new Date().toISOString() })
      .eq("id", profile.organization_id);
    if (error) throw error;
    await getCurrentProfile({ force: true });
    banner.className = "banner banner-success";
    banner.textContent = "Organization updated.";
    banner.style.display = "flex";
  } catch (err) {
    console.error(err);
    banner.className = "banner banner-error";
    banner.textContent = friendlyError(err, "Unable to save changes. Please try again.");
    banner.style.display = "flex";
  }
});

async function loadAudit() {
  const el = document.getElementById("audit-list");
  try {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("action, record_type, created_at, profiles(full_name)")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;

    if (!data || data.length === 0) {
      el.innerHTML = `<div class="empty-state"><h3>No activity recorded yet</h3></div>`;
      return;
    }

    el.innerHTML = data
      .map(
        (a) => `<div class="list-row">
        <div style="flex:1;">${escapeHtml(a.profiles?.full_name || "System")} — ${escapeHtml(a.action)}</div>
        <div class="text-muted" style="font-size:0.8rem;">${timeAgo(a.created_at)}</div>
      </div>`
      )
      .join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="banner banner-error">Activity log couldn't be loaded.</div>`;
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadAudit();
