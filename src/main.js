import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { SNAP, BEAM_SIZE, fmtIn, nextBeamOrientation, beamTiltTransform, beamTiltEuler } from "./grid.js";
import {
  getDoc, getObject, subscribe,
  addBeam, addPanel, addFixture, addSeforimRow, updateObject, removeObject, removeObjects, clearAll,
  setPosLive, beginLive, endLive, undo, redo, rotateSelectionY90, bbox,
  groupObjects, ungroupObjects, groupMembers,
  setGroupRotation, setGroupRotationLive, getGroupRotation, getGroupPivot,
  computeGroupPivot, worldPosOf, createPeak, setRafterFootLive,
} from "./state.js";
import { buildBeamMesh } from "./beam.js";
import { buildPanelMesh, setPanelOpacityMode } from "./panel.js";
import { FIXTURES, buildFixtureMesh, fixtureLabel } from "./fixtures.js";
import { buildBookMesh } from "./books.js";
import { computeConnections } from "./connections.js";
import { computeBom } from "./bom.js";
import { initAutosave } from "./io.js";
import { initProjectsDropdown } from "./ui/projects.js";
import { showConfirm, showToast, isDialogOpen } from "./ui/dialog.js";
import { openImportGallery, isImportGalleryOpen } from "./ui/importGallery.js";
import { openExportView } from "./exportView.js";

// Panel material labels — shared by the sidebar's material switcher, the
// BOM/summary suffixes, and the Add-type dropdown values ("panel:<key>").
const MATERIAL_LABELS = {
  plywood: 'Hardboard (3/16")',
  pegboard: 'Peg board (1/8")',
  "pegboard-aluminum": 'Aluminum peg board (1/8")',
  "pegboard-black-aluminum": 'Black aluminum peg board (1/8")',
  wood: 'Wood (1/2")',
};

// ------- Three.js setup -------
const wrap = document.getElementById("canvas-wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
camera.position.set(40, 50, 60);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 6, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(40, 80, 30);
scene.add(dir);

const gridHelper = new THREE.GridHelper(240, 160, 0x444444, 0x2a2a2a);
// Centered at origin so the dome and work area align.
scene.add(gridHelper);

scene.add(new THREE.AxesHelper(6));

// ------- Environments -------
// Registry of surroundings. Each entry's build() returns a THREE.Object3D.
const ENVIRONMENTS = {
  "dome-30": {
    label: "30' Dome + 1' Stem Wall",
    loftHeight: 90, // 7'6"
    build() {
      const group = new THREE.Group();
      const radius = 180; // 30' diameter = 360" → 180" radius
      const wallHeight = 12; // 1' stem wall

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x88aacc,
        wireframe: true,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });

      // Hemisphere dome sitting on top of the stem wall.
      const domeGeom = new THREE.SphereGeometry(
        radius, 48, 24,
        0, Math.PI * 2,
        0, Math.PI / 2
      );
      const dome = new THREE.Mesh(domeGeom, wireMat);
      dome.position.y = wallHeight;
      group.add(dome);

      // Cylindrical stem wall from ground to wallHeight.
      const wallGeom = new THREE.CylinderGeometry(
        radius, radius,  // top and bottom radius match dome base
        wallHeight,       // height
        48, 1,            // radial segments, height segments
        true              // open-ended (no caps)
      );
      const wall = new THREE.Mesh(wallGeom, wireMat);
      wall.position.y = wallHeight / 2; // cylinder is centered on its height
      group.add(wall);

      // Loft floor at 7'6" (90") — a 1.5" thick translucent disc.
      const loftHeight = 90;
      const loftThick = 1.5;
      const hAboveWall = loftHeight - wallHeight;
      const loftRadius = Math.sqrt(radius * radius - hAboveWall * hAboveWall);
      const loftGeom = new THREE.CylinderGeometry(loftRadius, loftRadius, loftThick, 48, 1);
      const loftMat = new THREE.MeshBasicMaterial({
        color: 0x88aacc,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const loft = new THREE.Mesh(loftGeom, loftMat);
      loft.position.y = loftHeight + loftThick / 2; // bottom face at loftHeight
      group.add(loft);

      return group;
    },
  },
  "dome-16": {
    label: "16' Dome",
    build() {
      const group = new THREE.Group();
      const radius = 96; // 16' diameter = 192" → 96" radius = 8' height

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x88aacc,
        wireframe: true,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });

      // Plain hemisphere on the ground — radius = height (8'), no stem wall.
      const domeGeom = new THREE.SphereGeometry(
        radius, 48, 24,
        0, Math.PI * 2,
        0, Math.PI / 2
      );
      const dome = new THREE.Mesh(domeGeom, wireMat);
      group.add(dome);

      return group;
    },
  },
};

let envMesh = null;
let envKey = localStorage.getItem("gridbeam.env") || "none";

