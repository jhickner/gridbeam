import { fmtIn } from "./grid.js";
import { bbox } from "./state.js";
import { computeConnections } from "./connections.js";
import { computePartLabels } from "./partLabels.js";

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

const ROLE_NOUN = { upright: "Upright", rail: "Rail", rafter: "Rafter" };
const EMPTY = new Set();

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

  // Fixtures and book rows are cosmetic — they show scale in the editor and
  // are not built, so they stay out of the plan and out of its diagrams.
  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");

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

  // Identical parts share a letter — the label names the cut, not the stick,
  // so it matches the cut list and drilling instructions.
  const labels = computePartLabels(doc);
  const lowY = new Map();
  for (const o of doc.objects) lowY.set(o.id, bbox(o)[0][1]);
  const parts = new Map(); // id → { key, role, obj, detail }

  const byHeight = (a, b) => (lowY.get(a.id) - lowY.get(b.id)) || String(a.id).localeCompare(String(b.id));
  for (const o of [...beams].sort(byHeight)) {
    parts.set(o.id, {
      key: labels.byId.get(o.id), role: beamRole(o), obj: o,
      detail: describe(o), at: at(o.pos),
    });
  }
  for (const o of [...panels].sort(byHeight)) {
    parts.set(o.id, {
      key: labels.byId.get(o.id), role: "panel", obj: o,
      detail: describe(o), at: at(o.pos),
    });
  }

  // Greedy build order, ordered by what will physically stand up while you
  // work on it. A part holds itself if it sits on the ground, or if the bolts
  // already holding it straddle its own centre — a rail spanning two uprights
  // stands, but two bolts clustered at one end leave the rest of it hanging in
  // the air, and someone has to hold that. Counting joints is not enough: what
  // matters is where along the part they land.
  //
  // Bracing an end that is already hanging outranks everything else, so the
  // build never accumulates loose ends waiting on each other.
  const GROUND = 0.05;
  // Bolts must span at least this fraction of the part to brace it rather than
  // just pivot it.
  const SPAN = 0.25;

  // Each part's long axis, and every bolt on it projected onto that axis. The
  // longest bbox side is the long axis — true for tilted beams too, since a
  // tilt never turns a beam's length into its shortest side.
  const support = new Map();
  for (const o of [...beams, ...panels]) {
    const [mn, mx] = bbox(o);
    let k = 0;
    for (let i = 1; i < 3; i++) if (mx[i] - mn[i] > mx[k] - mn[k]) k = i;
    support.set(o.id, { k, mid: (mn[k] + mx[k]) / 2, ext: mx[k] - mn[k], at: [] });
  }
  for (const bolt of bolts) {
    if (!bolt.a || !bolt.b || bolt.a === bolt.b) continue;
    for (const [self, other] of [[bolt.a, bolt.b], [bolt.b, bolt.a]]) {
      const s = support.get(self);
      if (s) s.at.push({ other, p: bolt.pos[s.k] });
    }
  }

  const standsAlone = (id, placedSet) => {
    if (lowY.get(id) <= GROUND) return true;
    const s = support.get(id);
    if (!s) return false;
    let lo = Infinity, hi = -Infinity;
    for (const b of s.at) {
      if (!placedSet.has(b.other)) continue;
      if (b.p < lo) lo = b.p;
      if (b.p > hi) hi = b.p;
    }
    return lo <= s.mid && hi >= s.mid && hi - lo >= SPAN * s.ext;
  };

  const placed = new Set();
  const order = [];
  const remaining = new Set(beams.map((o) => o.id));
  const hanging = new Set(); // placed, but still cantilevered

  while (remaining.size) {
    let best = null, bestScore = null, bestFixes = [];
    for (const id of remaining) {
      const nb = neighbours.get(id) || EMPTY;
      let joins = 0, boltsToPlaced = 0;
      for (const n of nb) {
        if (placed.has(n)) { joins++; boltsToPlaced += pairCount.get(pairKey(id, n)) || 0; }
      }
      let fixes = [];
      if (hanging.size) {
        const after = new Set(placed).add(id);
        for (const w of hanging) if (standsAlone(w, after)) fixes.push(w);
      }
      // Nothing placed yet: start on the ground, best connected, lowest.
      const score = [
        hanging.size && !fixes.length ? 1 : 0, // brace what is already hanging
        -fixes.length,
        standsAlone(id, placed) ? 0 : 1,
        joins > 0 || placed.size === 0 ? 0 : 1, // don't strand a piece if we can help it
        -joins,
        -boltsToPlaced,
        lowY.get(id),
        String(id),
      ];
      if (!bestScore || cmp(score, bestScore) < 0) { bestScore = score; best = id; bestFixes = fixes; }
    }
    remaining.delete(best);
    placed.add(best);
    for (const w of bestFixes) hanging.delete(w);

    const nb = neighbours.get(best) || new Set();
    const perLetter = new Map();
    for (const n of nb) {
      if (!placed.has(n) || n === best) continue;
      const key = parts.get(n) ? parts.get(n).key : "?";
      const e = perLetter.get(key) || { key, count: 0, bolts: 0 };
      e.count++;
      e.bolts += pairCount.get(pairKey(best, n)) || 0;
      perLetter.set(key, e);
    }
    const joinedTo = [...perLetter.values()]
      .sort((x, y) => x.key.localeCompare(y.key, undefined, { numeric: true }));

    const needsSupport = placed.size > 1 && joinedTo.length > 0 && !standsAlone(best, placed);
    // Only chase a hanging end that something still to come can actually brace.
    // A design with a genuine permanent cantilever would otherwise leave the
    // set non-empty forever, switching the bracing priority off for good.
    if (needsSupport &&
        [...remaining].some((rid) => standsAlone(best, new Set(placed).add(rid)))) {
      hanging.add(best);
    }

    order.push({
      id: best, joinedTo, needsSupport, braces: bestFixes,
      bolts: joinedTo.reduce((n, j) => n + j.bolts, 0),
    });
  }

  const steps = [];
  order.forEach((entry, i) => {
    const part = parts.get(entry.id);
    const noun = ROLE_NOUN[part.role];
    let action;
    if (i === 0) {
      action = `Lay out <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. This is the reference part; everything else is positioned from it.`;
    } else if (!entry.joinedTo.length && !(neighbours.get(entry.id) || EMPTY).size) {
      action = `Position <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. <em>No bolted connection inferred; set it by measurement.</em>`;
    } else if (!entry.joinedTo.length) {
      // Bolts to parts that come later — typically another leg going down on
      // the ground before anything spans them.
      action = `Stand <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. It bolts to parts added further on.`;
    } else {
      const to = entry.joinedTo.map((j) =>
        `${j.count > 1 ? `${j.count}× ` : ""}<b>${j.key}</b> (${j.bolts} bolt${j.bolts === 1 ? "" : "s"})`
      ).join(", ");
      action = `${noun} <b>${part.key}</b> — ${part.detail} — at ${at(part.obj.pos)}. Bolt to ${to}.`;
    }
    if (entry.braces.length) {
      const keys = [...new Set(entry.braces.map((b) => (parts.get(b) || { key: "?" }).key))]
        .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      action += ` This braces <b>${keys.join("</b>, <b>")}</b> — no need to hold it any longer.`;
    }
    // Bolts clustered at one end are a pivot, not a joint — say so, because the
    // next step is what actually makes it rigid.
    if (entry.needsSupport && entry.joinedTo.length) {
      action += ` <em>Bolted at one end only — hold or prop the free end until the next part goes on.</em>`;
    }
    steps.push({
      id: entry.id, key: part.key, bolts: entry.bolts,
      needsSupport: entry.needsSupport, braces: entry.braces.length, html: action,
    });
  });

  // Panels go on once the frame stands.
  const panelSteps = [...panels].sort(byHeight).map((o) => {
    const part = parts.get(o.id);
    return { id: o.id, key: part.key, bolts: 0,
      html: `Fit <b>${part.key}</b> — ${part.detail} — at ${at(o.pos)}.` };
  });
  // Parts with no bolted connection anywhere in the model. This has to be a
  // property of the connection graph, not of placement order — legs standing
  // on the ground join nothing at the moment they go down, and are fine.
  const stranded = order.filter((e) => !(neighbours.get(e.id) || EMPTY).size);
  // computeConnections skips beams inside a rotated group, so those always land
  // here. Counting them separately keeps the plan from calling a sound design
  // broken.
  const strandedRotated = stranded.filter((e) => {
    const o = parts.get(e.id);
    return o && o.obj.groupRotY;
  }).length;

  return {
    parts: [...parts.values()],
    groups: labels.groups,
    frameSteps: steps,
    panelSteps,
    totalBolts: bolts.length,
    floating: stranded.length,
    floatingRotated: strandedRotated,
  };
}
