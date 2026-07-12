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

export function buildFixtureMesh(o) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "fixture";
  group.userData.kind = o.kind;

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
