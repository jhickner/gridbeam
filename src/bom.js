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

export function computeBom(doc, { minimalMode = false, connections = null } = {}) {
  const beams = doc.objects.filter((o) => o.type === "beam");
  const panels = doc.objects.filter((o) => o.type === "panel");
  const { bolts, boltedHoles } = connections || computeConnections(doc);

  const cutList = {};
  for (const b of beams) cutList[b.length] = (cutList[b.length] || 0) + 1;
  const cutRows = Object.entries(cutList)
    .map(([len, qty]) => ({ length: +len, qty }))
    .sort((a, b) => b.length - a.length);

  const panelList = {};
  for (const p of panels) {
    const material = p.material || "plywood";
    const key = `${p.w}x${p.h}:${material}`;
    panelList[key] = panelList[key] || { w: p.w, h: p.h, material, qty: 0 };
    panelList[key].qty++;
  }
  const panelRows = Object.values(panelList).sort((a, b) => b.w * b.h - a.w * a.h);

  const nConn = bolts.length;
  const nScrews = panels.length * 4; // one screw per corner
  const hardware = [
    { item: "Bolt (1/4\"-20, user length)", qty: nConn },
    { item: "Flat washer", qty: nConn },
    { item: "Lock washer", qty: nConn },
    { item: "Hex nut", qty: nConn },
    { item: "Wood screw (panels)", qty: nScrews },
  ];

  // Minimal-mode drilling instructions: grouped by beam length and hole
  // pattern. Each hole is measured as distance from the nearest end and
  // labeled with its face (A or B). For a beam, the two perpendicular
  // drill directions are called face A (first perp axis) and face B
  // (second perp axis), matching the rendering convention:
  //   beam along X → A = Y direction, B = Z direction
  //   beam along Y → A = X direction, B = Z direction
  //   beam along Z → A = X direction, B = Y direction
  let drillingRows = null;
  if (minimalMode) {
    const perpsOf = (axis) => axis === "x" ? ["y", "z"] : axis === "y" ? ["x", "z"] : ["x", "y"];
    const groups = new Map();
    for (const b of beams) {
      const entries = boltedHoles.get(b.id) || new Set();
      const offs = holeOffsets(b.length);
      const perps = perpsOf(b.axis);
      // Collect holes with face labels. If a hole has bolts in both
      // directions, it still needs only one through-hole — mark as "A+B".
      const holeMap = new Map(); // holeIdx → Set<axisLetter>
      for (const e of entries) {
        const [iStr, ax] = e.split("|");
        const i = +iStr;
        if (!holeMap.has(i)) holeMap.set(i, new Set());
        holeMap.get(i).add(ax);
      }
      const holes = [];
      for (const [i, axes] of holeMap) {
        const off = offs[i];
        if (off === undefined) continue;
        // Always measure from the same end (hole-index-0 side).
        const fromStart = +off.toFixed(3);
        const fromEnd = +(b.length - off).toFixed(3);
        const faceLabels = [...axes].map((ax) => ax === perps[0] ? "A" : "B").sort();
        const face = faceLabels.join("+");
        holes.push({ fromStart, fromEnd, face });
      }
      holes.sort((a, b) => a.fromStart - b.fromStart || a.face.localeCompare(b.face));
      const key = b.length + "|" + holes.map((h) => `${h.fromStart}/${h.fromEnd}${h.face}`).join(",");
      if (!groups.has(key)) groups.set(key, { length: b.length, holes, qty: 0 });
      groups.get(key).qty++;
    }
    drillingRows = [...groups.values()].sort((a, b) => b.length - a.length);
  }

  return { cutRows, panelRows, hardware, nConn, fmtIn, drillingRows };
}

// ---------------------------------------------------------------------------
// 2D guillotine bin-packing for panel sheets (4'×8' stock).
// ---------------------------------------------------------------------------
const SHEET_W = 48;   // inches (4')
const SHEET_H = 96;   // inches (8')
// Per-material 4'×8' sheet price — plywood/hardboard and pegboard are
// different stock and shouldn't be packed onto (or costed as) the same sheet.
export const SHEET_PRICES = {
  plywood: 22.52,
  pegboard: 23.98,
  "pegboard-aluminum": 74.99,
  "pegboard-black-aluminum": 84.99,
  wood: 68,
};

