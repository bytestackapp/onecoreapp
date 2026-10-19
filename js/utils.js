// Small helpers shared by every page. Keep them here instead of copying them into each file.

/** Makes any text safe to put inside HTML (also safe for empty values and numbers). */
export function escapeHtml(str = "") {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** "teacher" -> "Teacher" */
export const cap = (s = "") => String(s ?? "").charAt(0).toUpperCase() + String(s ?? "").slice(1);

// Page navigation bar used by the People, Users and Groups lists: first, previous, "Page [select] of N", next, last
export function pagerHtml(page, pages) {
  if (pages <= 1) return "";
  const btn = (act, label, path, off) =>
    `<button type="button" class="icon-action sm" data-pg="${act}" title="${label}" aria-label="${label}" ${off ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></button>`;
  const options = Array.from({ length: pages }, (_, i) => `<option value="${i + 1}" ${i + 1 === page ? "selected" : ""}>${i + 1}</option>`).join("");
  return `<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;">
    ${btn("first", "First page", "M11 17l-5-5 5-5M18 17l-5-5 5-5", page <= 1)}
    ${btn("prev", "Previous page", "M15 18l-6-6 6-6", page <= 1)}
    <span class="text-muted" style="font-size:0.85rem;display:flex;align-items:center;gap:6px;white-space:nowrap;">Page
      <select data-pg="select" aria-label="Go to page" style="width:auto;min-width:0;padding:4px 24px 4px 8px;">${options}</select>
      of ${pages}</span>
    ${btn("next", "Next page", "M9 18l6-6-6-6", page >= pages)}
    ${btn("last", "Last page", "M13 17l5-5-5-5M6 17l5-5-5-5", page >= pages)}
  </div>`;
}

export function bindPager(container, page, pages, goTo) {
  container.querySelector('[data-pg="first"]')?.addEventListener("click", () => goTo(1));
  container.querySelector('[data-pg="prev"]')?.addEventListener("click", () => goTo(page - 1));
  container.querySelector('[data-pg="next"]')?.addEventListener("click", () => goTo(page + 1));
  container.querySelector('[data-pg="last"]')?.addEventListener("click", () => goTo(pages));
  container.querySelector('[data-pg="select"]')?.addEventListener("change", (e) => goTo(Number(e.target.value)));
}
