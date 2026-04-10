import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { SNAP, BEAM_SIZE, PANEL_THICK, fmtIn } from "./grid.js";
import {
  getDoc, getObject, subscribe,
  addBeam, addPanel, addFixture, updateObject, removeObject, removeObjects, clearAll,
  setPosLive, beginLive, endLive, undo, redo, rotateSelectionY90, bbox,
  groupObjects, ungroupObjects, groupMembers,
} from "./state.js";
import { buildBeamMesh } from "./beam.js";
import { buildPanelMesh } from "./panel.js";
import { FIXTURES, buildFixtureMesh, fixtureLabel } from "./fixtures.js";
import { computeConnections } from "./connections.js";
import { computeBom } from "./bom.js";
import { initAutosave, downloadJson, loadFromFile } from "./io.js";
import { openExportView } from "./exportView.js";

// ------- Three.js setup -------
const wrap = document.getElementById("canvas-wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
camera.position.set(60, 60, 80);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(12, 6, 12);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(40, 80, 30);
scene.add(dir);

const gridHelper = new THREE.GridHelper(240, 160, 0x444444, 0x2a2a2a);
gridHelper.position.set(120, 0, 120);
scene.add(gridHelper);

scene.add(new THREE.AxesHelper(6));

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
resize();

// ------- Mesh management -------
const root = new THREE.Group();
scene.add(root);
const meshById = new Map();
let boltsGroup = new THREE.Group();
scene.add(boltsGroup);

const boltGeom = new THREE.SphereGeometry(0.35, 12, 10);
const beamBoltMat = new THREE.MeshBasicMaterial({ color: 0xffd24a });

// ------- Multi-selection -------
const selectedIds = new Set();
// One Box3Helper per selected object; rebuilt when selection changes.
const outlineHelpers = new Map();

const hasSel = () => selectedIds.size > 0;
const primaryId = () => (selectedIds.size ? selectedIds.values().next().value : null);
const selectOnly = (id) => { selectedIds.clear(); if (id) selectedIds.add(id); };
const toggleSel = (id) => { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); };

function clearOutlines() {
  for (const [, h] of outlineHelpers) scene.remove(h);
  outlineHelpers.clear();
}
function refreshOutlines() {
  clearOutlines();
  for (const id of selectedIds) {
    const g = meshById.get(id);
    if (!g) { selectedIds.delete(id); continue; }
    const helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(g), 0x00e5ff);
    outlineHelpers.set(id, helper);
    scene.add(helper);
  }
}

function rebuildMeshes(doc) {
  const { bolts, boltedHoles } = computeConnections(doc);

  for (const [, g] of meshById) root.remove(g);
  meshById.clear();
  for (const o of doc.objects) {
    const g = o.type === "beam"
      ? buildBeamMesh(o, boltedHoles.get(o.id), minimalMode)
      : o.type === "fixture"
      ? buildFixtureMesh(o)
      : buildPanelMesh(o, clippedCorners);
    root.add(g);
    meshById.set(o.id, g);
  }

  boltsGroup.clear();
  for (const c of bolts) {
    const s = new THREE.Mesh(boltGeom, beamBoltMat);
    s.position.set(c.pos[0], c.pos[1], c.pos[2]);
    boltsGroup.add(s);
  }

  // Prune selection of any ids that no longer exist.
  for (const id of [...selectedIds]) if (!meshById.has(id)) selectedIds.delete(id);

  refreshOutlines();
  refreshSidebar();
  refreshSummary();
}

subscribe((doc) => {
  try { rebuildMeshes(doc); }
  catch (e) { console.error("rebuildMeshes failed:", e); }
});

// ------- Picking & dragging -------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickObjectId(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(root.children, true);
  for (const h of hits) {
    let obj = h.object;
    while (obj && !obj.userData.id) obj = obj.parent;
    if (obj && obj.userData.id) return obj.userData.id;
  }
  return null;
}

const planeAtY = (y) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);

// Drag state:
//  dragY       — plane height used for pointer → world projection
//  anchorXZ    — world XZ of the pointer hit at pointerdown
//  items       — [{ id, startPos: [x,y,z] }] snapshot for every selected object
//                so we can move them all by the same delta (and restore on shift-lock)
let drag = null;
let clipboard = null; // array of plain-object snapshots (no ids)