// Expand panelRows into individual rectangles, keeping material so callers
// can pack/price each material's sheets separately.
export function expandPanels(panelRows) {
  const out = [];
  for (const r of panelRows) {
    for (let i = 0; i < r.qty; i++) out.push({ w: r.w, h: r.h, material: r.material || "plywood" });
  }
  return out;
}

// Group expanded panels by material — one packPanelSheets() call per group.
export function groupPanelsByMaterial(panels) {
  const groups = new Map();
  for (const p of panels) {
    const material = p.material || "plywood";
    if (!groups.has(material)) groups.set(material, []);
    groups.get(material).push(p);
  }
  return groups;
}

// Try to place a panel (possibly rotated) into one of the available
// free rectangles on a sheet. Uses a guillotine split after placement.
function tryPlace(sheet, pw, ph) {
  let bestIdx = -1, bestArea = Infinity;
  let bestPw = pw, bestPh = ph;
  for (let ri = 0; ri < sheet.rects.length; ri++) {
    const r = sheet.rects[ri];
    for (const [tw, th] of [[pw, ph], [ph, pw]]) {
      if (tw <= r.w + 1e-6 && th <= r.h + 1e-6) {
        const area = r.w * r.h;
        if (area < bestArea) {
          bestArea = area; bestIdx = ri; bestPw = tw; bestPh = th;
        }
      }
    }
  }
  if (bestIdx === -1) return false;
  const r = sheet.rects[bestIdx];
  sheet.cuts.push({ w: bestPw, h: bestPh, x: r.x, y: r.y });
  sheet.rects.splice(bestIdx, 1);

  const remW = r.w - bestPw;
  const remH = r.h - bestPh;

  // After placing a panel in the top-left corner of the free rect, the
  // remaining L-shape must be split into two rectangles. Two options:
  //   A (horizontal): (remW × bestPh) right  + (r.w × remH) bottom
  //   B (vertical):   (remW × r.h)    right  + (bestPw × remH) bottom
  // Pick whichever yields the single largest contiguous piece so leftover
  // material stays usable for future cuts.
  const maxA = Math.max(remW * bestPh, r.w * remH);
  const maxB = Math.max(remW * r.h, bestPw * remH);

  if (maxA >= maxB) {
    // Horizontal split (A): bottom gets full width.
    if (remW > 1e-6) sheet.rects.push({ x: r.x + bestPw, y: r.y, w: remW, h: bestPh });
    if (remH > 1e-6) sheet.rects.push({ x: r.x, y: r.y + bestPh, w: r.w, h: remH });
  } else {
    // Vertical split (B): right gets full height.
    if (remW > 1e-6) sheet.rects.push({ x: r.x + bestPw, y: r.y, w: remW, h: r.h });
    if (remH > 1e-6) sheet.rects.push({ x: r.x, y: r.y + bestPh, w: bestPw, h: remH });
  }
  return true;
}

// Pack a list of {w, h} panels into 4'×8' sheets.
// Returns { sheets: [{ cuts: [{w,h,x,y}] }], totalSheets, totalWaste, oversize: [{w,h}] }
export function packPanelSheets(panels) {
  // Sort by max dimension descending for better packing.
  const sorted = [...panels].sort(
    (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h)
  );
  const sheets = [];
  const oversize = [];

  for (const p of sorted) {
    // Check if it even fits a single sheet (either orientation).
    const fitsSheet =
      (p.w <= SHEET_W + 1e-6 && p.h <= SHEET_H + 1e-6) ||
      (p.h <= SHEET_W + 1e-6 && p.w <= SHEET_H + 1e-6);
    if (!fitsSheet) { oversize.push(p); continue; }

    let placed = false;
    for (const sh of sheets) {
      if (tryPlace(sh, p.w, p.h)) { placed = true; break; }
    }
    if (!placed) {
      const sh = { rects: [{ x: 0, y: 0, w: SHEET_W, h: SHEET_H }], cuts: [] };
      tryPlace(sh, p.w, p.h);
      sheets.push(sh);
    }
  }

  const sheetArea = SHEET_W * SHEET_H;
  let usedArea = 0;
  for (const sh of sheets) {
    for (const c of sh.cuts) usedArea += c.w * c.h;
  }
  const totalWaste = sheets.length * sheetArea - usedArea;
  return { sheets, totalSheets: sheets.length, totalWaste, usedArea, oversize };
}
