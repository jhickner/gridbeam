import * as THREE from "three";
import { BEAM_SIZE, holeOffsets, beamTiltTransform, rotateByEuler } from "./grid.js";

const beamMat = new THREE.MeshStandardMaterial({ color: 0xc79a63, roughness: 0.8 });
const holeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
// Bolted hole highlight — bright so the join is obvious from either side.
const boltHoleMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });

// Returns a Group positioned so its local origin is the beam's min-corner.
// `boltedIdx` is an optional Set<"idx|axis"> listing which holes are bolted.
// `minimalMode` = true → only the bolted holes are drilled; no decorative
// full-length hole row. Used when the user wants a "drill only what's needed"
// build.
export function buildBeamMesh(o, boltedIdx, minimalMode = false) {
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

  const holeGeom = new THREE.CylinderGeometry(0.22, 0.22, BEAM_SIZE * 1.04, 12);
  const offs = holeOffsets(length);

  // Place one cylinder at (hole index i, through-axis p). Axis letter maps to
  // cylinder orientation: y is the default, x rotates around Z, z around X.
  const placeCylinder = (i, p, mat) => {
    const off = offs[i];
    if (off === undefined) return;
    const cx = axis === "x" ? off : BEAM_SIZE / 2;
    const cy = axis === "y" ? off : BEAM_SIZE / 2;
    const cz = axis === "z" ? off : BEAM_SIZE / 2;
    const m = new THREE.Mesh(holeGeom, mat);
    m.position.set(cx, cy, cz);
    if (p === "x") m.rotation.z = Math.PI / 2;
    else if (p === "z") m.rotation.x = Math.PI / 2;
    m.raycast = () => {};
    group.add(m);
  };

  if (minimalMode) {
    // Only drill the holes required by bolted connections.
    if (boltedIdx) {
      for (const entry of boltedIdx) {
        const [iStr, ax] = entry.split("|");
        placeCylinder(+iStr, ax, boltHoleMat);
      }
    }
  } else {
    // Full grid beam: two perpendicular holes at every hole position.
    const perps = axis === "x" ? ["y", "z"] : axis === "y" ? ["x", "z"] : ["x", "y"];
    for (let i = 0; i < offs.length; i++) {
      for (const p of perps) {
        const isBolted = boltedIdx && boltedIdx.has(`${i}|${p}`);
        placeCylinder(i, p, isBolted ? boltHoleMat : holeMat);
      }
    }
  }

  // Tilt swings the beam about its low-end bolt hole (see beamTiltTransform):
  // the rotation is about the group origin, and the offset shifts the group so
  // the bolt point stays fixed — as if the beam were hinged on that bolt.
  const { euler, offset } = beamTiltTransform(axis, o.tilt, length);
  group.position.set(o.pos[0] + offset[0], o.pos[1] + offset[1], o.pos[2] + offset[2]);
  group.rotation.set(euler.x, euler.y, euler.z);
  return group;
}

// World-space hole positions for a beam object (array of [x,y,z]).
// Index order is stable and matches the rendering order in buildBeamMesh.
export function beamHoleWorldPositions(o) {
  const out = [];
  const offs = holeOffsets(o.length);
  // Tilt rotates each hole about the end-bolt pivot; world = pos + offset + R·h.
  const { euler, offset } = beamTiltTransform(o.axis, o.tilt, o.length);
  for (const off of offs) {
    // Hole center in the beam's local frame (origin at the low corner).
    const h = [BEAM_SIZE / 2, BEAM_SIZE / 2, BEAM_SIZE / 2];
    if (o.axis === "x") h[0] = off; else if (o.axis === "y") h[1] = off; else h[2] = off;
    const r = rotateByEuler(h, euler);
    out.push([o.pos[0] + offset[0] + r[0], o.pos[1] + offset[1] + r[1], o.pos[2] + offset[2] + r[2]]);
  }
  return out;
}
