import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "events", pageTitle: "Events" });
if (!profile) throw new Error("redirecting");

const canCreate = profile.role === "admin" || profile.role === "teacher";
const listEl = document.getElementById("events-list");
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
  supabase
    .from("groups")
    .select("id, name")
    .order("name")
    .then(({ data }) => {
      groupSelect.innerHTML = (data || []).map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
    });
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";

  const audience = audienceSelect.value;
  const maxParticipants = document.getElementById("max_participants").value;

  const payload = {
    organization_id: profile.organization_id,
    title: document.getElementById("title").value.trim(),
    description: document.getElementById("description").value.trim() || null,
    event_date: document.getElementById("event_date").value,
    start_time: document.getElementById("start_time").value || null,
    end_time: document.getElementById("end_time").value || null,
    location: document.getElementById("location").value.trim() || null,
    audience_type: audience,
    audience_group_id: audience === "group" ? groupSelect.value : null,
    max_participants: maxParticipants ? parseInt(maxParticipants, 10) : null,
    organizer_id: profile.id,
  };

  try {
    const { data, error } = await supabase.from("events").insert(payload).select().single();
    if (error) throw error;
    await logAudit({ action: "event.created", recordType: "event", recordId: data.id, details: { title: payload.title } });
    formWrap.style.display = "none";
    form.reset();
    showToast("Event created.", "success");
    loadEvents();
  } catch (err) {
    console.error(err);
    formError.textContent = friendlyError(err, "Unable to create this event. Please try again.");
    formError.style.display = "flex";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create event";
  }
});

async function loadEvents() {
  listEl.innerHTML = `<div class="skeleton" style="height:90px;margin-bottom:10px;"></div>`;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("events")
      .select("id, title, description, event_date, start_time, end_time, location, rsvp_enabled, max_participants, status")
      .gte("event_date", today)
      .order("event_date", { ascending: true });
    if (error) throw error;

    const events = (data || []).filter((e) => e.status !== "cancelled");
    if (events.length === 0) {
      listEl.innerHTML = `<div class="card empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
        <h3>No upcoming events</h3><p>New events will appear here as soon as they're scheduled.</p>
      </div>`;
      return;
    }

    const rsvps = await loadRsvpMap(events.map((e) => e.id));

    listEl.innerHTML = events
      .map((e) => {
        const myRsvp = rsvps[e.id]?.rsvp_status;
        return `
        <div class="card" style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;gap:10px;">
            <div>
              <h3 style="margin:0;">${escapeHtml(e.title)}</h3>
              <div class="text-muted" style="font-size:0.85rem;">
                ${formatDate(e.event_date)}${e.start_time ? " · " + e.start_time.slice(0, 5) : ""}${e.end_time ? "–" + e.end_time.slice(0, 5) : ""}
                ${e.location ? " · " + escapeHtml(e.location) : ""}
              </div>
            </div>
          </div>
          ${e.description ? `<p style="margin-top:10px;">${escapeHtml(e.description)}</p>` : ""}
          ${
            e.rsvp_enabled
              ? `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
                  ${rsvpButton(e.id, "attending", "Attending", myRsvp)}
                  ${rsvpButton(e.id, "maybe", "Maybe", myRsvp)}
                  ${rsvpButton(e.id, "not_attending", "Not attending", myRsvp)}
                </div>`
              : ""
          }
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".rsvp-btn").forEach((btn) => {
      btn.addEventListener("click", () => rsvp(btn.getAttribute("data-event"), btn.getAttribute("data-status")));
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="banner banner-error">Events couldn't be loaded. Please refresh the page.</div>`;
  }
}

function rsvpButton(eventId, status, label, current) {
  const active = current === status;
  return `<button class="btn btn-sm ${active ? "btn-primary" : "btn-secondary"} rsvp-btn" data-event="${eventId}" data-status="${status}">${label}</button>`;
}

async function loadRsvpMap(eventIds) {
  if (eventIds.length === 0) return {};
  const { data, error } = await supabase
    .from("event_participants")
    .select("event_id, rsvp_status")
    .eq("profile_id", profile.id)
    .in("event_id", eventIds);
  if (error) {
    console.error(error);
    return {};
  }
  const map = {};
  (data || []).forEach((row) => (map[row.event_id] = row));
  return map;
}

async function rsvp(eventId, status) {
  try {
    const { error } = await supabase.from("event_participants").upsert(
      { event_id: eventId, profile_id: profile.id, rsvp_status: status, responded_at: new Date().toISOString() },
      { onConflict: "event_id,profile_id" }
    );
    if (error) throw error;
    loadEvents();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to save your RSVP. Please try again."), "error");
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadEvents();
