import { mountLayout } from "./layout.js";
import { supabase, formatDateTime, timeAgo, priorityLabel, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./dialog.js";

const profile = await mountLayout({ activeKey: "announcements", pageTitle: "Announcements" });
if (!profile) throw new Error("redirecting");

const canCreate = profile.role === "admin" || profile.role === "teacher";
const listEl = document.getElementById("announcements-list");
const newBtn = document.getElementById("new-btn");

let announcementsCache = [];

const ICON = {
  edit:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  delete:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>`,
};

// ---------- Audience picker ----------
const TYPE_LABELS = { everyone: "Everyone", teachers: "Teachers", students: "Students", parents: "Parents", guests: "Guests" };
let groupsCache = [];
let peopleCache = [];

function defaultAudience() {
  return { types: new Set(["everyone"]), groups: new Set(), users: new Set() };
}

function audienceFrom(a) {
  return {
    types: new Set(a.audience_types || []),
    groups: new Set(a.audience_group_ids || []),
    users: new Set(a.audience_user_ids || []),
  };
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
    const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

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
                 <div class="field aud-search"><input type="search" id="aud-group-search" placeholder="Search groups…" autocomplete="off" /></div>
                 <div class="aud-list" id="aud-groups"></div>`
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
	
	const groupsEl = backdrop.querySelector("#aud-groups");
    function renderGroups(query = "") {
      if (!groupsEl) return;
      const term = query.trim().toLowerCase();
      const matches = groupsCache.filter((g) => !term || g.name.toLowerCase().includes(term));
      groupsEl.innerHTML = matches.length
        ? matches.map((g) => `<label class="aud-row"><input type="checkbox" data-kind="group" value="${g.id}" /><span>${escapeHtml(g.name)}</span></label>`).join("")
        : `<div class="text-muted" style="padding:10px 0;font-size:0.85rem;">No matches</div>`;
      syncChecks();
    }
    renderGroups();

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
	backdrop.querySelector("#aud-group-search")?.addEventListener("input", (e) => renderGroups(e.target.value));

    const onKey = (e) => { if (e.key === "Escape") close(null); };
    function close(value) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
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

// ---------- New / Edit announcement modal ----------
if (canCreate) newBtn.style.display = "inline-flex";

let audienceOptionsReady = null;
async function openAnnouncementDialog(existingId = null) {
  if (!audienceOptionsReady || (groupsCache.length === 0 && peopleCache.length === 0)) {
    audienceOptionsReady = loadAudienceOptions();
  }
  await audienceOptionsReady;
  const existing = existingId ? announcementsCache.find((x) => x.id === existingId) : null;
  let audienceSel = existing ? audienceFrom(existing) : defaultAudience();

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="an-title">
      <h3 id="an-title">${existing ? "Edit announcement" : "New announcement"}</h3>
      <form id="an-form">
        <div class="field">
          <label for="an-title-input">Title</label>
          <input id="an-title-input" required maxlength="150" value="${existing ? escapeAttr(existing.title) : ""}" />
        </div>
        <div class="field">
          <label for="an-content">Content</label>
          <textarea id="an-content" rows="4" required>${existing ? escapeHtml(existing.content) : ""}</textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div class="field">
            <label for="an-priority">Priority</label>
            <select id="an-priority">
              <option value="normal">Normal</option>
              <option value="important">Important</option>
              <option value="action_required">Action required</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div class="field">
            <label for="an-audience-btn">Audience</label>
            <button type="button" id="an-audience-btn" class="audience-btn"></button>
          </div>
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;">
            <input type="checkbox" id="an-requires-ack" style="width:auto;" ${existing?.requires_acknowledgment ? "checked" : ""} />
            Require acknowledgment
          </label>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="an-submit">${existing ? "Save changes" : "Publish"}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  if (existing) backdrop.querySelector("#an-priority").value = existing.priority;

  const audienceBtn = backdrop.querySelector("#an-audience-btn");
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

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#an-title-input").focus();

  backdrop.querySelector("#an-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (audienceCount(audienceSel) === 0) {
      showToast("Choose at least one audience.", "error");
      return;
    }

    const submitBtn = backdrop.querySelector("#an-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = existing ? "Saving…" : "Publishing…";

    const fields = {
      title: backdrop.querySelector("#an-title-input").value.trim(),
      content: backdrop.querySelector("#an-content").value.trim(),
      priority: backdrop.querySelector("#an-priority").value,
      audience_types: [...audienceSel.types],
      audience_group_ids: [...audienceSel.groups],
      audience_user_ids: [...audienceSel.users],
      audience_type: null,        // old single-audience columns, no longer used
      audience_group_id: null,
      requires_acknowledgment: backdrop.querySelector("#an-requires-ack").checked,
    };

    try {
      if (existing) {
        const { data, error } = await supabase
          .from("announcements")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select("id");
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("row-level security"); // RLS blocked it silently
        if (fields.requires_acknowledgment && existing.created_by === profile.id) await autoAcknowledge(existing.id);
        await logAudit({ action: "announcement.updated", recordType: "announcement", recordId: existing.id, details: { title: fields.title } });
        showToast("Announcement updated.", "success");
      } else {
        const { data, error } = await supabase
          .from("announcements")
          .insert({ ...fields, organization_id: profile.organization_id, created_by: profile.id })
          .select()
          .single();
        if (error) throw error;
        if (fields.requires_acknowledgment) await autoAcknowledge(data.id);
        await logAudit({ action: "announcement.created", recordType: "announcement", recordId: data.id, details: { title: fields.title } });
        showToast("Announcement published.", "success");
      }
      close();
      loadAnnouncements();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, existing ? "Unable to save your changes. Please try again." : "Unable to publish this announcement. Please try again."), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = existing ? "Save changes" : "Publish";
    }
  });
}

