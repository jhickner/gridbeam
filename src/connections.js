// Infer bolt locations from proximity. Beams don't intersect; they sit face-to-face.
import { BEAM_SIZE, PANEL_THICK } from "./grid.js";
import { beamHoleWorldPositions } from "./beam.js";

const EPS = 1e-3;
const near = (a, b) => Math.abs(a - b) < EPS;

function beamAabb(o) {
  const d = o.axis === "x" ? [o.length, BEAM_SIZE, BEAM_SIZE]
          : o.axis === "y" ? [BEAM_SIZE, o.length, BEAM_SIZE]
          : [BEAM_SIZE, BEAM_SIZE, o.length];
  return [o.pos, [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
}

function panelAabb(o) {
  const t = PANEL_THICK;
  const d = o.normal === "x" ? [t, o.w, o.h]
          : o.normal === "y" ? [o.w, t, o.h]
          : [o.w, o.h, t];
  return [o.pos, [o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2]]];
}

// Returns { bolts, boltedHoles: Map<objectId, Set<"idx|axis">> }
// The axis letter is the direction the through-bolt travels — used by the
// beam renderer to only highlight the cylinder whose orientation matches the
// actual bolt direction (the two beams' touching face).
const AXIS_LETTER = ["x", "y", "z"];
export function computeConnections(doc) {
  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");
  const bolts = [];
  const boltedHoles = new Map();
  const markHole = (id, idx, axisLetter) => {
    if (!boltedHoles.has(id)) boltedHoles.set(id, new Set());
    boltedHoles.get(id).add(`${idx}|${axisLetter}`);
  };
  const seen = new Set();
  const addBolt = (p, kind) => {
    const k = `${kind}|${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    bolts.push({ pos: p, kind });
    return true;
  };

  // --- Beam-to-beam: adjacent, overlapping, and some hole in A lines up with one in B ---
  for (let i = 0; i < beams.length; i++) {
    for (let j = i + 1; j < beams.length; j++) {
      const A = beams[i], B = beams[j];
      const [amin, amax] = beamAabb(A);
      const [bmin, bmax] = beamAabb(B);

      let touchAxis = -1;
      for (let k = 0; k < 3; k++) {
        if (near(amax[k], bmin[k]) || near(bmax[k], amin[k])) { touchAxis = k; break; }
      }
      if (touchAxis === -1) continue;

      let overlap = true;
      for (let k = 0; k < 3; k++) {
        if (k === touchAxis) continue;
        if (amax[k] <= bmin[k] + EPS || bmax[k] <= amin[k] + EPS) { overlap = false; break; }
      }
      if (!overlap) continue;

      const holesA = beamHoleWorldPositions(A);
      const holesB = beamHoleWorldPositions(B);
      for (let ai = 0; ai < holesA.length; ai++) {
        for (let bi = 0; bi < holesB.length; bi++) {
          const ha = holesA[ai], hb = holesB[bi];
          const sameOther =
            near(ha[(touchAxis + 1) % 3], hb[(touchAxis + 1) % 3]) &&
            near(ha[(touchAxis + 2) % 3], hb[(touchAxis + 2) % 3]);
          if (!sameOther) continue;
          const mid = [(ha[0] + hb[0]) / 2, (ha[1] + hb[1]) / 2, (ha[2] + hb[2]) / 2];
          if (addBolt(mid, "beam-beam")) {
            const axisLetter = AXIS_LETTER[touchAxis];
            markHole(A.id, ai, axisLetter);
            markHole(B.id, bi, axisLetter);
          }
        }
      }
    }
  }

  // --- Beam-to-panel (every 3rd hole along the shared region) ---
  for (const P of panels) {
    const [pmin, pmax] = panelAabb(P);
    const nAxis = P.normal === "x" ? 0 : P.normal === "y" ? 1 : 2;
    for (const B of beams) {
      const [bmin, bmax] = beamAabb(B);
      const flush = near(bmax[nAxis], pmin[nAxis]) || near(pmax[nAxis], bmin[nAxis]);
      if (!flush) continue;
      let overlap = true;
      for (let k = 0; k < 3; k++) {
        if (k === nAxis) continue;
        if (bmax[k] <= pmin[k] + EPS || pmax[k] <= bmin[k] + EPS) { overlap = false; break; }
      }
      if (!overlap) continue;

      const holes = beamHoleWorldPositions(B);
      let count = 0;
      for (let hi = 0; hi < holes.length; hi++) {
        const h = holes[hi];
        const inside =
          h[(nAxis + 1) % 3] >= pmin[(nAxis + 1) % 3] - EPS &&
          h[(nAxis + 1) % 3] <= pmax[(nAxis + 1) % 3] + EPS &&
          h[(nAxis + 2) % 3] >= pmin[(nAxis + 2) % 3] - EPS &&
          h[(nAxis + 2) % 3] <= pmax[(nAxis + 2) % 3] + EPS;
        if (!inside) continue;
        if (count % 3 === 0) {
          const mid = h.slice();
          mid[nAxis] = near(bmax[nAxis], pmin[nAxis]) ? bmax[nAxis] : bmin[nAxis];
          if (addBolt(mid, "beam-panel")) markHole(B.id, hi, AXIS_LETTER[nAxis]);
        }
        count++;
      }
    }
  }

  return { bolts, boltedHoles };
}
