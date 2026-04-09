// 1.5" lattice helpers. All dimensions in inches.
export const SNAP = 1.5;
export const BEAM_SIZE = 1.5;       // 2x2 cross-section
export const PANEL_THICK = 0.25;    // 1/4" hardboard
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

// Format inches as fractional feet+inches-friendly string.
export function fmtIn(n) {
  const whole = Math.floor(n);
  const frac = n - whole;
  const frac8 = Math.round(frac * 2); // halves are enough for 1.5" multiples
  if (frac8 === 0) return `${whole}"`;
  if (frac8 === 1) return `${whole} 1/2"`;
  return `${whole + 1}"`;
}
