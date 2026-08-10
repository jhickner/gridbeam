import { fmtIn } from "./grid.js";

// Identical parts share one label. Every 18" beam is an "A" — the letter names
// the part you cut, not the individual stick, so the cut list, the drilling
// instructions and the assembly steps all point at the same thing.
//
// Order matches how the tables sort: beams longest first, then panels by area.

const MATERIAL_LABEL = {
  plywood: "Hardboard",
  pegboard: "Pegboard",
  "pegboard-aluminum": "Aluminium pegboard",
  "pegboard-black-aluminum": "Black aluminium pegboard",
  wood: "Wood",
};

// A…Z, then AA, AB, … for designs with more than 26 distinct parts.
export function letterAt(i) {
  let s = "";
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export const beamGroupKey = (o) => `beam|${o.length}`;
export const panelGroupKey = (o) => `panel|${o.w}x${o.h}|${o.material || "plywood"}`;

export function computePartLabels(doc) {
  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");

  const groups = [];

  const lengths = [...new Set(beams.map((b) => b.length))].sort((a, b) => b - a);
  for (const L of lengths) {
    groups.push({
      kind: "beam", key: `beam|${L}`, length: L,
      qty: beams.filter((b) => b.length === L).length,
      detail: `${fmtIn(L)} beam`,
    });
  }

  const pmap = new Map();
  for (const p of panels) {
    const k = panelGroupKey(p);
    if (!pmap.has(k)) {
      const mat = p.material || "plywood";
      pmap.set(k, {
        kind: "panel", key: k, w: p.w, h: p.h, material: mat, qty: 0,
        detail: `${MATERIAL_LABEL[mat] || mat} panel ${fmtIn(p.w)} × ${fmtIn(p.h)}`,
      });
    }
    pmap.get(k).qty++;
  }
  groups.push(...[...pmap.values()].sort((a, b) => b.w * b.h - a.w * a.h));

  groups.forEach((g, i) => { g.letter = letterAt(i); });

  const byKey = new Map(groups.map((g) => [g.key, g]));
  const byId = new Map();
  for (const o of beams) byId.set(o.id, byKey.get(beamGroupKey(o)).letter);
  for (const o of panels) byId.set(o.id, byKey.get(panelGroupKey(o)).letter);

  return { groups, byKey, byId };
}
