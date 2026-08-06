import { getDoc, loadDoc, subscribe } from "./state.js";
import { showToast } from "./ui/dialog.js";

const LEGACY_KEY = "gridbeam.autosave.v1";
const INDEX_KEY = "gridbeam.projects.v1";
const CURRENT_KEY = "gridbeam.currentProject";
const DEFAULT_NAME = "Untitled";
const projectKey = (name) => `gridbeam.project.v1.${name}`;

// Save/load envelope: { name, doc, view } so the camera and project name travel
// with the file. Back-compat: older saves are raw docs (detect by `objects`) or
// a bare { doc, view } pair with no name.
function unpack(raw) {
  if (!raw) return { doc: null, view: null, name: null };
  if (Array.isArray(raw.objects)) return { doc: raw, view: null, name: null };  // oldest
  return { doc: raw.doc || null, view: raw.view || null, name: raw.name || null };
}

let _getView = () => null;
let _applyView = () => {};

// ------- Project index -------

function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw == null) return null;               // null = never migrated
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); }
  catch (e) { warnStorage(e); }
}

function warnStorage(e) {
  console.warn("gridbeam storage write failed", e);
  const full = e && (e.name === "QuotaExceededError" || e.code === 22);
  showToast(
    full ? "Storage full — delete a project to keep saving." : "Save failed — changes may be lost.",
    { error: true }
  );
}

function indexOfName(list, name) {
  return list.findIndex((p) => p.name === name);
}

export function listProjects() {
  return (readIndex() || []).map((p) => ({ ...p }));
}

export function currentProjectName() {
  return localStorage.getItem(CURRENT_KEY) || DEFAULT_NAME;
}

function setCurrent(name) {
  try { localStorage.setItem(CURRENT_KEY, name); } catch (e) { warnStorage(e); }
}

export function uniqueName(base) {
  const list = readIndex() || [];
  const taken = new Set(list.map((p) => p.name));
  let name = (base || DEFAULT_NAME).trim() || DEFAULT_NAME;
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function readProject(name) {
  try { return unpack(JSON.parse(localStorage.getItem(projectKey(name)))); }
  catch { return { doc: null, view: null, name: null }; }
}

// Write the in-memory document into `name`'s slot and refresh its index entry.
function writeProject(name) {
  writeProjectDoc(name, getDoc(), _getView());
}

// Write an arbitrary doc into `name`'s slot, keeping the index ordered
// most-recently-saved first.
function writeProjectDoc(name, doc, view, savedAt) {
  try {
    localStorage.setItem(projectKey(name), JSON.stringify({ name, doc, view: view || null }));
  } catch (e) { warnStorage(e); return; }

  const list = readIndex() || [];
  const at = indexOfName(list, name);
  const entry = { name, savedAt: savedAt || Date.now(), count: doc.objects.length };
  if (at >= 0) list.splice(at, 1);
  list.unshift(entry);
  writeIndex(list);
  emitProjects();
}

// ------- Autosave -------

let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeProject(currentProjectName());
  }, 200);
}

// Commit any pending debounced write immediately. Must run before switching
// projects, or the last edits land in the wrong slot.
export function flushSave() {
  if (saveTimer == null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeProject(currentProjectName());
}

// ------- Change notification (for the projects UI) -------

const projectListeners = new Set();
export function subscribeProjects(fn) {
  projectListeners.add(fn);
  return () => projectListeners.delete(fn);
}
function emitProjects() {
  for (const fn of projectListeners) fn();
}

// ------- Init & migration -------

// One-time move from the single `gridbeam.autosave.v1` slot to a named project.
// The legacy key is left in place so rolling back loses nothing.
function migrate() {
  if (readIndex() != null) return;
  let list = [];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const { doc, view } = unpack(JSON.parse(raw));
      if (doc) {
        localStorage.setItem(
          projectKey(DEFAULT_NAME),
          JSON.stringify({ name: DEFAULT_NAME, doc, view })
        );
        list = [{ name: DEFAULT_NAME, savedAt: Date.now(), count: doc.objects.length }];
        setCurrent(DEFAULT_NAME);
      }
    }
  } catch (e) { console.warn("project migration failed", e); }
  writeIndex(list);
}

export function initAutosave({ getView, applyView }) {
  _getView = getView;
  _applyView = applyView;

  migrate();

  const list = readIndex() || [];
  let name = localStorage.getItem(CURRENT_KEY);
  if (!name || indexOfName(list, name) < 0) name = list.length ? list[0].name : DEFAULT_NAME;
  setCurrent(name);

  try {
    const { doc, view } = readProject(name);
    if (doc) loadDoc(doc);
    if (view) _applyView(view);
  } catch (e) { console.warn("project restore failed", e); }

  // First run: give the (empty) current project an index entry so it shows up
  // in the picker before the first edit.
  if (indexOfName(readIndex() || [], name) < 0) writeProject(name);

  subscribe(scheduleSave);
  // Expose a hook so the camera can trigger saves on orbit changes.
  return scheduleSave;
}

// ------- Project CRUD -------

export function newProject(name) {
  flushSave();
  const next = uniqueName(name || DEFAULT_NAME);
  setCurrent(next);
  loadDoc(null);
  writeProject(next);
  return next;
}

