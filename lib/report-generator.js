'use strict';
/**
 * report-generator.js
 * ─────────────────────────────────────────────────────────────
 * Generates distinctly different reports per type:
 *   oee     → OEE waterfall + shift breakdown + stop analysis
 *   energy  → Per-meter kW / kWh / PF / Voltage table + totals
 *   water   → Per-meter flow + daily totals + consumption
 *   machine → Per-machine health: vib/temp/bearing/current/status
 *   shift   → Shift vs shift KPI comparison
 *   custom  → User-selected columns with custom header/footer
 *
 * Output formats: Excel (.xlsx) | HTML (print-ready)
 */

const ExcelJS = require('exceljs');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const f1  = v => v != null ? parseFloat(v).toFixed(1)  : '—';
const f2  = v => v != null ? parseFloat(v).toFixed(2)  : '—';
const f0  = v => v != null ? parseInt(v).toLocaleString() : '—';
const pct = v => v != null ? parseFloat(v).toFixed(1) + '%' : '—';

function oeeColor(v) {
  const n = parseFloat(v);
  return n >= 80 ? '#166534' : n >= 65 ? '#92400e' : '#991b1b';
}
function oeeBg(v) {
  const n = parseFloat(v);
  return n >= 80 ? '#dcfce7' : n >= 65 ? '#fef3c7' : '#fee2e2';
}
function statusColor(s) {
  if (!s) return '#1e293b';
  s = s.toUpperCase();
  return s === 'OK' ? '#166534' : s === 'WARN' || s === 'WARNING' ? '#92400e' : '#991b1b';
}
function statusBg(s) {
  if (!s) return '#f8fafc';
  s = s.toUpperCase();
  return s === 'OK' ? '#dcfce7' : s === 'WARN' || s === 'WARNING' ? '#fef3c7' : '#fee2e2';
}

// ─────────────────────────────────────────────────────────────
// SHARED EXCEL STYLES
// ─────────────────────────────────────────────────────────────
const DARK  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1B3A5C' } };
const BLUE  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2563EB' } };
const ALT   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF8FAFC' } };
const GREEN = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFDCFCE7' } };
const AMBER = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEF3C7' } };
const RED   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEE2E2' } };
const WH    = { color:{ argb:'FFFFFFFF' }, bold:true, size:11 };
const BORDER = { top:{style:'thin',color:{argb:'FFE2E8F0'}}, bottom:{style:'thin',color:{argb:'FFE2E8F0'}}, left:{style:'thin',color:{argb:'FFE2E8F0'}}, right:{style:'thin',color:{argb:'FFE2E8F0'}} };

