import * as THREE from "three";

// "Seforim row" — a generated shelf of books ("book" objects). Unlike
// FIXTURES, each book is a distinct object with its own per-instance
// dims/color, since the whole point is variety along a shelf. This module
// owns both generating a row's contents and rendering a single book.

// Rich, leather-binding-style palette (cover, gilt/silver trim).
const PALETTE = [
  { cover: 0x6b1f2a, trim: 0xd4af37 }, // burgundy / gold
  { cover: 0x1f2a4d, trim: 0xd4af37 }, // navy / gold
  { cover: 0x1f4d2a, trim: 0xd4af37 }, // forest green / gold
  { cover: 0x4a2318, trim: 0xd4af37 }, // oxblood brown / gold
  { cover: 0x27408b, trim: 0xc0c0c0 }, // royal blue / silver
  { cover: 0x1a1a1a, trim: 0xd4af37 }, // black / gold
  { cover: 0x3a1f4d, trim: 0xd4af37 }, // deep purple / gold
  { cover: 0x1f4d4d, trim: 0xc0c0c0 }, // teal / silver
  { cover: 0x5c3a21, trim: 0xd4af37 }, // saddle brown / gold
  { cover: 0x2a2a5c, trim: 0xc0c0c0 }, // indigo / silver
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => min + Math.random() * (max - min);
const round2 = (n) => +n.toFixed(2);

function makeSingle(maxHeight) {
  const p = pick(PALETTE);
  return {
    width: round2(rand(1.3, 3.4)),
    height: round2(rand(maxHeight * 0.55, maxHeight)),
    depth: round2(rand(6.5, 9.2)),
    color: p.cover,
    accent: p.trim,
  };
}

// A run of matching volumes — e.g. a Chumash or Talmud set — sharing color,
// height and depth, each a bit narrower than a standalone volume. Real sets
// still have some volume-to-volume width variance, so it isn't a single
// repeated value.
function makeRun(maxHeight) {
  const p = pick(PALETTE);
  const height = round2(rand(maxHeight * 0.75, maxHeight));
  const depth = round2(rand(7, 9.3));
  const baseWidth = rand(1.0, 1.55);
  const count = Math.floor(rand(3, 12));
  const specs = [];
  for (let i = 0; i < count; i++) {
    specs.push({ width: round2(baseWidth * rand(0.88, 1.12)), height, depth, color: p.cover, accent: p.trim });
  }
  return specs;
}

// Fill `totalWidth` (inches) with books no taller than `maxHeight`, mixing
// eclectic singles with runs of matching sets. Returns an ordered list of
// { width, height, depth, color, accent } specs — no position/axis, that's
// the caller's job (see state.js addSeforimRow).
export function generateSeforim(totalWidth, maxHeight) {
  const MIN_LEFTOVER = 0.6;
  const specs = [];
  let remaining = totalWidth;
  while (remaining > MIN_LEFTOVER && specs.length < 300) {
    let candidate = Math.random() < 0.45 ? makeRun(maxHeight) : [makeSingle(maxHeight)];
    let candWidth = candidate.reduce((s, b) => s + b.width, 0);
    // A run that doesn't fit sheds volumes off the end until it does.
    while (candidate.length > 1 && candWidth > remaining) {
      candidate.pop();
      candWidth = candidate.reduce((s, b) => s + b.width, 0);
    }
    if (candWidth > remaining) {
      if (candWidth > remaining + MIN_LEFTOVER) break; // doesn't fit even loosely
      candidate[0].width = round2(Math.max(0.5, remaining)); // taper to fit exactly
      candWidth = candidate[0].width;
    }
    specs.push(...candidate);
    remaining -= candWidth;
  }
  // Stretch the last book to close out any small remaining gap so the row
  // reaches the shelf's full width edge-to-edge.
  if (specs.length && remaining > 0.05 && remaining < 4) {
    specs[specs.length - 1].width = round2(specs[specs.length - 1].width + remaining);
  }
  return specs;
}

// A book's per-instance materials aren't shared/cached like other object
// types', so they're tagged for disposal on mesh rebuild (see main.js
// disposeGroup).
function disposableMat(opts) {
  const m = new THREE.MeshStandardMaterial(opts);
  m.userData.disposable = true;
  return m;
}

// Visual seam between adjacent books along the row axis. Books are laid out
// shoulder to shoulder with no gap in their logical footprint (so runs still
// sum to the requested shelf width), but rendering each one slightly
// narrower than its footprint leaves a real gap — reading as a distinct
// spine edge even between same-colored volumes in a matching set, rather
// than one solid blended block.
const SEAM = 0.09;

export function buildBookMesh(o) {
  const group = new THREE.Group();
  group.userData.id = o.id;
  group.userData.type = "book";

  const rowIdx = o.axis === "x" ? 0 : 2; // which dim index runs along the shelf
  const dims = o.axis === "x"
    ? [o.width, o.height, o.depth]
    : [o.depth, o.height, o.width];
  const renderDims = dims.slice();
  renderDims[rowIdx] = Math.max(0.15, dims[rowIdx] - SEAM);
  const [dx, dy, dz] = dims;
  const [rdx, , rdz] = renderDims;

  const cover = new THREE.Mesh(
    new THREE.BoxGeometry(rdx, dy, rdz),
    disposableMat({ color: o.color, roughness: 0.55, metalness: 0.05 })
  );
  // Centered on the full (un-inset) footprint so the seam splits evenly
  // between this book and its neighbor on either side.
  cover.position.set(dx / 2, dy / 2, dz / 2);
  cover.userData.id = o.id;
  group.add(cover);

  // Gilt/silver tooling bands near top and bottom, wrapping the full
  // footprint so they read as ornate binding detail from any angle.
  const trimMat = disposableMat({ color: o.accent ?? 0xd4af37, roughness: 0.3, metalness: 0.6 });
  const bandH = Math.min(0.18, dy * 0.06);
  const inset = 0.02;
  for (const frac of [0.1, 0.85]) {
    const by = dy * frac;
    if (by + bandH > dy) continue;
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(rdx + inset * 2, bandH, rdz + inset * 2),
      trimMat
    );
    band.position.set(dx / 2, by + bandH / 2, dz / 2);
    band.raycast = () => {}; // decorative only, not selectable
    group.add(band);
  }

  group.position.set(o.pos[0], o.pos[1], o.pos[2]);
  return group;
}
