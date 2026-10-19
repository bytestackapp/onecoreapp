import { escapeHtml } from "./utils.js";
// Self-contained confirm dialog — replaces window.confirm() with an
// app-styled modal. Usage:
//   const ok = await confirmDialog({ title: "Reject request?", message: "...", danger: true });
//   if (!ok) return;

export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const modal = document.createElement("div");
    modal.className = "dialog-modal";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "dialog-title");
    modal.innerHTML = `
      <h3 id="dialog-title">${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      <div class="dialog-actions">
        <button class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";

    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    const cancelBtn = modal.querySelector('[data-action="cancel"]');
    confirmBtn.focus();

    function cleanup(result) {
      document.body.style.overflow = "";
      backdrop.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Tab") {
        // simple focus trap between the two buttons
        e.preventDefault();
        (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
      }
    }

    confirmBtn.addEventListener("click", () => cleanup(true));
    cancelBtn.addEventListener("click", () => cleanup(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    document.addEventListener("keydown", onKeydown);
  });
}