function excelOeeFill(v) { const n=parseFloat(v); return n>=80?GREEN:n>=65?AMBER:RED; }
function addSheetHeader(ws, title, subtitle, meta, cols) {
  ws.addRow([]);
  const r1 = ws.addRow([`  ${title}`]);
  r1.height = 28;
  r1.getCell(1).font  = { bold:true, size:14, color:{ argb:'FF1B3A5C' } };
  r1.getCell(1).fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE0F2FE' } };
  ws.mergeCells(`A${r1.number}:${colLetter(cols)}${r1.number}`);

  const r2 = ws.addRow([`  ${subtitle}`]);
  r2.getCell(1).font  = { size:10, color:{ argb:'FF64748B' } };
  ws.mergeCells(`A${r2.number}:${colLetter(cols)}${r2.number}`);

  const r3 = ws.addRow([`  Plant: ${meta.plant_name||'All'} | Period: ${meta.from?.slice(0,10)||''} → ${meta.to?.slice(0,10)||''} | Generated: ${new Date().toLocaleString('en-IN')}`]);
  r3.getCell(1).font = { size:9, italic:true, color:{ argb:'FF94A3B8' } };
  ws.mergeCells(`A${r3.number}:${colLetter(cols)}${r3.number}`);
  ws.addRow([]);
}
function colLetter(n) { return String.fromCharCode(64 + Math.min(n, 26)); }
function addHeaderRow(ws, headers) {
  const r = ws.addRow(headers);
  r.eachCell(c => { c.fill=DARK; c.font=WH; c.border=BORDER; c.alignment={vertical:'middle',wrapText:true}; });
  r.height = 22;
  return r;
}
function addDataRow(ws, values, alt=false, fills=[]) {
  const r = ws.addRow(values);
  r.eachCell((c,i) => {
    c.fill   = fills[i-1] || (alt ? ALT : { type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'} });
    c.border = BORDER;
    c.alignment = { vertical:'middle' };
  });
  return r;
}

// ─────────────────────────────────────────────────────────────
// HTML SHELL
// ─────────────────────────────────────────────────────────────
function htmlShell(title, body, meta, config={}) {
  const co    = config.company   || 'Factory-MIOS';
  const logo  = config.logo_text || 'Factory-MIOS';
  const foot  = config.footer_note || '';
  const ts    = config.show_timestamp !== false;
  const plant = meta.plant_name || 'All Plants';
  const period= `${meta.from?.slice(0,10)||''} to ${meta.to?.slice(0,10)||''}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${title} — ${plant}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;font-size:12px;background:#fff;}
  .page{max-width:1140px;margin:0 auto;padding:24px 32px;}

  /* HEADER */
  .rpt-header{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:3px solid #1B3A5C;padding-bottom:16px;margin-bottom:20px;}
  .rpt-logo{font-size:20px;font-weight:800;color:#1B3A5C;letter-spacing:.3px;}
  .rpt-logo span{color:#2563EB;}
  .rpt-company{font-size:11px;color:#64748B;margin-top:3px;}
  .rpt-title-area{text-align:right;}
  .rpt-title{font-size:18px;font-weight:700;color:#1B3A5C;}
  .rpt-sub{font-size:11px;color:#64748B;margin-top:4px;}
  .rpt-period{font-size:11px;color:#2563EB;margin-top:2px;font-weight:600;}

  /* STAT BOXES */
  .stat-grid{display:grid;gap:12px;margin-bottom:20px;}
  .stat-grid.cols4{grid-template-columns:repeat(4,1fr);}
  .stat-grid.cols5{grid-template-columns:repeat(5,1fr);}
  .stat-grid.cols3{grid-template-columns:repeat(3,1fr);}
  .stat-box{border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;}
  .stat-box .sb-icon{font-size:20px;margin-bottom:4px;}
  .stat-box .sb-val{font-size:24px;font-weight:800;color:#1B3A5C;line-height:1.1;}
  .stat-box .sb-label{font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:.5px;margin-top:3px;}
  .stat-box .sb-sub{font-size:10px;color:#94a3b8;margin-top:2px;}

  /* SECTION */
  .section{margin-bottom:24px;}
  .section-title{font-size:13px;font-weight:700;color:#1B3A5C;border-left:4px solid #2563EB;padding-left:10px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;}
  .section-title span{font-size:10px;color:#94a3b8;font-weight:400;}

  /* TABLES */
  table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px;}
  thead th{background:#1B3A5C;color:#fff;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:700;}
  tbody td{padding:7px 10px;border-bottom:1px solid #f1f5f9;}
  tbody tr:nth-child(even) td{background:#f8fafc;}
  tbody tr:hover td{background:#eff6ff;}
  .td-right{text-align:right;}
  .td-center{text-align:center;}
  .td-bold{font-weight:700;}

  /* STATUS BADGE */
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;}
  .badge-ok  {background:#dcfce7;color:#166534;}
  .badge-warn{background:#fef3c7;color:#92400e;}
  .badge-alert{background:#fee2e2;color:#991b1b;}

  /* OEE BAR */
  .oee-bar-wrap{background:#f1f5f9;border-radius:4px;height:8px;overflow:hidden;margin-top:3px;}
  .oee-bar{height:100%;border-radius:4px;}

  /* WATERFALL */
  .wf-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:20px;}
  .wf-box{border-radius:8px;padding:14px 10px;text-align:center;}
  .wf-box .wf-val{font-size:22px;font-weight:800;}
  .wf-box .wf-label{font-size:10px;margin-top:4px;font-weight:600;}
  .wf-box .wf-sub{font-size:9px;margin-top:2px;opacity:.7;}

  /* METER GRID */
  .meter-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px;}
  .meter-box{border:1px solid #e2e8f0;border-radius:8px;padding:12px;background:#f8fafc;}
  .meter-box .mb-id{font-size:10px;font-weight:700;color:#64748B;margin-bottom:6px;}
  .meter-box .mb-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f1f5f9;}
  .meter-box .mb-row:last-child{border:none;}
  .meter-box .mb-key{font-size:10px;color:#94a3b8;}
  .meter-box .mb-val{font-size:11px;font-weight:700;color:#1B3A5C;}

  /* MACHINE GRID */
  .machine-grid{display:grid;grid-template-columns:repeat(1,1fr);gap:12px;}
  .machine-card{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;}
  .machine-card .mc-header{background:#1B3A5C;color:#fff;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;}
  .machine-card .mc-id{font-size:12px;font-weight:700;}
  .machine-card .mc-body{padding:10px 14px;}
  .machine-card .mc-params{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;}
  .mc-param .mcp-label{font-size:9px;color:#94a3b8;text-transform:uppercase;}
  .mc-param .mcp-val{font-size:14px;font-weight:700;color:#1B3A5C;margin-top:2px;}

  /* FOOTER */
  .rpt-footer{margin-top:24px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8;}

  /* TIMESTAMP WATERMARK */
  .ts-watermark{position:fixed;bottom:8px;right:8px;font-size:8px;color:#cbd5e1;font-style:italic;}

  @media print{
    body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}
    .page{padding:12px 16px;}
    .no-print{display:none;}
    thead{display:table-header-group;}
  }
</style>
</head>
<body>
<div class="page">

  <div class="rpt-header">
    <div>
      <div class="rpt-logo">${logo.replace('OEE','OEE<span>')}.Platform</div>
      <div class="rpt-company">${co}</div>
    </div>
    <div class="rpt-title-area">
      <div class="rpt-title">${title}</div>
      <div class="rpt-sub">Plant: <strong>${plant}</strong></div>
      <div class="rpt-period">${period}</div>
    </div>
  </div>

  ${body}

  <div class="rpt-footer">
    <span>${co} — Confidential</span>
    <span>${foot}</span>
    ${ts ? `<span>Generated: ${new Date().toLocaleString('en-IN')}</span>` : ''}
  </div>
</div>
${ts ? `<div class="ts-watermark">Generated ${new Date().toISOString()}</div>` : ''}
<script>if(location.search.includes('print=1'))setTimeout(()=>window.print(),400);<\/script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// OEE REPORT
// ─────────────────────────────────────────────────────────────
function buildOEEHTML({ rows, shiftRows, summary, meta, config }) {
  const s = summary;
  const oeeVal = f1(s.avg_oee);
  const avail  = f1(s.avg_availability);
  const perf   = f1(s.avg_performance);
  const qual   = f1(s.avg_quality);

  // OEE Waterfall boxes
  const wf = `
  <div class="section">
    <div class="section-title">OEE Waterfall</div>
    <div class="wf-grid">
      <div class="wf-box" style="background:#eff6ff;">
        <div class="wf-val" style="color:#1B3A5C;">100%</div>
        <div class="wf-label" style="color:#1B3A5C;">Ideal</div>
        <div class="wf-sub">Planned capacity</div>
      </div>
      <div class="wf-box" style="background:${oeeBg(avail)};">
        <div class="wf-val" style="color:${oeeColor(avail)};">${avail}%</div>
        <div class="wf-label" style="color:${oeeColor(avail)};">Availability</div>
        <div class="wf-sub">Loss: ${f1(100-parseFloat(avail||0))}%</div>
      </div>
      <div class="wf-box" style="background:${oeeBg(perf)};">
        <div class="wf-val" style="color:${oeeColor(perf)};">${perf}%</div>
        <div class="wf-label" style="color:${oeeColor(perf)};">Performance</div>
        <div class="wf-sub">Loss: ${f1(100-parseFloat(perf||0))}%</div>
      </div>
      <div class="wf-box" style="background:${oeeBg(qual)};">
        <div class="wf-val" style="color:${oeeColor(qual)};">${qual}%</div>
        <div class="wf-label" style="color:${oeeColor(qual)};">Quality</div>
        <div class="wf-sub">Loss: ${f1(100-parseFloat(qual||0))}%</div>
      </div>
      <div class="wf-box" style="background:${oeeBg(s.avg_oee)};">
        <div class="wf-val" style="color:${oeeColor(s.avg_oee)};font-size:28px;">${oeeVal}%</div>
        <div class="wf-label" style="color:${oeeColor(s.avg_oee)};font-size:13px;">OEE</div>
        <div class="wf-sub">A×P×Q/10000</div>
      </div>
    </div>
  </div>`;

  const stats = `
  <div class="stat-grid cols4">
    <div class="stat-box"><div class="sb-icon">✅</div><div class="sb-val" style="color:#166534;">${f0(s.total_good)}</div><div class="sb-label">Good Parts</div></div>
    <div class="stat-box"><div class="sb-icon">❌</div><div class="sb-val" style="color:#991b1b;">${f0(s.total_scrap)}</div><div class="sb-label">Scrap Parts</div><div class="sb-sub">Quality loss</div></div>
    <div class="stat-box"><div class="sb-icon">⛔</div><div class="sb-val" style="color:#92400e;">${f0(s.total_stops)}</div><div class="sb-label">Total Stops</div></div>
    <div class="stat-box"><div class="sb-icon">📊</div><div class="sb-val">${f0(s.readings)}</div><div class="sb-label">Readings</div></div>
  </div>`;

  const shiftTable = shiftRows?.length ? `
  <div class="section">
    <div class="section-title">Shift-wise OEE Comparison <span>${shiftRows.length} shifts</span></div>
    <table>
      <thead><tr><th>Shift</th><th>OEE %</th><th>Availability</th><th>Performance</th><th>Quality</th><th>Good Parts</th><th>Scrap</th><th>Stops</th><th>Readings</th></tr></thead>
      <tbody>
        ${shiftRows.map((r,i)=>`<tr>
          <td class="td-bold">${r.shift||'—'}</td>
          <td style="background:${oeeBg(r.avg_oee)};color:${oeeColor(r.avg_oee)};font-weight:700;">${pct(r.avg_oee)}
            <div class="oee-bar-wrap"><div class="oee-bar" style="width:${r.avg_oee||0}%;background:${oeeColor(r.avg_oee)};"></div></div>
          </td>
          <td>${pct(r.avg_availability)}</td>
          <td>${pct(r.avg_performance)}</td>
          <td>${pct(r.avg_quality)}</td>
          <td style="color:#166534;font-weight:600;">${f0(r.total_good)}</td>
          <td style="color:#991b1b;">${f0(r.total_scrap)}</td>
          <td style="color:#92400e;">${f0(r.total_stops)}</td>
          <td class="td-center">${r.readings}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  const hourly = rows?.length ? `
  <div class="section">
    <div class="section-title">Hourly OEE Trend <span>Last 24 readings</span></div>
    <table>
      <thead><tr><th>Timestamp</th><th>Shift</th><th>OEE %</th><th>Availability</th><th>Performance</th><th>Quality</th><th>Good</th><th>Scrap</th></tr></thead>
      <tbody>
        ${rows.slice(-24).reverse().map(r=>`<tr>
          <td style="font-size:10px;color:#64748b;">${new Date(r.bucket).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
          <td class="td-center"><span class="badge badge-ok">${r.shift||'—'}</span></td>
          <td style="background:${oeeBg(r.plant_oee)};color:${oeeColor(r.plant_oee)};font-weight:700;">${pct(r.plant_oee)}</td>
          <td>${pct(r.plant_availability)}</td>
          <td>${pct(r.plant_performance)}</td>
          <td>${pct(r.plant_quality)}</td>
          <td style="color:#166534;">${f0(r.total_good)}</td>
          <td style="color:#991b1b;">${f0(r.total_scrap)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  return htmlShell('OEE Summary Report', wf + stats + shiftTable + hourly, meta, config);
}

// ─────────────────────────────────────────────────────────────
// ENERGY REPORT
// ─────────────────────────────────────────────────────────────
function buildEnergyHTML({ rows, shiftRows, summary, meta, config }) {
  const s = summary;
  const meters = [1,2,3,4,5];

  // Per-meter stats from latest reading
  const latestRow = rows?.[rows.length-1] || {};

  const meterBoxes = `
  <div class="section">
    <div class="section-title">Per Energy Meter — Live Snapshot</div>
    <div class="meter-grid">
      ${meters.map(i=>`
      <div class="meter-box">
        <div class="mb-id">⚡ Energy Meter ${i}</div>
        <div class="mb-row"><span class="mb-key">Active Power</span><span class="mb-val">${f1(latestRow[`em${i}_kw`])} kW</span></div>
        <div class="mb-row"><span class="mb-key">Consumption</span><span class="mb-val">${f1(latestRow[`em${i}_kwh`])} kWh</span></div>
        <div class="mb-row"><span class="mb-key">Power Factor</span><span class="mb-val">${f2(latestRow[`em${i}_pf`])}</span></div>
        <div class="mb-row"><span class="mb-key">Voltage</span><span class="mb-val">${f1(latestRow[`em${i}_voltage`])} V</span></div>
      </div>`).join('')}
    </div>
  </div>`;

  const stats = `
  <div class="stat-grid cols5">
    <div class="stat-box"><div class="sb-icon">⚡</div><div class="sb-val" style="color:#92400e;">${f1(s.total_kwh)}</div><div class="sb-label">Total kWh</div><div class="sb-sub">All meters combined</div></div>
    ${meters.map(i=>`<div class="stat-box"><div class="sb-icon">🔌</div><div class="sb-val">${f1(latestRow[`em${i}_kwh`])}</div><div class="sb-label">Meter ${i} kWh</div></div>`).join('')}
  </div>`;

  const hourly = rows?.length ? `
  <div class="section">
    <div class="section-title">Hourly Energy Consumption <span>kWh per meter per hour</span></div>
    <table>
      <thead><tr>
        <th>Timestamp</th><th>Shift</th>
        ${meters.map(i=>`<th>EM${i} kW</th><th>EM${i} kWh</th><th>EM${i} PF</th>`).join('')}
        <th>Total kWh</th>
      </tr></thead>
      <tbody>
        ${rows.slice(-24).reverse().map(r=>`<tr>
          <td style="font-size:10px;color:#64748b;">${new Date(r.bucket).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
          <td class="td-center">${r.shift||'—'}</td>
          ${meters.map(i=>`
            <td class="td-right">${f1(r[`em${i}_kw`])}</td>
            <td class="td-right td-bold">${f1(r[`em${i}_kwh`])}</td>
            <td class="td-right" style="color:${parseFloat(r[`em${i}_pf`])>=0.9?'#166534':'#991b1b'};">${f2(r[`em${i}_pf`])}</td>
          `).join('')}
          <td class="td-right td-bold" style="color:#92400e;">${f1([1,2,3,4,5].reduce((a,i)=>a+parseFloat(r[`em${i}_kwh`]||0),0).toFixed(1))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  const shiftEnergy = shiftRows?.length ? `
  <div class="section">
    <div class="section-title">Energy by Shift</div>
    <table>
      <thead><tr><th>Shift</th><th>Readings</th><th>Total kWh</th><th>Avg kWh/reading</th></tr></thead>
      <tbody>
        ${shiftRows.map(r=>`<tr>
          <td class="td-bold">${r.shift||'—'}</td>
          <td>${r.readings}</td>
          <td class="td-bold" style="color:#92400e;">${f1(r.total_kwh)}</td>
          <td>${f1(parseFloat(r.total_kwh||0)/Math.max(parseInt(r.readings||1),1))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  return htmlShell('Energy Consumption Report', stats + meterBoxes + shiftEnergy + hourly, meta, config);
}

// ─────────────────────────────────────────────────────────────
// WATER REPORT
// ─────────────────────────────────────────────────────────────
function buildWaterHTML({ rows, shiftRows, summary, meta, config }) {
  const latestRow = rows?.[rows.length-1] || {};
  const meters = [1,2,3,4,5];

  const meterBoxes = `
  <div class="section">
    <div class="section-title">Per Water Meter — Live Snapshot</div>
    <div class="meter-grid">
      ${meters.map(i=>`
      <div class="meter-box">
        <div class="mb-id">💧 Water Meter ${i}</div>
        <div class="mb-row"><span class="mb-key">Flow Rate</span><span class="mb-val" style="color:#0369a1;">${f1(latestRow[`w${i}_flow`])} L/min</span></div>
        <div class="mb-row"><span class="mb-key">Flow/hr</span><span class="mb-val">${f1(parseFloat(latestRow[`w${i}_flow`]||0)*60)} L/hr</span></div>
        <div class="mb-row"><span class="mb-key">Totalizer</span><span class="mb-val td-bold">${f1(latestRow[`w${i}_total`])} L</span></div>
      </div>`).join('')}
    </div>
  </div>`;

  const stats = `
  <div class="stat-grid cols4">
    <div class="stat-box"><div class="sb-icon">💧</div><div class="sb-val" style="color:#0369a1;">${f1(summary.avg_water_flow)}</div><div class="sb-label">Avg Flow (L/min)</div><div class="sb-sub">All 5 meters combined</div></div>
    <div class="stat-box"><div class="sb-icon">🪣</div><div class="sb-val">${f1(parseFloat(summary.avg_water_flow||0)*60)}</div><div class="sb-label">Flow Rate (L/hr)</div></div>
    <div class="stat-box"><div class="sb-icon">📅</div><div class="sb-val">${f0(summary.readings)}</div><div class="sb-label">Readings</div></div>
    <div class="stat-box"><div class="sb-icon">⏱️</div><div class="sb-val">${meta.from?.slice(0,10)||'—'}</div><div class="sb-label">Period Start</div></div>
  </div>`;

  const hourly = rows?.length ? `
  <div class="section">
    <div class="section-title">Hourly Water Flow <span>L/min per meter</span></div>
    <table>
      <thead><tr>
        <th>Timestamp</th><th>Shift</th>
        ${meters.map(i=>`<th>W${i} Flow (L/min)</th><th>W${i} Total (L)</th>`).join('')}
        <th>Combined Flow</th>
      </tr></thead>
      <tbody>
        ${rows.slice(-24).reverse().map(r=>`<tr>
          <td style="font-size:10px;color:#64748b;">${new Date(r.bucket).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
          <td class="td-center">${r.shift||'—'}</td>
          ${meters.map(i=>`
            <td class="td-right" style="color:#0369a1;font-weight:600;">${f1(r[`w${i}_flow`])}</td>
            <td class="td-right">${f1(r[`w${i}_total`])}</td>
          `).join('')}
          <td class="td-right td-bold" style="color:#0369a1;">${f1([1,2,3,4,5].reduce((a,i)=>a+parseFloat(r[`w${i}_flow`]||0),0).toFixed(1))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  return htmlShell('Water Consumption Report', stats + meterBoxes + hourly, meta, config);
}

// ─────────────────────────────────────────────────────────────
// MACHINE HEALTH REPORT
// ─────────────────────────────────────────────────────────────
function buildMachineHTML({ rows, shiftRows, summary, meta, config }) {
  const latestRow = rows?.[rows.length-1] || {};
  const machines  = [1,2,3,4,5];

  const machineCards = `
  <div class="section">
    <div class="section-title">Machine Health — Current Status</div>
    <div class="machine-grid">
      ${machines.map(i=>{
        const st = (latestRow[`m${i}_status`]||'—').toUpperCase();
        const badgeClass = st==='OK'?'badge-ok':st==='WARN'||st==='WARNING'?'badge-warn':'badge-alert';
        return `
        <div class="machine-card">
          <div class="mc-header">
            <div class="mc-id">🔧 Machine ${i}</div>
            <span class="badge ${badgeClass}">${st}</span>
          </div>
          <div class="mc-body">
            <div class="mc-params">
              <div class="mc-param"><div class="mcp-label">Vibration</div><div class="mcp-val" style="color:${parseFloat(latestRow[`m${i}_vib`])>8?'#991b1b':'#1B3A5C'}">${f1(latestRow[`m${i}_vib`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">mm/s</span></div></div>
              <div class="mc-param"><div class="mcp-label">Temperature</div><div class="mcp-val" style="color:${parseFloat(latestRow[`m${i}_temp`])>85?'#991b1b':'#1B3A5C'}">${f1(latestRow[`m${i}_temp`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">°C</span></div></div>
              <div class="mc-param"><div class="mcp-label">Bearing Temp</div><div class="mcp-val" style="color:${parseFloat(latestRow[`m${i}_bearing_temp`])>88?'#991b1b':'#1B3A5C'}">${f1(latestRow[`m${i}_bearing_temp`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">°C</span></div></div>
              <div class="mc-param"><div class="mcp-label">Current</div><div class="mcp-val">${f1(latestRow[`m${i}_current`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">A</span></div></div>
              <div class="mc-param"><div class="mcp-label">Speed</div><div class="mcp-val">${f0(latestRow[`m${i}_speed`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">RPM</span></div></div>
              <div class="mc-param"><div class="mcp-label">Coolant</div><div class="mcp-val">${f1(latestRow[`m${i}_coolant_temp`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">°C</span></div></div>
              <div class="mc-param"><div class="mcp-label">Air Press.</div><div class="mcp-val">${f1(latestRow[`m${i}_air_pressure`])} <span style="font-size:9px;font-weight:400;color:#94a3b8;">bar</span></div></div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  const hourly = rows?.length ? `
  <div class="section">
    <div class="section-title">Machine Health Trend <span>Last 20 readings — Vibration & Temperature</span></div>
    <table>
      <thead><tr>
        <th>Timestamp</th><th>Shift</th>
        ${machines.map(i=>`<th>M${i} Vib</th><th>M${i} Temp</th><th>M${i} Status</th>`).join('')}
      </tr></thead>
      <tbody>
        ${rows.slice(-20).reverse().map(r=>`<tr>
          <td style="font-size:10px;color:#64748b;">${new Date(r.bucket).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
          <td class="td-center">${r.shift||'—'}</td>
          ${machines.map(i=>{
            const st=(r[`m${i}_status`]||'—').toUpperCase();
            const bc=st==='OK'?'badge-ok':st==='WARN'||st==='WARNING'?'badge-warn':'badge-alert';
            return `
            <td class="td-right" style="color:${parseFloat(r[`m${i}_vib`])>8?'#991b1b':'#1B3A5C'};font-weight:${parseFloat(r[`m${i}_vib`])>8?700:400};">${f1(r[`m${i}_vib`])}</td>
            <td class="td-right" style="color:${parseFloat(r[`m${i}_temp`])>85?'#991b1b':'#1B3A5C'};">${f1(r[`m${i}_temp`])}</td>
            <td class="td-center"><span class="badge ${bc}">${st}</span></td>`;
          }).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '';

  return htmlShell('Machine Health Report', machineCards + hourly, meta, config);
}

// ─────────────────────────────────────────────────────────────
// SHIFT REPORT
// ─────────────────────────────────────────────────────────────
function buildShiftHTML({ rows, shiftRows, summary, meta, config }) {
  const shiftTable = shiftRows?.length ? `
  <div class="section">
    <div class="section-title">Shift Performance Comparison</div>
    <table>
      <thead><tr><th>Shift</th><th>OEE %</th><th>Availability</th><th>Performance</th><th>Quality</th><th>Good Parts</th><th>Scrap</th><th>Total kWh</th><th>Stops</th><th>Readings</th></tr></thead>
      <tbody>
        ${shiftRows.map(r=>`<tr>
          <td class="td-bold" style="font-size:13px;">${r.shift||'—'}</td>
          <td style="background:${oeeBg(r.avg_oee)};color:${oeeColor(r.avg_oee)};font-weight:700;font-size:14px;">
            ${pct(r.avg_oee)}
            <div class="oee-bar-wrap" style="margin-top:4px;"><div class="oee-bar" style="width:${r.avg_oee||0}%;background:${oeeColor(r.avg_oee)};"></div></div>
          </td>
          <td>${pct(r.avg_availability)}</td>
          <td>${pct(r.avg_performance)}</td>
          <td>${pct(r.avg_quality)}</td>
          <td style="color:#166534;font-weight:600;">${f0(r.total_good)}</td>
          <td style="color:#991b1b;">${f0(r.total_scrap)}</td>
          <td style="color:#92400e;">${f1(r.total_kwh)}</td>
          <td style="color:#92400e;">${f0(r.total_stops)}</td>
          <td class="td-center">${r.readings}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div style="color:#94a3b8;padding:20px;">No shift data available for this period.</div>';

  const stats = `
  <div class="stat-grid cols4">
    <div class="stat-box"><div class="sb-val" style="color:${oeeColor(summary.avg_oee)};font-size:32px;">${pct(summary.avg_oee)}</div><div class="sb-label">Overall OEE</div></div>
    <div class="stat-box"><div class="sb-val" style="color:#166534;">${f0(summary.total_good)}</div><div class="sb-label">Total Good Parts</div></div>
    <div class="stat-box"><div class="sb-val" style="color:#991b1b;">${f0(summary.total_scrap)}</div><div class="sb-label">Total Scrap</div></div>
    <div class="stat-box"><div class="sb-val" style="color:#92400e;">${f0(summary.total_stops)}</div><div class="sb-label">Total Stops</div></div>
  </div>`;

  return htmlShell('Shift Performance Report', stats + shiftTable, meta, config);
}

// ─────────────────────────────────────────────────────────────
// CUSTOM REPORT
// ─────────────────────────────────────────────────────────────
function buildCustomHTML({ rows, shiftRows, summary, meta, config }) {
  const cols = config.columns || [];
  if (!cols.length || !rows?.length) {
    return htmlShell('Custom Report', '<div style="color:#94a3b8;padding:40px;text-align:center;">No columns selected or no data.</div>', meta, config);
  }

  const FIELD_LABELS = {
    bucket:'Timestamp', shift:'Shift',
    plant_oee:'OEE %', plant_availability:'Availability %', plant_performance:'Performance %', plant_quality:'Quality %',
    total_good:'Good Parts', total_scrap:'Scrap Parts', total_stops:'Stops',
    em1_kw:'EM1 kW', em1_kwh:'EM1 kWh', em1_pf:'EM1 PF', em1_voltage:'EM1 Voltage',
    em2_kw:'EM2 kW', em2_kwh:'EM2 kWh', em2_pf:'EM2 PF', em2_voltage:'EM2 Voltage',
    em3_kw:'EM3 kW', em3_kwh:'EM3 kWh', em3_pf:'EM3 PF', em3_voltage:'EM3 Voltage',
    em4_kw:'EM4 kW', em4_kwh:'EM4 kWh', em4_pf:'EM4 PF', em4_voltage:'EM4 Voltage',
    em5_kw:'EM5 kW', em5_kwh:'EM5 kWh', em5_pf:'EM5 PF', em5_voltage:'EM5 Voltage',
    w1_flow:'W1 Flow', w1_total:'W1 Total', w2_flow:'W2 Flow', w2_total:'W2 Total',
    w3_flow:'W3 Flow', w3_total:'W3 Total', w4_flow:'W4 Flow', w4_total:'W4 Total', w5_flow:'W5 Flow', w5_total:'W5 Total',
    m1_vib:'M1 Vibration', m1_temp:'M1 Temp', m1_bearing_temp:'M1 Bearing', m1_current:'M1 Current', m1_speed:'M1 Speed', m1_status:'M1 Status',
    m2_vib:'M2 Vibration', m2_temp:'M2 Temp', m2_bearing_temp:'M2 Bearing', m2_current:'M2 Current', m2_speed:'M2 Speed', m2_status:'M2 Status',
    m3_vib:'M3 Vibration', m3_temp:'M3 Temp', m3_bearing_temp:'M3 Bearing', m3_current:'M3 Current', m3_speed:'M3 Speed', m3_status:'M3 Status',
    m4_vib:'M4 Vibration', m4_temp:'M4 Temp', m4_bearing_temp:'M4 Bearing', m4_current:'M4 Current', m4_speed:'M4 Speed', m4_status:'M4 Status',
    m5_vib:'M5 Vibration', m5_temp:'M5 Temp', m5_bearing_temp:'M5 Bearing', m5_current:'M5 Current', m5_speed:'M5 Speed', m5_status:'M5 Status',
  };

  const body = `
  <div class="section">
    <div class="section-title">Custom Report — ${cols.length} columns selected <span>${rows.length} rows</span></div>
    <table>
      <thead><tr>${cols.map(c=>`<th>${FIELD_LABELS[c]||c}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((r,ri)=>`<tr>
          ${cols.map(c=>{
            if(c==='bucket') return `<td style="font-size:10px;color:#64748b;">${new Date(r[c]).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td>`;
            if(c==='shift') return `<td class="td-center">${r[c]||'—'}</td>`;
            if(c.includes('status')){ const st=(r[c]||'').toUpperCase(); return `<td class="td-center"><span class="badge ${st==='OK'?'badge-ok':st==='WARN'?'badge-warn':'badge-alert'}">${st||'—'}</span></td>`; }
            if(c.includes('oee')||c.includes('avail')||c.includes('perf')||c.includes('quality')) return `<td style="background:${oeeBg(r[c])};color:${oeeColor(r[c])};font-weight:700;">${pct(r[c])}</td>`;
            if(c.includes('good')) return `<td class="td-right" style="color:#166534;font-weight:600;">${f0(r[c])}</td>`;
            if(c.includes('scrap')||c.includes('stop')) return `<td class="td-right" style="color:#991b1b;">${f0(r[c])}</td>`;
            if(c.includes('pf')) return `<td class="td-right">${f2(r[c])}</td>`;
            return `<td class="td-right">${f1(r[c])}</td>`;
          }).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

  return htmlShell(config.title||'Custom Report', body, meta, config);
}

// ─────────────────────────────────────────────────────────────
// EXCEL — type-aware sheets
// ─────────────────────────────────────────────────────────────
async function buildExcel({ rows, shiftRows, summary, meta, config }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Factory-MIOS — Factory-MIOS';
  wb.created = new Date();

  const type = meta.type || 'oee';

  // ── Summary sheet (always) ──
  const ws0 = wb.addWorksheet('Summary');
  ws0.columns = [{key:'k',width:30},{key:'v',width:20},{key:'u',width:14}];
  addSheetHeader(ws0, `Factory-MIOS — ${config?.title||type.toUpperCase()+' Report'}`, `Plant: ${meta.plant_name||'All'} | ${meta.from?.slice(0,10)} → ${meta.to?.slice(0,10)}`, meta, 3);
  addHeaderRow(ws0, ['Metric','Value','Unit']);
  const sumData = [
    ['Avg OEE', f1(summary.avg_oee),'%'],['Avg Availability',f1(summary.avg_availability),'%'],
    ['Avg Performance',f1(summary.avg_performance),'%'],['Avg Quality',f1(summary.avg_quality),'%'],
    ['Good Parts',f0(summary.total_good),'pcs'],['Scrap Parts',f0(summary.total_scrap),'pcs'],
    ['Total Stops',f0(summary.total_stops),''],['Total kWh',f1(summary.total_kwh),'kWh'],
    ['Avg Water Flow',f1(summary.avg_water_flow),'L/min'],['Readings',f0(summary.readings),''],
    ['Report Generated',new Date().toLocaleString('en-IN'),''],
  ];
  sumData.forEach((d,i) => { addDataRow(ws0,d,i%2===0,i===0?[BLUE]:[]) });

  // ── Shift sheet ──
  if(shiftRows?.length) {
    const ws1 = wb.addWorksheet('By Shift');
    ws1.columns=[{key:'shift',width:14},{key:'readings',width:12},{key:'avg_oee',width:12},{key:'avg_availability',width:16},{key:'avg_performance',width:16},{key:'avg_quality',width:14},{key:'total_good',width:14},{key:'total_scrap',width:14},{key:'total_kwh',width:14},{key:'total_stops',width:12}];
    addSheetHeader(ws1,'Shift-wise Performance','Per-shift OEE, Energy, Parts breakdown',meta,10);
    addHeaderRow(ws1,['Shift','Readings','OEE %','Availability %','Performance %','Quality %','Good Parts','Scrap','kWh','Stops']);
    shiftRows.forEach((r,i)=>{
      const row=addDataRow(ws1,[r.shift||'—',r.readings,f1(r.avg_oee),f1(r.avg_availability),f1(r.avg_performance),f1(r.avg_quality),f0(r.total_good),f0(r.total_scrap),f1(r.total_kwh),f0(r.total_stops)],i%2===0);
      row.getCell(3).fill = excelOeeFill(r.avg_oee);
      row.getCell(3).font = { bold:true };
    });
  }

  // ── Type-specific data sheet ──
  if(rows?.length) {
    if(type==='energy') {
      const ws2 = wb.addWorksheet('Energy Data');
      ws2.columns=[{key:'t',width:22},{key:'sh',width:12},...[1,2,3,4,5].flatMap(i=>[{key:`e${i}kw`,width:12},{key:`e${i}kwh`,width:12},{key:`e${i}pf`,width:10},{key:`e${i}v`,width:12}]),{key:'tot',width:14}];
      addSheetHeader(ws2,'Hourly Energy Data','kW, kWh, Power Factor, Voltage per meter',meta,22);
      addHeaderRow(ws2,['Time','Shift',...[1,2,3,4,5].flatMap(i=>[`EM${i} kW`,`EM${i} kWh`,`EM${i} PF`,`EM${i} Volt`]),'Total kWh']);
      rows.slice(-100).reverse().forEach((r,i)=>{
        const tot=[1,2,3,4,5].reduce((a,j)=>a+parseFloat(r[`em${j}_kwh`]||0),0);
        addDataRow(ws2,[new Date(r.bucket).toLocaleString('en-IN'),r.shift||'—',...[1,2,3,4,5].flatMap(j=>[f1(r[`em${j}_kw`]),f1(r[`em${j}_kwh`]),f2(r[`em${j}_pf`]),f1(r[`em${j}_voltage`])]),f1(tot)],i%2===0);
      });
    } else if(type==='water') {
      const ws2 = wb.addWorksheet('Water Data');
      ws2.columns=[{key:'t',width:22},{key:'sh',width:12},...[1,2,3,4,5].flatMap(i=>[{key:`w${i}f`,width:14},{key:`w${i}tot`,width:14}]),{key:'cf',width:14}];
      addSheetHeader(ws2,'Hourly Water Flow Data','Flow rate (L/min) and Totalizer per meter',meta,12);
      addHeaderRow(ws2,['Time','Shift',...[1,2,3,4,5].flatMap(i=>[`W${i} Flow (L/min)`,`W${i} Total (L)`]),'Combined Flow']);
      rows.slice(-100).reverse().forEach((r,i)=>{
        const cf=[1,2,3,4,5].reduce((a,j)=>a+parseFloat(r[`w${j}_flow`]||0),0);
        addDataRow(ws2,[new Date(r.bucket).toLocaleString('en-IN'),r.shift||'—',...[1,2,3,4,5].flatMap(j=>[f1(r[`w${j}_flow`]),f1(r[`w${j}_total`])]),f1(cf)],i%2===0);
      });
    } else if(type==='machine') {
      const ws2 = wb.addWorksheet('Machine Health');
      ws2.columns=[{key:'t',width:22},{key:'sh',width:12},...[1,2,3,4,5].flatMap(i=>[{key:`m${i}v`,width:12},{key:`m${i}t`,width:12},{key:`m${i}b`,width:12},{key:`m${i}c`,width:10},{key:`m${i}s`,width:12},{key:`m${i}st`,width:10}])];
      addSheetHeader(ws2,'Hourly Machine Health','Vibration (mm/s), Temperature (°C), Current (A), Status',meta,32);
      addHeaderRow(ws2,['Time','Shift',...[1,2,3,4,5].flatMap(i=>[`M${i} Vib`,`M${i} Temp`,`M${i} Bearing`,`M${i} Current`,`M${i} Speed`,`M${i} Status`])]);
      rows.slice(-100).reverse().forEach((r,i)=>{
        const row=addDataRow(ws2,[new Date(r.bucket).toLocaleString('en-IN'),r.shift||'—',...[1,2,3,4,5].flatMap(j=>[f1(r[`m${j}_vib`]),f1(r[`m${j}_temp`]),f1(r[`m${j}_bearing_temp`]),f1(r[`m${j}_current`]),f0(r[`m${j}_speed`]),r[`m${j}_status`]||'—'])],i%2===0);
        // Colour status cells
        [1,2,3,4,5].forEach((j,idx)=>{
          const statusCell=row.getCell(2+6*idx+6);
          const st=(statusCell.value||'').toUpperCase();
          statusCell.fill=st==='OK'?{type:'pattern',pattern:'solid',fgColor:{argb:'FFDCFCE7'}}:st.includes('WARN')?{type:'pattern',pattern:'solid',fgColor:{argb:'FFFEF3C7'}}:{type:'pattern',pattern:'solid',fgColor:{argb:'FFFEE2E2'}};
          statusCell.font={bold:true};
        });
      });
    } else {
      // OEE + custom — hourly OEE sheet
      const ws2 = wb.addWorksheet('Hourly OEE');
      ws2.columns=[{key:'t',width:22},{key:'sh',width:12},{key:'oee',width:12},{key:'av',width:14},{key:'pf',width:14},{key:'ql',width:12},{key:'gd',width:12},{key:'sc',width:12}];
      addSheetHeader(ws2,'Hourly OEE Data','Per-hour OEE breakdown with shift labels',meta,8);
      addHeaderRow(ws2,['Timestamp','Shift','OEE %','Availability %','Performance %','Quality %','Good Parts','Scrap']);
      rows.slice(-200).reverse().forEach((r,i)=>{
        const row=addDataRow(ws2,[new Date(r.bucket).toLocaleString('en-IN'),r.shift||'—',f1(r.plant_oee),f1(r.plant_availability),f1(r.plant_performance),f1(r.plant_quality),f0(r.total_good),f0(r.total_scrap)],i%2===0);
        row.getCell(3).fill=excelOeeFill(r.plant_oee);
        row.getCell(3).font={bold:true};
      });
    }
  }

  return wb.xlsx.writeBuffer();
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────
function buildHTML(data) {
  const type = data.meta?.type || 'oee';
  if (type === 'energy')  return buildEnergyHTML(data);
  if (type === 'water')   return buildWaterHTML(data);
  if (type === 'machine') return buildMachineHTML(data);
  if (type === 'shift')   return buildShiftHTML(data);
  if (type === 'custom')  return buildCustomHTML(data);
  return buildOEEHTML(data);
}

const REPORT_LABELS = {
  oee:'OEE Summary Report', shift:'Shift Performance Report',
  energy:'Energy Consumption Report', water:'Water Consumption Report',
  machine:'Machine Health Report', custom:'Custom Report',
};

module.exports = { buildExcel, buildHTML, REPORT_LABELS };
