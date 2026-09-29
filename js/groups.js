import { mountLayout } from "./layout.js";
import { supabase, friendlyError, logAudit } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "groups", pageTitle: "Groups" });
if (!profile) throw new Error("redirecting");

const isAdmin = profile.role === "admin";
const listEl = document.getElementById("groups-list");
const newBtn = document.getElementById("new-btn");

const GROUP_TYPE_LABELS = { class: "Class", department: "Department", club: "Club", team: "Team", parent_group: "Parent Group" };

const ICON = {
  add: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  remove: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  show: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  manage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3h-6l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.7 7.7 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1L9 21h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4z"/></svg>`,
};

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Who can be a head, per group type ----------
function headOptionsFor(groupType) {
  if (groupType === "class" || groupType === "department") {
    return [{ role: "adviser", personRoles: ["teacher"], label: "Teacher head" }];
  }
  if (groupType === "club" || groupType === "team") {
    return [
      { role: "adviser", personRoles: ["teacher"], label: "Teacher head" },
      { role: "lead", personRoles: ["student"], label: "Student head" },
    ];
  }
  if (groupType === "parent_group") {
    return [
      { role: "adviser", personRoles: ["teacher", "admin"], label: "Staff head" },
      { role: "parent_head", personRoles: ["parent"], label: "Parent head" },
    ];
  }
  return [];
}
function headRoleLabel(groupType, memberRole) {
  return headOptionsFor(groupType).find((o) => o.role === memberRole)?.label || "Head";
}
function isHeadRole(role) {
  return role === "adviser" || role === "lead" || role === "parent_head";
}

// ---------- New group modal ----------
if (isAdmin) newBtn.style.display = "inline-flex";