function setEnvironment(key) {
  if (envMesh) { scene.remove(envMesh); envMesh = null; }
  envKey = key;
  localStorage.setItem("gridbeam.env", key);
  const entry = ENVIRONMENTS[key];
  if (entry) {
    envMesh = entry.build();
    scene.add(envMesh);
  }
}

// Initialize on boot (after scene exists).
setEnvironment(envKey);

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

// Loft-resting indicators — small colored markers under objects on the loft.
const loftIndicators = new THREE.Group();
scene.add(loftIndicators);
const loftMarkerMat = new THREE.MeshBasicMaterial({
  color: 0xff8833, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
});

// ------- Move HUD (shows top/bottom height of selection while moving) -------
const moveHud = document.getElementById("move-hud");
let moveHudTimeout = null;

function showMoveHud() {
  if (!hasSel()) { hideHud(); return; }
  let minY = Infinity, maxY = -Infinity;
  for (const id of selectedIds) {
    const o = getObject(id);
    if (!o) continue;
    const [mn, mx] = bbox(o);
    if (mn[1] < minY) minY = mn[1];
    if (mx[1] > maxY) maxY = mx[1];
  }
  if (!isFinite(minY)) { hideHud(); return; }
  moveHud.innerHTML = `Bottom: ${fmtIn(minY)}<br>Top: ${fmtIn(maxY)}`;
  moveHud.style.display = "block";
  clearTimeout(moveHudTimeout);
  moveHudTimeout = setTimeout(hideHud, 1500);
}

function hideHud() {
  moveHud.style.display = "none";
  clearTimeout(moveHudTimeout);
  moveHudTimeout = null;
}

// ------- Per-beam top-edge height labels -------
// One floating label per selected beam, anchored above its top edge, showing
// the world-space height (Y) of that edge — not the beam's center or its
// pos (which is the beam's min-corner, not necessarily the top).
const beamHeightLabelsEl = document.getElementById("beam-height-labels");
const beamHeightLabels = new Map(); // id → HTMLElement

function updateBeamHeightLabels() {
  const seen = new Set();
  for (const id of selectedIds) {
    const o = getObject(id);
    if (!o || o.type !== "beam") continue;
    const [mn, mx] = bbox(o);
    const cx = (mn[0] + mx[0]) / 2;
    const cz = (mn[2] + mx[2]) / 2;
    const s = worldToScreen(cx, mx[1], cz);
    let el = beamHeightLabels.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "beam-height-label";
      beamHeightLabelsEl.appendChild(el);
      beamHeightLabels.set(id, el);
    }
    el.style.display = s.behind ? "none" : "block";
    el.style.left = s.x + "px";
    el.style.top = (s.y - 4) + "px";
    el.textContent = fmtIn(mx[1]);
    seen.add(id);
  }
  for (const [id, el] of beamHeightLabels) {
    if (!seen.has(id)) { el.remove(); beamHeightLabels.delete(id); }
  }
}

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

// Cached connections result — computed once per full rebuild and shared with
// refreshSummary so computeConnections doesn't run twice.
let cachedConnections = null;

function disposeGroup(g) {
  g.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    // Most materials are shared module-level singletons — don't dispose
    // them. Books' per-instance materials (varying color per book) are
    // tagged disposable since nothing else can reuse them.
    if (child.material && child.material.userData && child.material.userData.disposable) {
      child.material.dispose();
    }
  });
}

// Track wrapper groups for rotated groups so we can clean them up.
const rotGroupWrappers = new Map(); // groupId → THREE.Group

