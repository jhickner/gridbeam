import { computeBom, expandCuts } from "./bom.js";
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
    <thead><tr><th style="width:70px;">Board</th><th>Cuts</th><th class="qty">Leftover</th></tr></thead>
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

  <h2>Panels (1/4" hardboard, max 4×8')</h2>
  <table><thead><tr><th>Size</th><th class="qty">Qty</th></tr></thead><tbody>${panelHtml}</tbody></table>

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

    const pct = plan.totalBoards ? Math.round((plan.totalCut / (plan.totalBoards * stockLen)) * 100) : 0;
    const totalCost = (plan.totalBoards * unitPrice).toFixed(2);
    let s = '<strong>' + plan.totalBoards + '</strong> × ' + stockFt + ' 2×4'
          + ' @ $' + unitPrice.toFixed(2) + ' = <strong>$' + totalCost + '</strong><br>'
          + 'used ' + linFeet(plan.totalCut) + ' · '
          + 'waste ' + linFeet(plan.totalWaste) + ' · '
          + pct + '% utilization';
    if (plan.overLength.length) {
      s += '<div class="warn">⚠ ' + plan.overLength.length + ' cut(s) exceed stock length: '
        + plan.overLength.map(fmtIn).join(', ') + '</div>';
    }
    summary.innerHTML = s;

    if (!plan.boards.length) { out.innerHTML = '<tr><td colspan="3"><em>no cuts</em></td></tr>'; return; }
    out.innerHTML = plan.boards.map((b, i) =>
      '<tr class="board-row"><td>#' + (i + 1) + '</td>'
      + '<td>' + b.cuts.map(fmtIn).join(' + ') + '</td>'
      + '<td class="qty">' + fmtIn(b.leftover) + '</td></tr>'
    ).join('');
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