// Minimal-hole mode: when on, beams render only the holes required by bolted
// connections, and the exported plan includes drilling instructions.
let minimalMode = localStorage.getItem("gridbeam.minimalMode") === "1";
let clippedCorners = localStorage.getItem("gridbeam.clippedCorners") === "1";

// Marquee (rubber-band) selection: hold Alt/Option and drag a rectangle over
// the canvas. Shift+Alt adds to the current selection instead of replacing.
let marquee = null; // { startX, startY, curX, curY, el, additive }

function makeMarqueeEl() {
  const el = document.createElement("div");
  el.id = "marquee";
  wrap.appendChild(el);
  return el;
}

function updateMarqueeEl() {
  const { startX, startY, curX, curY, el } = marquee;
  const x = Math.min(startX, curX);
  const y = Math.min(startY, curY);
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.width = Math.abs(curX - startX) + "px";
  el.style.height = Math.abs(curY - startY) + "px";
}

// Project a world-space point to pixel coordinates relative to the canvas.
const _v = new THREE.Vector3();
function worldToScreen(x, y, z) {
  _v.set(x, y, z).project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: ((_v.x + 1) / 2) * rect.width,
    y: ((1 - _v.y) / 2) * rect.height,
    behind: _v.z > 1 || _v.z < -1,
  };
}

// Screen-space AABB of an object's 3D AABB. Returns null if entirely off-screen.
function screenBoxOfMesh(meshGroup) {
  const box = new THREE.Box3().setFromObject(meshGroup);
  if (!isFinite(box.min.x) || box.isEmpty()) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners = [
    [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
    [box.min.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.min.z],
    [box.min.x, box.min.y, box.max.z], [box.max.x, box.min.y, box.max.z],
    [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z],
  ];
  for (const c of corners) {
    const s = worldToScreen(c[0], c[1], c[2]);
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  return { minX, minY, maxX, maxY };
}

function finishMarquee() {
  if (!marquee) return;
  const rect = renderer.domElement.getBoundingClientRect();
  // Marquee coordinates were captured in canvas-wrap space; align to canvas.
  const mx1 = Math.min(marquee.startX, marquee.curX);
  const mx2 = Math.max(marquee.startX, marquee.curX);
  const my1 = Math.min(marquee.startY, marquee.curY);
  const my2 = Math.max(marquee.startY, marquee.curY);

  // Treat zero-area marquees as a click — clear selection unless additive.
  const tiny = (mx2 - mx1) < 3 && (my2 - my1) < 3;

  if (!marquee.additive && !tiny) selectedIds.clear();
  if (!tiny) {
    for (const [id, g] of meshById) {
      const sb = screenBoxOfMesh(g);
      if (!sb) continue;
      const overlap = sb.maxX >= mx1 && sb.minX <= mx2 && sb.maxY >= my1 && sb.minY <= my2;
      if (overlap) {
        // Include entire group when any member is hit.
        for (const m of groupMembers(id)) selectedIds.add(m);
      }
    }
  } else if (!marquee.additive) {
    selectedIds.clear();
  }

  marquee.el.remove();
  marquee = null;
  refreshOutlines();
  refreshSidebar();
}

function onPointerDown(e) {
  if (e.button !== 0) return;

  // Alt/Option = rubber-band selection instead of orbit/drag.
  if (e.altKey) {
    const rect = wrap.getBoundingClientRect();
    marquee = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      curX: e.clientX - rect.left,
      curY: e.clientY - rect.top,
      el: makeMarqueeEl(),
      additive: e.shiftKey,
    };
    updateMarqueeEl();
    controls.enabled = false;
    e.preventDefault();
    return;
  }

  const id = pickObjectId(e);

  // Clicking empty space = let OrbitControls rotate the view. Selection is
  // preserved; clear it explicitly with Esc or by clicking another object.
  if (!id) return;

  // Shift-click: toggle this id (and its group) in the selection.
  // Plain click on an already-selected object: keep the selection (so drag moves all).
  // Plain click on an unselected object: replace selection with this id + group members.
  const members = groupMembers(id);
  if (e.shiftKey) {
    // Toggle: if already selected remove the whole group, else add it.
    if (selectedIds.has(id)) {
      for (const m of members) selectedIds.delete(m);
    } else {
      for (const m of members) selectedIds.add(m);
    }
  } else if (!selectedIds.has(id)) {
    selectedIds.clear();
    for (const m of members) selectedIds.add(m);
  }
  refreshOutlines();
  refreshSidebar();

  // Nothing selected after the click? (shift-click that deselected the only item.)
  if (!selectedIds.has(id)) return;

  // Build drag set from current selection.
  const o = getObject(id);
  const dragY = o.pos[1];
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(planeAtY(dragY), hit)) return;

  const items = [];
  for (const sid of selectedIds) {
    const so = getObject(sid);
    if (so) items.push({ id: sid, startPos: so.pos.slice() });
  }
  drag = { dragY, anchorXZ: [hit.x, hit.z], items };
  controls.enabled = false;
  beginLive();
  document.body.classList.add("dragging");
}

