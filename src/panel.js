import * as THREE from "three";
import { panelThickness } from "./grid.js";

const panelMat = new THREE.MeshStandardMaterial({
  color: 0x8a5a3b, roughness: 0.9, transparent: true, opacity: 0.6,
});

// Same color/finish as beams (see beam.js) — this is dimensional lumber
// stock, not hardboard, so no transparency.
const woodMat = new THREE.MeshStandardMaterial({ color: 0xc79a63, roughness: 0.8 });

const screwMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
const screwGeom = new THREE.CylinderGeometry(0.15, 0.15, 0.3, 8);

const CHAMFER = 0.75;

// Standard hardboard pegboard: 1/4" holes on 1" centers, starting 1/2" from
// each edge — actual through-holes, punched by subtracting circles from the
// extruded shape (not a texture).
const PEG_SPACING = 1;
const PEG_HOLE_R = 0.125;
const PEG_MARGIN = 0.5;

const pegboardMat = new THREE.MeshStandardMaterial({
  color: 0xc9a66b, roughness: 0.85, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
});

// Brushed aluminum pegboard — same hole pattern/thickness as the hardboard
// version, just a metal cover panel. The scene has no environment map, so
// high metalness alone reads as dark/flat (metals get most of their
// brightness from reflections); a lighter base color and lower metalness
// keep it reading as bright aluminum under plain scene lighting.
const pegboardAluminumMat = new THREE.MeshStandardMaterial({
  color: 0xe0e2e5, roughness: 0.4, metalness: 0.45,
  transparent: true, opacity: 0.6, side: THREE.DoubleSide,
});

// Black anodized aluminum pegboard.
const pegboardBlackAluminumMat = new THREE.MeshStandardMaterial({
  color: 0x1c1c1e, roughness: 0.35, metalness: 0.8,
  transparent: true, opacity: 0.6, side: THREE.DoubleSide,
});

// Per-material render config: which shared material to use, and whether it
// needs the extruded/hole-punched geometry (all pegboard variants do).
const MATERIAL_CONFIG = {
  plywood: { mat: panelMat, pegboard: false },
  pegboard: { mat: pegboardMat, pegboard: true },
  "pegboard-aluminum": { mat: pegboardAluminumMat, pegboard: true },
  "pegboard-black-aluminum": { mat: pegboardBlackAluminumMat, pegboard: true },
  wood: { mat: woodMat, pegboard: false },
};
function configFor(material) {
  return MATERIAL_CONFIG[material] || MATERIAL_CONFIG.plywood;
}

// Global panel opacity override — toggled from the toolbar. Mutating these
// shared materials in place updates every panel mesh immediately, no rebuild
// needed.
const PANEL_MATERIALS = [panelMat, woodMat, pegboardMat, pegboardAluminumMat, pegboardBlackAluminumMat];
export function setPanelOpacityMode(mode) {
  const opacity = mode === "opaque" ? 1 : 0.5;
  const transparent = mode !== "opaque";
  for (const m of PANEL_MATERIALS) {
    m.opacity = opacity;
    m.transparent = transparent;
  }
}

// Punch a peg grid into a shape already spanning [0,faceU] × [0,faceV].
function addPegHoles(shape, faceU, faceV) {
  for (let u = PEG_MARGIN; u <= faceU - PEG_MARGIN + 1e-6; u += PEG_SPACING) {
    for (let v = PEG_MARGIN; v <= faceV - PEG_MARGIN + 1e-6; v += PEG_SPACING) {
      const hole = new THREE.Path();
      hole.absarc(u, v, PEG_HOLE_R, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  }
}

// Extruded panel geometry (outer boundary + optional peg holes), cached by
// the parameters that affect its shape.
const panelGeomCache = new Map(); // "faceU,faceV,clipped,pegboard,thickness" → BufferGeometry
function panelGeometry(faceU, faceV, clipped, pegboard, thickness) {
  const key = `${faceU},${faceV},${clipped},${pegboard},${thickness}`;
  let geom = panelGeomCache.get(key);
  if (geom) return geom;
  const shape = panelShape(faceU, faceV, clipped);
  if (pegboard) addPegHoles(shape, faceU, faceV);
  geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 8 });
  panelGeomCache.set(key, geom);
  return geom;
}

