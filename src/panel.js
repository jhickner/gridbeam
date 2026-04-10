import * as THREE from "three";
import { PANEL_THICK } from "./grid.js";

const panelMat = new THREE.MeshStandardMaterial({
  color: 0x8a5a3b, roughness: 0.9, transparent: true, opacity: 0.6,
});

const screwMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
const screwGeom = new THREE.CylinderGeometry(0.15, 0.15, 0.3, 8);

const CHAMFER = 0.75;

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

  const t = PANEL_THICK;

  // Fall back to simple box if dimensions are too small for a valid extrusion.
  if (!clippedCorners || o.w < 0.5 || o.h < 0.5) {
    // Simple box — no shape extrusion needed.
    const dims = o.normal === "x" ? [t, o.w, o.h]
               : o.normal === "y" ? [o.w, t, o.h]
               : [o.w, o.h, t];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), panelMat);
    mesh.position.set(dims[0] / 2, dims[1] / 2, dims[2] / 2);
    mesh.userData.id = o.id;
    group.add(mesh);
  } else {
    // Extruded octagon — 3/4" triangle removed from each corner.
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

    const shape = panelShape(faceU, faceV, true);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    const mesh = new THREE.Mesh(geom, panelMat);
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
