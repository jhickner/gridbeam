import * as THREE from "three";

// Fixture registry — static, fixed-dimension placeables (mattresses,
// hardware, anything that isn't a cut-to-size beam or panel).
//
// To add a new fixture: append an entry here AND add a toolbar button that
// calls addFixture({ kind: "..." }). Nothing else needs to change.
//
// Each entry:
//   label      — UI label used in the sidebar / toolbar.
//   dims       — [width, height, length] in inches. By convention:
//                  width  = short horizontal (matches axis "z" by default)
//                  height = vertical thickness (always Y)
//                  length = long horizontal (matches axis "x" by default)
//                If the fixture has no natural "long side" (e.g. a cube),
//                just pick one.
//   color      — display color.
//   opacity    — 0..1, defaults to 1.

// 13" MacBook Pro, modeled open (base + tilted screen) rather than as a
// closed slab. Canonical orientation (axis "x"): width along X, base depth
// along Z, hinge along the back edge (z = LAPTOP_BASE_DEPTH).
const LAPTOP_WIDTH = 11.97;
const LAPTOP_BASE_DEPTH = 8.36;
const LAPTOP_BASE_H = 0.6;
const LAPTOP_SCREEN_H = 8.4;
const LAPTOP_SCREEN_THICK = 0.25;
const LAPTOP_TILT = THREE.MathUtils.degToRad(12); // lean past vertical
// Overall AABB of the opened assembly — used for dims/selection/collision.
const LAPTOP_TOTAL_H = LAPTOP_BASE_H + LAPTOP_SCREEN_H * Math.cos(LAPTOP_TILT);
const LAPTOP_TOTAL_DEPTH = LAPTOP_BASE_DEPTH + LAPTOP_SCREEN_H * Math.sin(LAPTOP_TILT);

export const FIXTURES = {
  "crib-mattress": {
    label: "Crib Mattress",
    dims: [27.5, 4, 51.5], // 27.5 × 51.5 footprint, 4" thick
    color: 0xd3cfe6,
    opacity: 0.65,
  },
  "single-mattress": {
    label: "Single Mattress",
    dims: [38, 6, 75], // 38" × 75" footprint (twin), 6" thick
    color: 0xc6cfe6,
    opacity: 0.65,
  },
  "macbook-pro-13": {
    label: '13" MacBook Pro (open)',
    dims: [LAPTOP_TOTAL_DEPTH, LAPTOP_TOTAL_H, LAPTOP_WIDTH], // opened AABB
    color: 0xaeb0b4,
  },
};

// Given a fixture's dimensions and the requested long-axis direction,
// compute the world-space [dx, dy, dz] extents. `axis` is "x" or "z".
// height stays on Y.
export function fixtureDims(kind, axis) {
  const f = FIXTURES[kind];
  if (!f) return [1, 1, 1];
  const [w, h, l] = f.dims;
  return axis === "x" ? [l, h, w] : [w, h, l];
}

// Cache materials per kind so every fixture mesh doesn't allocate its own.
const _matCache = new Map();
function materialFor(kind) {
  let m = _matCache.get(kind);
  if (m) return m;
  const f = FIXTURES[kind];
  m = new THREE.MeshStandardMaterial({
    color: f.color,
    roughness: 0.95,
    transparent: (f.opacity ?? 1) < 1,
    opacity: f.opacity ?? 1,
  });
  _matCache.set(kind, m);
  return m;
}

const screenMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.4, metalness: 0.2 });

// Base + tilted screen, built in canonical orientation (width along local X,
// base depth along local Z, hinge at z = LAPTOP_BASE_DEPTH). Occupies the
// local box x:[0,LAPTOP_WIDTH] y:[0,LAPTOP_TOTAL_H] z:[0,LAPTOP_TOTAL_DEPTH].
function buildMacbookAssembly(id) {
  const asm = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(LAPTOP_WIDTH, LAPTOP_BASE_H, LAPTOP_BASE_DEPTH),
    materialFor("macbook-pro-13")
  );
  base.position.set(LAPTOP_WIDTH / 2, LAPTOP_BASE_H / 2, LAPTOP_BASE_DEPTH / 2);
  base.userData.id = id;
  asm.add(base);

  // Screen hinges off the back-top edge of the base, leaning back by
  // LAPTOP_TILT past vertical.
  const hinge = new THREE.Group();
  hinge.position.set(0, LAPTOP_BASE_H, LAPTOP_BASE_DEPTH);
  hinge.rotation.x = LAPTOP_TILT;
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(LAPTOP_WIDTH, LAPTOP_SCREEN_H, LAPTOP_SCREEN_THICK),
    screenMat
  );
  screen.position.set(LAPTOP_WIDTH / 2, LAPTOP_SCREEN_H / 2, 0);
  screen.userData.id = id;
  hinge.add(screen);
  asm.add(hinge);

  return asm;
}

export function buildFixtureMesh(o) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "fixture";
  group.userData.kind = o.kind;

  if (o.kind === "macbook-pro-13") {
    const asm = buildMacbookAssembly(o.id);
    if (o.axis === "z") {
      // Rotate the canonical (axis "x") assembly 90° about Y so its width
      // runs along Z, matching fixtureDims' axis swap.
      const wrapper = new THREE.Group();
      wrapper.rotation.y = Math.PI / 2;
      wrapper.position.set(0, 0, LAPTOP_WIDTH);
      wrapper.add(asm);
      group.add(wrapper);
    } else {
      group.add(asm);
    }
    group.position.set(o.pos[0], o.pos[1], o.pos[2]);
    return group;
  }

  const dims = fixtureDims(o.kind, o.axis);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), materialFor(o.kind));
  mesh.position.set(dims[0] / 2, dims[1] / 2, dims[2] / 2);
  mesh.userData.id = o.id;
  group.add(mesh);

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}

export function fixtureLabel(kind) {
  return (FIXTURES[kind] && FIXTURES[kind].label) || kind;
}
