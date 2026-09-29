/**
 * Standard sub-header for a page section (appearance is defined globally
 * in global.css; each page only chooses its icon, tone and text).
 *
 * @param {Object}  opts
 * @param {string}  opts.title
 * @param {string}  [opts.icon]      SVG markup, chosen per page (e.g. ICONS.megaphone from layout.js)
 * @param {"primary"|"success"|"warning"|"error"|"info"|"muted"} [opts.tone]
 * @param {number|string} [opts.count]  small count pill after the title
 * @param {string}  [opts.linkHtml]  right-aligned link markup, e.g. '<a class="link" href="...">View all</a>'
 */
export function sectionHead({ title, icon = "", tone = "", count, linkHtml = "" }) {
  const hasCount = count !== undefined && count !== null;
  return `
    <div class="section-head ${tone ? `tone-${tone}` : ""}">
      ${icon ? `<span class="section-icon">${icon}</span>` : ""}
      <h2>${title}</h2>
      ${hasCount ? `<span class="section-count">${count}</span>` : ""}
      ${linkHtml}
    </div>`;
}