function rebuildMeshes(doc) {
  cachedConnections = computeConnections(doc);
  const { bolts, boltedHoles } = cachedConnections;

  for (const [, g] of meshById) { disposeGroup(g); root.remove(g); }
  meshById.clear();
  for (const [, w] of rotGroupWrappers) { root.remove(w); }
  rotGroupWrappers.clear();

  // Collect rotated groups so we can batch their members into wrapper groups.
  const rotGroups = new Map(); // groupId → { rotY, pivot, members: [o...] }
  for (const o of doc.objects) {
    if (o.group && o.groupRotY && o.groupPivot) {
      if (!rotGroups.has(o.group)) {
        rotGroups.set(o.group, { rotY: o.groupRotY, pivot: o.groupPivot, members: [] });
      }
      rotGroups.get(o.group).members.push(o);
    }
  }

  // Build wrapper THREE.Groups for each rotated group.
  const rotatedIds = new Set();
  for (const [gid, rg] of rotGroups) {
    const wrapper = new THREE.Group();
    wrapper.position.set(rg.pivot[0], 0, rg.pivot[1]);
    wrapper.rotation.y = -rg.rotY * Math.PI / 180;
    for (const o of rg.members) {
      const g = o.type === "beam"
        ? buildBeamMesh(o, boltedHoles.get(o.id), minimalMode)
        : o.type === "fixture"
        ? buildFixtureMesh(o)
        : o.type === "book"
        ? buildBookMesh(o)
        : buildPanelMesh(o, clippedCorners);
      // Position relative to pivot (local group space).
      const bp = meshBasePos(o);
      g.position.set(bp[0] - rg.pivot[0], bp[1], bp[2] - rg.pivot[1]);
      wrapper.add(g);
      meshById.set(o.id, g);
      rotatedIds.add(o.id);
    }
    root.add(wrapper);
    rotGroupWrappers.set(gid, wrapper);
  }

  // Build non-rotated objects directly.
  for (const o of doc.objects) {
    if (rotatedIds.has(o.id)) continue;
    const g = o.type === "beam"
      ? buildBeamMesh(o, boltedHoles.get(o.id), minimalMode)
      : o.type === "fixture"
      ? buildFixtureMesh(o)
      : o.type === "book"
      ? buildBookMesh(o)
      : buildPanelMesh(o, clippedCorners);
    root.add(g);
    meshById.set(o.id, g);
  }

  boltsGroup.traverse((child) => { if (child.geometry) child.geometry.dispose(); });
  boltsGroup.clear();
  for (const c of bolts) {
    const s = new THREE.Mesh(boltGeom, beamBoltMat);
    s.position.set(c.pos[0], c.pos[1], c.pos[2]);
    boltsGroup.add(s);
  }

  // Loft-resting indicators.
  rebuildLoftIndicators(doc);

  // Prune selection of any ids that no longer exist.
  for (const id of [...selectedIds]) if (!meshById.has(id)) selectedIds.delete(id);

  refreshOutlines();
  refreshSidebar();
  refreshSummary();
}

// Absolute position for an object's mesh group (before any wrapper transform).
// Tilted beams are shifted by the tilt offset so they swing about the end bolt.
function meshBasePos(o) {
  if (o.type === "beam" && o.tilt) {
    const { offset } = beamTiltTransform(o.axis, o.tilt, o.length);
    return [o.pos[0] + offset[0], o.pos[1] + offset[1], o.pos[2] + offset[2]];
  }
  return [o.pos[0], o.pos[1], o.pos[2]];
}

// Fast path: only positions/rotations changed — update transforms in-place.
function updateMeshPositions(doc) {
  // Update wrapper group rotations for rotated groups.
  for (const [gid, wrapper] of rotGroupWrappers) {
    // Find any member to read current rotation.
    const member = doc.objects.find((o) => o.group === gid);
    if (member && member.groupRotY !== undefined && member.groupPivot) {
      wrapper.position.set(member.groupPivot[0], 0, member.groupPivot[1]);
      wrapper.rotation.y = -member.groupRotY * Math.PI / 180;
    }
  }

  for (const o of doc.objects) {
    const g = meshById.get(o.id);
    if (!g) continue;
    const bp = meshBasePos(o);
    if (o.groupRotY && o.groupPivot && rotGroupWrappers.has(o.group)) {
      // Mesh is a child of a wrapper — position relative to pivot.
      g.position.set(bp[0] - o.groupPivot[0], bp[1], bp[2] - o.groupPivot[1]);
    } else {
      g.position.set(bp[0], bp[1], bp[2]);
    }
    // Keep tilt in sync on the fast path too, so peak re-solves render live.
    if (o.type === "beam") {
      const t = beamTiltEuler(o.axis, o.tilt);
      g.rotation.set(t.x, t.y, t.z);
    }
  }
  rebuildLoftIndicators(doc);
}

