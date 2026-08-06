import {
  listProjects, currentProjectName, newProject, openProject, saveProjectAs,
  renameProject, deleteProject, subscribeProjects, downloadJson,
  exportAllProjects, readBackupFile, restoreBackup,
} from "../io.js";
import { showPrompt, showConfirm, showChoice, showToast } from "./dialog.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

const nameValidator = (skip) => (v) => {
  if (!v) return "Name can't be empty.";
  if (v.length > 60) return "Name is too long.";
  if (v !== skip && listProjects().some((p) => p.name === v)) return `"${v}" already exists.`;
  return null;
};

// The panel is a self-contained element the host mounts wherever it likes.
// The host must call setVisible(), so autosave-driven refreshes (which fire
// every 200ms while editing) don't rebuild markup nobody is looking at.
export function createProjectsPanel({ onImport, visible = true } = {}) {
  const el = document.createElement("div");
  el.className = "gb-projects";
  let shown = visible;

  function setVisible(v) {
    shown = v;
    if (v) render();
  }

  function render() {
    if (!shown) return;
    const current = currentProjectName();
    const rows = listProjects().map((p) => `
      <li class="${p.name === current ? "current" : ""}">
        <button class="gb-proj-open" data-open="${esc(p.name)}">
          <span class="gb-proj-name">${esc(p.name)}</span>
          <span class="gb-proj-meta">${p.count || 0} parts · ${esc(ago(p.savedAt))}</span>
        </button>
        <button class="gb-proj-icon" data-rename="${esc(p.name)}" title="Rename">✎</button>
        <button class="gb-proj-icon" data-delete="${esc(p.name)}" title="Delete">✕</button>
      </li>`).join("");

    el.innerHTML = `
      <div class="gb-projects-actions">
        <button data-new>+ New Project</button>
        <button data-saveas>Save As…</button>
      </div>
      <ul class="gb-projects-list">${rows || `<li class="gb-projects-empty">No saved projects</li>`}</ul>
      <div class="gb-projects-actions gb-projects-files">
        <button data-import>Import…</button>
        <button data-export>Export this project</button>
      </div>
      <div class="gb-projects-actions gb-projects-files">
        <button data-backup title="Save every project to one file">Back up all…</button>
        <button data-restore title="Restore projects from a backup file">Restore…</button>
      </div>
      <input type="file" data-restore-file accept="application/json" hidden />`;
  }

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const d = btn.dataset;

    if ("new" in d) {
      const name = await showPrompt({
        title: "New Project", label: "Name", value: "Untitled",
        confirmLabel: "Create", validate: nameValidator(),
      });
      if (name) { newProject(name); render(); }

    } else if ("saveas" in d) {
      const name = await showPrompt({
        title: "Save As", label: "Name", value: `${currentProjectName()} copy`,
        confirmLabel: "Save", validate: nameValidator(),
      });
      if (name) { saveProjectAs(name); render(); showToast(`Saved as "${name}"`); }

    } else if (d.open) {
      openProject(d.open);
      render();

    } else if (d.rename) {
      const from = d.rename;
      const to = await showPrompt({
        title: "Rename Project", label: "Name", value: from,
        confirmLabel: "Rename", validate: nameValidator(from),
      });
      if (to && to !== from) {
        try { renameProject(from, to); render(); }
        catch (err) { showToast(err.message, { error: true }); }
      }

    } else if (d.delete) {
      const name = d.delete;
      const ok = await showConfirm({
        title: "Delete Project",
        message: `Delete "${name}"? This can't be undone.`,
        confirmLabel: "Delete", danger: true,
      });
      if (ok) { deleteProject(name); render(); }

    } else if ("import" in d) {
      onImport?.();

    } else if ("export" in d) {
      downloadJson();

    } else if ("backup" in d) {
      const n = exportAllProjects();
      showToast(n === 1 ? "Backed up 1 project" : `Backed up ${n} projects`);

    } else if ("restore" in d) {
      el.querySelector("[data-restore-file]").click();
    }
  });

  el.addEventListener("change", async (e) => {
    const input = e.target.closest("[data-restore-file]");
    if (!input || !input.files[0]) return;
    const file = input.files[0];
    input.value = "";

    let payload;
    try { payload = await readBackupFile(file); }
    catch (err) { showToast(err.message, { error: true }); return; }

    const existing = listProjects().length;
    const mode = await showChoice({
      title: "Restore backup",
      message: `${file.name} holds ${payload.projects.length} project${
        payload.projects.length === 1 ? "" : "s"}. You currently have ${existing}.`,
      options: [
        { value: "merge", label: "Add to my projects",
          detail: "Keeps what's here. Name clashes get numbered." },
        { value: "replace", label: "Replace everything", danger: true,
          detail: `Deletes all ${existing} current project${existing === 1 ? "" : "s"} first.` },
      ],
    });
    if (!mode) return;

    const r = restoreBackup(payload, { mode });
    render();
    showToast(`Restored ${r.count} project${r.count === 1 ? "" : "s"}` +
      (r.renamed ? ` (${r.renamed} renamed)` : "") + ` — now on "${r.current}"`);
  });

  subscribeProjects(render);
  render();
  return { el, render, setVisible };
}

// Desktop chrome: a dropdown anchored under `button`, plus a click-to-rename
// label showing the current project.
export function initProjectsDropdown({ button, nameEl, onImport }) {
  const panel = createProjectsPanel({ onImport, visible: false });
  const wrap = document.createElement("div");
  wrap.className = "gb-projects-dropdown";
  wrap.hidden = true;
  wrap.appendChild(panel.el);
  document.body.appendChild(wrap);

  function syncName() {
    nameEl.textContent = currentProjectName();
  }

  function close() {
    wrap.hidden = true;
    button.classList.remove("active");
    panel.setVisible(false);
  }

  function open() {
    const r = button.getBoundingClientRect();
    wrap.style.top = `${r.bottom + 4}px`;
    wrap.style.left = `${r.left}px`;
    wrap.hidden = false;
    button.classList.add("active");
    panel.setVisible(true);
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    wrap.hidden ? open() : close();
  });
  document.addEventListener("click", (e) => {
    if (!wrap.hidden && !wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !wrap.hidden) close();
  });

  nameEl.addEventListener("click", async () => {
    const from = currentProjectName();
    const to = await showPrompt({
      title: "Rename Project", label: "Name", value: from,
      confirmLabel: "Rename", validate: nameValidator(from),
    });
    if (to && to !== from) {
      try { renameProject(from, to); }
      catch (err) { showToast(err.message, { error: true }); }
    }
  });

  subscribeProjects(syncName);
  syncName();
  return { panel, close };
}
