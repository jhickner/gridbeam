import { createGallery } from "../gallery.js";
import { createProject, openProject, flushSave } from "../io.js";
import { showToast } from "./dialog.js";

// Full-screen import tool: preview every file's contents before choosing which
// ones become projects.

let overlay = null;
let gallery = null;

export function isImportGalleryOpen() {
  return overlay !== null;
}

export function closeImportGallery() {
  if (!overlay) return;
  gallery.destroy();
  overlay.remove();
  overlay = null;
  gallery = null;
}

export function openImportGallery({ pickImmediately = false } = {}) {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.className = "gb-overlay";
  overlay.innerHTML = `
    <div class="gb-overlay-head">
      <strong>Import projects</strong>
      <span class="gb-overlay-hint">Click a card to select it · ⤢ to preview in 3D</span>
      <button data-close>Close</button>
    </div>`;

  gallery = createGallery({
    mode: "import",
    onImport: (chosen) => {
      flushSave();
      const names = [];
      for (const it of chosen) {
        names.push(createProject(it.title, it.doc, it.view));
      }
      if (names.length) openProject(names[names.length - 1]);
      closeImportGallery();
      showToast(names.length === 1
        ? `Imported "${names[0]}"`
        : `Imported ${names.length} projects — now on "${names[names.length - 1]}"`);
    },
  });

  overlay.appendChild(gallery.el);
  document.body.appendChild(overlay);
  overlay.querySelector("[data-close]").onclick = closeImportGallery;

  if (pickImmediately) gallery.openFilePicker();
}

// Escape backs out of the preview first, then the whole overlay.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !overlay) return;
  e.stopPropagation();
  if (gallery.isPreviewOpen()) gallery.closePreview();
  else closeImportGallery();
}, true);