function onPointerMove(e) {
  if (marquee) {
    const rect = wrap.getBoundingClientRect();
    marquee.curX = e.clientX - rect.left;
    marquee.curY = e.clientY - rect.top;
    updateMarqueeEl();
    return;
  }
  if (!drag) return;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(planeAtY(drag.dragY), hit)) return;
  let dx = hit.x - drag.anchorXZ[0];
  let dz = hit.z - drag.anchorXZ[1];

  // Shift = lock to the axis with the greater travel from the drag origin.
  if (e.shiftKey) {
    if (Math.abs(dx) >= Math.abs(dz)) dz = 0;
    else dx = 0;
  }

  for (const it of drag.items) {
    setPosLive(it.id, [it.startPos[0] + dx, it.startPos[1], it.startPos[2] + dz]);
  }
}

function onPointerUp() {
  if (marquee) {
    finishMarquee();
    controls.enabled = true;
    return;
  }
  if (!drag) return;
  drag = null;
  controls.enabled = true;
  document.body.classList.remove("dragging");
  endLive();
}

renderer.domElement.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

// ------- Hotkeys -------
const cycleAxis = (a) => (a === "x" ? "y" : a === "y" ? "z" : "x");

function forEachSelected(fn) {
  for (const id of [...selectedIds]) {
    const o = getObject(id);
    if (o) fn(o);
  }
}

// Apply a per-object mutation to every selected object as ONE undo step.
// The callback should use updateObject(..., { commit: false }) so individual
// edits don't push their own snapshots — beginLive/endLive wraps the batch.
function mutateSelection(fn) {
  if (!hasSel()) return;
  beginLive();
  for (const id of [...selectedIds]) {
    const o = getObject(id);
    if (o) fn(o);
  }
  endLive();
}

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  // Undo/redo.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }

  // Group / ungroup.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
    e.preventDefault();
    if (e.shiftKey) {
      ungroupObjects([...selectedIds]);
    } else {
      groupObjects([...selectedIds]);
    }
    refreshSidebar();
    return;
  }

  // Select all.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectedIds.clear();
    for (const o of getDoc().objects) selectedIds.add(o.id);
    refreshOutlines();
    refreshSidebar();
    return;
  }

  // Copy / paste.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
    if (!hasSel()) return;
    clipboard = [];
    for (const id of selectedIds) {
      const o = getObject(id);
      if (!o) continue;
      const { id: _omit, ...rest } = o;
      clipboard.push(JSON.parse(JSON.stringify(rest)));
    }
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
    if (!clipboard || !clipboard.length) return;
    const newIds = [];
    for (const c of clipboard) {
      // Offset each paste from its source so they don't land on top.
      const pos = [c.pos[0] + SNAP * 2, c.pos[1], c.pos[2] + SNAP * 2];
      if (c.type === "beam") newIds.push(addBeam({ length: c.length, axis: c.axis, pos }));
      else if (c.type === "fixture") newIds.push(addFixture({ kind: c.kind, axis: c.axis, pos }));
      else if (c.type === "panel") newIds.push(addPanel({ w: c.w, h: c.h, normal: c.normal, pos }));
    }
    selectedIds.clear();
    for (const id of newIds) selectedIds.add(id);
    refreshOutlines();
    refreshSidebar();
    e.preventDefault();
    return;
  }

  if (!hasSel()) return;

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeObjects([...selectedIds]);
    selectedIds.clear();
    return;
  }
  if (e.key === "Escape") {
    selectedIds.clear();
    refreshOutlines();
    refreshSidebar();
    return;
  }
  if (e.key === "r" || e.key === "R") {
    if (selectedIds.size > 1) {
      // Group rotate: 90° about the selection's centroid on the Y axis,
      // keeping the relative arrangement of the selected objects intact.
      rotateSelectionY90([...selectedIds]);
    } else {
      // Single object: just cycle its own orientation axis.
      forEachSelected((o) => {
        if (o.type === "beam") updateObject(o.id, { axis: cycleAxis(o.axis) });
        else if (o.type === "fixture") {
          // Fixtures only rotate around Y (thickness is vertical), so cycle x↔z.
          updateObject(o.id, { axis: o.axis === "x" ? "z" : "x" });
        } else updateObject(o.id, { normal: cycleAxis(o.normal) });
      });
    }
    return;
  }
  if (e.key === "q" || e.key === "Q") {
    mutateSelection((o) =>
      updateObject(o.id, { pos: [o.pos[0], o.pos[1] - SNAP, o.pos[2]] }, { commit: false }));
    return;
  }
  if (e.key === "e" || e.key === "E") {
    mutateSelection((o) =>
      updateObject(o.id, { pos: [o.pos[0], o.pos[1] + SNAP, o.pos[2]] }, { commit: false }));
    return;
  }
  // Arrow keys — nudge selected objects by one 1.5" step on the ground plane.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const dx = e.key === "ArrowLeft" ? -SNAP : e.key === "ArrowRight" ? SNAP : 0;
    const dz = e.key === "ArrowUp" ? -SNAP : e.key === "ArrowDown" ? SNAP : 0;
    mutateSelection((o) =>
      updateObject(o.id, { pos: [o.pos[0] + dx, o.pos[1], o.pos[2] + dz] }, { commit: false }));
    return;
  }
  // [ / ] — shrink/grow beams (length) or panels (W and H) by one 1.5" step.
  if (e.key === "[" || e.key === "]") {
    const delta = e.key === "]" ? SNAP : -SNAP;
    mutateSelection((o) => {
      if (o.type === "beam") updateObject(o.id, { length: o.length + delta }, { commit: false });
      else if (o.type === "panel") updateObject(o.id, { w: o.w + delta, h: o.h + delta }, { commit: false });
    });
    return;
  }
});

