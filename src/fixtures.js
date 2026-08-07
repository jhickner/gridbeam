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

const HDX_BODY = 0x1b1b1d;
const HDX_LID = 0xf5c518;
// Lid depth as a fraction of overall height — the snap-on lid is a shallow cap,
// and the ratio holds well enough across the size range to avoid a per-size
// constant.
const HDX_LID_FRACTION = 0.09;
// How far the lid's skirt hangs past the body, per side. A physical lip, so
// it stays constant across the size range rather than scaling with the tote.
const HDX_LID_OVERHANG = 0.15;

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

  // HDX Tough Storage Totes — black body, yellow snap-on lid. Manufacturer
  // exterior dimensions measured at the top of the tote; the real totes taper
  // inward toward the base so they nest, which is not modeled. The top is the
  // widest point, so a straight box is the correct clearance envelope.
  "hdx-27gal": {
    label: "HDX Tote 27 gal",
    dims: [19.6, 15.2, 28.6],
    base: [14.3, 23.3],
    color: HDX_BODY,
    lid: true,
  },
  "hdx-7gal": {
    label: "HDX Tote 7 gal",
    dims: [13.4, 10.6, 18.8],
    base: [8.2, 14.3],
    color: HDX_BODY,
    lid: true,
  },
  "hdx-6.5qt": {
    label: "HDX Tote 6.5 qt",
    dims: [8.1, 6.2, 12.9],
    base: [5.8, 9.8],
    color: HDX_BODY,
    lid: true,
  },
};

// Footprint at the base, in the same [dx, dz] convention as fixtureDims.
function fixtureBase(kind, axis) {
  const f = FIXTURES[kind];
  if (!f || !f.base) return null;
  const [w, l] = f.base;
  return axis === "x" ? [l, w] : [w, l];
}

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

const hdxLidMat = new THREE.MeshStandardMaterial({ color: HDX_LID, roughness: 0.75 });

// A box whose bottom face is smaller than its top, for the nesting taper.
// Built by displacing BoxGeometry's own vertices — each side face has vertices
// only at the two extremes in Y, so scaling them by height gives an exact
// linear taper while keeping the box's winding, and its one-quad-per-face
// topology keeps the recomputed normals flat.
function taperedBoxGeometry(topX, topZ, botX, botZ, height) {
  const g = new THREE.BoxGeometry(topX, height, topZ);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + height / 2) / height; // 0 at the base, 1 at the rim
    pos.setX(i, pos.getX(i) * THREE.MathUtils.lerp(botX / topX, 1, t));
    pos.setZ(i, pos.getZ(i) * THREE.MathUtils.lerp(botZ / topZ, 1, t));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Black body tapering in toward the base (so the real totes nest), with a
// yellow lid capping the top. The lid overhangs the rim slightly, as the real
// snap-on lid does, but stays inside the published exterior dimensions so the
// fixture's AABB still matches the spec — the rim is the widest point.
function buildToteAssembly(o, dims) {
  const [dx, dy, dz] = dims;
  const asm = new THREE.Group();
  const lidH = dy * HDX_LID_FRACTION;
  const bodyH = dy - lidH;
  const topX = dx - HDX_LID_OVERHANG * 2, topZ = dz - HDX_LID_OVERHANG * 2;
  const base = fixtureBase(o.kind, o.axis);

  const body = new THREE.Mesh(
    base
      ? taperedBoxGeometry(topX, topZ, base[0], base[1], bodyH)
      : new THREE.BoxGeometry(topX, bodyH, topZ),
    materialFor(o.kind)
  );
  body.position.set(dx / 2, bodyH / 2, dz / 2);
  body.userData.id = o.id;
  asm.add(body);

  const lid = new THREE.Mesh(new THREE.BoxGeometry(dx, lidH, dz), hdxLidMat);
  lid.position.set(dx / 2, bodyH + lidH / 2, dz / 2);
  lid.userData.id = o.id;
  asm.add(lid);

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

  if (FIXTURES[o.kind] && FIXTURES[o.kind].lid) {
    group.add(buildToteAssembly(o, dims));
    group.position.set(o.pos[0], o.pos[1], o.pos[2]);
    return group;
  }

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
