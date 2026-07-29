// Document model + undo/redo + pub-sub.
import { snap, snapLength, BEAM_SIZE, SNAP, HOLE_INSET, panelThickness, beamTiltTransform, rotateByEuler } from "./grid.js";
import { fixtureDims } from "./fixtures.js";
import { generateSeforim } from "./books.js";

// Panel sheet stock comes as 4'×8'. Either dimension may be the long one,
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
  // Books are decorative, real-world-scaled shelf dressing, not gridbeam
  // structure — grid-snapping X/Z would shuffle their spine widths apart
  // (each coordinate rounds independently) and ruin a tightly packed row.
  if (o.type === "book") {
    const out = pos.slice();
    if (out[1] < 0) out[1] = 0;
    return out;
  }
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

export function addBeam({ length = 12, axis = "x", pos = [0, 0, 0], tilt = 0 } = {}) {
  pushUndo();
  const o = { id: newId(), type: "beam", length: snapLength(length), axis, pos: pos.map(snap) };
  if (tilt) o.tilt = tilt;
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

export function addPanel({ w = 12, h = 12, normal = "y", pos = [0, 0, 0], material = "plywood" } = {}) {
  pushUndo();
  const [cw, ch] = clampPanel(w, h);
  const o = { id: newId(), type: "panel", w: cw, h: ch, normal, material, pos: [0, 0, 0] };
  o.pos = snapPosFor(o, pos);
  doc.objects.push(o);
  emit();
  return o.id;
}

// A row of "books" (seforim) standing shoulder to shoulder, filling `width`
// along `axis` starting at `pos`, each no taller than `height`. Generated
// covers/runs come from books.js; here we just lay them out and group them
// so the whole row moves/rotates as one unit. Returns the new object ids.
export function addSeforimRow({ axis = "x", pos = [0, 0, 0], width = 36, height = 11 } = {}) {
  const specs = generateSeforim(width, height);
  if (!specs.length) return [];
  pushUndo();
  const gid = specs.length > 1 ? newGroupId() : null;
  const ids = [];
  let offset = 0;
  for (const spec of specs) {
    const p = axis === "x" ? [pos[0] + offset, pos[1], pos[2]] : [pos[0], pos[1], pos[2] + offset];
    const o = {
      id: newId(), type: "book", axis, pos: p,
      width: spec.width, height: spec.height, depth: spec.depth,
      color: spec.color, accent: spec.accent,
    };
    if (gid) o.group = gid;
    doc.objects.push(o);
    ids.push(o.id);
    offset += spec.width;
  }
  emit();
  return ids;
}

export function updateObject(id, patch, { commit = true, keepExactY = false } = {}) {
  const o = getObject(id);
  if (!o) return;
  if (commit) pushUndo();
  // Detect position-only changes so we can emit a fast-path hint.
  const posOnly = Object.keys(patch).length === 1 && Array.isArray(patch.pos);
  // Surface-snapping wants the object's exact rest height (e.g. a panel's
  // top, which isn't necessarily on the 1.5" grid) — capture it before the
  // grid-snap below clobbers it.
  const exactY = keepExactY
    ? (Array.isArray(patch.foot) ? patch.foot[1] : Array.isArray(patch.pos) ? patch.pos[1] : undefined)
    : undefined;
  Object.assign(o, patch);
  if (o.type === "beam") o.length = snapLength(o.length);
  if (o.type === "panel") { const [cw, ch] = clampPanel(o.w, o.h); o.w = cw; o.h = ch; }
  if (o.peak) {
    // A rafter's pos/tilt are derived — snap the foot and re-solve the joint.
    if (Array.isArray(o.foot)) o.foot = o.foot.map(snap);
    if (exactY !== undefined) o.foot[1] = Math.max(0, exactY);
    solvePeakInternal(o.peak);
  } else if (Array.isArray(o.pos)) {
    o.pos = snapPosFor(o, o.pos);
    if (exactY !== undefined) o.pos[1] = Math.max(0, exactY);
  }
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
        if (o.type === "beam" || o.type === "fixture" || o.type === "book") o.axis = rotAxis[o.axis];
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

// ------- Peaks -------
// A peak links two rafters that share an apex. Each rafter stores the peak id
// and its fixed `foot` (bottom end, snapped to grid). Each rafter's pos+tilt are
// DERIVED: the apex is the upper intersection of the two rafters' reach, so
// changing a rafter's length (or moving a foot) re-solves and the joint holds.
// The angle is whatever it needs to be — not constrained to 45°.
let nextPeakId = 1;
function newPeakId() { return `pk${nextPeakId++}`; }

function peakRafters(pid) { return doc.objects.filter((o) => o.peak === pid); }

export function createPeak({ axis = "x", foot = [0, 0, 0], span = 24, lenA = 18, lenB = 18 } = {}) {
  pushUndo();
  const hi = axis === "x" ? 0 : 2, per = axis === "x" ? 2 : 0;
  const footA = foot.map(snap);
  // Rafter B is offset one beam-width in the perpendicular axis so the two
  // rafters sit face-to-face (not colliding) and bolt through at the peak —
  // how a grid-beam peak is actually assembled.
  const footB = footA.slice(); footB[hi] += snap(span); footB[per] += BEAM_SIZE;
  const pid = newPeakId();
  const mk = (len, ft) => ({ id: newId(), type: "beam", axis, length: snapLength(len), pos: [0, 0, 0], peak: pid, foot: ft });
  const a = mk(lenA, footA), b = mk(lenB, footB);
  doc.objects.push(a, b);
  solvePeakInternal(pid);
  emit();
  return [a.id, b.id];
}

// The foot's CENTERLINE point. `foot` is a grid reference like a normal beam's
// min-corner; adding half a beam on the two cross-section axes puts the rafter's
// centerline (and holes) on the same grid+0.75 lattice every other beam uses, so
// an untilted rafter coincides exactly with a normal beam at the same grid pos.
function footCenterOf(o) {
  const h = BEAM_SIZE / 2;
  return o.axis === "x" ? [o.foot[0], o.foot[1] + h, o.foot[2] + h]
       : o.axis === "z" ? [o.foot[0] + h, o.foot[1] + h, o.foot[2]]
       : [o.foot[0] + h, o.foot[1] + h, o.foot[2] + h];
}

// Compute the apex and write derived pos/tilt/apex onto both rafters. No emit.
function solvePeakInternal(pid) {
  const rafters = peakRafters(pid);
  if (rafters.length !== 2) return;
  const [A, B] = rafters;
  const axis = A.axis;
  const hi = axis === "x" ? 0 : 2, per = axis === "x" ? 2 : 0;
  // Solve the apex in the rafters' vertical plane (in-plane horizontal + Y) using
  // CENTERLINE feet. The perpendicular axis is ignored here: each rafter lies in
  // its own offset plane and only spans hi/Y, so both reach the same (hi, Y) apex
  // while keeping their own perpendicular coordinate — that 1.5" offset is what
  // lets them bolt at the top.
  const fcA = footCenterOf(A), fcB = footCenterOf(B);
  const ax = fcA[hi], ay = fcA[1], bx = fcB[hi], by = fcB[1];
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  // Solve to the rafters' TOP HOLES (HOLE_INSET in from the tip), not the tips —
  // so the bolt lands in a real hole and each rafter overhangs the joint a
  // little, giving the face-to-face overlap a peak bolt actually needs.
  const la = A.length - HOLE_INSET, lb = B.length - HOLE_INSET;
  // Two-circle intersection: `t` along the foot-to-foot line, `hh` perpendicular.
  const t = (la * la - lb * lb + d * d) / (2 * d);
  let h2 = la * la - t * t;
  if (h2 < 0) h2 = 0; // lengths too short to meet → apex collapses onto the line
  const hh = Math.sqrt(h2);
  const px = ax + t * dx / d, py = ay + t * dy / d;
  const ex = -dy / d, ey = dx / d; // unit perpendicular
  const up = (py + hh * ey) >= (py - hh * ey) ? 1 : -1; // pick the higher apex
  const aHi = px + up * hh * ex, aY = py + up * hh * ey;
  for (const o of rafters) {
    const fc = footCenterOf(o);
    const apex = [0, 0, 0];
    apex[hi] = aHi; apex[1] = aY; apex[per] = fc[per]; // stay in this rafter's plane
    setRafterFromApex(o, apex, fc);
  }
}

// Place a rafter so its foot centerline stays put and its far side reaches `apex`.
function setRafterFromApex(o, apex, fc) {
  const axis = o.axis, hi = axis === "x" ? 0 : 2, h = BEAM_SIZE / 2;
  const run = apex[hi] - fc[hi], rise = apex[1] - fc[1];
  // Keep tilt in [-90,90]: if the apex is to the +axis side, the near end is the
  // foot (+tilt); otherwise the far end is the foot (−tilt).
  let tilt, footAlong;
  if (run >= 0) { tilt = Math.atan2(rise, run) * 180 / Math.PI; footAlong = 0; }
  else { tilt = Math.atan2(-rise, -run) * 180 / Math.PI; footAlong = o.length; }
  const { euler, offset } = beamTiltTransform(axis, tilt, o.length);
  const V = axis === "x" ? [footAlong, h, h] : [h, h, footAlong];
  const rV = rotateByEuler(V, euler);
  // pos chosen so the foot end-center lands exactly on fc: fc = pos + offset + R·V.
  o.tilt = tilt;
  o.pos = [fc[0] - offset[0] - rV[0], fc[1] - offset[1] - rV[1], fc[2] - offset[2] - rV[2]];
  o.apex = apex.slice();
  o.footC = fc.slice(); // physical foot centerline — used for foot-join detection
}

// Re-solve a peak after an external edit (length or foot). Emits.
export function solvePeak(pid) { solvePeakInternal(pid); emit(); }

// Set one rafter's foot (drag), snapping XZ to the grid, then re-solve. Live.
export function setRafterFootLive(id, foot) {
  const o = getObject(id);
  if (!o || !o.peak) return;
  o.foot = [snap(foot[0]), foot[1], snap(foot[2])];
  solvePeakInternal(o.peak);
  emit("pos");
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
  // Re-seed id/group/peak counters so new ones don't collide.
  let max = 0, gmax = 0, pmax = 0;
  for (const o of doc.objects) {
    const m = /^o(\d+)$/.exec(o.id || "");
    if (m) max = Math.max(max, +m[1]);
    const gm = /^g(\d+)$/.exec(o.group || "");
    if (gm) gmax = Math.max(gmax, +gm[1]);
    const pm = /^pk(\d+)$/.exec(o.peak || "");
    if (pm) pmax = Math.max(pmax, +pm[1]);
  }
  nextId = max + 1;
  nextGroupId = gmax + 1;
  nextPeakId = pmax + 1;
  // Re-derive peak geometry from feet/lengths so files saved by an older solver
  // pick up the current alignment.
  const peakIds = new Set();
  for (const o of doc.objects) if (o.peak) peakIds.add(o.peak);
  for (const pid of peakIds) solvePeakInternal(pid);
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

    if (o.type === "beam" || o.type === "fixture" || o.type === "book") {
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

// An object's local box extents [dx, dy, dz], measured from its pos (min corner
// of the untilted box).
function objDims(o) {
  if (o.type === "beam") {
    return o.axis === "x" ? [o.length, BEAM_SIZE, BEAM_SIZE]
         : o.axis === "y" ? [BEAM_SIZE, o.length, BEAM_SIZE]
         : [BEAM_SIZE, BEAM_SIZE, o.length];
  } else if (o.type === "fixture") {
    return fixtureDims(o.kind, o.axis);
  } else if (o.type === "book") {
    return o.axis === "x" ? [o.width, o.height, o.depth] : [o.depth, o.height, o.width];
  } else {
    const t = panelThickness(o.material);
    return o.normal === "x" ? [t, o.w, o.h] : o.normal === "y" ? [o.w, t, o.h] : [o.w, o.h, t];
  }
}

// Compute an object's world-space AABB [min, max], each a 3-array. Accounts for
// beam tilt (rotation about the end-bolt pivot) and group rotation (yaw about
// the group pivot), matching how the mesh is actually rendered.
export function bbox(o) {
  const [dx, dy, dz] = objDims(o);
  const { euler, offset } = o.type === "beam"
    ? beamTiltTransform(o.axis, o.tilt, o.length)
    : { euler: { x: 0, y: 0, z: 0 }, offset: [0, 0, 0] };
  const tilted = euler.x !== 0 || euler.z !== 0;
  const grouped = o.groupRotY && o.groupPivot;

  // Fast path: axis-aligned and no group rotation.
  if (!tilted && !grouped) {
    return [o.pos.slice(), [o.pos[0] + dx, o.pos[1] + dy, o.pos[2] + dz]];
  }

  let gcos = 1, gsin = 0, px = 0, pz = 0;
  if (grouped) { [px, pz] = o.groupPivot; const rad = -o.groupRotY * Math.PI / 180; gcos = Math.cos(rad); gsin = Math.sin(rad); }

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const lx of [0, dx]) for (const ly of [0, dy]) for (const lz of [0, dz]) {
    // world = pos + offset + R·v — mirrors beam.js so bounds track the mesh.
    const [tx, ty, tz] = tilted ? rotateByEuler([lx, ly, lz], euler) : [lx, ly, lz];
    let wx = o.pos[0] + offset[0] + tx, wy = o.pos[1] + offset[1] + ty, wz = o.pos[2] + offset[2] + tz;
    if (grouped) {
      const rdx = wx - px, rdz = wz - pz;
      wx = px + rdx * gcos - rdz * gsin;
      wz = pz + rdx * gsin + rdz * gcos;
    }
    mn[0] = Math.min(mn[0], wx); mn[1] = Math.min(mn[1], wy); mn[2] = Math.min(mn[2], wz);
    mx[0] = Math.max(mx[0], wx); mx[1] = Math.max(mx[1], wy); mx[2] = Math.max(mx[2], wz);
  }
  return [mn, mx];
}
