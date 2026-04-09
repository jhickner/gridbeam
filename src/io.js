import { getDoc, loadDoc, subscribe } from "./state.js";

const KEY = "gridbeam.autosave.v1";

// Save/load envelope: { doc, view } so the camera travels with the project.
// Back-compat: older saves are raw docs — detect by presence of `objects`.
function unpack(raw) {
  if (!raw) return { doc: null, view: null };
  if (Array.isArray(raw.objects)) return { doc: raw, view: null };      // old
  return { doc: raw.doc || null, view: raw.view || null };
}

let _getView = () => null;
let _applyView = () => {};

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = { doc: getDoc(), view: _getView() };
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch (e) { console.warn("autosave failed", e); }
  }, 200);
}

export function initAutosave({ getView, applyView }) {
  _getView = getView;
  _applyView = applyView;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const { doc, view } = unpack(JSON.parse(raw));
      if (doc) loadDoc(doc);
      if (view) _applyView(view);
    }
  } catch (e) { console.warn("autosave restore failed", e); }

  subscribe(scheduleSave);
  // Expose a hook so the camera can trigger saves on orbit changes.
  return scheduleSave;
}

export function downloadJson() {
  const payload = { doc: getDoc(), view: _getView() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gridbeam-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function loadFromFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const { doc, view } = unpack(JSON.parse(r.result));
        if (doc) loadDoc(doc);
        if (view) _applyView(view);
        resolve();
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
