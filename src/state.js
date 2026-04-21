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
function emit(hint) { listeners.forEach((fn) => fn(doc, hint)); }

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
  // Clear any in-progress drag so it doesn't corrupt the stack.
  dragSnapshot = null;
  redoStack.push(clone(doc));
  doc = undoStack.pop();
  emit();
}
export function redo() {
  if (!redoStack.length) return;
  dragSnapshot = null;
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
  // Detect position-only changes so we can emit a fast-path hint.
  const posOnly = Object.keys(patch).length === 1 && Array.isArray(patch.pos);
  Object.assign(o, patch);
  if (o.type === "beam") o.length = snapLength(o.length);
  if (o.type === "panel") { const [cw, ch] = clampPanel(o.w, o.h); o.w = cw; o.h = ch; }
  if (Array.isArray(o.pos)) o.pos = snapPosFor(o, o.pos);
  // During a live batch (beginLive/endLive), skip per-object emits —
  // the batch will emit once at endLive().
  if (!liveMode) emit(posOnly ? "pos" : undefined);
}

// Live position updates during drag (no undo entry per frame).
// Emits "pos" hint so the renderer can skip expensive rebuilds.
export function setPosLive(id, pos) {
  const o = getObject(id);
  if (!o) return;
  o.pos = snapPosFor(o, pos);
  emit("pos");
}
// Drag protocol: snapshot the doc on pointerdown, push that snapshot
// onto the undo stack on pointerup — so one drag = one undo step.
let dragSnapshot = null;
let liveMode = false; // true between beginLive/endLive — suppresses per-object emits
export function beginLive() { dragSnapshot = clone(doc); liveMode = true; }
export function endLive() {
  liveMode = false;
  if (dragSnapshot) {
    undoStack.push(dragSnapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    dragSnapshot = null;
  }
  emit(); // full rebuild after batch completes
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

// ------- Grouping -------
let nextGroupId = 1;
function newGroupId() { return `g${nextGroupId++}`; }

// Assign all `ids` to a new group. One undo step.
export function groupObjects(ids) {
  if (!ids || ids.length < 2) return;
  pushUndo();
  const gid = newGroupId();
  for (const id of ids) {
    const o = getObject(id);
    if (o) o.group = gid;
  }
  emit();
}

// Remove the group tag from all `ids`. If the group was rotated, bake the
// rotation into world positions and snap back to the grid.
export function ungroupObjects(ids) {
  if (!ids || !ids.length) return;
  pushUndo();
  for (const id of ids) {
    const o = getObject(id);
    if (!o) continue;
    if (o.groupRotY && o.groupPivot) {
      // Bake rotation into world position.
      const wp = worldPosOf(o);
      o.pos = snapPosFor(o, wp);
      // Snap axis/normal to nearest 90° based on the rotation.
      const snappedRot = Math.round(o.groupRotY / 90) * 90;
      const turns = (((snappedRot % 360) + 360) % 360) / 90; // 0,1,2,3
      const rotAxis = { x: "z", z: "x", y: "y" };
      for (let t = 0; t < turns; t++) {
        if (o.type === "beam" || o.type === "fixture") o.axis = rotAxis[o.axis];
        else if (o.type === "panel") {
          o.normal = rotAxis[o.normal];
          const tmp = o.w; o.w = o.h; o.h = tmp;
        }
      }
    }
    delete o.group;
    delete o.groupRotY;
    delete o.groupPivot;
  }
  emit();
}

// Return all object ids that share a group with `id`.
export function groupMembers(id) {
  const o = getObject(id);
  if (!o || !o.group) return [id];
  return doc.objects.filter((x) => x.group === o.group).map((x) => x.id);
}

// Set the Y-axis rotation (degrees) and pivot for a group. Called during
// live drag rotation and by the T hotkey.
export function setGroupRotation(ids, angleDeg, pivot) {
  for (const id of ids) {
    const o = getObject(id);
    if (!o) continue;
    o.groupRotY = angleDeg;
    o.groupPivot = pivot;
  }
  emit("pos"); // fast path — only transforms changed, not geometry
}

export function setGroupRotationLive(ids, angleDeg, pivot) {
  for (const id of ids) {
    const o = getObject(id);
    if (!o) continue;
    o.groupRotY = angleDeg;
    o.groupPivot = pivot;
  }
  emit("pos");
}

// Get the current rotation angle for a group (from any member). Returns 0 if none.
export function getGroupRotation(id) {
  const o = getObject(id);
  return (o && o.groupRotY) || 0;
}

export function getGroupPivot(id) {
  const o = getObject(id);
  return (o && o.groupPivot) || null;
}

// Compute the world position of an object, accounting for group rotation.
// Returns a new [x, y, z] array.
export function worldPosOf(o) {
  if (!o.groupRotY || !o.groupPivot) return o.pos.slice();
  const [px, pz] = o.groupPivot;
  const rad = -o.groupRotY * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = o.pos[0] - px, dz = o.pos[2] - pz;
  return [
    px + dx * cos - dz * sin,
    o.pos[1],
    pz + dx * sin + dz * cos,
  ];
}

// Compute the group centroid in local (unrotated) space for a set of ids.
export function computeGroupPivot(ids) {
  let cx = 0, cz = 0, n = 0;
  for (const id of ids) {
    const o = getObject(id);
    if (!o) continue;
    const [mn, mx] = bbox(o);
    cx += (mn[0] + mx[0]) / 2;
    cz += (mn[2] + mx[2]) / 2;
    n++;
  }
  return n ? [cx / n, cz / n] : [0, 0];
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
  // Re-seed id/group counters so new ones don't collide.
  let max = 0, gmax = 0;
  for (const o of doc.objects) {
    const m = /^o(\d+)$/.exec(o.id || "");
    if (m) max = Math.max(max, +m[1]);
    const gm = /^g(\d+)$/.exec(o.group || "");
    if (gm) gmax = Math.max(gmax, +gm[1]);
  }
  nextId = max + 1;
  nextGroupId = gmax + 1;
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

// Compute an object's local AABB (before group rotation).
function localBbox(o) {
  if (o.type === "beam") {
    const dims = { x: [o.length, BEAM_SIZE, BEAM_SIZE], y: [BEAM_SIZE, o.length, BEAM_SIZE], z: [BEAM_SIZE, BEAM_SIZE, o.length] }[o.axis];
    return [o.pos.slice(), [o.pos[0] + dims[0], o.pos[1] + dims[1], o.pos[2] + dims[2]]];
  } else if (o.type === "fixture") {
    const d = fixtureDims(o.kind, o.axis);
    return [o.pos.slice(), [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
  } else {
    const t = 0.25;
    const d = o.normal === "x" ? [t, o.w, o.h] : o.normal === "y" ? [o.w, t, o.h] : [o.w, o.h, t];
    return [o.pos.slice(), [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
  }
}

// Compute an object's world-space AABB [min, max], each a 3-array.
// Accounts for group rotation by rotating the 8 local corners and taking min/max.
export function bbox(o) {
  const [lmn, lmx] = localBbox(o);
  if (!o.groupRotY || !o.groupPivot) return [lmn, lmx];

  const [px, pz] = o.groupPivot;
  const rad = -o.groupRotY * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const mn = [Infinity, lmn[1], Infinity];
  const mx = [-Infinity, lmx[1], -Infinity];
  // Rotate each of the 4 XZ corners (Y stays unchanged).
  for (const x of [lmn[0], lmx[0]]) {
    for (const z of [lmn[2], lmx[2]]) {
      const dx = x - px, dz = z - pz;
      const wx = px + dx * cos - dz * sin;
      const wz = pz + dx * sin + dz * cos;
      mn[0] = Math.min(mn[0], wx);
      mn[2] = Math.min(mn[2], wz);
      mx[0] = Math.max(mx[0], wx);
      mx[2] = Math.max(mx[2], wz);
    }
  }
  return [mn, mx];
}