// ------- Sidebar -------
const elSelEmpty = document.getElementById("sel-empty");
const elSelProps = document.getElementById("sel-props");
const elSummary = document.getElementById("summary");

function refreshSidebar() {
  if (!hasSel()) {
    elSelEmpty.hidden = false;
    elSelProps.hidden = true;
    elSelProps.innerHTML = "";
    return;
  }
  elSelEmpty.hidden = true;
  elSelProps.hidden = false;

  // Multi-selection: show count + a note. Per-object property editing stays
  // single-selection only to keep the inputs unambiguous.
  if (selectedIds.size > 1) {
    // Combined AABB across the selection, reported as W × D × H (X, Z, Y).
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const id of selectedIds) {
      const o = getObject(id);
      if (!o) continue;
      const [mn, mx] = bbox(o);
      for (let i = 0; i < 3; i++) {
        if (mn[i] < min[i]) min[i] = mn[i];
        if (mx[i] > max[i]) max[i] = mx[i];
      }
    }
    const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
    // Check if selection is a single group.
    const groups = new Set();
    for (const id of selectedIds) { const o = getObject(id); if (o && o.group) groups.add(o.group); }
    const isGrouped = groups.size === 1 && selectedIds.size === groupMembers([...selectedIds][0]).length;

    elSelProps.innerHTML = `
      <div><strong>${selectedIds.size} objects selected</strong>
        ${isGrouped ? '<span style="color:#4acfff;font-size:11px;"> (grouped)</span>' : ""}
      </div>
      <div style="margin-top:6px;">
        <div style="color:#aaa;font-size:11px;">Extent W × D × H</div>
        <div style="font-family:ui-monospace,Menlo,monospace;">
          ${fmtIn(dx)} × ${fmtIn(dz)} × ${fmtIn(dy)}
        </div>
      </div>
      <div style="color:#888;font-size:11px;margin-top:8px;">
        Drag to move · R group-rotate · Q/E raise/lower · arrows nudge · Del<br>
        ${isGrouped ? "⌘⇧G ungroup" : "⌘G group"}
      </div>
    `;
    return;
  }

  const id = primaryId();
  const o = getObject(id);
  if (!o) { selectedIds.clear(); refreshSidebar(); return; }

  const axisField = o.type === "beam"
    ? `<label>Axis</label>
       <select data-k="axis">
         <option value="x"${o.axis === "x" ? " selected" : ""}>X</option>
         <option value="y"${o.axis === "y" ? " selected" : ""}>Y</option>
         <option value="z"${o.axis === "z" ? " selected" : ""}>Z</option>
       </select>`
    : o.type === "fixture"
    ? `<label>Long side along</label>
       <select data-k="axis">
         <option value="x"${o.axis === "x" ? " selected" : ""}>X</option>
         <option value="z"${o.axis === "z" ? " selected" : ""}>Z</option>
       </select>`
    : `<label>Normal</label>
       <select data-k="normal">
         <option value="x"${o.normal === "x" ? " selected" : ""}>X</option>
         <option value="y"${o.normal === "y" ? " selected" : ""}>Y</option>
         <option value="z"${o.normal === "z" ? " selected" : ""}>Z</option>
       </select>`;

  const dimFields = o.type === "beam"
    ? `<label>Length (in)</label><input type="number" step="1.5" min="3" max="120" data-k="length" value="${o.length}">`
    : o.type === "fixture"
    ? (() => {
        const f = FIXTURES[o.kind];
        const d = f ? f.dims : null;
        return d
          ? `<div style="color:#888;font-size:11px;">${fixtureLabel(o.kind)} — ${d[0]}" × ${d[2]}" × ${d[1]}" (fixed)</div>`
          : `<div style="color:#888;font-size:11px;">${o.kind}</div>`;
      })()
    : `<label>W × H (in)</label>
       <div class="row">
         <input type="number" step="1.5" min="1.5" data-k="w" value="${o.w}">
         <input type="number" step="1.5" min="1.5" data-k="h" value="${o.h}">
       </div>`;

  const typeLabel = o.type === "fixture" ? fixtureLabel(o.kind) : o.type;
  elSelProps.innerHTML = `
    <div><strong>${typeLabel}</strong> <span style="color:#666;font-size:11px;">${o.id}</span></div>
    ${dimFields}
    ${axisField}
    <label>Position X / Y / Z (in)</label>
    <div class="row">
      <input type="number" step="1.5" data-k="px" value="${o.pos[0]}">
      <input type="number" step="1.5" data-k="py" value="${o.pos[1]}">
      <input type="number" step="1.5" data-k="pz" value="${o.pos[2]}">
    </div>
  `;
  elSelProps.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("change", () => {
      const patch = {};
      const k = el.dataset.k;
      const v = el.type === "number" ? parseFloat(el.value) : el.value;
      if (k === "px" || k === "py" || k === "pz") {
        const o2 = getObject(id);
        const np = o2.pos.slice();
        np[k === "px" ? 0 : k === "py" ? 1 : 2] = v;
        patch.pos = np;
      } else {
        patch[k] = v;
      }
      updateObject(id, patch);
    });
  });
}

