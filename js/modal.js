// Shared dialog helpers.
//
// 1. openShell(html, onClose) is the one way to open a simple dialog. Clicking outside it or pressing
//    Escape closes it. (Use it for new dialogs instead of copying the code.)
// 2. EVERY dialog on a page, whoever built it, also gets the same behaviour automatically:
//    - the page behind stops scrolling while a dialog is open,
//    - keyboard focus moves into the dialog, stays inside it, and returns to the button that opened it.
//    Escape stays with each dialog, so stacked dialogs close one at a time.

export function openShell(html, onClose) {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (onClose) onClose();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  return { backdrop, close };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openBackdrops = () => [...document.querySelectorAll(".dialog-backdrop")].filter((el) => el.style.display !== "none");

let outsideFocus = null; // the last thing focused outside any dialog (where focus goes back to)
let knownCount = 0;

document.addEventListener("focusin", (e) => {
  if (!e.target.closest?.(".dialog-backdrop")) outsideFocus = e.target;
});

function sync() {
  const open = openBackdrops();
  if (open.length) document.body.style.overflow = "hidden";
  else if (knownCount > 0) document.body.style.overflow = "";
  if (open.length > knownCount) {
    const top = open[open.length - 1];
    if (!top.contains(document.activeElement)) {
      const box = top.querySelector(".dialog-modal") || top;
      box.setAttribute("tabindex", "-1");
      box.focus({ preventScroll: true });
    }
  } else if (open.length === 0 && knownCount > 0) {
    // back to the button that opened the dialog (never to a text field: that would raise the keyboard)
    if (outsideFocus && outsideFocus.isConnected && /^(BUTTON|A)$/.test(outsideFocus.tagName)) {
      outsideFocus.focus({ preventScroll: true });
    }
  }
  knownCount = open.length;
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Tab") return;
    const open = openBackdrops();
    if (!open.length) return;
    const top = open[open.length - 1];
    if (top.querySelector('[role="alertdialog"]')) return; // the confirm dialog keeps its own focus handling
    const items = [...top.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const box = top.querySelector(".dialog-modal");
    if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },
  true
);

if (document.body) new MutationObserver(sync).observe(document.body, { childList: true });
sync();
