import { computeConnections } from "./connections.js";
import { fmtIn, holeOffsets } from "./grid.js";

// First-Fit-Decreasing bin-packing of cut lengths into stock boards.
// `cuts` is a flat array of individual required lengths (qty already expanded).
// Returns { boards, totalBoards, totalCut, totalWaste, overLength[] }.
// `overLength` lists any cuts that exceed the stock length (can't be made).
export function planStock(cuts, stockLen) {
  const sorted = [...cuts].sort((a, b) => b - a);
  const boards = []; // each: { cuts: [], used: number }
  const overLength = [];
  for (const L of sorted) {
    if (L > stockLen + 1e-9) { overLength.push(L); continue; }
    let placed = false;
    for (const b of boards) {
      if (stockLen - b.used >= L - 1e-9) { b.cuts.push(L); b.used += L; placed = true; break; }
    }
    if (!placed) boards.push({ cuts: [L], used: L });
  }
  let totalCut = 0;
  for (const b of boards) { b.leftover = +(stockLen - b.used).toFixed(3); totalCut += b.used; }
  const totalWaste = +(boards.length * stockLen - totalCut).toFixed(3);
  return { boards, totalBoards: boards.length, totalCut: +totalCut.toFixed(3), totalWaste, overLength };
}

// Expand cutRows into a flat list of individual beam lengths.
export function expandCuts(cutRows) {
  const out = [];
  for (const r of cutRows) for (let i = 0; i < r.qty; i++) out.push(r.length);
  return out;
}

export function computeBom(doc, { minimalMode = false } = {}) {
  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");
  const { bolts, boltedHoles } = computeConnections(doc);

  const cutList = {};
  for (const b of beams) cutList[b.length] = (cutList[b.length] || 0) + 1;
  const cutRows = Object.entries(cutList)
    .map(([len, qty]) => ({ length: +len, qty }))
    .sort((a, b) => b.length - a.length);

  const panelList = {};
  for (const p of panels) {
    const key = `${p.w}x${p.h}`;
    panelList[key] = panelList[key] || { w: p.w, h: p.h, qty: 0 };
    panelList[key].qty++;
  }
  const panelRows = Object.values(panelList).sort((a, b) => b.w * b.h - a.w * a.h);

  const nConn = bolts.length;
  const hardware = [
    { item: "Bolt (1/4\"-20, user length)", qty: nConn },
    { item: "Flat washer", qty: nConn },
    { item: "Lock washer", qty: nConn },
    { item: "Hex nut", qty: nConn },
  ];

  // Minimal-mode drilling instructions: grouped purely by beam length and
  // hole pattern. Each hole is measured as the distance from the nearest
  // end of the beam (since a 2×2 can be flipped end-for-end during layout)
  // and drilling direction is irrelevant — a through-hole in a 2×2 serves
  // any bolt axis. Beams with identical patterns after this normalization
  // are merged into a single row with a qty count.
  let drillingRows = null;
  if (minimalMode) {
    const groups = new Map();
    for (const b of beams) {
      const entries = boltedHoles.get(b.id) || new Set();
      const offs = holeOffsets(b.length);
      // Deduplicate hole indices (multiple bolt axes at the same position
      // collapse into a single drilled hole).
      const indices = new Set();
      for (const e of entries) indices.add(+e.split("|")[0]);
      const holes = [];
      for (const i of indices) {
        const off = offs[i];
        if (off === undefined) continue;
        holes.push(+Math.min(off, b.length - off).toFixed(3));
      }
      holes.sort((a, b) => a - b);
      const key = b.length + "|" + holes.join(",");
      if (!groups.has(key)) groups.set(key, { length: b.length, holes, qty: 0 });
      groups.get(key).qty++;
    }
    drillingRows = [...groups.values()].sort((a, b) => b.length - a.length);
  }

  return { cutRows, panelRows, hardware, nConn, fmtIn, drillingRows };
}
