import { mountLayout } from "./layout.js";
import { supabase, formatDateTime, priorityLabel, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "announcements", pageTitle: "Announcements" });
if (!profile) throw new Error("redirecting");

const canCreate = profile.role === "admin" || profile.role === "teacher";
const listEl = document.getElementById("announcements-list");
const newBtn = document.getElementById("new-btn");
const formWrap = document.getElementById("new-form-wrap");
const form = document.getElementById("new-form");
const formError = document.getElementById("form-error");
const audienceSelect = document.getElementById("audience");
const groupField = document.getElementById("group-field");
const groupSelect = document.getElementById("group-select");
const submitBtn = document.getElementById("submit-btn");

if (canCreate) {
  newBtn.style.display = "inline-flex";
  loadGroupsForForm();
}

newBtn.addEventListener("click", () => (formWrap.style.display = "block"));
document.getElementById("cancel-btn").addEventListener("click", () => {
  formWrap.style.display = "none";
  form.reset();
  formError.style.display = "none";
});
audienceSelect.addEventListener("change", () => {
  groupField.style.display = audienceSelect.value === "group" ? "block" : "none";
});

async function loadGroupsForForm() {
  const { data } = await supabase.from("groups").select("id, name").order("name");
  groupSelect.innerHTML = (data || []).map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Publishing…";

  const audience = audienceSelect.value;
  const payload = {
    organization_id: profile.organization_id,
    title: document.getElementById("title").value.trim(),
    content: document.getElementById("content").value.trim(),
    priority: document.getElementById("priority").value,
    audience_type: audience,
    audience_group_id: audience === "group" ? groupSelect.value : null,
    requires_acknowledgment: document.getElementById("requires-ack").checked,
    created_by: profile.id,
  };

  try {
    const { data, error } = await supabase.from("announcements").insert(payload).select().single();
    if (error) throw error;
    await logAudit({ action: "announcement.created", recordType: "announcement", recordId: data.id, details: { title: payload.title } });
    formWrap.style.display = "none";
    form.reset();
    showToast("Announcement published.", "success");
    loadAnnouncements();
  } catch (err) {
    console.error(err);
    formError.textContent = friendlyError(err, "Unable to publish this announcement. Please try again.");
    formError.style.display = "flex";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Publish";
  }
});

async function loadAnnouncements() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("announcements")
      .select("id, title, content, priority, requires_acknowledgment, created_at, expires_at")
      .order("publish_at", { ascending: false });
    if (error) throw error;

    if (!data || data.length === 0) {
      listEl.innerHTML = `<div class="card empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 11v2a2 2 0 002 2h1l3.5 5v-14L6 11H5a2 2 0 00-2 2z"/></svg>
        <h3>No announcements yet</h3><p>Nothing has been posted for you to see right now.</p>
      </div>`;
      return;
    }

    const acks = await loadAckMap(data.map((a) => a.id));

    listEl.innerHTML = data
      .map((a) => {
        const ack = acks[a.id];
        const needsAck = a.requires_acknowledgment && !ack?.acknowledged_at;
        return `
        <div class="card" style="margin-bottom:12px;" data-id="${a.id}">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div class="priority-rail tag-${a.priority}" style="align-self:stretch;"></div>
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">
                <h3 style="margin:0;">${escapeHtml(a.title)}</h3>
                <span class="tag tag-${a.priority}">${priorityLabel(a.priority)}</span>
              </div>
              <p style="white-space:pre-wrap;">${escapeHtml(a.content)}</p>
              <div class="text-muted" style="font-size:0.8rem;display:flex;justify-content:space-between;align-items:center;">
                <span>${formatDateTime(a.created_at)}</span>
                ${
                  a.requires_acknowledgment
                    ? needsAck
                      ? `<button class="btn btn-primary btn-sm ack-btn" data-id="${a.id}">Acknowledge</button>`
                      : `<span class="tag tag-approved">Acknowledged</span>`
                    : ""
                }
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".ack-btn").forEach((btn) => {
      btn.addEventListener("click", () => acknowledge(btn.getAttribute("data-id"), btn));
    });

    // Mark all rendered announcements as "viewed" (fire and forget).
    data.forEach((a) => markViewed(a.id, acks[a.id]));
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">Announcements couldn't be loaded. Please refresh the page.</div>`;
  }
}

async function loadAckMap(announcementIds) {
  if (announcementIds.length === 0) return {};
  const { data, error } = await supabase
    .from("announcement_acknowledgments")
    .select("announcement_id, viewed_at, acknowledged_at")
    .eq("profile_id", profile.id)
    .in("announcement_id", announcementIds);
  if (error) {
    console.error(error);
    return {};
  }
  const map = {};
  (data || []).forEach((row) => (map[row.announcement_id] = row));
  return map;
}

async function markViewed(announcementId, existing) {
  if (existing?.viewed_at) return;
  try {
    await supabase.from("announcement_acknowledgments").upsert(
      { announcement_id: announcementId, profile_id: profile.id, viewed_at: new Date().toISOString() },
      { onConflict: "announcement_id,profile_id", ignoreDuplicates: false }
    );
  } catch (err) {
    console.error("markViewed failed:", err);
  }
}

async function acknowledge(announcementId, btn) {
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const { error } = await supabase.from("announcement_acknowledgments").upsert(
      {
        announcement_id: announcementId,
        profile_id: profile.id,
        viewed_at: new Date().toISOString(),
        acknowledged_at: new Date().toISOString(),
      },
      { onConflict: "announcement_id,profile_id" }
    );
    if (error) throw error;
    btn.outerHTML = `<span class="tag tag-approved">Acknowledged</span>`;
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Acknowledge";
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadAnnouncements();
