import * as THREE from "three";
import { PANEL_THICK } from "./grid.js";

const panelMat = new THREE.MeshStandardMaterial({
  color: 0x8a5a3b, roughness: 0.9, transparent: true, opacity: 0.6,
});

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

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}
