// 1.5" lattice helpers. All dimensions in inches.
export const SNAP = 1.5;
export const BEAM_SIZE = 1.5;       // 2x2 cross-section
// Panel thickness varies by material — pegboard and wood aren't the same
// stock as the hardboard panel. The aluminum pegboard variants are the same
// gauge as standard perforated hardboard pegboard.
export const PANEL_THICKNESS = {
  plywood: 0.1875,
  pegboard: 0.125,
  "pegboard-aluminum": 0.125,
  "pegboard-black-aluminum": 0.125,
  wood: 0.5,
};
export function panelThickness(material) {
  return PANEL_THICKNESS[material] ?? PANEL_THICKNESS.plywood;
}
export const HOLE_INSET = 0.75;     // first hole from beam end
export const MIN_BEAM = 3;
export const MAX_BEAM = 120;

export const snap = (v) => Math.round(v / SNAP) * SNAP;
export const snapVec = (v) => v.map(snap);

// Valid beam cut lengths: 3, 4.5, 6 ... 120.
export function validBeamLengths() {
  const out = [];
  for (let L = MIN_BEAM; L <= MAX_BEAM + 1e-9; L += SNAP) out.push(+L.toFixed(3));
  return out;
}

export function snapLength(n) {
  const clamped = Math.max(MIN_BEAM, Math.min(MAX_BEAM, n));
  return +(Math.round(clamped / SNAP) * SNAP).toFixed(3);
}

// Return the list of hole positions (offsets from beam start along its axis).
export function holeOffsets(length) {
  const out = [];
  for (let off = HOLE_INSET; off <= length - HOLE_INSET + 1e-6; off += SNAP) {
    out.push(+off.toFixed(3));
  }
  return out;
}

// Beam orientation presets cycled by the R key on a single beam. `axis` is the
// length axis; `tilt` is a rotation (degrees) in the beam's vertical plane,
// pivoting about its low end. Two beams tilted +45 and -45 in the same plane
// meet at a 90° peak (a right angle), which is the point of the 45° presets.
export const BEAM_ORIENTATIONS = [
  { axis: "x", tilt: 0 },
  { axis: "x", tilt: 45 },
  { axis: "x", tilt: -45 },
  { axis: "y", tilt: 0 },
  { axis: "z", tilt: 0 },
  { axis: "z", tilt: 45 },
  { axis: "z", tilt: -45 },
];

// Next preset in the R cycle given a beam's current { axis, tilt }.
export function nextBeamOrientation(axis, tilt = 0) {
  const cur = tilt || 0;
  const i = BEAM_ORIENTATIONS.findIndex((p) => p.axis === axis && p.tilt === cur);
  return BEAM_ORIENTATIONS[(i + 1) % BEAM_ORIENTATIONS.length];
}

// Euler rotation (radians) that realizes a beam tilt. Horizontal beams tilt so
// the far (+axis) end rises; the sign is chosen so +tilt always lifts that end.
// Vertical ('y') beams and tilt 0 stay axis-aligned. Only one of x/z is ever
// nonzero, so Euler order doesn't matter.
export function beamTiltEuler(axis, tilt = 0) {
  const rad = (tilt || 0) * Math.PI / 180;
  if (!rad) return { x: 0, y: 0, z: 0 };
  if (axis === "x") return { x: 0, y: 0, z: rad };   // +tilt lifts the +X end
  if (axis === "z") return { x: -rad, y: 0, z: 0 };  // +tilt lifts the +Z end
  return { x: 0, y: 0, z: 0 };
}

// Rotate a local vector by a tilt Euler (only one of x/z is ever nonzero).
export function rotateByEuler(v, e) {
  let [x, y, z] = v;
  if (e.x) { const c = Math.cos(e.x), s = Math.sin(e.x); const ny = y * c - z * s, nz = y * s + z * c; y = ny; z = nz; }
  if (e.z) { const c = Math.cos(e.z), s = Math.sin(e.z); const nx = x * c - y * s, ny = x * s + y * c; x = nx; y = ny; }
  return [x, y, z];
}

// Local pivot for a tilt: the bolt hole on the *raised* end — the end that ends
// up higher after tilting (+tilt raises the far/+axis end, −tilt raises the near
// end). Pivoting on the apex end is what lets two opposing rafters meet at a
// grid point: each rafter's apex is its pivot (pos + this point), so placing the
// second rafter (length − 2·HOLE_INSET) away in the length axis makes the apex
// bolts coincide exactly. Holes sit HOLE_INSET from each end, centered in the
// cross-section.
export function beamTiltPivot(axis, tilt = 0, length = 0) {
  const h = BEAM_SIZE / 2;
  const along = tilt > 0 ? length - HOLE_INSET : HOLE_INSET;
  if (axis === "x") return [along, h, h];
  if (axis === "z") return [h, h, along];
  return [h, h, h]; // 'y' — never tilted
}

// Combined tilt transform for rendering and bounds. `euler` is the rotation
// (about the group origin); `offset` is added to the beam's pos so the apex-end
// bolt stays fixed in world space while the rest of the beam swings. Derived
// from: world = pos + offset + R·v, and requiring the pivot P to map to pos + P
// ⇒ offset = P − R·P.
export function beamTiltTransform(axis, tilt = 0, length = 0) {
  const euler = beamTiltEuler(axis, tilt);
  if (!euler.x && !euler.z) return { euler, offset: [0, 0, 0] };
  const P = beamTiltPivot(axis, tilt, length);
  const RP = rotateByEuler(P, euler);
  return { euler, offset: [P[0] - RP[0], P[1] - RP[1], P[2] - RP[2]] };
}

// Format inches with common fractions down to 1/4" — enough for 0.75"
// grid-beam hole offsets (3/4", 2 1/4", 3 3/4", ...).
export function fmtIn(n) {
  const neg = n < 0 ? "-" : "";
  n = Math.abs(n);
  const whole = Math.floor(n);
  const q = Math.round((n - whole) * 4); // quarters
  const wholeFinal = q === 4 ? whole + 1 : whole;
  const qFinal = q === 4 ? 0 : q;
  const fracStr = qFinal === 0 ? "" : qFinal === 2 ? " 1/2" : qFinal === 1 ? " 1/4" : " 3/4";
  // Don't show a leading 0 when we only have a fraction: "3/4"" instead of "0 3/4"".
  const body = wholeFinal === 0 && fracStr ? fracStr.trim() : `${wholeFinal}${fracStr}`;
  return `${neg}${body}"`;
}
