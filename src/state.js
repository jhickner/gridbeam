// Document model + undo/redo + pub-sub.
import { snap, snapLength, BEAM_SIZE, SNAP } from "./grid.js";
import { fixtureDims } from "./fixtures.js";

// 1/4" hardboard sheets come as 4'×8'. Either dimension may be the long one,
// but the smaller must be ≤ 48" and the larger ≤ 96".
const PANEL_MAX_LONG = 96;
const PANEL_MAX_SHORT = 48;
function clampPanel(w, h) {
  w = isFinite(w) ? Math.min(Math.max(snap(w), SNAP), PANEL_MAX_LONG) : SNAP;
  h = isFinite(h) ? Math.min(Math.max(snap(h), SNAP), PANEL_MAX_LONG) : SNAP;
  if (w > PANEL_MAX_SHORT && h > PANEL_MAX_SHORT) {
    if (w <= h) w = PANEL_MAX_SHORT; else h = PANEL_MAX_SHORT;
  }
  return [w, h];
}

function snapPosFor(o, pos) {
  const out = pos.map(snap);
  // `pos` is the object's min corner, so pos[1] is its minimum Y. Clamp to
  // the ground plane — no part of any object may dip below Y = 0.
  if (out[1] < 0) out[1] = 0;
  return out;
}

let nextId = 1;
const newId = () => `o${nextId++}`;

function freshDoc() {
  return { version: 1, objects: [] };
}

let doc = freshDoc();
let undoStack = [];
let redoStack = [];
const listeners = new Set();

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => fn(doc)); }

export function getDoc() { return doc; }
export function getObject(id) { return doc.objects.find((o) => o.id === id); }

function clone(d) { return JSON.parse(JSON.stringify(d)); }

function pushUndo() {
  undoStack.push(clone(doc));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(clone(doc));
  doc = undoStack.pop();
  emit();
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(clone(doc));
  doc = redoStack.pop();
  emit();
}

export function addBeam({ length = 12, axis = "x", pos = [0, 0, 0] } = {}) {
  pushUndo();
  const o = { id: newId(), type: "beam", length: snapLength(length), axis, pos: pos.map(snap) };
  doc.objects.push(o);
  emit();
  return o.id;
}

export function addFixture({ kind, axis = "x", pos = [0, 0, 0] } = {}) {
  if (!kind) throw new Error("addFixture requires a kind");
  pushUndo();
  const o = { id: newId(), type: "fixture", kind, axis, pos: pos.map(snap) };
  doc.objects.push(o);
  emit();
  return o.id;
}

export function addPanel({ w = 12, h = 12, normal = "y", pos = [0, 0, 0] } = {}) {
  pushUndo();
  const [cw, ch] = clampPanel(w, h);
  const o = { id: newId(), type: "panel", w: cw, h: ch, normal, pos: [0, 0, 0] };
  o.pos = snapPosFor(o, pos);
  doc.objects.push(o);
  emit();
  return o.id;
}

export function updateObject(id, patch, { commit = true } = {}) {
  const o = getObject(id);
  if (!o) return;
  if (commit) pushUndo();
  Object.assign(o, patch);
  if (o.type === "beam") o.length = snapLength(o.length);
  if (o.type === "panel") { const [cw, ch] = clampPanel(o.w, o.h); o.w = cw; o.h = ch; }
  if (Array.isArray(o.pos)) o.pos = snapPosFor(o, o.pos);
  emit();
}