// Show a flat marker under each object resting on the active environment's loft plane.
function rebuildLoftIndicators(doc) {
  loftIndicators.traverse((c) => { if (c.geometry && c.geometry !== boltGeom) c.geometry.dispose(); });
  loftIndicators.clear();
  const env = ENVIRONMENTS[envKey];
  if (!env || !env.loftHeight) return;
  const lh = env.loftHeight;
  const EPS = 0.01;
  for (const o of doc.objects) {
    if (Math.abs(o.pos[1] - lh) > EPS) continue;
    // Object's bottom face is on the loft. Place a thin rectangle matching
    // its footprint, slightly below the object.
    const [mn, mx] = bbox(o);
    const dx = mx[0] - mn[0], dz = mx[2] - mn[2];
    if (dx < 0.1 || dz < 0.1) continue;
    const geom = new THREE.PlaneGeometry(dx, dz);
    const marker = new THREE.Mesh(geom, loftMarkerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(mn[0] + dx / 2, lh - 0.05, mn[2] + dz / 2);
    loftIndicators.add(marker);
  }
}

subscribe((doc, hint) => {
  try {
    if (hint === "pos") updateMeshPositions(doc);
    else rebuildMeshes(doc);
  } catch (e) { console.error("rebuildMeshes failed:", e); }

  // Drop selections pointing at objects the document no longer has (project
  // switch, import, undo past a create).
  if (hint !== "pos" && selectedIds.size) {
    const live = new Set(doc.objects.map((o) => o.id));
    let dropped = false;
    for (const id of [...selectedIds]) if (!live.has(id)) { selectedIds.delete(id); dropped = true; }
    if (dropped) { refreshOutlines(); refreshSidebar(); }
  }
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

// Interaction mode: "orbit" (default) or "select" (marquee on empty-space drag).
let interactionMode = localStorage.getItem("gridbeam.mode") || "orbit";

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

  // Empty space: in select mode start a marquee; in orbit mode let
  // OrbitControls handle the gesture.
  if (!id) {
    if (interactionMode === "select") {
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
    }
    return;
  }

  // Shift-click: toggle this id (and its group) in the selection.
  // Plain click on an already-selected object: keep the selection (so drag moves all).
  // Plain click on an unselected object: replace selection with this id + group members.
  const members = groupMembers(id);
  const clickedObj = getObject(id);

  // Shift+click on an already-selected group → enter rotation drag mode.
  if (e.shiftKey && selectedIds.has(id) && clickedObj && clickedObj.group && members.length >= 2) {
    const ids = members;
    const pivot = getGroupPivot(id) || computeGroupPivot(ids);
    const startRot = getGroupRotation(id);
    const dragY = clickedObj.pos[1];
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(planeAtY(dragY), hit)) return;
    const startAngle = Math.atan2(hit.x - pivot[0], hit.z - pivot[1]);
    drag = { rotating: true, ids, pivot, startRot, startAngle, dragY };
    controls.enabled = false;
    beginLive();
    document.body.classList.add("dragging");
    return;
  }

  if (e.shiftKey) {
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

  if (!selectedIds.has(id)) return;

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
    if (!so) continue;
    // Peak rafters move by their foot (pos is derived); everything else by pos.
    if (so.peak && so.foot) items.push({ id: sid, startFoot: so.foot.slice() });
    else items.push({ id: sid, startPos: so.pos.slice() });
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

  // Rotation drag mode.
  if (drag.rotating) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(planeAtY(drag.dragY), hit)) return;
    const curAngle = Math.atan2(hit.x - drag.pivot[0], hit.z - drag.pivot[1]);
    const deltaRad = curAngle - drag.startAngle;
    const deltaDeg = deltaRad * 180 / Math.PI;
    setGroupRotationLive(drag.ids, drag.startRot + deltaDeg, drag.pivot);
    return;
  }
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
    if (it.startFoot) {
      setRafterFootLive(it.id, [it.startFoot[0] + dx, it.startFoot[1], it.startFoot[2] + dz]);
    } else {
      setPosLive(it.id, [it.startPos[0] + dx, it.startPos[1], it.startPos[2] + dz]);
    }
  }
  showMoveHud();
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
  showMoveHud(); // show final position briefly, then auto-hide
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

// Nudge the selection by a grid delta. Peak rafters move by their foot (pos is
// derived); everything else moves by pos. One undo step.
function nudgeSelected(dx, dy, dz) {
  mutateSelection((o) => {
    if (o.peak && o.foot) {
      updateObject(o.id, { foot: [o.foot[0] + dx, o.foot[1] + dy, o.foot[2] + dz] }, { commit: false });
    } else {
      updateObject(o.id, { pos: [o.pos[0] + dx, o.pos[1] + dy, o.pos[2] + dz] }, { commit: false });
    }
  });
}

// Grow each selected object's size by one grid step along `axis` ("x"/"z"),
// in the direction of `sign` (+1/-1) — the edge on the opposite side stays
// fixed, so the object visibly extends toward the pressed arrow.
// Only resizes the dimension that actually runs along that world axis:
//   beam    — its own length, only if o.axis matches.
//   panel   — w or h, whichever maps to that axis given o.normal.
// Objects with no matching resizable dimension (fixtures, cross-axis beams,
// a panel's vertical w/h) are left untouched.
function growSelectedDirectional(axis, sign) {
  const posIdx = axis === "x" ? 0 : 2;
  mutateSelection((o) => {
    if (o.type === "beam") {
      if (o.axis !== axis) return;
      if (o.peak) {
        // A peak rafter's pos is derived from its foot/span — just grow it,
        // the joint re-solves without needing an edge-anchored shift.
        updateObject(o.id, { length: o.length + SNAP }, { commit: false });
        return;
      }
      const patch = { length: o.length + SNAP };
      if (sign < 0) {
        const np = o.pos.slice(); np[posIdx] -= SNAP; patch.pos = np;
      }
      updateObject(o.id, patch, { commit: false });
    } else if (o.type === "panel") {
      let prop = null;
      if (o.normal === "y") prop = axis === "x" ? "w" : "h";
      else if (o.normal === "z" && axis === "x") prop = "w";
      else if (o.normal === "x" && axis === "z") prop = "h";
      if (!prop) return;
      const patch = { [prop]: o[prop] + SNAP };
      if (sign < 0) {
        const np = o.pos.slice(); np[posIdx] -= SNAP; patch.pos = np;
      }
      updateObject(o.id, patch, { commit: false });
    }
  });
}