function refreshSummary() {
  const doc = getDoc();
  const { cutRows, panelRows, nConn } = computeBom(doc);
  const cut = cutRows.length
    ? cutRows.map((r) => `<tr><td>${fmtIn(r.length)}</td><td>${r.qty}</td></tr>`).join("")
    : `<tr><td colspan="2"><em>none</em></td></tr>`;
  const pan = panelRows.length
    ? panelRows.map((r) => `<tr><td>${fmtIn(r.w)}×${fmtIn(r.h)}</td><td>${r.qty}</td></tr>`).join("")
    : `<tr><td colspan="2"><em>none</em></td></tr>`;
  elSummary.innerHTML = `
    <table><thead><tr><th>Beam</th><th>Qty</th></tr></thead><tbody>${cut}</tbody></table>
    <table style="margin-top:8px;"><thead><tr><th>Panel</th><th>Qty</th></tr></thead><tbody>${pan}</tbody></table>
    <div style="margin-top:8px;color:#888;">${nConn} bolted connection${nConn === 1 ? "" : "s"}</div>
  `;
}

// ------- Toolbar wiring -------
const LAST_BEAM_KEY = "gridbeam.lastBeamLength";
const LAST_PANEL_KEY = "gridbeam.lastPanelDims";
let lastBeamLength = localStorage.getItem(LAST_BEAM_KEY) || "12";
let lastPanelDims = localStorage.getItem(LAST_PANEL_KEY) || "12x18";