// Live position updates during drag (no undo entry per frame).
export function setPosLive(id, pos) {
  const o = getObject(id);
  if (!o) return;
  o.pos = snapPosFor(o, pos);
  emit();
}
// Drag protocol: snapshot the doc on pointerdown, push that snapshot
// onto the undo stack on pointerup — so one drag = one undo step.
let dragSnapshot = null;
export function beginLive() { dragSnapshot = clone(doc); }
export function endLive() {
  if (dragSnapshot) {
    undoStack.push(dragSnapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    dragSnapshot = null;
  }
  emit();
}

export function removeObject(id) {
  pushUndo();
  doc.objects = doc.objects.filter((o) => o.id !== id);
  emit();
}

// Remove many objects as a single undo step.
export function removeObjects(ids) {
  if (!ids || !ids.length) return;
  pushUndo();
  const set = new Set(ids);
  doc.objects = doc.objects.filter((o) => !set.has(o.id));
  emit();
}

export function clearAll() {
  pushUndo();
  doc = freshDoc();
  emit();
}

export function loadDoc(next) {
  undoStack = []; redoStack = [];
  doc = next && next.objects ? next : freshDoc();
  // Sanitize: fix any NaN dimensions that may have been persisted.
  for (const o of doc.objects) {
    if (o.type === "panel") {
      const [cw, ch] = clampPanel(o.w, o.h);
      o.w = cw; o.h = ch;
    }
  }
  // Re-seed id counter so new ids don't collide.
  let max = 0;
  for (const o of doc.objects) {
    const m = /^o(\d+)$/.exec(o.id || "");
    if (m) max = Math.max(max, +m[1]);
  }
  nextId = max + 1;
  emit();
}

// Rotate a set of selected objects together 90° CCW around the vertical Y
// axis, pivoting about the centroid of their AABBs (snapped to the grid).
// One atomic undo step. Beam axes and panel normals map x↔z (y stays); panel
// w/h swap; all positions are re-snapped so the grid invariants are preserved.
export function rotateSelectionY90(ids) {
  if (!ids || !ids.length) return;
  pushUndo();

  const rotAxis = { x: "z", z: "x", y: "y" };
  const items = [];
  let cxSum = 0, czSum = 0;
  for (const id of ids) {
    const o = getObject(id);
    if (!o) continue;
    const [mn, mx] = bbox(o);
    const cx = (mn[0] + mx[0]) / 2;
    const cz = (mn[2] + mx[2]) / 2;
    cxSum += cx; czSum += cz;
    items.push({ o, mn, mx, cx, cz });
  }
  if (!items.length) return;

  // Pivot: XZ centroid snapped to the 1.5" grid so rotated positions stay clean.
  const px = Math.round((cxSum / items.length) / SNAP) * SNAP;
  const pz = Math.round((czSum / items.length) / SNAP) * SNAP;

  for (const it of items) {
    const { o, mn, mx, cx, cz } = it;
    // 90° CCW about (px, pz): (x,z) → (px - (z-pz), pz + (x-px))
    const nx = px - (cz - pz);
    const nz = pz + (cx - px);

    const oldD = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const newD = [oldD[2], oldD[1], oldD[0]]; // swap X and Z extents
    const newPos = [nx - newD[0] / 2, mn[1], nz - newD[2] / 2];

    if (o.type === "beam" || o.type === "fixture") {
      o.axis = rotAxis[o.axis];
    } else {
      o.normal = rotAxis[o.normal];
      // Rotating about Y always swaps the panel's w/h regardless of normal
      // (see derivation in the rotation notes).
      const tmp = o.w; o.w = o.h; o.h = tmp;
    }
    o.pos = snapPosFor(o, newPos);
  }
  emit();
}

// Compute an object's world-space AABB [min, max], each a 3-array.
export function bbox(o) {
  if (o.type === "beam") {
    const dims = { x: [o.length, BEAM_SIZE, BEAM_SIZE], y: [BEAM_SIZE, o.length, BEAM_SIZE], z: [BEAM_SIZE, BEAM_SIZE, o.length] }[o.axis];
    return [o.pos.slice(), [o.pos[0] + dims[0], o.pos[1] + dims[1], o.pos[2] + dims[2]]];
  } else if (o.type === "fixture") {
    const d = fixtureDims(o.kind, o.axis);
    return [o.pos.slice(), [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
  } else {
    // panel: 1/4" thick along `normal`, w along next axis cyclically, h along the one after
    const t = 0.25;
    const d = o.normal === "x" ? [t, o.w, o.h] : o.normal === "y" ? [o.w, t, o.h] : [o.w, o.h, t];
    return [o.pos.slice(), [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
  }
}
