// @ts-nocheck
// Single global image lightbox. All thumbnails across composer / user bubbles /
// inspect dialog / timeline carry data-image-url + data-image-group +
// data-image-index, and this module captures clicks at document level.

const state = {
  dialog: null,
  imgEl: null,
  metaEl: null,
  closeBtn: null,
  prevBtn: null,
  nextBtn: null,
  images: [],
  currentIndex: 0,
  bound: false,
};

function ensureRefs() {
  if (state.dialog) return state.dialog;
  const dialog = document.getElementById("imageLightbox");
  if (!dialog) return null;
  state.dialog = dialog;
  state.imgEl = dialog.querySelector(".image-lightbox-img");
  state.metaEl = dialog.querySelector(".image-lightbox-meta");
  state.closeBtn = dialog.querySelector(".image-lightbox-close");
  state.prevBtn = dialog.querySelector(".image-lightbox-prev");
  state.nextBtn = dialog.querySelector(".image-lightbox-next");
  bindDialogEvents();
  return dialog;
}

function bindDialogEvents() {
  if (state.bound) return;
  const { dialog, closeBtn, prevBtn, nextBtn } = state;
  if (!dialog) return;
  closeBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    closeLightbox();
  });
  prevBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    prev();
  });
  nextBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    next();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeLightbox();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeLightbox();
  });
  dialog.addEventListener("close", () => {
    if (state.imgEl) state.imgEl.src = "";
  });
  document.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeLightbox();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  });
  state.bound = true;
}

function isOpen() {
  return Boolean(state.dialog && state.dialog.open);
}

function setIndex(index) {
  if (!state.images.length) return;
  const length = state.images.length;
  state.currentIndex = ((index % length) + length) % length;
  paint();
}

function paint() {
  const image = state.images[state.currentIndex];
  if (!image || !state.imgEl) return;
  state.imgEl.src = image.url;
  state.imgEl.alt = image.name || image.mimeType || "image";
  if (state.metaEl) {
    const label = image.name ? `${image.name} · ` : "";
    state.metaEl.textContent = `${label}${state.currentIndex + 1} / ${state.images.length}`;
  }
  if (state.prevBtn) state.prevBtn.hidden = state.images.length < 2;
  if (state.nextBtn) state.nextBtn.hidden = state.images.length < 2;
}

export function openLightbox({ images, startIndex = 0 } = {}) {
  if (!Array.isArray(images) || images.length === 0) return;
  const dialog = ensureRefs();
  if (!dialog) return;
  state.images = images.filter((image) => image && image.url);
  if (!state.images.length) return;
  setIndex(startIndex);
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

export function closeLightbox() {
  const dialog = ensureRefs();
  if (!dialog) return;
  if (typeof dialog.close === "function") {
    if (dialog.open) dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  state.images = [];
  state.currentIndex = 0;
}

export function next() {
  setIndex(state.currentIndex + 1);
}

export function prev() {
  setIndex(state.currentIndex - 1);
}

function collectGroupImages(root, group) {
  const buttons = root.querySelectorAll(`[data-image-group="${cssEscape(group)}"][data-image-url]`);
  const seen = new Map();
  buttons.forEach((button) => {
    const index = Number(button.getAttribute("data-image-index") || 0);
    const url = button.getAttribute("data-image-url") || "";
    const name = button.getAttribute("data-image-name") || undefined;
    const mimeType = button.getAttribute("data-image-mime") || undefined;
    if (!url) return;
    seen.set(index, { url, name, mimeType });
  });
  const indices = [...seen.keys()].sort((a, b) => a - b);
  return indices.map((index) => seen.get(index));
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/(["\\\]\[\.])/g, "\\$1");
}

function bindGlobalDelegate() {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest("[data-image-url]");
      if (!trigger) return;
      // Skip clicks on remove buttons inside attachment cards.
      if (target.closest("[data-attachment-remove]")) return;
      event.preventDefault();
      const group = trigger.getAttribute("data-image-group") || "default";
      const startIndex = Number(trigger.getAttribute("data-image-index") || 0);
      const images = collectGroupImages(document, group);
      if (!images.length) return;
      const startUrl = trigger.getAttribute("data-image-url") || "";
      const startInGroup = images.findIndex((image) => image.url === startUrl);
      openLightbox({
        images,
        startIndex: startInGroup >= 0 ? startInGroup : startIndex,
      });
    },
    false,
  );
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureRefs();
      bindGlobalDelegate();
    });
  } else {
    ensureRefs();
    bindGlobalDelegate();
  }
}