function panelShape(w, h, clipped) {
  const s = new THREE.Shape();
  if (!clipped) {
    s.moveTo(0, 0);
    s.lineTo(w, 0);
    s.lineTo(w, h);
    s.lineTo(0, h);
    s.closePath();
    return s;
  }
  const c = Math.min(CHAMFER, w / 2, h / 2);
  s.moveTo(c, 0);
  s.lineTo(w - c, 0);
  s.lineTo(w, c);
  s.lineTo(w, h - c);
  s.lineTo(w - c, h);
  s.lineTo(c, h);
  s.lineTo(0, h - c);
  s.lineTo(0, c);
  s.closePath();
  return s;
}

export function buildPanelMesh(o, clippedCorners = false) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "panel";

  const t = panelThickness(o.material);
  const { mat, pegboard: isPegboard } = configFor(o.material);
  // Pegboard always needs the extruded shape (to punch real holes through);
  // plain panels only extrude when clipped corners are on and dims allow it.
  const extrude = isPegboard || (clippedCorners && o.w >= 0.5 && o.h >= 0.5);

  if (!extrude) {
    // Simple box — no shape extrusion needed.
    const dims = o.normal === "x" ? [t, o.w, o.h]
               : o.normal === "y" ? [o.w, t, o.h]
               : [o.w, o.h, t];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), mat);
    mesh.position.set(dims[0] / 2, dims[1] / 2, dims[2] / 2);
    mesh.userData.id = o.id;
    group.add(mesh);
  } else {
    // Extruded shape — optionally an octagon (3/4" triangle removed from
    // each corner) and/or a peg-hole grid, both punched all the way through.
    // Shape is always drawn in its own XY with u=o.w, v=o.h.
    // ExtrudeGeometry extrudes along local +Z by thickness t.
    // Then rotate+position so the extrusion runs along the normal axis and
    // the group origin is at the panel's min corner.
    // The shape is drawn in 2D (u, v) then extruded along local +Z.
    // For each normal, pick (faceU, faceV) so that after rotation the
    // world-space extents match dims = [t, o.w, o.h] (normal=x),
    // [o.w, t, o.h] (normal=y), or [o.w, o.h, t] (normal=z).
    let faceU, faceV;
    if (o.normal === "x") {
      // rotation.y=PI/2: shape u→world -Z, shape v→world Y
      // So u should span Z extent (o.h) and v should span Y extent (o.w).
      faceU = o.h; faceV = o.w;
    } else {
      // normal=y: shape u→world X (o.w), shape v→world Z (o.h). ✓
      // normal=z: shape u→world X (o.w), shape v→world Y (o.h). ✓
      faceU = o.w; faceV = o.h;
    }

    const geom = panelGeometry(faceU, faceV, clippedCorners, isPegboard, t);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.id = o.id;

    if (o.normal === "z") {
      // No rotation needed.
    } else if (o.normal === "y") {
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(0, t, 0);
    } else {
      // normal=x
      mesh.rotation.y = Math.PI / 2;
      mesh.position.set(0, 0, faceU); // faceU = o.h = Z extent
    }

    group.add(mesh);
  }

  // Screw indicators at each corner.
  const dims = o.normal === "x" ? [t, o.w, o.h]
             : o.normal === "y" ? [o.w, t, o.h]
             : [o.w, o.h, t];
  const INSET = 0.75;
  const corners = panelCorners(dims, INSET);
  for (const c of corners) {
    const s = new THREE.Mesh(screwGeom, screwMat);
    s.position.set(c[0], c[1], c[2]);
    if (o.normal === "x") s.rotation.z = Math.PI / 2;
    else if (o.normal === "z") s.rotation.x = Math.PI / 2;
    s.raycast = () => {};
    group.add(s);
  }

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}

function panelCorners(dims, d) {
  const [dx, dy, dz] = dims;
  if (dx < 1) {
    const cx = dx / 2;
    return [[cx, d, d], [cx, dy - d, d], [cx, d, dz - d], [cx, dy - d, dz - d]];
  }
  if (dy < 1) {
    const cy = dy / 2;
    return [[d, cy, d], [dx - d, cy, d], [d, cy, dz - d], [dx - d, cy, dz - d]];
  }
  const cz = dz / 2;
  return [[d, d, cz], [dx - d, d, cz], [d, dy - d, cz], [dx - d, dy - d, cz]];
}