function newGroupDialog() {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="ng-title">
      <h3 id="ng-title">New group</h3>
      <form id="new-form">
        <div class="field">
          <label for="name">Name</label>
          <input id="name" required placeholder="e.g. Grade 4 - Section A" />
        </div>
        <div class="field">
          <label for="group_type">Type</label>
          <select id="group_type">
            <option value="class">Class</option>
            <option value="department">Department</option>
            <option value="club">Club</option>
            <option value="team">Team</option>
            <option value="parent_group">Parent Group</option>
          </select>
        </div>
        <div class="field">
          <label for="description">Description</label>
          <input id="description" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="ng-submit">Create</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

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
  backdrop.querySelector("#name").focus();

  backdrop.querySelector("#new-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = backdrop.querySelector("#ng-submit");
    submitBtn.disabled = true;
    try {
      const { data, error } = await supabase
        .from("groups")
        .insert({
          organization_id: profile.organization_id,
          name: backdrop.querySelector("#name").value.trim(),
          group_type: backdrop.querySelector("#group_type").value,
          description: backdrop.querySelector("#description").value.trim() || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      await logAudit({ action: "group.created", recordType: "group", recordId: data.id, details: { name: data.name } });
      close();
      showToast("Group created.", "success");
      loadGroups();
    } catch (err) {
      console.error(err);
      showToast(friendlyError(err, "Unable to create this group. Please try again."), "error");
      submitBtn.disabled = false;
    }
  });
}

newBtn?.addEventListener("click", newGroupDialog);

// ---------- List ----------
async function loadGroups() {
  listEl.innerHTML = `<div class="skeleton" style="height:70px;margin-bottom:10px;"></div>`;
  try {
    let query = supabase
      .from("groups")
      .select("id, name, group_type, description, group_members(profile_id, member_role, profiles(full_name, role))")
      .order("name");
    if (!isAdmin) {
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

    listEl.innerHTML = data.map((g) => groupCard(g)).join("");

    listEl.querySelectorAll(".show-btn").forEach((btn) => {
      btn.addEventListener("click", () => openViewDialog(btn.getAttribute("data-id")));
    });
    listEl.querySelectorAll(".manage-btn").forEach((btn) => {
      btn.addEventListener("click", () => openManageDialog(btn.getAttribute("data-id")));
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="card empty-state"><h3>Groups couldn't be loaded</h3><p>Please refresh the page.</p></div>`;
    showToast("Groups couldn't be loaded.", "error");
  }
}

function groupCard(g) {
  const members = g.group_members || [];
  const heads = members.filter((m) => isHeadRole(m.member_role));
  const regular = members.filter((m) => m.member_role === "member");

  return `
    <div class="card" style="margin-bottom:10px;" data-id="${g.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="min-width:0;">
          <h3 style="margin:0;">${escapeHtml(g.name)}</h3>
          ${g.description ? `<p style="margin:4px 0 0;">${escapeHtml(g.description)}</p>` : ""}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="icon-action sm show-btn" data-id="${g.id}" title="Show heads and members" aria-label="Show heads and members">${ICON.show}</button>
          ${isAdmin ? `<button type="button" class="icon-action sm manage-btn" data-id="${g.id}" title="Manage group" aria-label="Manage group">${ICON.manage}</button>` : ""}
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
        <span class="tag tag-normal">${escapeHtml(GROUP_TYPE_LABELS[g.group_type] || g.group_type)}</span>
        ${
          heads.length
            ? heads
                .map(
                  (h) =>
                    `<span class="tag tag-approved">${escapeHtml(headRoleLabel(g.group_type, h.member_role))}: ${escapeHtml(h.profiles?.full_name || "Unknown")}</span>`
                )
                .join("")
            : `<span class="tag tag-pending">No head assigned</span>`
        }
        <span class="tag tag-normal">${regular.length === 0 ? "No members" : `${regular.length} ${regular.length === 1 ? "member" : "members"}`}</span>
      </div>
    </div>`;
}

function emptyState() {
  return `<div class="card empty-state"><h3>No groups yet</h3><p>${isAdmin ? "Create your first class or group to get started." : "You haven't been added to a group yet."}</p></div>`;
}

// ---------- View dialog: read-only heads + members ----------
async function openViewDialog(groupId) {
  const { data: g, error: gErr } = await supabase.from("groups").select("id, name, group_type").eq("id", groupId).single();
  if (gErr || !g) {
    showToast("Unable to load this group.", "error");
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="vw-title">
      <h3 id="vw-title">${escapeHtml(g.name)}</h3>
      <div class="aud-body" id="vw-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

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
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  const bodyEl = backdrop.querySelector("#vw-body");
  try {
    const members = await fetchGroupDetail(groupId);
    const heads = members.filter((m) => isHeadRole(m.member_role));
    const regular = members.filter((m) => m.member_role === "member");

    const row = (name, meta) => `
      <div class="aud-row" style="cursor:default;">
        <span>${escapeHtml(name || "Unknown")}</span>
        <span class="aud-meta">${escapeHtml(meta)}</span>
      </div>`;

    bodyEl.innerHTML = `
      <div class="ack-group-title">Head${heads.length === 1 ? "" : "s"} (${heads.length})</div>
      <div class="aud-list">
        ${
          heads.length
            ? heads.map((h) => row(h.profiles?.full_name, headRoleLabel(g.group_type, h.member_role))).join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No head assigned yet.</div>`
        }
      </div>
      <div class="ack-group-title" style="margin-top:18px;">Members (${regular.length})</div>
      <div class="aud-list">
        ${
          regular.length
            ? regular.map((m) => row(m.profiles?.full_name, cap(m.profiles?.role || ""))).join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No members yet.</div>`
        }
      </div>`;
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = `<div class="text-muted" style="padding:8px 0;">Unable to load the member list.</div>`;
    showToast(friendlyError(err, "Unable to load the member list."), "error");
  }
}

// ---------- Manage dialog: heads + members ----------
let peopleCache = [];

async function loadPeopleCache() {
  const { data, error } = await supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name");
  if (error) {
    console.error(error);
    return;
  }
  peopleCache = data || [];
}

async function fetchGroupDetail(groupId) {
  const { data, error } = await supabase
    .from("group_members")
    .select("id, profile_id, member_role, profiles(full_name, role)")
    .eq("group_id", groupId);
  if (error) throw error;
  return data || [];
}

async function upsertMember(groupId, profileId, role) {
  const { error } = await supabase
    .from("group_members")
    .upsert({ group_id: groupId, profile_id: profileId, member_role: role }, { onConflict: "group_id,profile_id" });
  if (error) throw error;
}

async function removeRow(rowId) {
  const { error } = await supabase.from("group_members").delete().eq("id", rowId);
  if (error) throw error;
}

async function openManageDialog(groupId) {
  const { data: g, error: gErr } = await supabase.from("groups").select("id, name, group_type").eq("id", groupId).single();
  if (gErr || !g) {
    showToast("Unable to load this group.", "error");
    return;
  }
  if (peopleCache.length === 0) await loadPeopleCache();

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="mg-title">
      <h3 id="mg-title">${escapeHtml(g.name)}</h3>
      <div class="aud-body" id="mg-body"><div class="skeleton" style="height:60px;"></div></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    loadGroups();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);

  let showAddHead = false;
  let showAddMember = false;
  let headSearch = "";
  let memberSearch = "";

  async function render() {
    const members = await fetchGroupDetail(groupId);
    const heads = members.filter((m) => isHeadRole(m.member_role));
    const regular = members.filter((m) => m.member_role === "member");
    const memberIds = new Set(members.map((m) => m.profile_id));
    const options = headOptionsFor(g.group_type);
    const headEligibleRoles = new Set(options.flatMap((o) => o.personRoles));

    const bodyEl = backdrop.querySelector("#mg-body");
    bodyEl.innerHTML = `
      <div class="ack-group-title">Heads (${heads.length}/3)</div>
      <div class="aud-list">
        ${
          heads.length
            ? heads
                .map(
                  (h) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(h.profiles?.full_name || "Unknown")}</span>
                <span class="aud-meta">${escapeHtml(headRoleLabel(g.group_type, h.member_role))}</span>
                <button type="button" class="icon-action sm danger" data-remove="${h.id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.remove}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No heads assigned yet.</div>`
        }
      </div>
      ${
        headEligibleRoles.size === 0
          ? ""
          : heads.length >= 3
          ? `<p class="text-muted" style="font-size:0.8rem;margin:6px 0 0;">Maximum of 3 heads reached.</p>`
          : showAddHead
          ? `<div class="field aud-search"><input type="search" id="mg-head-search" placeholder="Search by name…" autocomplete="off" value="${escapeHtml(headSearch)}" /></div>
             <div class="aud-list" id="mg-head-results"></div>
             <button type="button" class="btn btn-secondary btn-sm" data-act="cancel-add-head" style="margin-top:8px;">Cancel</button>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-act="add-head" style="margin-top:6px;">Add head</button>`
      }

      <div class="ack-group-title" style="margin-top:18px;">Members (${regular.length})</div>
      <div class="aud-list">
        ${
          regular.length
            ? regular
                .map(
                  (m) => `
              <div class="aud-row" style="cursor:default;">
                <span>${escapeHtml(m.profiles?.full_name || "Unknown")}</span>
                <span class="aud-meta">${escapeHtml(cap(m.profiles?.role || ""))}</span>
                <button type="button" class="icon-action sm danger" data-remove="${m.id}" title="Remove" aria-label="Remove" style="margin-left:8px;">${ICON.remove}</button>
              </div>`
                )
                .join("")
            : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No members yet.</div>`
        }
      </div>
      ${
        showAddMember
          ? `<div class="field aud-search"><input type="search" id="mg-member-search" placeholder="Search by name…" autocomplete="off" value="${escapeHtml(memberSearch)}" /></div>
             <div class="aud-list" id="mg-member-results"></div>
             <button type="button" class="btn btn-secondary btn-sm" data-act="cancel-add-member" style="margin-top:8px;">Cancel</button>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-act="add-member" style="margin-top:6px;">Add member</button>`
      }
    `;

    bodyEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await removeRow(btn.getAttribute("data-remove"));
          showToast("Removed.", "success");
          await render();
        } catch (err) {
          console.error(err);
          showToast(friendlyError(err, "Unable to remove."), "error");
        }
      });
    });

    bodyEl.querySelector('[data-act="add-head"]')?.addEventListener("click", () => {
      showAddHead = true;
      render();
    });
    bodyEl.querySelector('[data-act="cancel-add-head"]')?.addEventListener("click", () => {
      showAddHead = false;
      headSearch = "";
      render();
    });
    bodyEl.querySelector('[data-act="add-member"]')?.addEventListener("click", () => {
      showAddMember = true;
      render();
    });
    bodyEl.querySelector('[data-act="cancel-add-member"]')?.addEventListener("click", () => {
      showAddMember = false;
      memberSearch = "";
      render();
    });

    if (showAddHead) {
      const input = bodyEl.querySelector("#mg-head-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener("input", (e) => {
        headSearch = e.target.value;
        renderHeadResults();
      });
      renderHeadResults();
    }
    if (showAddMember) {
      const input = bodyEl.querySelector("#mg-member-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener("input", (e) => {
        memberSearch = e.target.value;
        renderMemberResults();
      });
      renderMemberResults();
    }

    function renderHeadResults() {
      const resEl = bodyEl.querySelector("#mg-head-results");
      if (!resEl) return;
      const term = headSearch.trim().toLowerCase();
      const matches = peopleCache
        .filter((p) => headEligibleRoles.has(p.role) && !heads.some((h) => h.profile_id === p.id))
        .filter((p) => !term || p.full_name.toLowerCase().includes(term))
        .slice(0, 50);
      resEl.innerHTML = matches.length
        ? matches
            .map(
              (p) => `
          <div class="aud-row">
            <span>${escapeHtml(p.full_name)}</span>
            <span class="aud-meta">${escapeHtml(cap(p.role))}</span>
            <button type="button" class="icon-action sm approve" data-pick="${p.id}" title="Add as head" aria-label="Add as head" style="margin-left:8px;">${ICON.add}</button>
          </div>`
            )
            .join("")
        : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No matches.</div>`;

      resEl.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const personId = btn.getAttribute("data-pick");
          const person = peopleCache.find((p) => p.id === personId);
          const opt = options.find((o) => o.personRoles.includes(person?.role));
          if (!opt) {
            showToast("This person's role can't be a head of this group.", "error");
            return;
          }
          try {
            await upsertMember(groupId, personId, opt.role);
            await logAudit({ action: "group.head_assigned", recordType: "group", recordId: groupId, details: { name: person.full_name, role: opt.label } });
            showToast("Head added.", "success");
            showAddHead = false;
            headSearch = "";
            await render();
          } catch (err) {
            console.error(err);
            showToast(friendlyError(err, "Unable to add this head. The group may already have 3."), "error");
          }
        });
      });
    }

    function renderMemberResults() {
      const resEl = bodyEl.querySelector("#mg-member-results");
      if (!resEl) return;
      const term = memberSearch.trim().toLowerCase();
      const matches = peopleCache
        .filter((p) => !memberIds.has(p.id))
        .filter((p) => !term || p.full_name.toLowerCase().includes(term))
        .slice(0, 50);
      resEl.innerHTML = matches.length
        ? matches
            .map(
              (p) => `
          <div class="aud-row">
            <span>${escapeHtml(p.full_name)}</span>
            <span class="aud-meta">${escapeHtml(cap(p.role))}</span>
            <button type="button" class="icon-action sm approve" data-pick="${p.id}" title="Add as member" aria-label="Add as member" style="margin-left:8px;">${ICON.add}</button>
          </div>`
            )
            .join("")
        : `<div class="text-muted" style="padding:8px 0;font-size:0.85rem;">No matches.</div>`;

      resEl.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const personId = btn.getAttribute("data-pick");
          try {
            await upsertMember(groupId, personId, "member");
            showToast("Member added.", "success");
            showAddMember = false;
            memberSearch = "";
            await render();
          } catch (err) {
            console.error(err);
            showToast(friendlyError(err, "Unable to add this member."), "error");
          }
        });
      });
    }
  }

  render();
}

loadGroups();
