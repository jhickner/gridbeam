import { computeBom, expandCuts, expandPanels, groupPanelsByMaterial, packPanelSheets, SHEET_PRICES } from "./bom.js";
import { fmtIn } from "./grid.js";
import { buildAssembly } from "./assembly.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function openExportView(doc, screenshotDataUrl, {
  minimalMode = false, title = "", assembly = null, stepImages = null, win = null,
} = {}) {
  const planTitle = title.trim() || "Grid Beam Construction Plan";
  const { cutRows, panelRows, hardware, nConn, drillingRows } = computeBom(doc, { minimalMode });

  const cutHtml = cutRows.length
    ? cutRows.map((r) =>
        `<tr><td class="pl">${r.letter}</td><td>${fmtIn(r.length)}</td><td class="qty">${r.qty}</td></tr>`
      ).join("")
    : `<tr><td colspan="3"><em>none</em></td></tr>`;
  const MATERIAL_LABEL = {
    plywood: 'Hardboard (3/16")',
    pegboard: 'Peg Board (1/8")',
    "pegboard-aluminum": 'Aluminum Peg Board (1/8")',
    "pegboard-black-aluminum": 'Black Aluminum Peg Board (1/8")',
    wood: 'Wood (1/2")',
  };

  // Panel cut list, split into one table per material.
  const panelsByMaterial = new Map();
  for (const r of panelRows) {
    const material = r.material || "plywood";
    if (!panelsByMaterial.has(material)) panelsByMaterial.set(material, []);
    panelsByMaterial.get(material).push(r);
  }
  const panelCutListHtml = panelRows.length
    ? [...panelsByMaterial.entries()].map(([material, rows]) => `
        <h3 style="margin-top:14px;color:#ccc;font-size:14px;">${MATERIAL_LABEL[material] || material}</h3>
        <table><thead><tr><th>Part</th><th>Size</th><th class="qty">Qty</th></tr></thead><tbody>
          ${rows.map((r) =>
            `<tr><td class="pl">${r.letter}</td><td>${fmtIn(r.w)} × ${fmtIn(r.h)}</td><td class="qty">${r.qty}</td></tr>`
          ).join("")}
        </tbody></table>
      `).join("")
    : `<table><tbody><tr><td colspan="2"><em>none</em></td></tr></tbody></table>`;
  const hwHtml = hardware.map((r) => `<tr><td>${r.item}</td><td>${r.qty}</td></tr>`).join("");

  // Flat list of required cuts — consumed by the popup's inline script that
  // re-packs the stock when the user changes the stock-length input.
  const cutsJson = JSON.stringify(expandCuts(cutRows));

  // Panel sheet packing — plywood and pegboard are different stock, so each
  // material is packed (and priced) onto its own set of sheets.
  const allPanels = expandPanels(panelRows);
  const panelGroups = groupPanelsByMaterial(allPanels);

  // Generate SVG cut diagrams + tables for one material's sheet packing.
  // Returns { html, cost } — cost is pulled out separately for the grand total.
  function renderSheetPlan(material, panels) {
    const pack = packPanelSheets(panels);
    const price = SHEET_PRICES[material] ?? SHEET_PRICES.plywood;
    const cost = pack.totalSheets * price;
    const totalCost = cost.toFixed(2);
    const pct = pack.totalSheets
      ? Math.round((pack.usedArea / (pack.totalSheets * 48 * 96)) * 100) : 0;
    let summary = `<strong>${pack.totalSheets}</strong> × 4'×8' sheet`
      + (pack.totalSheets === 1 ? "" : "s")
      + ` @ $${price.toFixed(2)} = <strong>$${totalCost}</strong><br>`
      + `${pct}% utilization`;
    if (pack.oversize.length) {
      summary += `<div class="warn">⚠ ${pack.oversize.length} panel(s) exceed 4'×8' sheet size</div>`;
    }
    // Scale: fit 48"×96" sheet into a reasonable on-screen width.
    const SVG_W = 380;                         // px width of each diagram
    const SCALE = SVG_W / 48;                  // px per inch (sheet short side = width)
    const SVG_H = Math.round(96 * SCALE);      // px height

    // Distinct colors for each cut so they're visually separable.
    const palette = [
      "#5b8fb9", "#b95b5b", "#6db95b", "#b9a05b", "#8f5bb9",
      "#5bb9a8", "#b96a8c", "#7ab95b", "#5b6fb9", "#b98a5b",
    ];

    const sheetDiagrams = pack.sheets.map((sh, si) => {
      let rects = "";
      sh.cuts.forEach((c, ci) => {
        const x = c.x * SCALE;
        const y = c.y * SCALE;
        const w = c.w * SCALE;
        const h = c.h * SCALE;
        const fill = palette[ci % palette.length];
        rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" fill-opacity="0.35" stroke="${fill}" stroke-width="1.5"/>`;
        // Dimension label centered in the rectangle.
        const label = `${fmtIn(c.w)} × ${fmtIn(c.h)}`;
        const cx = x + w / 2, cy = y + h / 2;
        // Only show label if rect is big enough to read.
        if (w > 35 && h > 16) {
          rects += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" `
                +  `fill="#eee" font-size="11" font-family="ui-monospace,Menlo,monospace">${label}</text>`;
        }
      });
      return `
        <div style="margin-top:12px;">
          <div style="color:#aaa;font-size:12px;margin-bottom:4px;">Sheet #${si + 1}
            <span style="color:#666;font-size:11px;">(4' × 8')</span></div>
          <svg width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}"
               style="background:#111;border:1px solid #333;border-radius:4px;">
            ${rects}
            <!-- Sheet outline -->
            <rect x="0" y="0" width="${SVG_W}" height="${SVG_H}" fill="none" stroke="#555" stroke-width="1" stroke-dasharray="4 2"/>
          </svg>
        </div>`;
    }).join("");

    const sheetRows = pack.sheets.map((sh, i) =>
      `<tr class="board-row"><td>#${i + 1}</td><td>${
        sh.cuts.map((c) => `${fmtIn(c.w)} × ${fmtIn(c.h)}`).join(" &nbsp;+&nbsp; ")
      }</td></tr>`
    ).join("");

    const html = `
      <h3 style="margin-top:16px;color:#ccc;font-size:14px;">${MATERIAL_LABEL[material] || material}</h3>
      <div class="summary">${summary}</div>
      <table style="margin-top:10px;">
        <thead><tr><th style="width:70px;">Sheet</th><th>Cuts</th></tr></thead>
        <tbody>${sheetRows}</tbody>
      </table>
      ${sheetDiagrams}
    `;
    return { html, cost };
  }

  let panelStockHtml = "";
  let panelTotalCost = 0;
  if (allPanels.length) {
    const plans = [...panelGroups.entries()].map(([material, panels]) => renderSheetPlan(material, panels));
    panelStockHtml = `<h2>Panel Sheet Plan</h2>` + plans.map((p) => p.html).join("");
    panelTotalCost = plans.reduce((s, p) => s + p.cost, 0);
  }

  // ---- Construction plan ----
  const asm = assembly || buildAssembly(doc);
  // Images arrive in the same order the steps are emitted, so one running
  // index walks all three step lists.
  const imagesByIndex = stepImages || [];
  let imgCursor = 0;
  const stepList = (steps, startAt) =>
    `<ol class="steps" start="${startAt}">` +
    steps.map((s, i) => {
      const img = imagesByIndex[imgCursor++];
      return `<li><div class="step-n">${startAt + i}</div>
                ${img ? `<img class="step-img" src="${img}" alt="">` : ""}
                <div class="step-text">${s.html}</div></li>`;
    }).join("") +
    `</ol>`;

  // One row per distinct part, not per stick — "A × 8", not A1…A8.
  const partsKeyHtml = (asm.groups || []).length
    ? `<table><thead><tr><th>Part</th><th>Description</th><th class="qty">Qty</th></tr></thead><tbody>` +
      asm.groups.map((g) =>
        `<tr><td class="pl">${g.letter}</td><td>${g.detail}</td><td class="qty">× ${g.qty}</td></tr>`
      ).join("") +
      `</tbody></table>`
    : "";

  let stepNo = 1;
  let assemblySections = "";
  if (asm.frameSteps.length) {
    assemblySections += `<h3>Frame</h3>${stepList(asm.frameSteps, stepNo)}`;
    stepNo += asm.frameSteps.length;
  }
  if (asm.panelSteps.length) {
    assemblySections += `<h3>Panels</h3>${stepList(asm.panelSteps, stepNo)}`;
    stepNo += asm.panelSteps.length;
  }
  if (asm.extraSteps.length) {
    assemblySections += `<h3>Fitted items</h3>${stepList(asm.extraSteps, stepNo)}`;
    stepNo += asm.extraSteps.length;
  }

  const assemblyHtml = asm.parts.length
    ? `<p style="color:#888;font-size:12px;">
         ${stepNo - 1} steps. Parts are added in an order where each one bolts to
         something already standing, working from the ground up — one workable
         sequence, not the only one. Cut and drill everything first.
         ${asm.floating > 0
           ? `<br><span style="color:#e0a04a;">${asm.floating} part${asm.floating === 1 ? " has" : "s have"}
              no inferred bolted connection${asm.floatingRotated > 0
                ? ` — ${asm.floatingRotated} of them sit in a rotated group, which the connection finder skips, so those are expected`
                : ""}.</span>`
           : ""}
       </p>
       <h3>Part key</h3>
       ${partsKeyHtml}
       ${assemblySections}`
    : `<p style="color:#666;font-size:12px;">Nothing to assemble yet.</p>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(planTitle)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 820px; margin: 24px auto; padding: 0 16px;
         color: #ddd; background: #1a1a1a; }
  h1 { margin-bottom: 4px; color: #fff; }
  .meta { color: #888; font-size: 12px; margin-bottom: 20px; }
  h2 { margin-top: 28px; border-bottom: 1px solid #333; padding-bottom: 4px; color: #eee; }
  ol.steps { padding: 0; margin: 12px 0 0; list-style: none;
             display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  ol.steps li { margin: 0; line-height: 1.45;
                background: #202020; border: 1px solid #303030; border-radius: 8px; overflow: hidden;
                break-inside: avoid; }
  ol.steps .step-n { padding: 6px 10px; background: #2a2a2a; color: #ff9d2e; font-weight: 700;
                     font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  ol.steps .step-img { display: block; width: 100%; background: #14181c; }
  ol.steps .step-text { padding: 8px 10px; font-size: 12px; color: #ccc; }
  ol.steps b { color: #4acfff; font-family: ui-monospace, Menlo, monospace; }
  ol.steps em { color: #e0a04a; font-style: normal; }
  .pl { color: #ff9d2e; font-weight: 700; font-family: ui-monospace, Menlo, monospace; }

  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  th { background: #242424; color: #aaa; font-weight: normal; }
  td.qty, th.qty { text-align: right; width: 80px; }
  img.screenshot { width: 100%; border: 1px solid #333; border-radius: 4px; }
  .board-row td { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .stock-input { padding: 4px 6px; width: 80px; background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; }
  .summary { background: #222; border: 1px solid #333; padding: 8px 12px; border-radius: 4px; font-size: 13px; }
  .warn { color: #ff6b6b; }
  a { color: #4acfff; }
  button { margin-left: 8px; padding: 4px 10px; background: #333; color: #eee; border: 1px solid #444; border-radius: 3px; cursor: pointer; }
  button:hover { background: #444; }
  /* The screen theme is dark. Printing it drops the background and leaves pale
     text on white paper, so restate the whole document in black on white. */
  @media print {
    :root { color-scheme: light; }
    body { margin: 12mm; background: #fff; color: #000; max-width: none; }
    h1, h2, h3, strong, b { color: #000; }
    h2 { color: #000; border-color: #000; }
    p, .meta, .step-text, td, th, li { color: #000; }
    th, td { border-color: #999; }
    th { background: #eee; color: #000; }
    .summary { background: #f2f2f2; border-color: #999; color: #000; }
    img.screenshot { border-color: #ccc; }
    .stock-input { border: none; padding: 0; background: transparent; color: #000; }
    .pl, ol.steps b { color: #000; }
    ol.steps { grid-template-columns: repeat(2, 1fr); }
    ol.steps li { border: 1px solid #000; background: #fff; }
    /* Matches the screen rule's specificity, which a bare .step-text would not. */
    ol.steps .step-text { color: #000; }
    ol.steps .step-n { background: none; color: #000; border-bottom: 1px solid #000; font-size: 13px; }
    ol.steps em { color: #000; font-style: italic; }
    /* !important is needed here: much of the plan carries an inline colour
       style from the generators, and an inline style outranks any selector. */
    h3, p, div, span, li, td, th, .meta, .pl { color: #000 !important; }
    svg { background: #fff !important; }
    svg text { fill: #000 !important; }
    svg rect, svg circle { stroke: #333 !important; }
    button, .no-print { display: none; }
  }
</style></head>
<body>
  <h1>${esc(planTitle)}</h1>
  <div class="meta">Generated ${new Date().toLocaleString()}
    <button class="no-print" onclick="window.print()">Print</button></div>

  ${screenshotDataUrl ? `<img class="screenshot" src="${screenshotDataUrl}" alt="3D view"/>` : ""}

  <h2>Beam Cut List</h2>
  <table><thead><tr><th>Part</th><th>Length</th><th class="qty">Qty</th></tr></thead>
  <tbody>${cutHtml}</tbody></table>

  <h2>Stock Plan</h2>
  <p>
    Stock board:
    <select id="stock-in" class="stock-input" style="width:auto;">
      <option value="8">8' 2×4 — $3.85</option>
      <option value="10" selected>10' 2×4 — $6.75</option>
      <option value="12">12' 2×4 — $8.12</option>
    </select>
  </p>
  <div id="stock-summary" class="summary"></div>
  <table id="stock-table" style="margin-top:10px;">
    <thead><tr><th style="width:80px;">Board</th><th>Cuts (per 2×2 rail)</th><th class="qty">Leftover</th></tr></thead>
    <tbody></tbody>
  </table>

  ${drillingRows ? `
  <h2>Drilling Instructions (minimal-hole mode)</h2>
  <p style="color:#888;font-size:12px;">
    Each diagram shows a beam from the side. Face 1 holes are on top,
    face 2 holes on the bottom. Mark one face of each beam as face 1 before
    drilling. Letters are the parts from the cut list.
  </p>
  ${drillingRows.length ? drillingRows.map((r) => {
    // SVG diagram: beam shown as a rectangle, holes as circles on face A (top) / face B (bottom).
    const PX_PER_IN = 6;
    const beamW = Math.max(r.length * PX_PER_IN, 60);
    const beamH = 28;
    const padL = 10, padR = 40, padY = 22;
    const svgW = beamW + padL + padR;
    const svgH = beamH + padY * 2;
    const bx = padL, by = padY;
    const holeR = 5;

    const aHoles = r.holes.filter((h) => h.face.includes("1"));
    const bHoles = r.holes.filter((h) => h.face.includes("2"));

    const holeSvg = (holes, cy, color) => holes.map((h) => {
      const cx = bx + (h.fromStart / r.length) * beamW;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${holeR}" fill="${color}" fill-opacity="0.8"/>`
        + `<text x="${cx.toFixed(1)}" y="${cy + (cy < by + beamH / 2 ? -10 : 16)}" text-anchor="middle" fill="#aaa" font-size="9" font-family="ui-monospace,Menlo,monospace">${fmtIn(h.fromStart)}</text>`;
    }).join("");

    return `
      <div style="margin:16px 0;">
        <div style="color:#ccc;font-size:12px;margin-bottom:4px;">
          <span class="pl">${r.letter}${r.variant ? ` (pattern ${r.variant})` : ""}</span>
          <strong>${fmtIn(r.length)}</strong> beam × ${r.qty}
        </div>
        <svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="background:#111;border:1px solid #333;border-radius:4px;">
          <!-- Beam body -->
          <rect x="${bx}" y="${by}" width="${beamW}" height="${beamH}" fill="#6b5030" stroke="#8a6a4a" rx="2"/>
          <!-- Length dimension -->
          <text x="${bx + beamW + 6}" y="${by + beamH / 2 + 4}" fill="#888" font-size="10" font-family="ui-monospace,Menlo,monospace">${fmtIn(r.length)}</text>
          <!-- Face labels -->
          <text x="${bx - 2}" y="${by - 4}" fill="#4acfff" font-size="9" font-family="sans-serif">1</text>
          <text x="${bx - 2}" y="${by + beamH + 12}" fill="#ff8844" font-size="9" font-family="sans-serif">2</text>
          <!-- Face A holes (top edge) -->
          ${holeSvg(aHoles, by, "#4acfff")}
          <!-- Face B holes (bottom edge) -->
          ${holeSvg(bHoles, by + beamH, "#ff8844")}
        </svg>
      </div>`;
  }).join("") : `<p><em>No drilling needed.</em></p>`}
  ` : ""}

  <h2>Panel Cut List</h2>
  ${panelCutListHtml}

  ${panelStockHtml}

  <h2>Hardware</h2>
  <p style="color:#666;font-size:12px;">${nConn} bolted connection${nConn === 1 ? "" : "s"} inferred from proximity.</p>
  <table><thead><tr><th>Item</th><th class="qty">Qty</th></tr></thead><tbody>${hwHtml}</tbody></table>

  <h2>Construction Plan</h2>
  ${assemblyHtml}

  <h2>Total Cost</h2>
  <div id="total-cost-summary" class="summary"></div>
  <p style="color:#666;font-size:12px;margin-top:4px;">Hardware is not priced above and isn't included in this total.</p>

<script>
  const CUTS = ${cutsJson};
  const PANEL_TOTAL_COST = ${panelTotalCost};

  function fmtIn(n) {
    const neg = n < 0 ? '-' : '';
    n = Math.abs(n);
    const whole = Math.floor(n);
    const q = Math.round((n - whole) * 4);
    const w = q === 4 ? whole + 1 : whole;
    const qf = q === 4 ? 0 : q;
    const frac = qf === 0 ? '' : qf === 2 ? ' 1/2' : qf === 1 ? ' 1/4' : ' 3/4';
    const body = w === 0 && frac ? frac.trim() : w + frac;
    return neg + body + '"';
  }

  // First-Fit-Decreasing — identical algorithm to bom.js planStock.
  function planStock(cuts, stockLen) {
    const sorted = [...cuts].sort((a, b) => b - a);
    const boards = [];
    const overLength = [];
    for (const L of sorted) {
      if (L > stockLen + 1e-9) { overLength.push(L); continue; }
      let placed = false;
      for (const b of boards) {
        if (stockLen - b.used >= L - 1e-9) { b.cuts.push(L); b.used += L; placed = true; break; }
      }
      if (!placed) boards.push({ cuts: [L], used: L });
    }
    for (const b of boards) b.leftover = +(stockLen - b.used).toFixed(3);
    const totalCut = boards.reduce((s, b) => s + b.used, 0);
    const totalWaste = +(boards.length * stockLen - totalCut).toFixed(3);
    return { boards, totalBoards: boards.length, totalCut: +totalCut.toFixed(3), totalWaste, overLength };
  }

  // Board length (feet) → unit price. Keep in sync with the select above.
  const PRICES = { 8: 3.85, 10: 6.75, 12: 8.12 };

  function updateTotalCost(lumberCost) {
    const totalEl = document.getElementById('total-cost-summary');
    const grand = lumberCost + PANEL_TOTAL_COST;
    totalEl.innerHTML = 'Lumber $' + lumberCost.toFixed(2)
      + ' + Panels $' + PANEL_TOTAL_COST.toFixed(2)
      + ' = <strong>$' + grand.toFixed(2) + '</strong>';
  }

  function render() {
    const stockFeet = parseFloat(document.getElementById('stock-in').value);
    const out = document.querySelector('#stock-table tbody');
    const summary = document.getElementById('stock-summary');
    if (!isFinite(stockFeet) || stockFeet <= 0) {
      out.innerHTML = '';
      summary.textContent = 'Enter a valid stock length.';
      updateTotalCost(0);
      return;
    }
    const stockLen = stockFeet * 12;
    const unitPrice = PRICES[stockFeet] || 0;
    const plan = planStock(CUTS, stockLen);
    const linFeet = (n) => (n / 12).toFixed(2) + "'";
    const stockFt = stockFeet + "'";

    // Each 2×4 is ripped lengthwise into two 2×2 rails, so each stock
    // board yields 2 rails worth of usable length.
    const totalRails = plan.totalBoards; // bins from FFD = individual 2×2 rails
    const totalBoards = Math.ceil(totalRails / 2); // actual 2×4s to buy
    const totalStock = totalRails * stockLen; // total linear inches of rail
    const pct = totalStock ? Math.round((plan.totalCut / totalStock) * 100) : 0;
    const lumberCost = totalBoards * unitPrice;
    const totalCost = lumberCost.toFixed(2);
    let s = '<strong>' + totalBoards + '</strong> × ' + stockFt + ' 2×4'
          + ' @ $' + unitPrice.toFixed(2) + ' = <strong>$' + totalCost + '</strong>'
          + ' &nbsp;(' + totalRails + ' rail' + (totalRails === 1 ? '' : 's') + ' of 2×2)<br>'
          + 'used ' + linFeet(plan.totalCut) + ' · '
          + 'waste ' + linFeet(totalStock - plan.totalCut) + ' · '
          + pct + '% utilization';
    if (plan.overLength.length) {
      s += '<div class="warn">⚠ ' + plan.overLength.length + ' cut(s) exceed stock length: '
        + plan.overLength.map(fmtIn).join(', ') + '</div>';
    }
    summary.innerHTML = s;
    updateTotalCost(lumberCost);

    if (!plan.boards.length) { out.innerHTML = '<tr><td colspan="3"><em>no cuts</em></td></tr>'; return; }

    // Format each board's cuts, grouping identical lengths.
    function fmtBoardCuts(cuts) {
      const groups = {};
      for (const c of cuts) {
        const k = c.toFixed(3);
        groups[k] = groups[k] || { len: c, qty: 0 };
        groups[k].qty++;
      }
      return Object.values(groups)
        .sort((a, b) => b.len - a.len)
        .map(g => g.qty > 1 ? g.qty + ' × ' + fmtIn(g.len) : fmtIn(g.len))
        .join(', ');
    }

    // Group rails into 2×4 pairs for display.
    var rows = '';
    for (var bi = 0; bi < plan.boards.length; bi += 2) {
      var boardNum = Math.floor(bi / 2) + 1;
      var b1 = plan.boards[bi];
      var b2 = plan.boards[bi + 1];
      rows += '<tr class="board-row" style="border-top:1px solid #444;">'
        + '<td rowspan="' + (b2 ? 2 : 1) + '">2×4 #' + boardNum + '</td>'
        + '<td>' + fmtBoardCuts(b1.cuts) + '</td>'
        + '<td class="qty">' + fmtIn(b1.leftover) + '</td></tr>';
      if (b2) {
        rows += '<tr class="board-row">'
          + '<td>' + fmtBoardCuts(b2.cuts) + '</td>'
          + '<td class="qty">' + fmtIn(b2.leftover) + '</td></tr>';
      }
    }
    out.innerHTML = rows;
  }

  document.getElementById('stock-in').addEventListener('change', render);
  render();
</script>
</body></html>`;

  // Callers that need to render first pass a window they opened during the
  // click itself — opening one after an await trips popup blockers.
  const w = win || window.open("", "_blank");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
