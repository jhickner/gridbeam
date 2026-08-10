import { fmtIn } from "./grid.js";
import { bbox } from "./state.js";
import { computeConnections } from "./connections.js";
import { fixtureLabel } from "./fixtures.js";

// Turns a finished design into an assembly order.
//
// The order is derived, not authored: parts are added one at a time, always
// choosing one that bolts to something already standing, preferring whatever
// sits lowest. That gives a sequence you can physically build — every part
// after the first has something to bolt to — but it is one valid order out of
// many, not the only right way to put the piece together.

// Lexicographic compare of the mixed number/string sort keys above.
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

const MATERIAL_LABEL = {
  plywood: "Hardboard",
  pegboard: "Pegboard",
  "pegboard-aluminum": "Aluminium pegboard",
  "pegboard-black-aluminum": "Black aluminium pegboard",
  wood: "Wood",
};

function beamRole(o) {
  if (o.tilt) return "rafter";
  return o.axis === "y" ? "upright" : "rail";
}

const ROLE_PREFIX = { upright: "U", rail: "R", rafter: "F" };
const ROLE_NOUN = { upright: "Upright", rail: "Rail", rafter: "Rafter" };

function orientationOf(o) {
  if (o.tilt) return `tilted ${o.tilt > 0 ? "+" : ""}${o.tilt}° in the ${o.axis.toUpperCase()}Y plane`;
  if (o.axis === "y") return "vertical";
  return `horizontal, along ${o.axis.toUpperCase()}`;
}

const at = (p) => `x ${fmtIn(p[0])}, y ${fmtIn(p[1])}, z ${fmtIn(p[2])}`;

function describe(o) {
  if (o.type === "beam") {
    return `${fmtIn(o.length)} beam, ${orientationOf(o)}`;
  }
  if (o.type === "panel") {
    const mat = MATERIAL_LABEL[o.material || "plywood"] || o.material;
    return `${mat} panel ${fmtIn(o.w)} × ${fmtIn(o.h)}, face ${o.normal.toUpperCase()}`;
  }
  return o.type;
}

export function buildAssembly(doc, connections = null) {
  const { bolts } = connections || computeConnections(doc);

  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");
  const extras = doc.objects.filter((o) => o.type === "fixture");

  // Bolt counts per unordered pair, and the adjacency that follows from them.
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairCount = new Map();
  const neighbours = new Map();
  for (const bolt of bolts) {
    if (!bolt.a || !bolt.b || bolt.a === bolt.b) continue;
    const k = pairKey(bolt.a, bolt.b);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
    if (!neighbours.has(bolt.a)) neighbours.set(bolt.a, new Set());
    if (!neighbours.has(bolt.b)) neighbours.set(bolt.b, new Set());
    neighbours.get(bolt.a).add(bolt.b);
    neighbours.get(bolt.b).add(bolt.a);
  }

  // Label every beam by role, numbered bottom-up so U1/R1 are near the floor.
  const lowY = new Map();
  for (const o of doc.objects) lowY.set(o.id, bbox(o)[0][1]);
  const roleCounters = { upright: 0, rail: 0, rafter: 0 };
  const parts = new Map(); // id → { key, role, obj, detail }

  const byHeight = (a, b) => (lowY.get(a.id) - lowY.get(b.id)) || String(a.id).localeCompare(String(b.id));
  for (const o of [...beams].sort(byHeight)) {
    const role = beamRole(o);
    const key = `${ROLE_PREFIX[role]}${++roleCounters[role]}`;
    parts.set(o.id, { key, role, obj: o, detail: describe(o), at: at(o.pos) });
  }
  let panelN = 0;
  for (const o of [...panels].sort(byHeight)) {
    parts.set(o.id, { key: `P${++panelN}`, role: "panel", obj: o, detail: describe(o), at: at(o.pos) });
  }

  // Greedy build order over the beams: prefer a part bolted to what's already
  // standing (most bolts first), then whatever sits lowest. A design in several
  // disconnected pieces restarts from the lowest unplaced part.
  const placed = new Set();
  const order = [];
  const remaining = new Set(beams.map((o) => o.id));

  while (remaining.size) {
    let best = null, bestScore = null;
    for (const id of remaining) {
      const nb = neighbours.get(id) || new Set();
      let joins = 0, boltsToPlaced = 0;
      for (const n of nb) {
        if (placed.has(n)) { joins++; boltsToPlaced += pairCount.get(pairKey(id, n)) || 0; }
      }
      // Sort key: connected-first, then most bolts, then lowest, then stable id.
      const score = [joins > 0 ? 0 : 1, -boltsToPlaced, lowY.get(id), String(id)];
      if (!bestScore || cmp(score, bestScore) < 0) { bestScore = score; best = id; }
    }
    remaining.delete(best);
    placed.add(best);

    const nb = neighbours.get(best) || new Set();
    const joinedTo = [...nb].filter((n) => placed.has(n) && n !== best)
      .map((n) => ({ key: parts.get(n) ? parts.get(n).key : "?", bolts: pairCount.get(pairKey(best, n)) || 0 }))
      .sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));
    order.push({ id: best, joinedTo, bolts: joinedTo.reduce((n, j) => n + j.bolts, 0) });
  }

  const steps = [];
  order.forEach((entry, i) => {
    const part = parts.get(entry.id);
    const noun = ROLE_NOUN[part.role];
    let action;
    if (i === 0) {
      action = `Lay out <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. This is the reference part; everything else is positioned from it.`;
    } else if (!entry.joinedTo.length) {
      action = `Position <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. <em>No bolted connection inferred; set it by measurement.</em>`;
    } else {
      const to = entry.joinedTo.map((j) => `<b>${j.key}</b> (${j.bolts} bolt${j.bolts === 1 ? "" : "s"})`).join(", ");
      action = `${noun} <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. Bolt to ${to}.`;
    }
    steps.push({ id: entry.id, key: part.key, bolts: entry.bolts, html: action });
  });

  // Panels and fixtures go on once the frame stands.
  const panelSteps = [...panels].sort(byHeight).map((o) => {
    const part = parts.get(o.id);
    return { id: o.id, key: part.key, bolts: 0,
      html: `Fit <b>${part.key}</b> — ${part.detail} — at ${at(o.pos)}.` };
  });
  const extraSteps = [...extras].sort(byHeight).map((o) => ({
    id: o.id, key: "", bolts: 0,
    html: `Place ${fixtureLabel(o.kind)} at ${at(o.pos)}. <em>Not part of the build — shown for fit.</em>`,
  }));

  // Parts that had nothing to bolt to when their turn came. The first part is
  // excluded — it starts the build, so of course it joins nothing.
  const stranded = order.slice(1).filter((e) => !e.joinedTo.length);
  // computeConnections skips beams inside a rotated group, so those always land
  // here. Counting them separately keeps the plan from calling a sound design
  // broken.
  const strandedRotated = stranded.filter((e) => {
    const o = parts.get(e.id);
    return o && o.obj.groupRotY;
  }).length;

  return {
    parts: [...parts.values()],
    frameSteps: steps,
    panelSteps,
    extraSteps,
    totalBolts: bolts.length,
    floating: stranded.length,
    floatingRotated: strandedRotated,
  };
}
