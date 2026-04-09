import { computeBom, expandCuts } from "./bom.js";
import { fmtIn } from "./grid.js";

export function openExportView(doc, screenshotDataUrl) {
  const { cutRows, panelRows, hardware, nConn } = computeBom(doc);

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
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 820px; margin: 24px auto; color: #222; }
  h1 { margin-bottom: 4px; }
  .meta { color: #777; font-size: 12px; margin-bottom: 20px; }
  h2 { margin-top: 28px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f5f5f5; }
  td.qty, th.qty { text-align: right; width: 80px; }
  img.screenshot { width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .board-row td { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .stock-input { padding: 4px 6px; width: 80px; }
  .summary { background: #f9f9f9; padding: 8px 12px; border-radius: 4px; font-size: 13px; }
  .warn { color: #b00; }
  @media print { body { margin: 12mm; } button, .no-print { display: none; } .stock-input { border: none; padding: 0; } }
  button { margin-left: 8px; padding: 4px 10px; }
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
    Stock board length:
    <input id="stock-in" class="stock-input" type="number" step="1.5" min="3" value="96" />
    inches
    <span style="color:#777;font-size:12px;"> (e.g. 96 = 8', 120 = 10')</span>
  </p>
  <div id="stock-summary" class="summary"></div>
  <table id="stock-table" style="margin-top:10px;">
    <thead><tr><th style="width:70px;">Board</th><th>Cuts</th><th class="qty">Leftover</th></tr></thead>
    <tbody></tbody>
  </table>

  <h2>Panels (1/4" hardboard, max 4×8')</h2>
  <table><thead><tr><th>Size</th><th class="qty">Qty</th></tr></thead><tbody>${panelHtml}</tbody></table>

  <h2>Hardware</h2>
  <p style="color:#666;font-size:12px;">${nConn} bolted connection${nConn === 1 ? "" : "s"} inferred from proximity.</p>
  <table><thead><tr><th>Item</th><th class="qty">Qty</th></tr></thead><tbody>${hwHtml}</tbody></table>

<script>
  const CUTS = ${cutsJson};

  function fmtIn(n) {
    const whole = Math.floor(n);
    const frac = n - whole;
    const h = Math.round(frac * 2);
    if (h === 0) return whole + '"';
    if (h === 1) return whole + ' 1/2"';
    return (whole + 1) + '"';
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

  function render() {
    const stockLen = parseFloat(document.getElementById('stock-in').value);
    const out = document.querySelector('#stock-table tbody');
    const summary = document.getElementById('stock-summary');
    if (!isFinite(stockLen) || stockLen <= 0) {
      out.innerHTML = '';
      summary.textContent = 'Enter a valid stock length.';
      return;
    }
    const plan = planStock(CUTS, stockLen);
    const linFeet = (n) => (n / 12).toFixed(2) + "'";
    const stockFt = linFeet(stockLen);

    const pct = plan.totalBoards ? Math.round((plan.totalCut / (plan.totalBoards * stockLen)) * 100) : 0;
    let s = '<strong>' + plan.totalBoards + '</strong> board' + (plan.totalBoards === 1 ? '' : 's')
          + ' @ ' + fmtIn(stockLen) + ' (' + stockFt + ') · '
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

  document.getElementById('stock-in').addEventListener('input', render);
  render();
</script>
</body></html>`;

  const w = window.open("", "_blank");
  w.document.open();
  w.document.write(html);
  w.document.close();
}
