import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "events", pageTitle: "Events" });
if (!profile) throw new Error("redirecting");

const canCreate = profile.role === "admin" || profile.role === "teacher";
const listEl = document.getElementById("events-list");
const newBtn = document.getElementById("new-btn");

function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

if (canCreate) newBtn.style.display = "inline-flex";

// -----------------------------------------------------------------
// Audience picker — same design as Announcements: role types, specific
// groups, or specific people, all combinable. "Clear" resets to Everyone.
// -----------------------------------------------------------------
const TYPE_LABELS = { everyone: "Everyone", teachers: "Teachers", students: "Students", parents: "Parents", guests: "Guests" };
let groupsCache = [];
let peopleCache = [];

function defaultAudience() {
  return { types: new Set(["everyone"]), groups: new Set(), users: new Set() };
}
function audienceCount(sel) {
  return sel.types.size + sel.groups.size + sel.users.size;
}
function audienceLabel(sel) {
  const n = audienceCount(sel);
  if (n === 0) return "Choose audience…";
  if (n > 1) return `Multiple (${n})`;
  if (sel.types.size) return TYPE_LABELS[[...sel.types][0]] || "Custom";
  if (sel.groups.size) {
    const g = groupsCache.find((x) => x.id === [...sel.groups][0]);
    return `Group: ${g?.name || "Unknown"}`;
  }
  const p = peopleCache.find((x) => x.id === [...sel.users][0]);
  return p?.full_name || "1 person";
}

async function loadAudienceOptions() {
  const [g, p] = await Promise.all([
    supabase.from("groups").select("id, name").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("organization_id", profile.organization_id).eq("is_active", true).neq("id", profile.id).order("full_name"),
  ]);
  groupsCache = g.data || [];
  peopleCache = p.data || [];
  if (g.error || p.error) {
    console.error(g.error || p.error);
    showToast("Couldn't load the groups and people lists.", "error");
  }
}

// Modal with checkboxes. Resolves to the new selection, or null if cancelled.
function audienceDialog(current) {
  return new Promise((resolve) => {
    const sel = { types: new Set(current.types), groups: new Set(current.groups), users: new Set(current.users) };

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="aud-title">
        <h3 id="aud-title">Choose audience</h3>
        <div class="aud-body">
          <div class="aud-list">
            ${Object.entries(TYPE_LABELS).map(([k, label]) => `<label class="aud-row"><input type="checkbox" data-kind="type" value="${k}" /><span>${label}</span></label>`).join("")}
          </div>
          ${
            groupsCache.length
              ? `<div class="ack-group-title">Specific groups</div>
                 <div class="aud-list">
                   ${groupsCache.map((g) => `<label class="aud-row"><input type="checkbox" data-kind="group" value="${g.id}" /><span>${escapeHtml(g.name)}</span></label>`).join("")}
                 </div>`
              : ""
          }
          <div class="ack-group-title">Specific people</div>
          <div class="field aud-search"><input type="search" id="aud-search" placeholder="Search by name…" autocomplete="off" /></div>
          <div class="aud-list" id="aud-people"></div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="clear">Clear</button>
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-act="done">Done</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const peopleEl = backdrop.querySelector("#aud-people");

    function syncChecks() {
      backdrop.querySelectorAll("input[data-kind]").forEach((cb) => {
        const set = cb.dataset.kind === "type" ? sel.types : cb.dataset.kind === "group" ? sel.groups : sel.users;
        cb.checked = set.has(cb.value);
      });
    }

    function renderPeople(query = "") {
      const term = query.trim().toLowerCase();
      const matches = peopleCache.filter((p) => !term || p.full_name.toLowerCase().includes(term)).slice(0, 100);
      peopleEl.innerHTML = matches.length
        ? matches.map((p) => `<label class="aud-row"><input type="checkbox" data-kind="user" value="${p.id}" /><span>${escapeHtml(p.full_name)}</span><span class="aud-meta">${escapeHtml(cap(p.role))}</span></label>`).join("")
        : `<div class="text-muted" style="padding:10px 0;font-size:0.85rem;">No matches</div>`;
      syncChecks();
    }
    renderPeople();

    backdrop.addEventListener("change", (e) => {
      const cb = e.target;
      if (!cb.matches || !cb.matches("input[data-kind]")) return;
      const kind = cb.dataset.kind;
      if (kind === "type") {
        if (cb.checked && cb.value === "everyone") {
          sel.types = new Set(["everyone"]);
          sel.groups.clear();
          sel.users.clear();
        } else if (cb.checked) {
          sel.types.delete("everyone");
          sel.types.add(cb.value);
        } else {
          sel.types.delete(cb.value);
        }
      } else {
        const set = kind === "group" ? sel.groups : sel.users;
        if (cb.checked) {
          set.add(cb.value);
          sel.types.delete("everyone");
        } else {
          set.delete(cb.value);
        }
      }
      syncChecks();
    });
    backdrop.querySelector("#aud-search").addEventListener("input", (e) => renderPeople(e.target.value));

    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    function close(value) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    backdrop.querySelector('[data-act="clear"]').addEventListener("click", () => {
      sel.types = new Set(["everyone"]);
      sel.groups.clear();
      sel.users.clear();
      syncChecks();
    });
    backdrop.querySelector('[data-act="done"]').addEventListener("click", () => {
      if (audienceCount(sel) === 0) {
        showToast("Choose at least one audience.", "error");
        return;
      }
      close(sel);
    });
  });
}