// Load a stored project into the editor unconditionally.
function activate(name) {
  const { doc, view } = readProject(name);
  setCurrent(name);
  loadDoc(doc);
  if (view) _applyView(view);
}

export function openProject(name) {
  if (name === currentProjectName()) return;
  flushSave();
  activate(name);
  emitProjects();
}

// Store a document as a new project WITHOUT switching to it. Returns the name
// actually used (de-duplicated). Used by the import gallery.
export function createProject(desiredName, doc, view = null) {
  const name = uniqueName(desiredName);
  writeProjectDoc(name, doc, view);
  return name;
}

export function saveProjectAs(name) {
  flushSave();
  const next = uniqueName(name || DEFAULT_NAME);
  setCurrent(next);
  writeProject(next);
  return next;
}

export function renameProject(from, to) {
  const target = (to || "").trim();
  if (!target || target === from) return from;
  const list = readIndex() || [];
  if (indexOfName(list, target) >= 0) throw new Error(`A project named "${target}" already exists.`);

  const at = indexOfName(list, from);
  if (at < 0) return from;

  if (from === currentProjectName()) flushSave();
  const payload = readProject(from);
  try {
    localStorage.setItem(
      projectKey(target),
      JSON.stringify({ name: target, doc: payload.doc, view: payload.view })
    );
  } catch (e) { warnStorage(e); return from; }
  localStorage.removeItem(projectKey(from));

  list[at] = { ...list[at], name: target };
  writeIndex(list);
  if (from === currentProjectName()) setCurrent(target);
  emitProjects();
  return target;
}

export function deleteProject(name) {
  const list = readIndex() || [];
  const at = indexOfName(list, name);
  if (at < 0) return;

  const wasCurrent = name === currentProjectName();
  if (wasCurrent) { clearTimeout(saveTimer); saveTimer = null; }

  localStorage.removeItem(projectKey(name));
  list.splice(at, 1);
  writeIndex(list);

  if (wasCurrent) {
    // activate() rather than openProject() — current still points at the
    // project we just removed, which would trip its same-name guard.
    if (list.length) activate(list[0].name);
    else newProject(DEFAULT_NAME);
  }
  emitProjects();
}

// ------- File import / export -------

export function downloadJson() {
  const name = currentProjectName();
  const payload = { name, doc: getDoc(), view: _getView() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "gridbeam";
  a.href = url;
  a.download = `${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ------- Whole-store backup -------

const BACKUP_KIND = "gridbeam-backup";

export function isBackupPayload(raw) {
  return !!raw && raw.kind === BACKUP_KIND && Array.isArray(raw.projects);
}

// Bundle every stored project into one file.
export function exportAllProjects() {
  flushSave();
  const projects = (readIndex() || [])
    .map((p) => {
      const { doc, view } = readProject(p.name);
      return doc ? { name: p.name, savedAt: p.savedAt, doc, view } : null;
    })
    .filter(Boolean);

  const payload = {
    kind: BACKUP_KIND,
    version: 1,
    exportedAt: Date.now(),
    current: currentProjectName(),
    projects,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gridbeam-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return projects.length;
}

export function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      let raw;
      try { raw = JSON.parse(r.result); }
      catch { reject(new Error("That file isn't valid JSON.")); return; }
      if (!isBackupPayload(raw)) {
        reject(new Error("That isn't a Grid Beam backup file — use Import… for single projects."));
        return;
      }
      const usable = raw.projects.filter((p) => p && p.doc && Array.isArray(p.doc.objects));
      if (!usable.length) { reject(new Error("That backup contains no projects.")); return; }
      resolve({ ...raw, projects: usable });
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// mode "merge"   — add the backup's projects alongside what's here, renaming
//                  collisions rather than overwriting.
// mode "replace" — wipe the store first, so names come back exactly as saved.
export function restoreBackup(payload, { mode = "merge" } = {}) {
  flushSave();
  clearTimeout(saveTimer);
  saveTimer = null;

  if (mode === "replace") {
    for (const p of readIndex() || []) localStorage.removeItem(projectKey(p.name));
    writeIndex([]);
  }

  const restored = [];
  for (const p of payload.projects) {
    const name = uniqueName(p.name || DEFAULT_NAME);
    writeProjectDoc(name, p.doc, p.view, p.savedAt);
    restored.push({ from: p.name, to: name });
  }

  // writeProjectDoc unshifts each entry, so the index ends up reversed.
  const list = readIndex() || [];
  list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  writeIndex(list);

  const wanted = restored.find((r) => r.from === payload.current);
  const target = (wanted && wanted.to) || restored[0].to;
  activate(target);
  emitProjects();

  return {
    count: restored.length,
    renamed: restored.filter((r) => r.from !== r.to).length,
    current: target,
  };
}

// Imports as a NEW named project rather than overwriting the current one.
export function loadFromFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const { doc, view, name } = unpack(JSON.parse(r.result));
        flushSave();
        const fallback = file.name.replace(/\.json$/i, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
        const next = uniqueName(name || fallback || DEFAULT_NAME);
        setCurrent(next);
        loadDoc(doc);
        if (view) _applyView(view);
        writeProject(next);
        resolve(next);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