// Snap each selected object onto the closest surface under its footprint —
// the top of whichever other (unselected) object's XZ footprint overlaps it
// and is nearest by distance (whether that's above or below its current
// position), or the ground if nothing's closer. Surface heights (e.g. a
// panel's top) aren't generally on the 1.5" beam grid, so the result is
// applied as an exact height rather than grid-snapped, or it'd still miss.
const SURFACE_EPS = 1e-3;
function snapSelectedToSurface() {
  const doc = getDoc();
  mutateSelection((o) => {
    const [mn, mx] = bbox(o);
    let bestTop = 0; // ground
    let bestDist = Math.abs(mn[1]);
    for (const other of doc.objects) {
      if (other.id === o.id || selectedIds.has(other.id)) continue;
      const [omn, omx] = bbox(other);
      const overlapsXZ = omx[0] > mn[0] + SURFACE_EPS && omn[0] < mx[0] - SURFACE_EPS
                       && omx[2] > mn[2] + SURFACE_EPS && omn[2] < mx[2] - SURFACE_EPS;
      if (!overlapsXZ) continue;
      const dist = Math.abs(omx[1] - mn[1]);
      if (dist < bestDist) { bestDist = dist; bestTop = omx[1]; }
    }
    const dy = bestTop - mn[1];
    if (Math.abs(dy) < 1e-6) return;
    if (o.peak && o.foot) {
      updateObject(o.id, { foot: [o.foot[0], o.foot[1] + dy, o.foot[2]] }, { commit: false, keepExactY: true });
    } else {
      updateObject(o.id, { pos: [o.pos[0], o.pos[1] + dy, o.pos[2]] }, { commit: false, keepExactY: true });
    }
  });
}