// -----------------------------------------------------------------
// New-event modal
// -----------------------------------------------------------------
async function newEventDialog() {
  if (groupsCache.length === 0 && peopleCache.length === 0) await loadAudienceOptions();
  let audienceSel = defaultAudience();

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ev-title">
      <h3 id="ev-title">New event</h3>
      <form id="ev-form">
        <div class="field">
          <label for="ev-title-input">Title</label>
          <input id="ev-title-input" required maxlength="150" />
        </div>
        <div class="field">
          <label for="ev-description">Description</label>
          <textarea id="ev-description" rows="3"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div class="field">
            <label for="ev-date">Date</label>
            <input id="ev-date" type="date" required />
          </div>
          <div class="field">
            <label for="ev-location">Location</label>
            <input id="ev-location" />
          </div>
          <div class="field">
            <label for="ev-start">Start time</label>
            <input id="ev-start" type="time" />
          </div>
          <div class="field">
            <label for="ev-end">End time</label>
            <input id="ev-end" type="time" />
          </div>
          <div class="field">
            <label for="ev-audience-btn">Audience</label>
            <button type="button" id="ev-audience-btn" class="audience-btn"></button>
          </div>
          <div class="field">
            <label for="ev-max">Max participants</label>
            <input id="ev-max" type="number" min="1" placeholder="No limit" />
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="ev-submit">Create event</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const audienceBtn = backdrop.querySelector("#ev-audience-btn");
  function renderAudienceBtn() {
    audienceBtn.textContent = audienceLabel(audienceSel);
  }
  renderAudienceBtn();
  audienceBtn.addEventListener("click", async () => {
    const result = await audienceDialog(audienceSel);
    if (result) {
      audienceSel = result;
      renderAudienceBtn();
    }
  });

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#ev-title-input").focus();

  backdrop.querySelector("#ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (audienceCount(audienceSel) === 0) {
      showToast("Choose at least one audience.", "error");
      return;
    }
    const submitBtn = backdrop.querySelector("#ev-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";

    const maxParticipants = backdrop.querySelector("#ev-max").value;
    const payload = {
      organization_id: profile.organization_id,
      title: backdrop.querySelector("#ev-title-input").value.trim(),
      description: backdrop.querySelector("#ev-description").value.trim() || null,
      event_date: backdrop.querySelector("#ev-date").value,
      start_time: backdrop.querySelector("#ev-start").value || null,
      end_time: backdrop.querySelector("#ev-end").value || null,
      location: backdrop.querySelector("#ev-location").value.trim() || null,
      audience_types: [...audienceSel.types],
      audience_group_ids: [...audienceSel.groups],
      audience_user_ids: [...audienceSel.users],
      max_participants: maxParticipants ? parseInt(maxParticipants, 10) : null,
      organizer_id: profile.id,
    };

    try {
      const { data, error } = await supabase.from("events").insert(payload).select().single();
      if (error) throw error;
      await logAudit({ action: "event.created", recordType: "event", recordId: data.id, details: { title: payload.title } });
      close();
      showToast("Event created.", "success");
      loadEvents();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to create this event. Please try again."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Create event";
    }
  });
}

newBtn?.addEventListener("click", newEventDialog);

// -----------------------------------------------------------------
// List + RSVP
// -----------------------------------------------------------------
async function loadEvents() {
  listEl.innerHTML = `<div class="skeleton" style="height:90px;margin-bottom:10px;"></div>`;
  try {
    const today = localDate();
    const { data, error } = await supabase
      .from("events")
      .select("id, title, description, event_date, start_time, end_time, location, rsvp_enabled, max_participants, status, organizer_id, profiles!events_organizer_id_fkey(full_name)")
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
            <div style="min-width:0;">
              <h3 style="margin:0;">${escapeHtml(e.title)}</h3>
              ${e.profiles?.full_name ? `<div class="text-muted" style="font-size:0.82rem;margin-top:2px;">${escapeHtml(e.profiles.full_name)}</div>` : ""}
              <div class="text-muted" style="font-size:0.85rem;margin-top:2px;">
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
    listEl.innerHTML = `<div class="card empty-state"><h3>Events couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Events couldn't be loaded.", "error");
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

loadEvents();
