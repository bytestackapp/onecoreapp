// App settings dialog (Settings page). One card on the page opens this dialog with every app setting,
// grouped by topic. To add another setting later, put a new field inside a group in openAppSettingsDialog().

import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const PEOPLE_PRIVACY_HINTS = {
  staff: "Students and parents see only the email and phone of admins and teachers. Admins and teachers see everyone's.",
  everyone: "Everyone in the organization can see each other's email and phone number on the People page.",
  none: "Students and parents can't see anyone's email or phone number. Admins and teachers still see everyone's.",
};

export function initAppSettings({ profile, actionLabels }) {
  if (actionLabels) actionLabels["settings.people_privacy_changed"] = "- changed who can see contact details";
  document.getElementById("app-settings-btn")?.addEventListener("click", () => openAppSettingsDialog(profile));
}

async function openAppSettingsDialog(profile) {
  let current = "everyone";
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("people_contact_visibility")
      .eq("id", profile.organization_id)
      .single();
    if (error) throw error;
    current = data?.people_contact_visibility || "everyone";
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to load the app settings."), "error");
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="as-title">
      <h3 id="as-title">App settings</h3>
      <form id="as-form">
        <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;opacity:0.65;margin:4px 0 10px;">People setting</div>
        <div class="field">
          <label for="as-privacy">Privacy</label>
          <select id="as-privacy">
            <option value="staff" ${current === "staff" ? "selected" : ""}>Staff Only</option>
            <option value="everyone" ${current === "everyone" ? "selected" : ""}>Everyone</option>
            <option value="none" ${current === "none" ? "selected" : ""}>None</option>
          </select>
          <div class="field-hint" id="as-privacy-hint"></div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="as-submit">Save</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);

  const privacySelect = backdrop.querySelector("#as-privacy");
  const privacyHint = backdrop.querySelector("#as-privacy-hint");
  const showHint = () => { privacyHint.textContent = PEOPLE_PRIVACY_HINTS[privacySelect.value] || ""; };
  privacySelect.addEventListener("change", showHint);
  showHint();

  backdrop.querySelector("#as-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#as-submit");
    const value = privacySelect.value;
    if (value === current) {
      close();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      const { error } = await supabase
        .from("organizations")
        .update({ people_contact_visibility: value, updated_at: new Date().toISOString() })
        .eq("id", profile.organization_id);
      if (error) throw error;
      await logAudit({
        action: "settings.people_privacy_changed",
        recordType: "organization",
        recordId: profile.organization_id,
        details: { from: current, to: value },
      });
      showToast("App settings saved.", "success");
      close();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to save the app settings."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}
