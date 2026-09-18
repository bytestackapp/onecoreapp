import { mountLayout } from "./layout.js";
import { supabase, initials, friendlyError, getCurrentProfile } from "./supabase-client.js";

const profile = await mountLayout({ activeKey: "profile", pageTitle: "Profile" });
if (!profile) throw new Error("redirecting");

document.getElementById("profile-avatar").textContent = initials(profile.full_name);
document.getElementById("profile-name").textContent = profile.full_name;
document.getElementById("profile-role").textContent = profile.role;
document.getElementById("full_name").value = profile.full_name || "";
document.getElementById("email").value = profile.email || "";
document.getElementById("phone").value = profile.phone || "";

const form = document.getElementById("profile-form");
const banner = document.getElementById("form-banner");
const saveBtn = document.getElementById("save-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  banner.style.display = "none";
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: document.getElementById("full_name").value.trim(),
        phone: document.getElementById("phone").value.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);
    if (error) throw error;

    await getCurrentProfile({ force: true });
    banner.className = "banner banner-success";
    banner.textContent = "Profile updated.";
    banner.style.display = "flex";
    document.getElementById("profile-name").textContent = document.getElementById("full_name").value.trim();
  } catch (err) {
    console.error(err);
    banner.className = "banner banner-error";
    banner.textContent = friendlyError(err, "Unable to save your profile. Please try again.");
    banner.style.display = "flex";
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save changes";
  }
});