// Check whether a Y-delta would push any selected object below the ground
// plane. Returns true if the move is safe.
function canMoveSelY(dy) {
  for (const id of selectedIds) {
    const o = getObject(id);
    if (o && o.pos[1] + dy < -0.001) return false;
  }
  return true;
}

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (isDialogOpen() || isImportGalleryOpen()) return;

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
    // Map old group ids → fresh group ids so pasted groups stay grouped
    // but don't merge with the originals.
    const groupMap = new Map();
    const newIds = [];
    for (const c of clipboard) {
      const pos = [c.pos[0] + SNAP, c.pos[1], c.pos[2]];
      let newId;
      if (c.type === "beam") newId = addBeam({ length: c.length, axis: c.axis, pos, tilt: c.tilt });
      else if (c.type === "fixture") newId = addFixture({ kind: c.kind, axis: c.axis, pos });
      else if (c.type === "panel") newId = addPanel({ w: c.w, h: c.h, normal: c.normal, pos, material: c.material });
      if (newId && c.group) {
        if (!groupMap.has(c.group)) groupMap.set(c.group, `g${Date.now()}_${groupMap.size}`);
        const o = getObject(newId);
        if (o) o.group = groupMap.get(c.group);
      }
      if (newId) newIds.push(newId);
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
    // Deleting one peak rafter removes its partner too — a lone rafter is junk.
    const ids = new Set(selectedIds);
    for (const sid of selectedIds) {
      const o = getObject(sid);
      if (o && o.peak) for (const p of getDoc().objects) if (p.peak === o.peak) ids.add(p.id);
    }
    removeObjects([...ids]);
    selectedIds.clear();
    return;
  }
  // Tab — cycle through beams of the same length as the current selection.
  if (e.key === "Tab") {
    e.preventDefault();
    const pid = primaryId();
    if (!pid) return;
    const cur = getObject(pid);
    if (!cur || cur.type !== "beam") return;
    const doc = getDoc();
    const sameLen = doc.objects.filter((o) => o.type === "beam" && o.length === cur.length);
    if (sameLen.length < 2) return;
    const idx = sameLen.findIndex((o) => o.id === pid);
    const next = sameLen[(idx + (e.shiftKey ? sameLen.length - 1 : 1)) % sameLen.length];
    const members = groupMembers(next.id);
    selectedIds.clear();
    for (const m of members) selectedIds.add(m);
    refreshOutlines();
    refreshSidebar();
    return;
  }
  if (e.key === "Escape") {
    selectedIds.clear();
    refreshOutlines();
    refreshSidebar();
    return;
  }
  // T / Shift+T — rotate a group by ±5° around Y.
  if (e.key === "t" || e.key === "T") {
    // Only works when the entire selection is a single group.
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    const first = getObject(ids[0]);
    if (!first || !first.group) return;
    const allSameGroup = ids.every((id) => { const o = getObject(id); return o && o.group === first.group; });
    if (!allSameGroup) return;
    const delta = e.shiftKey ? -5 : 5;
    const currentRot = getGroupRotation(ids[0]);
    const pivot = getGroupPivot(ids[0]) || computeGroupPivot(ids);
    beginLive();
    setGroupRotation(ids, currentRot + delta, pivot);
    endLive();
    return;
  }
  if (e.key === "r" || e.key === "R") {
    if (selectedIds.size > 1) {
      // Group rotate: 90° about the selection's centroid on the Y axis,
      // keeping the relative arrangement of the selected objects intact.
      rotateSelectionY90([...selectedIds]);
    } else {
      // Single object: cycle its own orientation. Beams step through the
      // preset list (three cardinal axes + ±45° tilts), so two beams can be
      // set to opposing 45° tilts to form a right-angle peak.
      forEachSelected((o) => {
        if (o.type === "beam") {
          const next = nextBeamOrientation(o.axis, o.tilt);
          updateObject(o.id, { axis: next.axis, tilt: next.tilt });
        }
        else if (o.type === "fixture" || o.type === "book") {
          // Fixtures/books only rotate around Y (thickness is vertical), so cycle x↔z.
          updateObject(o.id, { axis: o.axis === "x" ? "z" : "x" });
        } else updateObject(o.id, { normal: cycleAxis(o.normal) });
      });
    }
    return;
  }
  if (e.key === "a" || e.key === "A") {
    nudgeSelected(0, SNAP, 0);
    showMoveHud();
    return;
  }
  if (e.key === "z" || e.key === "Z") {
    if (!canMoveSelY(-SNAP)) return;
    nudgeSelected(0, -SNAP, 0);
    showMoveHud();
    return;
  }
  // S — drop the selection straight down onto whatever's underneath it
  // (the top of the nearest overlapping beam/panel/fixture, or the ground),
  // rather than requiring exact A/Z nudging to match an arbitrary surface height.
  if (e.key === "s" || e.key === "S") {
    snapSelectedToSurface();
    showMoveHud();
    return;
  }
  // Arrow keys — nudge selected objects by one 1.5" step on the ground plane.
  // Shift+arrow instead grows the selection's size in the pressed direction
  // (the opposite edge stays put), rather than moving it.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const axis = (e.key === "ArrowLeft" || e.key === "ArrowRight") ? "x" : "z";
    const sign = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
    if (e.shiftKey) {
      growSelectedDirectional(axis, sign);
    } else {
      const dx = axis === "x" ? sign * SNAP : 0;
      const dz = axis === "z" ? sign * SNAP : 0;
      nudgeSelected(dx, 0, dz);
    }
    showMoveHud();
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

    const rotAngle = isGrouped ? getGroupRotation([...selectedIds][0]) : 0;
    const rotInfo = rotAngle
      ? `<div style="margin-top:6px;">
           <div style="color:#aaa;font-size:11px;">Rotation</div>
           <div style="font-family:ui-monospace,Menlo,monospace;">${rotAngle.toFixed(1)}°</div>
         </div>`
      : "";

    elSelProps.innerHTML = `
      <div><strong>${selectedIds.size} objects selected</strong>
        ${isGrouped ? '<span style="color:#4acfff;font-size:11px;"> (grouped)</span>' : ""}
      </div>
      ${rotInfo}
      <div style="margin-top:6px;">
        <div style="color:#aaa;font-size:11px;">Extent W × D × H</div>
        <div style="font-family:ui-monospace,Menlo,monospace;">
          ${fmtIn(dx)} × ${fmtIn(dz)} × ${fmtIn(dy)}
        </div>
      </div>
      <div style="color:#888;font-size:11px;margin-top:8px;">
        Drag to move · R 90° · T/⇧T ±5° · Shift+drag rotate<br>
        A/Z raise/lower · S snap to surface · arrows nudge · ⇧arrow resize · Del<br>
        ${isGrouped ? "⌘⇧G ungroup" : "⌘G group"}
      </div>
    `;
    return;
  }

  const id = primaryId();
  const o = getObject(id);
  if (!o) { selectedIds.clear(); refreshSidebar(); return; }

  const axisField = o.peak
    ? "" // a peak rafter's axis is fixed by the peak
    : o.type === "beam"
    ? `<label>Axis</label>
       <select data-k="axis">
         <option value="x"${o.axis === "x" ? " selected" : ""}>X</option>
         <option value="y"${o.axis === "y" ? " selected" : ""}>Y</option>
         <option value="z"${o.axis === "z" ? " selected" : ""}>Z</option>
       </select>`
    : o.type === "fixture" || o.type === "book"
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

  // Tilt: a peak rafter's tilt is derived (shown read-only); a free beam's tilt
  // is an editable ±45° preset.
  const tiltField = o.peak
    ? `<div style="color:#888;font-size:11px;margin-top:4px;">Peak rafter — tilt ${Number(o.tilt || 0).toFixed(1)}° (auto)</div>`
    : o.type === "beam"
    ? `<label>Tilt</label>
       <select data-k="tilt">
         <option value="0"${!o.tilt ? " selected" : ""}>None</option>
         <option value="45"${o.tilt === 45 ? " selected" : ""}>+45° (peak)</option>
         <option value="-45"${o.tilt === -45 ? " selected" : ""}>−45° (peak)</option>
       </select>`
    : "";

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
    : o.type === "book"
    ? `<div style="color:#888;font-size:11px;">
         Book — ${fmtIn(o.width)} × ${fmtIn(o.height)} × ${fmtIn(o.depth)} (fixed)
         <span style="display:inline-block;width:10px;height:10px;margin-left:4px;vertical-align:-1px;
           background:#${(o.color ?? 0).toString(16).padStart(6, "0")};border:1px solid #555;"></span>
       </div>`
    : `<label>W × H (in)</label>
       <div class="row">
         <input type="number" step="1.5" min="1.5" data-k="w" value="${o.w}">
         <input type="number" step="1.5" min="1.5" data-k="h" value="${o.h}">
       </div>
       <label>Material</label>
       <select data-k="material">
         ${Object.entries(MATERIAL_LABELS).map(([key, label]) => {
           const selected = (o.material || "plywood") === key;
           return `<option value="${key}"${selected ? " selected" : ""}>${label}</option>`;
         }).join("")}
       </select>`;

  const typeLabel = o.type === "fixture" ? fixtureLabel(o.kind) : o.type;
  elSelProps.innerHTML = `
    <div><strong>${typeLabel}</strong> <span style="color:#666;font-size:11px;">${o.id}</span></div>
    ${dimFields}
    ${axisField}
    ${tiltField}
    <label>${o.peak ? "Foot X / Y / Z (in)" : "Position X / Y / Z (in)"}</label>
    <div class="row">
      <input type="number" step="1.5" data-k="p0" value="${(o.peak ? o.foot : o.pos)[0]}">
      <input type="number" step="1.5" data-k="p1" value="${(o.peak ? o.foot : o.pos)[1]}">
      <input type="number" step="1.5" data-k="p2" value="${(o.peak ? o.foot : o.pos)[2]}">
    </div>
  `;
  elSelProps.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("change", () => {
      const patch = {};
      const k = el.dataset.k;
      const v = el.type === "number" ? parseFloat(el.value) : el.value;
      if (k === "p0" || k === "p1" || k === "p2") {
        const o2 = getObject(id);
        const idx = k === "p0" ? 0 : k === "p1" ? 1 : 2;
        if (o2.peak) { const nf = o2.foot.slice(); nf[idx] = v; patch.foot = nf; }
        else { const np = o2.pos.slice(); np[idx] = v; patch.pos = np; }
      } else if (k === "tilt") {
        patch.tilt = parseFloat(v); // select value is a string
      } else {
        patch[k] = v;
      }
      updateObject(id, patch);
    });
  });
}

