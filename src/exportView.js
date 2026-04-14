import { computeBom, expandCuts, expandPanels, packPanelSheets, SHEET_PRICE } from "./bom.js";
import { fmtIn } from "./grid.js";

export function openExportView(doc, screenshotDataUrl, { minimalMode = false } = {}) {
  const { cutRows, panelRows, hardware, nConn, drillingRows } = computeBom(doc, { minimalMode });

  const cutHtml = cutRows.length
    ? cutRows.map((r) => `<tr><td>${fmtIn(r.length)}</td><td>${r.qty}</td></tr>`).join("")
    : `<tr><td colspan="2"><em>none</em></td></tr>`;
  const panelHtml = panelRows.length
    ? panelRows.map((r) => `<tr><td>${fmtIn(r.w)} × ${fmtIn(r.h)}</td><td>${r.qty}</td></tr>`).join("")
    : `<tr><td colspan="2"><em>none</em></td></tr>`;
  const hwHtml = hardware.map((r) => `<tr><td>${r.item}</td><td>${r.qty}</td></tr>`).join("");

  // Flat list of required cuts — consumed by the popup's inline script that
  // re-packs the stock when the user changes the stock-length input.
  const cutsJson = JSON.stringify(expandCuts(cutRows));

  // Panel sheet packing.
  const allPanels = expandPanels(panelRows);
  const panelPack = packPanelSheets(allPanels);
  let panelStockHtml = "";
  if (allPanels.length) {
    const totalCost = (panelPack.totalSheets * SHEET_PRICE).toFixed(2);
    const pct = panelPack.totalSheets
      ? Math.round((panelPack.usedArea / (panelPack.totalSheets * 48 * 96)) * 100) : 0;
    let summary = `<strong>${panelPack.totalSheets}</strong> × 4'×8' sheet`
      + (panelPack.totalSheets === 1 ? "" : "s")
      + ` @ $${SHEET_PRICE.toFixed(2)} = <strong>$${totalCost}</strong><br>`
      + `${pct}% utilization`;
    if (panelPack.oversize.length) {
      summary += `<div class="warn">⚠ ${panelPack.oversize.length} panel(s) exceed 4'×8' sheet size</div>`;
    }
    // Generate SVG cut diagrams for each sheet.
    // Scale: fit 48"×96" sheet into a reasonable on-screen width.
    const SVG_W = 380;                         // px width of each diagram
    const SCALE = SVG_W / 48;                  // px per inch (sheet short side = width)
    const SVG_H = Math.round(96 * SCALE);      // px height

    // Distinct colors for each cut so they're visually separable.
    const palette = [
      "#5b8fb9", "#b95b5b", "#6db95b", "#b9a05b", "#8f5bb9",
      "#5bb9a8", "#b96a8c", "#7ab95b", "#5b6fb9", "#b98a5b",
    ];

    const sheetDiagrams = panelPack.sheets.map((sh, si) => {
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

    const sheetRows = panelPack.sheets.map((sh, i) =>
      `<tr class="board-row"><td>#${i + 1}</td><td>${
        sh.cuts.map((c) => `${fmtIn(c.w)} × ${fmtIn(c.h)}`).join(" &nbsp;+&nbsp; ")
      }</td></tr>`
    ).join("");

    panelStockHtml = `
      <h2>Panel Sheet Plan</h2>
      <div class="summary">${summary}</div>
      <table style="margin-top:10px;">
        <thead><tr><th style="width:70px;">Sheet</th><th>Cuts</th></tr></thead>
        <tbody>${sheetRows}</tbody>
      </table>
      ${sheetDiagrams}
    `;
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Grid Beam Plan</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 820px; margin: 24px auto; padding: 0 16px;
         color: #ddd; background: #1a1a1a; }
  h1 { margin-bottom: 4px; color: #fff; }
  .meta { color: #888; font-size: 12px; margin-bottom: 20px; }
  h2 { margin-top: 28px; border-bottom: 1px solid #333; padding-bottom: 4px; color: #eee; }
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
  @media print {
    :root { color-scheme: light; }
    body { margin: 12mm; background: #fff; color: #222; }
    h1 { color: #000; }
    h2 { color: #000; border-color: #ddd; }
    th, td { border-color: #eee; }
    th { background: #f5f5f5; color: #555; }
    .summary { background: #f9f9f9; border-color: #ddd; }
    img.screenshot { border-color: #ccc; }
    .stock-input { border: none; padding: 0; background: transparent; color: #000; }
    button, .no-print { display: none; }
  }
</style></head>
<body>
  <h1>Grid Beam Construction Plan</h1>
  <div class="meta">Generated ${new Date().toLocaleString()}
    <button class="no-print" onclick="window.print()">Print</button></div>

  ${screenshotDataUrl ? `<img class="screenshot" src="${screenshotDataUrl}" alt="3D view"/>` : ""}

  <h2>Beam Cut List</h2>
  <table><thead><tr><th>Length</th><th class="qty">Qty</th></tr></thead><tbody>${cutHtml}</tbody></table>

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
    Each hole is a single through-hole drilled perpendicular to the length of
    the 2×2. Positions are measured from the nearest end of the beam, so the
    beam can be oriented either way during assembly.
  </p>
  <table>
    <thead><tr>
      <th style="width:70px;">Length</th>
      <th class="qty" style="width:50px;">Qty</th>
      <th>Holes (from nearest end)</th>
    </tr></thead>
    <tbody>
      ${drillingRows.length ? drillingRows.map((r) => `
        <tr>
          <td>${fmtIn(r.length)}</td>
          <td class="qty">${r.qty}</td>
          <td>${r.holes.length
            ? r.holes.map(fmtIn).join(" &nbsp; · &nbsp; ")
            : "<em>no holes (not bolted to anything)</em>"}</td>
        </tr>
      `).join("") : `<tr><td colspan="3"><em>none</em></td></tr>`}
    </tbody>
  </table>
  ` : ""}

  <h2>Panel Cut List (1/4" hardboard)</h2>
  <table><thead><tr><th>Size</th><th class="qty">Qty</th></tr></thead><tbody>${panelHtml}</tbody></table>

  ${panelStockHtml}

  <h2>Hardware</h2>
  <p style="color:#666;font-size:12px;">${nConn} bolted connection${nConn === 1 ? "" : "s"} inferred from proximity.</p>
  <table><thead><tr><th>Item</th><th class="qty">Qty</th></tr></thead><tbody>${hwHtml}</tbody></table>

<script>
  const CUTS = ${cutsJson};

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

  function render() {
    const stockFeet = parseFloat(document.getElementById('stock-in').value);
    const out = document.querySelector('#stock-table tbody');
    const summary = document.getElementById('stock-summary');
    if (!isFinite(stockFeet) || stockFeet <= 0) {
      out.innerHTML = '';
      summary.textContent = 'Enter a valid stock length.';
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
    const totalCost = (totalBoards * unitPrice).toFixed(2);
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

  const w = window.open("", "_blank");
  w.document.open();
  w.document.write(html);
  w.document.close();
}
