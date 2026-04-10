import * as THREE from "three";
import { PANEL_THICK } from "./grid.js";

const panelMat = new THREE.MeshStandardMaterial({
  color: 0x8a5a3b, roughness: 0.9, transparent: true, opacity: 0.6,
});

const screwMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
const screwGeom = new THREE.CylinderGeometry(0.15, 0.15, 0.3, 8);

export function buildPanelMesh(o) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "panel";

  const t = PANEL_THICK;
  const dims = o.normal === "x" ? [t, o.w, o.h]
             : o.normal === "y" ? [o.w, t, o.h]
             : [o.w, o.h, t];

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), panelMat);
  mesh.position.set(dims[0] / 2, dims[1] / 2, dims[2] / 2);
  mesh.userData.id = o.id;
  group.add(mesh);

  // Small screw indicators at each corner. Inset slightly so they sit
  // visibly on the panel face rather than right at the edge.
  const INSET = 0.75;
  const corners = panelCorners(dims, INSET);
  for (const c of corners) {
    const s = new THREE.Mesh(screwGeom, screwMat);
    s.position.set(c[0], c[1], c[2]);
    // Orient the cylinder perpendicular to the panel face.
    if (o.normal === "x") s.rotation.z = Math.PI / 2;
    else if (o.normal === "z") s.rotation.x = Math.PI / 2;
    // y (default cylinder axis) already points through the panel for normal=y
    s.raycast = () => {};
    group.add(s);
  }

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}

// Compute the 4 corner positions (in group-local space) of the panel face,
// inset by `d` from each edge.
function panelCorners(dims, d) {
  const [dx, dy, dz] = dims;
  const cx = dx / 2; // center of the thin axis

  // For each normal orientation, the panel face spans two of the three axes.
  // We enumerate the 4 corners on that face, inset by d.
  if (dx < 1) {
    // normal = x → face spans Y, Z
    return [[cx, d, d], [cx, dy - d, d], [cx, d, dz - d], [cx, dy - d, dz - d]];
  }
  if (dy < 1) {
    // normal = y → face spans X, Z
    return [[d, cy, d], [dx - d, cy, d], [d, cy, dz - d], [dx - d, cy, dz - d]];
  }
  // normal = z → face spans X, Y
  const cz = dz / 2;
  return [[d, d, cz], [dx - d, d, cz], [d, dy - d, cz], [dx - d, dy - d, cz]];
}
