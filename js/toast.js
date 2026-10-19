import { escapeHtml } from "./utils.js";
// Self-contained toast system — works on any page, including auth pages
// that never call mountLayout(). First call lazily creates the container.

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.id = "toast-container";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "true");
  document.body.appendChild(container);
  return container;
}

const ICONS = {
  success: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.2l2.2 2.2 4.8-5"/></svg>`,
  error: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/></svg>`,
  info: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/></svg>`,
};

/**
 * @param {string} message
 * @param {"success"|"error"|"info"} type
 * @param {number} duration ms before auto-dismiss
 */
export function showToast(message, type = "info", duration = 4500) {
  const el = ensureContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${ICONS[type] || ICONS.info}</span><span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;
  el.appendChild(toast);

  const remove = () => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector(".toast-close").addEventListener("click", remove);
  let timer = setTimeout(remove, duration);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => { timer = setTimeout(remove, 1500); });
}

