// Switch-academy dialog (opened from the top-right menu) and the
// "join another academy" flow. Switching is a database call plus a token
// refresh; nobody has to sign out and back in.

import { supabase, friendlyError, isUsableAcademy, switchToProfile } from "./supabase-client.js";
import { showToast } from "./toast.js";

function esc(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
const msg = (err, fallback) => (err?.code === "P0001" && err.message ? err.message : friendlyError(err, fallback));

function shell(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  return { backdrop, close };
}

function statusOf(a) {
  if (a.is_active !== false) return isUsableAcademy(a) ? null : "Guest access ended";
  return a.is_approved ? "Deactivated" : "Pending approval";
}

export function openAcademySwitcher(academies, currentProfile) {
  const { backdrop, close } = shell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="sw-title">
      <h3 id="sw-title">Switch academy</h3>
      <div style="max-height:50vh;overflow-y:auto;margin:4px 0 8px;">
        ${academies
          .map((a) => {
            const status = statusOf(a);
            const isCurrent = a.profile_id === currentProfile.id;
            const unread = Number(a.unread) > 0 ? `<span class="badge">${Number(a.unread) > 9 ? "9+" : a.unread}</span>` : "";
            const right = isCurrent
              ? `<span class="tag tag-approved">Current</span>`
              : status
                ? `<span class="tag tag-pending">${esc(status)}</span>`
                : `${unread}<button type="button" class="btn btn-primary btn-sm sw-btn" data-id="${a.profile_id}">Switch</button>`;
            return `<div style="display:flex;align-items:center;gap:10px;padding:12px 2px;border-bottom:1px solid var(--border, #e5e7eb);">
              <div style="flex:1;min-width:0;opacity:${isCurrent ? "1" : "0.55"};">
                <div style="font-weight:${isCurrent ? "700" : "500"};color:${isCurrent ? "var(--text, #111827)" : "inherit"};">${esc(a.academy_name || "Academy")}</div>
                <div class="text-muted" style="font-size:0.8rem;">${esc(cap(a.role))} · ${esc(a.full_name)}</div>
              </div>
              ${right}
            </div>`;
          })
          .join("")}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="join">Join another academy</button>
        <button type="button" class="btn btn-primary" data-act="close">Close</button>
      </div>
    </div>`);

  backdrop.querySelector('[data-act="close"]').addEventListener("click", close);
  backdrop.querySelector('[data-act="join"]').addEventListener("click", () => {
    close();
    openJoinDialog(currentProfile);
  });
  backdrop.querySelectorAll(".sw-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Switching…";
      try {
        await switchToProfile(btn.getAttribute("data-id"));
        window.location.href = "dashboard.html";
      } catch (err) {
        console.error(err);
        showToast(msg(err, "Unable to switch academy."), "error");
        btn.disabled = false;
        btn.textContent = "Switch";
      }
    })
  );
}

function openJoinDialog(currentProfile) {
  const { backdrop, close } = shell(`
    <div class="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="jn-title">
      <h3 id="jn-title">Join another academy</h3>
      <form id="jn-form">
        <div class="field">
          <label for="jn-code">Invite code</label>
          <input id="jn-code" type="text" required style="text-transform:uppercase;" />
          <div class="field-hint">Ask that academy's administrator for its invite code.</div>
        </div>
        <div class="field">
          <label for="jn-name">Your name in that academy</label>
          <input id="jn-name" type="text" required value="${esc(currentProfile.full_name || "")}" />
          <div class="field-hint">Each academy keeps its own profile, so you can use a different name, photo and contact details there.</div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="jn-submit">Send request</button>
        </div>
      </form>
    </div>`);

  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector("#jn-code").focus();
  backdrop.querySelector("#jn-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = backdrop.querySelector("#jn-submit");
    const code = backdrop.querySelector("#jn-code").value.trim().toUpperCase();
    const name = backdrop.querySelector("#jn-name").value.trim();
    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      const { data: orgs, error: lErr } = await supabase.rpc("lookup_org_by_invite_code", { code });
      if (lErr) throw lErr;
      const org = orgs?.[0];
      if (!org) {
        showToast("Invalid invite code. Please check with the administrator.", "error");
        return;
      }
      const { error } = await supabase.rpc("add_academy", { p_invite_code: code, p_full_name: name });
      if (error) throw error;
      close();
      showToast(`Request sent to ${org.name}. It will appear in Switch academy once approved.`, "success", 6000);
    } catch (err) {
      console.error(err);
      showToast(msg(err, "Unable to join that academy."), "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Send request";
    }
  });
}
