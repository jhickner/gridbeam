import * as THREE from "three";
import { BEAM_SIZE, holeOffsets } from "./grid.js";

const beamMat = new THREE.MeshStandardMaterial({ color: 0xc79a63, roughness: 0.8 });
const holeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
// Bolted hole highlight — bright so the join is obvious from either side.
const boltHoleMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });

// Returns a Group positioned so its local origin is the beam's min-corner.
// `boltedIdx` is an optional Set<number> of hole indices that should be
// rendered in the "bolted" color (indices match beamHoleWorldPositions order).
export function buildBeamMesh(o, boltedIdx) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "beam";

  const { length, axis } = o;
  const dims = axis === "x" ? [length, BEAM_SIZE, BEAM_SIZE]
            : axis === "y" ? [BEAM_SIZE, length, BEAM_SIZE]
            : [BEAM_SIZE, BEAM_SIZE, length];

  const box = new THREE.Mesh(new THREE.BoxGeometry(...dims), beamMat);
  box.position.set(dims[0] / 2, dims[1] / 2, dims[2] / 2);
  box.userData.id = o.id;
  group.add(box);

  // Slightly larger radius so the highlight reads at a distance.
  const holeGeom = new THREE.CylinderGeometry(0.22, 0.22, BEAM_SIZE * 1.04, 12);
  const offs = holeOffsets(length);
  for (let i = 0; i < offs.length; i++) {
    const off = offs[i];
    const cx = axis === "x" ? off : BEAM_SIZE / 2;
    const cy = axis === "y" ? off : BEAM_SIZE / 2;
    const cz = axis === "z" ? off : BEAM_SIZE / 2;
    const perps = axis === "x" ? ["y", "z"] : axis === "y" ? ["x", "z"] : ["x", "y"];
    for (const p of perps) {
      // Highlight only the cylinder whose through-axis matches the bolt direction
      // recorded by connections.js — i.e. the one perpendicular to the touching face.
      const isBolted = boltedIdx && boltedIdx.has(`${i}|${p}`);
      const m = new THREE.Mesh(holeGeom, isBolted ? boltHoleMat : holeMat);
      m.position.set(cx, cy, cz);
      if (p === "x") m.rotation.z = Math.PI / 2;
      else if (p === "z") m.rotation.x = Math.PI / 2;
      m.raycast = () => {};
      group.add(m);
    }
  }

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}

// World-space hole positions for a beam object (array of [x,y,z]).
// Index order is stable and matches the rendering order in buildBeamMesh.
export function beamHoleWorldPositions(o) {
  const out = [];
  const offs = holeOffsets(o.length);
  for (const off of offs) {
    const p = o.pos.slice();
    if (o.axis === "x") p[0] += off; else if (o.axis === "y") p[1] += off; else p[2] += off;
    if (o.axis !== "x") p[0] += BEAM_SIZE / 2;
    if (o.axis !== "y") p[1] += BEAM_SIZE / 2;
    if (o.axis !== "z") p[2] += BEAM_SIZE / 2;
    out.push(p);
  }
  return out;
}