function refreshSummary() {
  const doc = getDoc();
  const { cutRows, panelRows, nConn } = computeBom(doc, { connections: cachedConnections });
  const cut = cutRows.length
    ? cutRows.map((r) => `<tr><td>${fmtIn(r.length)}</td><td>${r.qty}</td></tr>`).join("")
    : `<tr><td colspan="2"><em>none</em></td></tr>`;
  const pan = panelRows.length
    ? panelRows.map((r) => {
        const material = r.material || "plywood";
        const suffix = material === "plywood" ? "" : ` (${MATERIAL_LABELS[material] || material})`;
        return `<tr><td>${fmtIn(r.w)}×${fmtIn(r.h)}${suffix}</td><td>${r.qty}</td></tr>`;
      }).join("")
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
const LAST_SEFORIM_KEY = "gridbeam.lastSeforimDims";
let lastBeamLength = localStorage.getItem(LAST_BEAM_KEY) || "12";
let lastPanelDims = localStorage.getItem(LAST_PANEL_KEY) || "12x18";
let lastSeforimDims = localStorage.getItem(LAST_SEFORIM_KEY) || "36x11";

// Populate the add-type dropdown with fixture entries from the registry.
const addTypeSelect = document.getElementById("add-type-select");
{
  const opt = document.createElement("option");
  opt.value = "peak";
  opt.textContent = "Peak (2 rafters)";
  addTypeSelect.appendChild(opt);
}
for (const kind of Object.keys(FIXTURES)) {
  const opt = document.createElement("option");
  opt.value = `fixture:${kind}`;
  opt.textContent = fixtureLabel(kind);
  addTypeSelect.appendChild(opt);
}

document.getElementById("btn-add").onclick = () => {
  const val = addTypeSelect.value;
  if (val === "beam") {
    const raw = prompt("Beam length in inches (multiple of 1.5, 3–120):", lastBeamLength);
    if (raw == null) return;
    const n = parseFloat(raw);
    if (!isFinite(n)) return;
    lastBeamLength = raw.trim();
    localStorage.setItem(LAST_BEAM_KEY, lastBeamLength);
    selectOnly(addBeam({ length: n, pos: [0, 0, 0] }));
  } else if (val === "panel" || val.startsWith("panel:")) {
    const material = val.startsWith("panel:") ? val.slice("panel:".length) : "plywood";
    const raw = prompt("Panel W × H in inches (e.g. 12x18):", lastPanelDims);
    if (raw == null) return;
    const m = /^\s*([\d.]+)\s*[xX×]\s*([\d.]+)\s*$/.exec(raw);
    if (!m) return;
    lastPanelDims = raw.trim();
    localStorage.setItem(LAST_PANEL_KEY, lastPanelDims);
    selectOnly(addPanel({ w: parseFloat(m[1]), h: parseFloat(m[2]), pos: [0, 0, 0], material }));
  } else if (val === "seforim") {
    const raw = prompt("Shelf width × max spine height in inches (e.g. 36x11):", lastSeforimDims);
    if (raw == null) return;
    const m = /^\s*([\d.]+)\s*[xX×]\s*([\d.]+)\s*$/.exec(raw);
    if (!m) return;
    lastSeforimDims = raw.trim();
    localStorage.setItem(LAST_SEFORIM_KEY, lastSeforimDims);
    const ids = addSeforimRow({ axis: "x", pos: [0, 0, 0], width: parseFloat(m[1]), height: parseFloat(m[2]) });
    selectedIds.clear();
    for (const id of ids) selectedIds.add(id);
    refreshOutlines();
    refreshSidebar();
  } else if (val === "peak") {
    // Two rafters joined at a shared apex; feet 24" apart, on grid. Edit each
    // side's length (sidebar or [ ]) and the peak re-solves so the joint holds.
    const [a] = createPeak({ axis: "x", foot: [0, 0, 0], span: 24, lenA: 18, lenB: 18 });
    selectOnly(a); // single rafter selected so its Length/Foot show in the sidebar
  } else if (val.startsWith("fixture:")) {
    const kind = val.slice("fixture:".length);
    selectOnly(addFixture({ kind, axis: "x", pos: [0, 0, 0] }));
  }
};
// ------- Mode toggle -------
const btnOrbit = document.getElementById("btn-mode-orbit");
const btnSelect = document.getElementById("btn-mode-select");
function syncModeButtons() {
  btnOrbit.classList.toggle("active", interactionMode === "orbit");
  btnSelect.classList.toggle("active", interactionMode === "select");
}
syncModeButtons();
btnOrbit.onclick = () => { interactionMode = "orbit"; localStorage.setItem("gridbeam.mode", "orbit"); syncModeButtons(); };
btnSelect.onclick = () => { interactionMode = "select"; localStorage.setItem("gridbeam.mode", "select"); syncModeButtons(); };

document.getElementById("btn-undo").onclick = undo;
document.getElementById("btn-redo").onclick = redo;
initProjectsDropdown({
  button: document.getElementById("btn-projects"),
  nameEl: document.getElementById("project-name"),
  onImport: () => openImportGallery({ pickImmediately: true }),
});

document.getElementById("btn-import").onclick = () => openImportGallery();

document.getElementById("btn-export").onclick = () => {
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL("image/png");
  openExportView(getDoc(), data, { minimalMode });
};
document.getElementById("btn-clear").onclick = async () => {
  const ok = await showConfirm({
    title: "Clear",
    message: "Remove all objects from this project?",
    confirmLabel: "Clear", danger: true,
  });
  if (ok) { clearAll(); selectedIds.clear(); }
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

const btnPanelOpacity = document.getElementById("btn-panel-opacity");
let panelOpaque = localStorage.getItem("gridbeam.panelOpaque") === "1";
function syncPanelOpacityButton() {
  btnPanelOpacity.textContent = "Panels: " + (panelOpaque ? "100%" : "50%");
  btnPanelOpacity.style.background = panelOpaque ? "#55371f" : "";
  setPanelOpacityMode(panelOpaque ? "opaque" : "transparent");
}
syncPanelOpacityButton();
btnPanelOpacity.onclick = () => {
  panelOpaque = !panelOpaque;
  localStorage.setItem("gridbeam.panelOpaque", panelOpaque ? "1" : "0");
  syncPanelOpacityButton();
};

// ------- Environment selector -------
const envSelect = document.getElementById("env-select");
envSelect.value = envKey;
envSelect.addEventListener("change", () => setEnvironment(envSelect.value));

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
  updateBeamHeightLabels();
  renderer.render(scene, camera);
}
tick();