newBtn.addEventListener("click", () => openAnnouncementDialog());

async function loadAnnouncements() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    const { data, error } = await supabase
      .from("announcements")
      .select("id, title, content, priority, audience_types, audience_group_ids, audience_user_ids, requires_acknowledgment, created_by, created_at, expires_at")
      .order("publish_at", { ascending: false });
    if (error) throw error;
    announcementsCache = data || [];

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
        const canManage = profile.role === "admin" || a.created_by === profile.id;
        return `
        <div class="card" style="margin-bottom:12px;" data-id="${a.id}">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
                <h3 style="margin:0;">${escapeHtml(a.title)}</h3>
                ${
                  canManage
                    ? `<div class="card-actions">
                        <button type="button" class="icon-action sm edit-btn" data-id="${a.id}" title="Edit" aria-label="Edit">${ICON.edit}</button>
                        <button type="button" class="icon-action sm danger delete-btn" data-id="${a.id}" title="Delete" aria-label="Delete">${ICON.delete}</button>
                      </div>`
                    : ""
                }
              </div>
              <p style="white-space:pre-wrap;">${escapeHtml(a.content)}</p>
              ${
                canManage && a.requires_acknowledgment
                  ? `<button type="button" class="ack-summary" data-id="${a.id}"><span>Checking responses…</span></button>`
                  : ""
              }
              <div class="text-muted" style="font-size:0.8rem;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span>${formatDateTime(a.created_at)}</span>
                <div style="display:flex;gap:6px;align-items:center;">
                  <span class="tag tag-${a.priority}">${priorityLabel(a.priority)}</span>
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
          </div>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".ack-btn").forEach((btn) => {
      btn.addEventListener("click", () => acknowledge(btn.getAttribute("data-id"), btn));
    });

    listEl.querySelectorAll(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => openAnnouncementDialog(btn.getAttribute("data-id")));
    });

    listEl.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteAnnouncement(btn.getAttribute("data-id")));
    });

    listEl.querySelectorAll(".ack-summary").forEach((el) => {
      el.addEventListener("click", () => openAckDialog(el.getAttribute("data-id")));
    });
    fillAckSummaries();

    // Mark all rendered announcements as "viewed" (fire and forget).
    data.forEach((a) => markViewed(a.id, acks[a.id]));
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="card empty-state"><h3>Announcements couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Announcements couldn't be loaded.", "error");
  }
}

async function deleteAnnouncement(id) {
  const a = announcementsCache.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: "Delete this announcement?",
    message: "It will be removed for everyone, along with any acknowledgments. This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  try {
    const { data, error } = await supabase.from("announcements").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("row-level security");
    await logAudit({ action: "announcement.deleted", recordType: "announcement", recordId: id, details: { title: a?.title } });
    showToast("Announcement deleted.", "success");
    loadAnnouncements();
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to delete this announcement."), "error");
  }
}

async function fetchAckStatus(id) {
  const { data, error } = await supabase.rpc("announcement_ack_status", { p_announcement_id: id });
  if (error) throw error;
  return data || [];
}

async function fillAckSummaries() {
  const els = Array.from(listEl.querySelectorAll(".ack-summary"));
  await Promise.all(
    els.map(async (el) => {
      try {
        const rows = await fetchAckStatus(el.getAttribute("data-id"));
        const done = rows.filter((r) => r.acknowledged_at).length;
        const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;
        el.innerHTML = `<span>${done} of ${rows.length} acknowledged</span><span class="bar"><span style="width:${pct}%"></span></span>`;
      } catch (err) {
        console.error(err);
        el.innerHTML = `<span>Responses unavailable</span>`;
      }
    })
  );
}

async function openAckDialog(id) {
  const a = announcementsCache.find((x) => x.id === id);
  let rows;
  try {
    rows = await fetchAckStatus(id);
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to load responses."), "error");
    return;
  }

  const acknowledged = rows.filter((r) => r.acknowledged_at);
  const pending = rows.filter((r) => !r.acknowledged_at);
  const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
  const item = (r, detail) => `
    <div class="list-row">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">${escapeHtml(r.full_name)}</div>
        <div class="text-muted" style="font-size:0.78rem;">${escapeHtml(cap(r.role))}</div>
      </div>
      <div class="text-muted" style="font-size:0.78rem;white-space:nowrap;">${detail}</div>
    </div>`;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ack-dialog-title">
      <h3 id="ack-dialog-title">Acknowledgments</h3>
      <p>${escapeHtml(a?.title || "")}</p>
      <div class="ack-list">
        ${rows.length === 0 ? `<div class="empty-state"><p>No recipients found for this audience.</p></div>` : ""}
        ${pending.length ? `<div class="ack-group-title">Not yet acknowledged (${pending.length})</div>${pending.map((r) => item(r, r.viewed_at ? `Seen ${timeAgo(r.viewed_at)}` : "Not seen yet")).join("")}` : ""}
        ${acknowledged.length ? `<div class="ack-group-title">Acknowledged (${acknowledged.length})</div>${acknowledged.map((r) => item(r, formatDateTime(r.acknowledged_at))).join("")}` : ""}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
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

// The issuer counts as having read and acknowledged their own announcement.
async function autoAcknowledge(announcementId) {
  const now = new Date().toISOString();
  const { error } = await supabase.from("announcement_acknowledgments").upsert(
    { announcement_id: announcementId, profile_id: profile.id, viewed_at: now, acknowledged_at: now },
    { onConflict: "announcement_id,profile_id" }
  );
  if (error) console.error("autoAcknowledge failed:", error);
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
    showToast("Announcement acknowledged.", "success");
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Acknowledge";
    showToast(friendlyError(err, "Unable to save your acknowledgment."), "error");
  }
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str = "") {
  return escapeHtml(str);
}

loadAnnouncements();


// Refresh the list when a push about an announcement arrives while this page is open.
window.addEventListener("onecore:push", (e) => {
  if (e.detail?.forThisAcademy && e.detail.related_type === "announcement" && !document.querySelector(".dialog-backdrop")) loadAnnouncements();
});
