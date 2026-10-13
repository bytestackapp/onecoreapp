import { mountLayout, sectionHead } from "./layout.js";
import { supabase, initials, friendlyError, getCurrentProfile } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { initChildDeviceCard, openFindMyChild, FMC_ICON } from "./find-my-child.js";

const profile = await mountLayout({ activeKey: "profile", pageTitle: "Profile" });
if (!profile) throw new Error("redirecting");

const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const ICON = {
  edit: svg('<path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1"/>'),
  child: svg('<circle cx="12" cy="5.5" r="2.5"/><path d="M12 8.5v6M7.5 11l4.5 1.5 4.5-1.5M9 21l3-6.5 3 6.5"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
};

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Block 1: identity ----------
document.getElementById("profile-avatar").textContent = initials(profile.full_name);
document.getElementById("profile-role").textContent = profile.role;
document.getElementById("profile-role").className = `tag tag-role-${profile.role}`;
if (profile.organizations?.name) {
  document.getElementById("profile-academy").textContent = `${profile.organizations.name}`;
}

// ---------- Section headers ----------
document.getElementById("basic-head").innerHTML = sectionHead({ title: "Basic Information", icon: ICON.user, tone: "info" });
document.getElementById("security-head").innerHTML = sectionHead({ title: "Security Details", icon: ICON.lock, tone: "info" });
// Edit button lives inside the section header (same as the eye icon on Attendance)
const editBtn = document.createElement("button");
editBtn.type = "button";
editBtn.id = "edit-profile-btn";
editBtn.className = "icon-action sm";
editBtn.title = "Edit";
editBtn.setAttribute("aria-label", "Edit basic information");
editBtn.style.marginLeft = "auto";
editBtn.innerHTML = ICON.edit;
const basicHead = document.getElementById("basic-head");
(basicHead.querySelector(".section-head") || basicHead).appendChild(editBtn);

// ---------- Block 2: basic information (read-only view) ----------
function renderProfile() {
  document.getElementById("profile-name").textContent = profile.full_name || "—";
  document.getElementById("profile-avatar").textContent = initials(profile.full_name);
  document.getElementById("view-full-name").textContent = profile.full_name || "—";
  document.getElementById("view-email").textContent = profile.email || "—";
  document.getElementById("view-phone").textContent = profile.phone || "—";
}
renderProfile();

// ---------- Edit modal: name and phone (email is fixed) ----------
function openEditDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="edit-profile-title">
      <h3 id="edit-profile-title">Edit basic information</h3>
      <div class="banner banner-error" id="edit-profile-error" style="display:none;"></div>
      <div class="field">
        <label for="edit-full-name">Full name</label>
        <input id="edit-full-name" value="${escapeHtml(profile.full_name || "")}" autocomplete="name" />
      </div>
      <div class="field">
        <label for="edit-email">Email</label>
        <input id="edit-email" value="${escapeHtml(profile.email || "")}" disabled />
        <div class="field-hint">Contact an administrator to change your email.</div>
      </div>
      <div class="field">
        <label for="edit-phone">Phone</label>
        <input id="edit-phone" type="tel" value="${escapeHtml(profile.phone || "")}" autocomplete="tel" />
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const nameInput = backdrop.querySelector("#edit-full-name");
  const phoneInput = backdrop.querySelector("#edit-phone");
  const errorEl = backdrop.querySelector("#edit-profile-error");
  const saveBtn = backdrop.querySelector('[data-act="save"]');
  nameInput.focus();

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);

  saveBtn.addEventListener("click", async () => {
    errorEl.style.display = "none";
    const fullName = nameInput.value.trim();
    const phone = phoneInput.value.trim() || null;
    if (!fullName) {
      errorEl.textContent = "Please enter your full name.";
      errorEl.style.display = "flex";
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName, phone, updated_at: new Date().toISOString() })
        .eq("id", profile.id);
      if (error) throw error;

      await getCurrentProfile({ force: true });
      profile.full_name = fullName;
      profile.phone = phone;
      renderProfile();
      showToast("Profile updated.", "success");
      close();
    } catch (err) {
      console.error(err);
      errorEl.textContent = friendlyError(err, "Unable to save your profile. Please try again.");
      errorEl.style.display = "flex";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}
document.getElementById("edit-profile-btn").addEventListener("click", openEditDialog);

// ---------- Linked Student block: the students (children) linked to this user ----------
async function loadLinkedStudents() {
  const section = document.getElementById("linked-students-section");
  const listEl = document.getElementById("linked-students-list");
  const isParent = profile.role === "parent";

  const show = (build) => {
    document.getElementById("linked-head").innerHTML = sectionHead({ title: "Linked Student", icon: ICON.child, tone: "info" });
    listEl.replaceChildren();
    build();
    section.style.display = "";
  };
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "text-muted";
    p.style.margin = "0";
    p.textContent = text;
    listEl.appendChild(p);
  };

  try {
    const { data, error } = await supabase
      .from("guardians")
      .select("id, student_id, profiles!guardians_student_id_fkey(full_name)")
      .eq("parent_id", profile.id);
    if (error) throw error;

    const students = (data || [])
      .map((l) => ({ id: l.student_id, name: l.profiles?.full_name }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // Parents always see the block; teachers/admins only when they have a linked student
    if (!isParent && students.length === 0) return;

    show(() => {
      if (students.length === 0) {
        note("No student linked yet. Contact an administrator to link your child.");
        return;
      }
      students.forEach((student) => {
        const row = document.createElement("div");
        row.className = "info-row";
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;";

        const nameEl = document.createElement("div");
        nameEl.className = "info-value";
        nameEl.textContent = student.name;
        row.appendChild(nameEl);

        // Find My Child: anyone with a linked student (parent, teacher or admin) gets the button
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-primary btn-sm fmc-btn";
        btn.setAttribute("aria-label", `Find My Child: ${student.name}`);
        btn.innerHTML = `${FMC_ICON}<span>Find My Child</span>`;
        btn.addEventListener("click", () => openFindMyChild({ childId: student.id, childName: student.name }));
        row.appendChild(btn);

        listEl.appendChild(row);
      });
    });
  } catch (err) {
    console.error(err);
    if (!isParent) return;
    show(() => note("Linked students couldn't be loaded. Please refresh the page."));
  }
}

loadLinkedStudents();
initChildDeviceCard(profile);
