import { mountLayout } from "./layout.js";
import { supabase, formatDate, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";
import { todayPH } from "./time.js";

const profile = await mountLayout({ activeKey: "events", pageTitle: "Events" });
if (!profile) throw new Error("redirecting");

const canCreate = profile.role === "admin" || profile.role === "teacher";
const listEl = document.getElementById("events-list");
const newBtn = document.getElementById("new-btn");

const ICON = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>`,
};
let eventsCache = [];

function audienceFromEvent(e) {
  return {
    types: new Set(e.audience_types || []),
    groups: new Set(e.audience_group_ids || []),
    users: new Set(e.audience_user_ids || []),
  };
}

function localDate() {
  return todayPH(); // today in Philippine time
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

// -----------------------------------------------------------------
// Online meeting platforms (shown in the picker, stored as the `id`)
// -----------------------------------------------------------------
const PLATFORMS = [
  { id: "zoom", label: "Zoom", hosts: ["zoom.us", "zoom.com"] },
  { id: "meet", label: "Google Meet", hosts: ["meet.google.com"] },
  { id: "teams", label: "Teams", hosts: ["teams.microsoft.com", "teams.live.com"] },
  { id: "webex", label: "Webex", hosts: ["webex.com"] },
  { id: "messenger", label: "Messenger", hosts: ["messenger.com", "m.me", "facebook.com"] },
  { id: "other", label: "Other", hosts: [] },
];
const platformLabel = (id) => PLATFORMS.find((p) => p.id === id)?.label || "Online";

// Only http(s) links are ever used as a href (blocks javascript: and similar).
function isHttpUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
}
function hostMatches(url, platform) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return platform.hosts.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

const VIDEO_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`;

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
    supabase.from("groups").select("id, name").eq("organization_id", profile.organization_id).order("name"),
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
// Online meeting picker — choose a platform, then paste the link/details.
// Resolves to { platform, link, details }, { remove: true }, or null (cancelled).
// -----------------------------------------------------------------
function meetingDialog(current) {
  return new Promise((resolve) => {
    let platform = current?.platform || null;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="mt-title">
        <h3 id="mt-title">Online meeting</h3>
        <div class="text-muted" style="font-size:0.85rem;margin-bottom:10px;">Choose the platform, then paste the meeting link or details.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
          ${PLATFORMS.map(
            (p) => `<button type="button" data-plat="${p.id}" style="display:flex;align-items:center;gap:8px;padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.35);background:transparent;color:inherit;cursor:pointer;text-align:left;font:inherit;">${VIDEO_ICON}<span>${p.label}</span></button>`
          ).join("")}
        </div>
        <div class="field">
          <label for="mt-link">Meeting link</label>
          <input id="mt-link" type="url" inputmode="url" placeholder="https://" autocomplete="off" />
          <div id="mt-hint" class="text-muted" style="font-size:0.78rem;margin-top:4px;"></div>
        </div>
        <div class="field">
          <label for="mt-details">Meeting details (optional)</label>
          <textarea id="mt-details" rows="4" maxlength="2000" placeholder="Meeting ID, passcode, dial-in number… or paste the full invite"></textarea>
        </div>
        <div class="dialog-actions">
          ${current ? `<button type="button" class="btn btn-secondary" data-act="remove">Remove</button>` : ""}
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-act="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const linkEl = backdrop.querySelector("#mt-link");
    const detailsEl = backdrop.querySelector("#mt-details");
    const hintEl = backdrop.querySelector("#mt-hint");
    linkEl.value = current?.link || "";
    detailsEl.value = current?.details || "";

    function syncPlatforms() {
      backdrop.querySelectorAll("[data-plat]").forEach((b) => {
        const on = b.dataset.plat === platform;
        b.style.borderColor = on ? "#2952e3" : "rgba(128,128,128,0.35)";
        b.style.background = on ? "rgba(41,82,227,0.10)" : "transparent";
        b.style.fontWeight = on ? "600" : "400";
      });
    }
    function updateHint() {
      const p = PLATFORMS.find((x) => x.id === platform);
      const link = linkEl.value.trim();
      hintEl.textContent =
        p && p.hosts.length && link && isHttpUrl(link) && !hostMatches(link, p)
          ? `This doesn't look like a ${p.label} link. You can still save it.`
          : "";
    }
    syncPlatforms();
    updateHint();

    backdrop.querySelectorAll("[data-plat]").forEach((b) =>
      b.addEventListener("click", () => {
        platform = b.dataset.plat;
        syncPlatforms();
        updateHint();
      })
    );
    linkEl.addEventListener("input", updateHint);

    // Capture phase + stopImmediatePropagation so Escape closes only this
    // dialog, not the New-event modal underneath it.
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        close(null);
      }
    };
    function close(value) {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    backdrop.querySelector('[data-act="remove"]')?.addEventListener("click", () => close({ remove: true }));
    backdrop.querySelector('[data-act="save"]').addEventListener("click", () => {
      if (!platform) {
        showToast("Choose a meeting platform.", "error");
        return;
      }
      let link = linkEl.value.trim();
      const details = detailsEl.value.trim();
      // No link typed? Use the first link found in the pasted details.
      if (!link) {
        const found = details.match(/https?:\/\/[^\s<>"']+/);
        if (found) link = found[0];
      }
      if (!link && !details) {
        showToast("Add the meeting link or details.", "error");
        return;
      }
      if (link && !isHttpUrl(link)) {
        showToast("Enter a valid link starting with https://", "error");
        return;
      }
      close({ platform, link: link || null, details: details || null });
    });
  });
}

// -----------------------------------------------------------------
// New-event modal
// -----------------------------------------------------------------
async function newEventDialog(existing = null) {
  if (groupsCache.length === 0 && peopleCache.length === 0) await loadAudienceOptions();
  let audienceSel = existing ? audienceFromEvent(existing) : defaultAudience();

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ev-title" style="max-width:460px;">
      <h3 id="ev-title">${existing ? "Edit event" : "New event"}</h3>
      <form id="ev-form">
        <div class="field">
          <label for="ev-title-input">Title</label>
          <input id="ev-title-input" required maxlength="150" />
        </div>
        <div class="field">
          <label for="ev-description">Description</label>
          <textarea id="ev-description" rows="3"></textarea>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="field">
            <label for="ev-date">Date</label>
            <input id="ev-date" type="date" required />
          </div>
          <div class="field">
            <label for="ev-audience-btn">Audience</label>
            <button type="button" id="ev-audience-btn" class="audience-btn"></button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="field">
            <label for="ev-start">Start time</label>
            <input id="ev-start" type="time" />
          </div>
          <div class="field">
            <label for="ev-end">End time</label>
            <input id="ev-end" type="time" />
          </div>
        </div>

        <div class="field">
          <label for="ev-location">Location</label>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <button type="button" class="btn btn-sm btn-primary" id="ev-loc-inperson" style="flex:1;">In person</button>
            <button type="button" class="btn btn-sm btn-secondary" id="ev-loc-online" style="flex:1;">Online</button>
          </div>
          <input id="ev-location" placeholder="Room, building or address" />
          <button type="button" id="ev-meeting-btn" class="audience-btn" style="display:none;"></button>
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="ev-submit">${existing ? "Save changes" : "Create event"}</button>
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

  // Location: typed place (In person) or an online meeting (Online).
  let locMode = existing?.is_online ? "online" : "in_person";
  let meeting = existing?.is_online
    ? { platform: existing.meeting_platform, link: existing.meeting_link, details: existing.meeting_details }
    : null; // { platform, link, details }
  const locInput = backdrop.querySelector("#ev-location");
  if (existing) {
    backdrop.querySelector("#ev-title-input").value = existing.title || "";
    backdrop.querySelector("#ev-description").value = existing.description || "";
    backdrop.querySelector("#ev-date").value = existing.event_date || "";
    backdrop.querySelector("#ev-start").value = (existing.start_time || "").slice(0, 5);
    backdrop.querySelector("#ev-end").value = (existing.end_time || "").slice(0, 5);
    if (!existing.is_online) locInput.value = existing.location || "";
  }
  const meetingBtn = backdrop.querySelector("#ev-meeting-btn");
  const inPersonBtn = backdrop.querySelector("#ev-loc-inperson");
  const onlineBtn = backdrop.querySelector("#ev-loc-online");

  function renderLocation() {
    const online = locMode === "online";
    inPersonBtn.className = `btn btn-sm ${online ? "btn-secondary" : "btn-primary"}`;
    onlineBtn.className = `btn btn-sm ${online ? "btn-primary" : "btn-secondary"}`;
    locInput.style.display = online ? "none" : "";
    meetingBtn.style.display = online ? "" : "none";
    meetingBtn.textContent = meeting
      ? `${platformLabel(meeting.platform)} · ${meeting.link ? "link added" : "details added"}`
      : "Set up online meeting…";
  }
  async function editMeeting() {
    const result = await meetingDialog(meeting);
    if (result?.remove) {
      meeting = null;
      locMode = "in_person";
    } else if (result) {
      meeting = result;
    } else if (!meeting) {
      locMode = "in_person"; // cancelled with nothing saved
    }
    renderLocation();
  }
  inPersonBtn.addEventListener("click", () => {
    locMode = "in_person";
    renderLocation();
  });
  onlineBtn.addEventListener("click", () => {
    locMode = "online";
    renderLocation();
    if (!meeting) editMeeting();
  });
  meetingBtn.addEventListener("click", editMeeting);
  renderLocation();

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
    if (locMode === "online" && !meeting) {
      showToast("Set up the online meeting first.", "error");
      return;
    }
    const submitBtn = backdrop.querySelector("#ev-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = existing ? "Saving…" : "Creating…";

    const payload = {
      organization_id: profile.organization_id,
      title: backdrop.querySelector("#ev-title-input").value.trim(),
      description: backdrop.querySelector("#ev-description").value.trim() || null,
      event_date: backdrop.querySelector("#ev-date").value,
      start_time: backdrop.querySelector("#ev-start").value || null,
      end_time: backdrop.querySelector("#ev-end").value || null,
      // Online events also get a readable location so other screens (e.g. the dashboard) still show something.
      location: locMode === "online" ? `Online · ${platformLabel(meeting.platform)}` : locInput.value.trim() || null,
      is_online: locMode === "online",
      meeting_platform: locMode === "online" ? meeting.platform : null,
      meeting_link: locMode === "online" ? meeting.link : null,
      meeting_details: locMode === "online" ? meeting.details : null,
      audience_types: [...audienceSel.types],
      audience_group_ids: [...audienceSel.groups],
      audience_user_ids: [...audienceSel.users],
      organizer_id: profile.id,
    };

    try {
      if (existing) {
        // The creator and organization never change when editing.
        const { organization_id, organizer_id, ...changes } = payload;
        const { data, error } = await supabase
          .from("events")
          .update({ ...changes, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select("id");
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("row-level security"); // blocked silently by RLS
        await logAudit({ action: "event.updated", recordType: "event", recordId: existing.id, details: { title: payload.title } });
        close();
        showToast("Event updated.", "success");
      } else {
        const { data, error } = await supabase.from("events").insert(payload).select().single();
        if (error) throw error;
        await logAudit({ action: "event.created", recordType: "event", recordId: data.id, details: { title: payload.title } });
        close();
        showToast("Event created.", "success");
      }
      loadEvents();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, existing ? "Unable to save your changes. Please try again." : "Unable to create this event. Please try again."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = existing ? "Save changes" : "Create event";
    }
  });
}

newBtn?.addEventListener("click", () => newEventDialog());

// -----------------------------------------------------------------
// List + RSVP
// -----------------------------------------------------------------
async function loadEvents() {
  listEl.innerHTML = `<div class="skeleton" style="height:90px;margin-bottom:10px;"></div>`;
  try {
    const today = localDate();
    const { data, error } = await supabase
      .from("events")
      .select("id, title, description, event_date, start_time, end_time, location, is_online, meeting_platform, meeting_link, meeting_details, status, organizer_id, audience_types, audience_group_ids, audience_user_ids, profiles!events_organizer_id_fkey(full_name)")
      .gte("event_date", today)
      .order("event_date", { ascending: true });
    if (error) throw error;

    const events = (data || []).filter((e) => e.status !== "cancelled");
    eventsCache = events;
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
        const canManage = profile.role === "admin" || e.organizer_id === profile.id;
        return `
        <div class="card" style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div style="min-width:0;">
              <h3 style="margin:0;">${escapeHtml(e.title)}</h3>
              ${e.profiles?.full_name ? `<div class="text-muted" style="font-size:0.82rem;margin-top:2px;">${escapeHtml(e.profiles.full_name)}</div>` : ""}
              <div class="text-muted" style="font-size:0.85rem;margin-top:2px;">
                ${formatDate(e.event_date)}${e.start_time ? " · " + e.start_time.slice(0, 5) : ""}${e.end_time ? "–" + e.end_time.slice(0, 5) : ""}
                ${!e.is_online && e.location ? " · " + escapeHtml(e.location) : ""}
              </div>
            </div>
            ${
              canManage
                ? `<div class="card-actions">
                    <button type="button" class="icon-action sm edit-event-btn" data-id="${e.id}" title="Edit" aria-label="Edit">${ICON.edit}</button>
                    <button type="button" class="icon-action sm danger delete-event-btn" data-id="${e.id}" title="Delete" aria-label="Delete">${ICON.delete}</button>
                  </div>`
                : ""
            }
          </div>
          ${e.description ? `<p style="margin-top:10px;">${escapeHtml(e.description)}</p>` : ""}
          ${e.is_online ? meetingBlock(e) : ""}
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
            ${rsvpButton(e.id, "attending", "Attending", myRsvp)}
            ${rsvpButton(e.id, "maybe", "Maybe", myRsvp)}
            ${rsvpButton(e.id, "not_attending", "Not attending", myRsvp)}
          </div>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".edit-event-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ev = eventsCache.find((x) => x.id === btn.getAttribute("data-id"));
        if (ev) newEventDialog(ev);
      });
    });
    listEl.querySelectorAll(".delete-event-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteEvent(btn.getAttribute("data-id")));
    });
    listEl.querySelectorAll(".rsvp-btn").forEach((btn) => {
      btn.addEventListener("click", () => rsvp(btn.getAttribute("data-event"), btn.getAttribute("data-status")));
    });
    listEl.querySelectorAll(".copy-link-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.getAttribute("data-link"));
          showToast("Link copied.", "success");
        } catch {
          showToast("Couldn't copy the link. Use Join instead.", "error");
        }
      });
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="card empty-state"><h3>Events couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Events couldn't be loaded.", "error");
  }
}

async function deleteEvent(id) {
  const ev = eventsCache.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: "Delete this event?",
    message: "It will be removed for everyone, along with any RSVPs. This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  try {
    const { data, error } = await supabase.from("events").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("row-level security");
    await logAudit({ action: "event.deleted", recordType: "event", recordId: id, details: { title: ev?.title } });
    showToast("Event deleted.", "success");
    loadEvents();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to delete this event."), "error");
  }
}

// Meeting details shown on the event card to everyone who can see the event.
function meetingBlock(e) {
  const link = isHttpUrl(e.meeting_link) ? e.meeting_link : null;
  return `<div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(41,82,227,0.08);">
    <div style="font-weight:600;font-size:0.85rem;">Online · ${escapeHtml(platformLabel(e.meeting_platform))}</div>
    ${e.meeting_details ? `<div class="text-muted" style="font-size:0.85rem;white-space:pre-wrap;margin-top:4px;">${escapeHtml(e.meeting_details)}</div>` : ""}
    ${
      link
        ? `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <a class="btn btn-sm btn-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-flex;align-items:center;">Join</a>
            <button type="button" class="btn btn-sm btn-secondary copy-link-btn" data-link="${escapeHtml(link)}">Copy link</button>
          </div>`
        : ""
    }
  </div>`;
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


// Refresh the list when a push about an event arrives while this page is open.
window.addEventListener("onecore:push", (e) => {
  if (e.detail?.forThisAcademy && e.detail.related_type === "event" && !document.querySelector(".dialog-backdrop")) loadEvents();
});