document.getElementById("btn-add-beam").onclick = () => {
  const raw = prompt("Beam length in inches (multiple of 1.5, 3–120):", lastBeamLength);
  if (raw == null) return;
  const n = parseFloat(raw);
  if (!isFinite(n)) return;
  lastBeamLength = raw.trim();
  localStorage.setItem(LAST_BEAM_KEY, lastBeamLength);
  selectOnly(addBeam({ length: n, pos: [0, 0, 0] }));
};
// Auto-generate one "+ <Fixture>" button per registered fixture so adding a
// new entry to FIXTURES automatically exposes it in the toolbar.
const fixturesSlot = document.getElementById("btn-add-mattress");
for (const kind of Object.keys(FIXTURES)) {
  const btn = document.createElement("button");
  btn.textContent = "+ " + fixtureLabel(kind);
  btn.onclick = () => selectOnly(addFixture({ kind, axis: "x", pos: [0, 0, 0] }));
  fixturesSlot.parentNode.insertBefore(btn, fixturesSlot);
}
fixturesSlot.remove(); // drop the placeholder from index.html

document.getElementById("btn-add-panel").onclick = () => {
  const raw = prompt("Panel W × H in inches (e.g. 12x18):", lastPanelDims);
  if (raw == null) return;
  const m = /^\s*([\d.]+)\s*[xX×]\s*([\d.]+)\s*$/.exec(raw);
  if (!m) return;
  lastPanelDims = raw.trim();
  localStorage.setItem(LAST_PANEL_KEY, lastPanelDims);
  selectOnly(addPanel({ w: parseFloat(m[1]), h: parseFloat(m[2]), pos: [0, 0, 0] }));
};
document.getElementById("btn-undo").onclick = undo;
document.getElementById("btn-redo").onclick = redo;
document.getElementById("btn-save").onclick = downloadJson;

const fileInput = document.getElementById("file-load");
document.getElementById("btn-load").onclick = () => fileInput.click();
fileInput.onchange = async () => {
  if (fileInput.files[0]) {
    await loadFromFile(fileInput.files[0]);
    fileInput.value = "";
  }
};

document.getElementById("btn-export").onclick = () => {
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL("image/png");
  openExportView(getDoc(), data, { minimalMode });
};
document.getElementById("btn-clear").onclick = () => {
  if (confirm("Clear all objects?")) { clearAll(); selectedIds.clear(); }
};

const btnMinimal = document.getElementById("btn-minimal");
function syncMinimalButton() {
  btnMinimal.textContent = "Minimal Holes: " + (minimalMode ? "on" : "off");
  btnMinimal.style.background = minimalMode ? "#55371f" : "";
}
syncMinimalButton();
btnMinimal.onclick = () => {
  minimalMode = !minimalMode;
  localStorage.setItem("gridbeam.minimalMode", minimalMode ? "1" : "0");
  syncMinimalButton();
  rebuildMeshes(getDoc());
};

const btnClipped = document.getElementById("btn-clipped");
function syncClippedButton() {
  btnClipped.textContent = "Clipped Corners: " + (clippedCorners ? "on" : "off");
  btnClipped.style.background = clippedCorners ? "#55371f" : "";
}
syncClippedButton();
btnClipped.onclick = () => {
  clippedCorners = !clippedCorners;
  localStorage.setItem("gridbeam.clippedCorners", clippedCorners ? "1" : "0");
  syncClippedButton();
  rebuildMeshes(getDoc());
};

// ------- View persistence -------
// Serializable snapshot of the OrbitControls camera state.
function getView() {
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    target: [controls.target.x, controls.target.y, controls.target.z],
    zoom: camera.zoom,
  };
}
function applyView(v) {
  if (!v) return;
  if (Array.isArray(v.pos)) camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
  if (Array.isArray(v.target)) controls.target.set(v.target[0], v.target[1], v.target[2]);
  if (typeof v.zoom === "number") camera.zoom = v.zoom;
  camera.updateProjectionMatrix();
  controls.update();
}

// ------- Boot -------
const scheduleSave = initAutosave({ getView, applyView });
// Persist camera moves too (debounced inside scheduleSave).
controls.addEventListener("change", scheduleSave);
rebuildMeshes(getDoc());

function tick() {
  requestAnimationFrame(tick);
  controls.update();
  // Keep outlines synced with object motion.
  for (const [id, helper] of outlineHelpers) {
    const g = meshById.get(id);
    if (g) helper.box.setFromObject(g);
  }
  renderer.render(scene, camera);
}
tick();
