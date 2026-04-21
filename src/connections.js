// Infer bolt locations from proximity. Beams don't intersect; they sit face-to-face.
import { BEAM_SIZE, PANEL_THICK, SNAP } from "./grid.js";
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
  // Skip rotated objects — bolts only make sense for grid-aligned beams.
  const beams = doc.objects.filter((o) => o.type === "beam" && !o.groupRotY);
  const panels = doc.objects.filter((o) => o.type === "panel" && !o.groupRotY);
  const bolts = [];
  const boltedHoles = new Map();
  // Track which hole indices per beam are occupied and in which direction.
  // Two bolts at the same hole in DIFFERENT directions would collide inside
  // the beam. Same direction is fine (same physical path).
  const occupiedHole = new Map(); // beamId → Map<holeIdx, axisLetter>
  const isOccupiedDifferent = (id, idx, axis) => {
    const m = occupiedHole.get(id);
    if (!m) return false;
    const existing = m.get(idx);
    return existing !== undefined && existing !== axis;
  };
  const markHole = (id, idx, axisLetter) => {
    if (!boltedHoles.has(id)) boltedHoles.set(id, new Set());
    boltedHoles.get(id).add(`${idx}|${axisLetter}`);
    if (!occupiedHole.has(id)) occupiedHole.set(id, new Map());
    occupiedHole.get(id).set(idx, axisLetter);
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

      // Find all axes where the two beams touch face-to-face, then pick
      // one where the bolt goes through SIDE faces (not end caps) of both.
      const aAxisIdx = A.axis === "x" ? 0 : A.axis === "y" ? 1 : 2;
      const bAxisIdx = B.axis === "x" ? 0 : B.axis === "y" ? 1 : 2;
      let touchAxis = -1;
      for (let k = 0; k < 3; k++) {
        if (near(amax[k], bmin[k]) || near(bmax[k], amin[k])) {
          // Bolt along this axis would enter through an end cap — skip it
          // but keep looking for a valid side-face axis.
          if (k === aAxisIdx || k === bAxisIdx) continue;
          touchAxis = k;
          break;
        }
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
      const parallel = A.axis === B.axis;

      if (parallel) {
        // Collect matching holes, then pick equidistant bolts at ~1 per foot.
        // To prevent collisions where four parallel beams form a 2×2 square,
        // each touch axis (0/1/2) gets every 3rd hole: axis 0 → indices 0,3,6,...
        // axis 1 → 1,4,7,...  axis 2 → 2,5,8,...  Guaranteed non-overlapping.
        const axL = AXIS_LETTER[touchAxis];
        const allMatches = [];
        for (let ai = 0; ai < holesA.length; ai++) {
          for (let bi = 0; bi < holesB.length; bi++) {
            const ha = holesA[ai], hb = holesB[bi];
            const sameOther =
              near(ha[(touchAxis + 1) % 3], hb[(touchAxis + 1) % 3]) &&
              near(ha[(touchAxis + 2) % 3], hb[(touchAxis + 2) % 3]);
            if (!sameOther) continue;
            allMatches.push({ ai, bi, ha, hb });
          }
        }
        // Filter to this axis's slot (every 3rd hole).
        const matches = allMatches.filter((_, i) => i % 3 === touchAxis % 3);
        if (matches.length === 0 && allMatches.length > 0) {
          matches.push(allMatches[0]); // fallback for very short overlaps
        }
        // Space equidistantly: at most one bolt per 12" (1 foot).
        const overlapLen = matches.length * SNAP * 3; // ×3 since we took every 3rd
        const maxBolts = Math.max(1, Math.ceil(overlapLen / 12));
        const step = matches.length / maxBolts;
        for (let n = 0; n < maxBolts; n++) {
          const idx = Math.min(Math.round(step * n + step / 2 - 0.5), matches.length - 1);
          if (idx < 0) continue;
          const { ai, bi, ha, hb } = matches[idx];
          if (isOccupiedDifferent(A.id, ai, axL) || isOccupiedDifferent(B.id, bi, axL)) continue;
          const mid = [(ha[0] + hb[0]) / 2, (ha[1] + hb[1]) / 2, (ha[2] + hb[2]) / 2];
          if (addBolt(mid, "beam-beam")) {
            markHole(A.id, ai, axL);
            markHole(B.id, bi, axL);
          }
        }
        continue;
      }

      let matchCount = 0;
      for (let ai = 0; ai < holesA.length; ai++) {
        for (let bi = 0; bi < holesB.length; bi++) {
          const ha = holesA[ai], hb = holesB[bi];
          const sameOther =
            near(ha[(touchAxis + 1) % 3], hb[(touchAxis + 1) % 3]) &&
            near(ha[(touchAxis + 2) % 3], hb[(touchAxis + 2) % 3]);
          if (!sameOther) continue;
          // A hole can only take one bolt — skip if either hole is already
          // occupied by a bolt in a different direction.
          const axLetter = AXIS_LETTER[touchAxis];
          if (isOccupiedDifferent(A.id, ai, axLetter) || isOccupiedDifferent(B.id, bi, axLetter)) continue;
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

  // Panels are attached with screws (not bolts) so they are excluded from
  // the bolt connection list. Corner screw markers are rendered in panel.js.

  return { bolts, boltedHoles };
}
