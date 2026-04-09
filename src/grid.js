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
