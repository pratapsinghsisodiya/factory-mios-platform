'use strict';
/**
 * zot-agent.js — Facto-Bot v2: Natural Language OEE Intelligence Engine
 * ─────────────────────────────────────────────────────────────────────────
 * Upgraded with:
 *  - "Why" intent: multi-metric root cause analysis
 *  - Line-level diagnostics (Line 1 / Line 2 performance breakdown)
 *  - Machine-level correlation (vib/temp → performance/stops)
 *  - Contextual narrative answers from live DB data
 *  - Recommendation engine based on real values
 *  - Trend intent (is it getting better/worse)
 *  - Comparison intent (line1 vs line2, shift A vs B)
 */

// ── TIME PERIOD → SQL ─────────────────────────────────────────────
// NOTE: shift is NO LONGER a period — it is a separate filter in parseQuestion
function periodToSQL(period) {
  const now = new Date();
  const iso  = d => d.toISOString();

  // Dynamic "last N days" — e.g. last_3d, last_5d, last_30d
  const dMatch = period.match(/^last_(\d+)d$/);
  if (dMatch) {
    const days = parseInt(dMatch[1]);
    return { from: new Date(Date.now() - days*86400000).toISOString(), to: iso(now), label:`last ${days} day${days>1?'s':''}` };
  }
  // Dynamic "last N hours" — e.g. last_2h, last_12h
  const hMatch = period.match(/^last_(\d+)h$/);
  if (hMatch) {
    const hours = parseInt(hMatch[1]);
    return { from: new Date(Date.now() - hours*3600000).toISOString(), to: iso(now), label:`last ${hours} hour${hours>1?'s':''}` };
  }

  switch (period) {
    case 'live':
    case 'now':
      return { from: new Date(Date.now()-300000).toISOString(), to: iso(now), label:'last 5 minutes', limit:1 };
    case 'last_1h':
      return { from: new Date(Date.now()-3600000).toISOString(), to: iso(now), label:'last 1 hour' };
    case 'last_8h':
      return { from: new Date(Date.now()-28800000).toISOString(), to: iso(now), label:'last 8 hours' };
    case 'last_24h':
      return { from: new Date(Date.now()-86400000).toISOString(), to: iso(now), label:'last 24 hours' };
    case 'last_3d':
      return { from: new Date(Date.now()-3*86400000).toISOString(), to: iso(now), label:'last 3 days' };
    case 'last_7d':
    case 'this_week': {
      const w = new Date(now); w.setDate(w.getDate()-7);
      return { from: iso(w), to: iso(now), label:'last 7 days' };
    }
    case 'last_30d': {
      const m = new Date(now); m.setDate(m.getDate()-30);
      return { from: iso(m), to: iso(now), label:'last 30 days' };
    }
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate()-1); y.setHours(0,0,0,0);
      const ye = new Date(now); ye.setHours(0,0,0,0);
      return { from: iso(y), to: iso(ye), label:'yesterday' };
    }
    case 'this_month': {
      const sm = new Date(now); sm.setDate(1); sm.setHours(0,0,0,0);
      return { from: iso(sm), to: iso(now), label:'this month' };
    }
    case 'today':
    default: {
      const sod = new Date(now); sod.setHours(0,0,0,0);
      return { from: iso(sod), to: iso(now), label:'today' };
    }
  }
}

// ── INTENT + ENTITY PARSER ────────────────────────────────────────
function parseQuestion(q) {
  const raw = q;
  q = q.toLowerCase().replace(/[?!،。]/g,'').trim();

  // ── SHIFT FILTER — parsed independently from time period ─────────
  // Shift is always a WHERE filter, NEVER a time period.
  // "last 3 days shift A" → period=last_3d AND shiftFilter=SHIFT_A
  let shiftFilter = null;
  if      (/shift\s*[_-]?a\b|shift\s*1\b|morning\s*shift/.test(q))   shiftFilter = 'SHIFT_A';
  else if (/shift\s*[_-]?b\b|shift\s*2\b|afternoon\s*shift/.test(q)) shiftFilter = 'SHIFT_B';
  else if (/shift\s*[_-]?c\b|shift\s*3\b|night\s*shift/.test(q))     shiftFilter = 'SHIFT_C';

  // ── TIME PERIOD — checked in priority order ───────────────────────
  let period = 'today';
  if      (/\bnow\b|\bcurrent\b|\blive\b|\breal.?time\b/.test(q))     period = 'live';
  else if (/\byesterday\b/.test(q))                                    period = 'yesterday';
  else if (/this\s*month\b/.test(q))                                   period = 'this_month';
  else if (/this\s*week|last\s*7\s*day|past\s*week/.test(q))          period = 'this_week';
  else if (/last\s*30\s*day|past\s*month/.test(q))                    period = 'last_30d';
  else {
    // Dynamic "last N days" — captures any number e.g. last 3 days, last 10 days
    const dayMatch = q.match(/last\s*(\d+)\s*day/);
    if (dayMatch) {
      const n = parseInt(dayMatch[1]);
      period = n === 1 ? 'last_24h' : n === 7 ? 'this_week' : `last_${n}d`;
    } else {
      // Dynamic "last N hours"
      const hourMatch = q.match(/last\s*(\d+)\s*hour/);
      if (hourMatch) {
        const n = parseInt(hourMatch[1]);
        period = n <= 1 ? 'last_1h' : n <= 8 ? 'last_8h' : n <= 24 ? 'last_24h' : `last_${n}h`;
      } else if (/last\s*1?\s*hour|past\s*hour/.test(q)) {
        period = 'last_1h';
      } else if (/last\s*8\s*hour|8\s*hour/.test(q)) {
        period = 'last_8h';
      } else if (/last\s*24\s*hour|24\s*hour/.test(q)) {
        period = 'last_24h';
      }
    }
  }

  // If only a shift mentioned with no explicit time range → last 24h for that shift
  if (period === 'today' && shiftFilter && !/\btoday\b/.test(q)) period = 'last_24h';

  // ── Metric ───────────────────────────────────────────────────────
  let metric = 'summary';
  if      (/\boee\b/.test(q))                                          metric = 'oee';
  else if (/availab/.test(q))                                          metric = 'availability';
  else if (/performanc/.test(q))                                       metric = 'performance';
  else if (/quality/.test(q))                                          metric = 'quality';
  else if (/scrap|reject|defect|rework/.test(q))                      metric = 'scrap';
  else if (/good.?part|production.?unit|part.?produc|output|produc/.test(q)) metric = 'production';
  else if (/stop|downtime|breakdown|loss\s*time/.test(q))             metric = 'stops';
  else if (/energy|kwh|kw\b|power\s*factor|pf\b|electric/.test(q))   metric = 'energy';
  else if (/water|flow|litr|liter|consum/.test(q))                    metric = 'water';
  else if (/vibration|vib\b/.test(q))                                  metric = 'vibration';
  else if (/temperature|temp\b|bearing/.test(q))                      metric = 'temperature';
  else if (/machine|motor|equipment/.test(q))                          metric = 'machine';
  else if (/alert|alarm|warn/.test(q))                                 metric = 'alerts';
  else if (/summary|overview|how.?is|how.?are|status/.test(q))        metric = 'summary';

  // ── Intent — "why" checked FIRST, then specific intents ──────────
  let intent = 'get_value';
  if (/\bwhy\b|\broot\s*cause\b|\breason\b|\bcause\b|\bdue\s*to\b|\bwhat.*caus/.test(q))
    intent = 'why';
  else if (/\bbest\b|\btop\b|\bhighest\b|\bmaximum\b|\bmax\b|\bmost\b/.test(q))
    intent = 'get_best';
  else if (/\bworst\b|\blowest\b|\bminimum\b|\bmin\b|\bleast\b/.test(q))
    intent = 'get_worst';
  else if (/\bcompare\b|\bvs\b|\bversus\b|\bdifference\b|\bbetween\b/.test(q))
    intent = 'compare';
  else if (/\btrend\b|\bover\s*time\b|\bhow\s*has\b|\bchanged\b|\bimprove\b|\bdeteriora/.test(q))
    intent = 'get_trend';
  // by_shift ONLY when asking for breakdown across ALL shifts — NOT when a specific shift is named
  else if (/\bper\s*shift\b|\beach\s*shift\b|\bby\s*shift\b|\ball\s*shift/.test(q) && !shiftFilter)
    intent = 'by_shift';
  else if (/\bshift\b/.test(q) && !shiftFilter && !/line/.test(q))
    intent = 'by_shift';
  else if (/\bline\b|\bl1\b|\bl2\b/.test(q))
    intent = 'by_line';
  else if (/\bmachine\b|\bmotor\b/.test(q) && /\bwhich\b|\bbest\b|\bworst\b/.test(q))
    intent = 'get_best';
  else if (/what|tell me|show|how much|how many|give me|display/.test(q))
    intent = 'get_value';

  // ── Machine number ───────────────────────────────────────────────
  let machine = null;
  const mMatch = q.match(/machine\s*([1-5])|m([1-5])\b|motor\s*([1-5])/);
  if (mMatch) machine = parseInt(mMatch[1]||mMatch[2]||mMatch[3]);

  // ── Meter number ─────────────────────────────────────────────────
  let meter = null;
  const emMatch = q.match(/meter\s*([1-5])|em([1-5])\b/);
  if (emMatch) meter = parseInt(emMatch[1]||emMatch[2]);

  // ── Line number ──────────────────────────────────────────────────
  let line = null;
  const lMatch = q.match(/line\s*([12])|l([12])\b/);
  if (lMatch) line = parseInt(lMatch[1]||lMatch[2]);

  // ── "Why" questions — infer metric from context if not set ───────
  if (intent === 'why') {
    if (metric === 'summary' && /line\s*[12]/.test(q)) metric = 'oee';
    if (metric === 'summary' && /perform/.test(q))     metric = 'performance';
    if (metric === 'summary' && /availab/.test(q))     metric = 'availability';
    if (metric === 'summary' && /quality/.test(q))     metric = 'quality';
    if (metric === 'summary')                           metric = 'oee';
  }

  return { intent, metric, period, shiftFilter, machine, meter, line, raw };
}

// ── DIAGNOSTIC QUERY (multi-metric for "why" intent) ─────────────
async function runDiagnostic(db, parsed) {
  const p = periodToSQL(parsed.period);
  const params = [p.from, p.to];
  const line = parsed.line;

  // Apply shift filter if a specific shift was requested (e.g. "last 3 days shift A OEE")
  let shiftClause = '';
  if (parsed.shiftFilter) {
    params.push(parsed.shiftFilter);
    shiftClause = ` AND shift = $${params.length}`;
  }

  // Get all critical metrics at once
  const sql = `
    SELECT
      ROUND(AVG(plant_oee)::numeric,2)          AS plant_oee,
      ROUND(AVG(plant_availability)::numeric,2) AS plant_avail,
      ROUND(AVG(plant_performance)::numeric,2)  AS plant_perf,
      ROUND(AVG(plant_quality)::numeric,2)      AS plant_qual,
      ROUND(AVG(l1_oee)::numeric,2)             AS l1_oee,
      ROUND(AVG(l1_avail)::numeric,2)           AS l1_avail,
      ROUND(AVG(l1_perf)::numeric,2)            AS l1_perf,
      ROUND(AVG(l1_qual)::numeric,2)            AS l1_qual,
      ROUND(AVG(l2_oee)::numeric,2)             AS l2_oee,
      ROUND(AVG(l2_avail)::numeric,2)           AS l2_avail,
      ROUND(AVG(l2_perf)::numeric,2)            AS l2_perf,
      ROUND(AVG(l2_qual)::numeric,2)            AS l2_qual,
      MAX(total_stops)                           AS total_stops,
      MAX(total_stop_min)                        AS total_stop_min,
      MAX(total_scrap)                           AS total_scrap,
      MAX(total_good)                            AS total_good,
      MAX(total_parts)                           AS total_parts,
      ROUND(AVG(m1_vib)::numeric,2) AS m1_vib, ROUND(MAX(m1_vib)::numeric,2) AS m1_vib_max,
      ROUND(AVG(m1_temp)::numeric,1) AS m1_temp, ROUND(AVG(m1_bearing_temp)::numeric,1) AS m1_bt,
      ROUND(AVG(m1_current)::numeric,2) AS m1_cur, MODE() WITHIN GROUP (ORDER BY m1_status) AS m1_status,
      ROUND(AVG(m2_vib)::numeric,2) AS m2_vib, ROUND(MAX(m2_vib)::numeric,2) AS m2_vib_max,
      ROUND(AVG(m2_temp)::numeric,1) AS m2_temp, ROUND(AVG(m2_bearing_temp)::numeric,1) AS m2_bt,
      ROUND(AVG(m2_current)::numeric,2) AS m2_cur, MODE() WITHIN GROUP (ORDER BY m2_status) AS m2_status,
      ROUND(AVG(m3_vib)::numeric,2) AS m3_vib, ROUND(MAX(m3_vib)::numeric,2) AS m3_vib_max,
      ROUND(AVG(m3_temp)::numeric,1) AS m3_temp, ROUND(AVG(m3_bearing_temp)::numeric,1) AS m3_bt,
      ROUND(AVG(m3_current)::numeric,2) AS m3_cur, MODE() WITHIN GROUP (ORDER BY m3_status) AS m3_status,
      ROUND(AVG(m4_vib)::numeric,2) AS m4_vib, ROUND(MAX(m4_vib)::numeric,2) AS m4_vib_max,
      ROUND(AVG(m4_temp)::numeric,1) AS m4_temp, ROUND(AVG(m4_bearing_temp)::numeric,1) AS m4_bt,
      ROUND(AVG(m4_current)::numeric,2) AS m4_cur, MODE() WITHIN GROUP (ORDER BY m4_status) AS m4_status,
      ROUND(AVG(m5_vib)::numeric,2) AS m5_vib, ROUND(MAX(m5_vib)::numeric,2) AS m5_vib_max,
      ROUND(AVG(m5_temp)::numeric,1) AS m5_temp, ROUND(AVG(m5_bearing_temp)::numeric,1) AS m5_bt,
      ROUND(AVG(m5_current)::numeric,2) AS m5_cur, MODE() WITHIN GROUP (ORDER BY m5_status) AS m5_status,
      ROUND(AVG(em1_kw+em2_kw+em3_kw+em4_kw+em5_kw)::numeric,1) AS total_kw,
      MODE() WITHIN GROUP (ORDER BY shift) AS active_shift,
      COUNT(*) AS readings
    FROM plant_readings WHERE time >= $1 AND time <= $2${shiftClause}
  `;

  const result = await db.query(sql, params);
  const row = result.rows[0];
  return { row, period: p, line };
}

// ── ROOT CAUSE ANALYSIS FORMATTER ─────────────────────────────────
function formatRootCause(parsed, row, period) {
  const f1 = v => v != null ? parseFloat(v).toFixed(1) : '—';
  const f0 = v => v != null ? parseInt(v).toLocaleString() : '—';
  const pct = v => v != null ? parseFloat(v).toFixed(1)+'%' : '—';
  const line = parsed.line;
  const metric = parsed.metric;

  // ── Choose which line to diagnose ──────────────────────────────
  let focusOee, focusAvail, focusPerf, focusQual, focusLabel;
  if (line === 1) {
    focusOee = parseFloat(row.l1_oee||0); focusAvail = parseFloat(row.l1_avail||0);
    focusPerf = parseFloat(row.l1_perf||0); focusQual = parseFloat(row.l1_qual||0);
    focusLabel = 'Line 1';
  } else if (line === 2) {
    focusOee = parseFloat(row.l2_oee||0); focusAvail = parseFloat(row.l2_avail||0);
    focusPerf = parseFloat(row.l2_perf||0); focusQual = parseFloat(row.l2_qual||0);
    focusLabel = 'Line 2';
  } else {
    focusOee = parseFloat(row.plant_oee||0); focusAvail = parseFloat(row.plant_avail||0);
    focusPerf = parseFloat(row.plant_perf||0); focusQual = parseFloat(row.plant_qual||0);
    focusLabel = 'Plant';
  }

  // ── Loss calculation ───────────────────────────────────────────
  const lossAvail = (100 - focusAvail).toFixed(1);
  const lossPerf  = (100 - focusPerf).toFixed(1);
  const lossQual  = (100 - focusQual).toFixed(1);

  // Determine biggest loss driver
  const losses = [
    { name:'Availability', loss: 100-focusAvail, col:'blue' },
    { name:'Performance',  loss: 100-focusPerf,  col:'purple' },
    { name:'Quality',      loss: 100-focusQual,  col:'teal' },
  ].sort((a,b) => b.loss - a.loss);
  const primaryLoss = losses[0];

  // ── Machine health issues ──────────────────────────────────────
  const machineIssues = [];
  for (let i = 1; i <= 5; i++) {
    const vib  = parseFloat(row[`m${i}_vib`]||0);
    const temp = parseFloat(row[`m${i}_temp`]||0);
    const bt   = parseFloat(row[`m${i}_bt`]||0);
    const cur  = parseFloat(row[`m${i}_cur`]||0);
    const st   = (row[`m${i}_status`]||'').toUpperCase();
    const issues = [];
    if (vib > 8)  issues.push(`high vibration (${f1(vib)} mm/s — threshold: 8)`);
    else if (vib > 6) issues.push(`elevated vibration (${f1(vib)} mm/s)`);
    if (temp > 85) issues.push(`overtemperature (${f1(temp)} °C — threshold: 85°C)`);
    else if (temp > 75) issues.push(`high temperature (${f1(temp)} °C)`);
    if (bt > 85)   issues.push(`bearing overheat (${f1(bt)} °C)`);
    if (st === 'ALERT') issues.push(`in ALERT state`);
    if (st === 'WARN')  issues.push(`in WARNING state`);
    if (issues.length) {
      machineIssues.push({ machine: i, issues, severity: st==='ALERT'?3:st==='WARN'?2:1 });
    }
  }
  machineIssues.sort((a,b) => b.severity - a.severity);

  // ── Stop analysis ──────────────────────────────────────────────
  const stops    = parseInt(row.total_stops||0);
  const stopMin  = parseInt(row.total_stop_min||0);
  const scrapPct = row.total_parts > 0 ? (row.total_scrap/row.total_parts*100).toFixed(2) : 0;

  // ── Build narrative ────────────────────────────────────────────
  const metricValue = metric==='performance' ? focusPerf : metric==='availability' ? focusAvail : metric==='quality' ? focusQual : focusOee;
  const metricLabel = metric==='performance' ? 'Performance' : metric==='availability' ? 'Availability' : metric==='quality' ? 'Quality' : 'OEE';
  const statusIcon  = metricValue >= 80 ? '🟢' : metricValue >= 65 ? '🟡' : '🔴';

  const shiftTag = parsed.shiftFilter ? ` — ${parsed.shiftFilter.replace('_',' ')}` : '';
  let out = `🔍 **Root Cause Analysis — ${focusLabel} ${metricLabel} — ${period.label}${shiftTag}**\n\n`;
  out += `${statusIcon} **Current ${metricLabel}: ${pct(metricValue)}** `;
  if (metricValue < 65)       out += `(Critical — target ≥ 85%)\n\n`;
  else if (metricValue < 80)  out += `(Below target — target ≥ 85%)\n\n`;
  else                         out += `(On target ✅)\n\n`;

  // OEE breakdown
  out += `**📊 OEE Loss Breakdown:**\n`;
  out += `⏱ Availability loss: **${lossAvail}%** (${pct(focusAvail)} available)\n`;
  out += `⚡ Performance loss: **${lossPerf}%** (${pct(focusPerf)} of ideal rate)\n`;
  out += `🎯 Quality loss: **${lossQual}%** (${pct(focusQual)} good parts)\n\n`;

  // Primary driver
  out += `**🔎 Primary Driver: ${primaryLoss.name} Loss (${primaryLoss.loss.toFixed(1)}%)**\n`;

  if (primaryLoss.name === 'Availability') {
    out += stops > 0
      ? `→ ${stops} stops recorded, totaling **${stopMin} minutes** of unplanned downtime.\n`
      : `→ Machine availability below target. Check for micro-stops, slow restarts, or material wait time.\n`;
    out += `→ Every 1% availability loss = ${Math.round(focusAvail * 0.01 * 480 / 100)} min/shift lost.\n\n`;
  } else if (primaryLoss.name === 'Performance') {
    out += `→ Machines running slower than ideal cycle time. Causes: speed reduction, minor stops, sensor drift.\n`;
    out += `→ Check if operators reduced speed due to quality concerns or vibration alarms.\n\n`;
  } else {
    out += `→ Scrap/rework rate: **${scrapPct}%** (${f0(row.total_scrap)} rejected of ${f0(row.total_parts)} total).\n`;
    out += `→ Check upstream process: temperature control, tool wear, material batch quality.\n\n`;
  }

  // Machine issues
  if (machineIssues.length) {
    out += `**🔧 Machine-Level Findings:**\n`;
    machineIssues.slice(0,3).forEach(m => {
      const icon = m.severity >= 3 ? '🔴' : '🟡';
      out += `${icon} Machine ${m.machine}: ${m.issues.join(', ')}\n`;
    });
    // Link machine issues to performance
    const alertMachines = machineIssues.filter(m => m.severity >= 2);
    if (alertMachines.length) {
      out += `\n→ These ${alertMachines.length} machine issue(s) are likely causing speed reduction and unplanned stops, directly reducing ${primaryLoss.name}.\n`;
    }
    out += '\n';
  } else {
    out += `**🔧 Machine Health:** All machines within normal parameters — no hardware faults detected.\n\n`;
  }

  // Stop data
  if (stops > 0) {
    out += `**⛔ Stop Events:**\n`;
    out += `${stops} stops | ${stopMin} min downtime | Avg stop: ${stops>0?(stopMin/stops).toFixed(0):0} min each\n\n`;
  }

  // ── Line comparison ────────────────────────────────────────────
  const l1oee = parseFloat(row.l1_oee||0), l2oee = parseFloat(row.l2_oee||0);
  if (l1oee > 0 && l2oee > 0) {
    out += `**📍 Line Comparison:**\n`;
    out += `Line 1 OEE: ${pct(l1oee)} (Avail ${pct(row.l1_avail)} | Perf ${pct(row.l1_perf)} | Qual ${pct(row.l1_qual)})\n`;
    out += `Line 2 OEE: ${pct(l2oee)} (Avail ${pct(row.l2_avail)} | Perf ${pct(row.l2_perf)} | Qual ${pct(row.l2_qual)})\n`;
    const diff = Math.abs(l1oee - l2oee).toFixed(1);
    if (parseFloat(diff) > 2) {
      const lower = l1oee < l2oee ? 'Line 1' : 'Line 2';
      const lowerData = l1oee < l2oee ? { avail: row.l1_avail, perf: row.l1_perf, qual: row.l1_qual } : { avail: row.l2_avail, perf: row.l2_perf, qual: row.l2_qual };
      const weakest = [
        { n:'Availability', v: 100-parseFloat(lowerData.avail||100) },
        { n:'Performance', v: 100-parseFloat(lowerData.perf||100) },
        { n:'Quality', v: 100-parseFloat(lowerData.qual||100) },
      ].sort((a,b) => b.v-a.v)[0];
      out += `⚠️ ${lower} is under-performing by ${diff}% — weakest factor: **${weakest.n}**\n\n`;
    }
  }

  // ── Recommendations ────────────────────────────────────────────
  out += `**💡 Recommended Actions:**\n`;
  const recs = [];
  if (primaryLoss.name === 'Availability' && stops > 3)
    recs.push(`Log downtime reason codes for the ${stops} stops to identify repeat failure pattern`);
  if (machineIssues.some(m => m.issues.some(i => i.includes('vibration'))))
    recs.push(`Schedule bearing inspection for: ${machineIssues.filter(m => m.issues.some(i => i.includes('vibration'))).map(m=>'M'+m.machine).join(', ')}`);
  if (machineIssues.some(m => m.issues.some(i => i.includes('temp'))))
    recs.push(`Check coolant flow and heat exchangers for overtemperature machines`);
  if (parseFloat(scrapPct) > 3)
    recs.push(`Quality gate: ${scrapPct}% scrap rate — inspect tooling and upstream process parameters`);
  if (primaryLoss.name === 'Performance')
    recs.push(`Run cycle time study: compare actual vs ideal cycle time to identify speed loss root cause`);
  if (focusAvail < 80)
    recs.push(`Review planned maintenance schedule — low availability (${pct(focusAvail)}) suggests unplanned stops dominating`);
  if (!recs.length)
    recs.push(`Continue monitoring — no critical issues detected. Consider raising OEE target to 88%`);

  recs.slice(0,4).forEach((r,i) => { out += `${i+1}. ${r}\n`; });

  out += `\n📡 *Based on ${row.readings} readings — ${period.label}*`;
  return out;
}

// ── STANDARD QUERY BUILDER ────────────────────────────────────────
function buildQuery(parsed) {
  const { intent, metric, period, machine, meter, line } = parsed;
  const p = periodToSQL(period);
  const params = [p.from, p.to];
  // shiftFilter comes from parsed.shiftFilter (independent of time period)
  const shiftFilter = parsed.shiftFilter ? ` AND shift = '${parsed.shiftFilter}'` : '';

  // ── OEE / Availability / Performance / Quality ────────────────
  if (['oee','availability','performance','quality'].includes(metric)) {
    const col = metric === 'oee' ? 'plant_oee' : `plant_${metric}`;
    const l1  = metric === 'oee' ? 'l1_oee' : `l1_${metric==='availability'?'avail':metric==='performance'?'perf':'qual'}`;
    const l2  = metric === 'oee' ? 'l2_oee' : `l2_${metric==='availability'?'avail':metric==='performance'?'perf':'qual'}`;

    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift, ROUND(AVG(${col})::numeric,2) AS value, COUNT(*) AS readings
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY value DESC`,
        params, label: p.label, metric, intent
      };
    }
    if (intent === 'by_line' || line) {
      return {
        sql: `SELECT ROUND(AVG(${l1})::numeric,2) AS line_1, ROUND(AVG(${l2})::numeric,2) AS line_2,
                     ROUND(AVG(plant_oee)::numeric,2) AS plant_oee,
                     MAX(total_stops) AS stops, MAX(total_stop_min) AS stop_min
              FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
        params, label: p.label, metric, intent
      };
    }
    if (intent === 'compare') {
      return {
        sql: `SELECT shift, ROUND(AVG(${col})::numeric,2) AS value,
                     ROUND(AVG(${l1})::numeric,2) AS line_1, ROUND(AVG(${l2})::numeric,2) AS line_2,
                     COUNT(*) AS readings
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY value DESC`,
        params, label: p.label, metric, intent
      };
    }
    return {
      sql: `SELECT ROUND(AVG(${col})::numeric,2) AS avg_val,
                   ROUND(MAX(${col})::numeric,2) AS max_val,
                   ROUND(MIN(${col})::numeric,2) AS min_val,
                   ROUND(AVG(l1_oee)::numeric,2) AS l1_oee,
                   ROUND(AVG(l2_oee)::numeric,2) AS l2_oee,
                   COUNT(*) AS readings, MODE() WITHIN GROUP (ORDER BY shift) AS dominant_shift
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── PRODUCTION / GOOD PARTS ───────────────────────────────────
  if (metric === 'production') {
    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift, MAX(total_good) AS good_parts, MAX(total_parts) AS total_parts,
                     ROUND((MAX(total_good)::float/NULLIF(MAX(total_parts),0)*100)::numeric,1) AS quality_pct
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY good_parts DESC`,
        params, label: p.label, metric, intent
      };
    }
    return {
      sql: `SELECT MAX(total_good) AS good_parts, MAX(total_scrap) AS scrap_parts,
                   MAX(total_parts) AS total_parts,
                   ROUND((MAX(total_good)::float/NULLIF(MAX(total_parts),0)*100)::numeric,1) AS quality_pct,
                   MAX(total_stops) AS total_stops, MAX(total_stop_min) AS stop_minutes
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── SCRAP / REJECTION ─────────────────────────────────────────
  if (metric === 'scrap') {
    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift, MAX(total_scrap) AS scrap_parts, MAX(total_parts) AS total_parts,
                     ROUND((MAX(total_scrap)::float/NULLIF(MAX(total_parts),0)*100)::numeric,2) AS scrap_pct
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY scrap_pct DESC`,
        params, label: p.label, metric, intent
      };
    }
    return {
      sql: `SELECT MAX(total_scrap) AS scrap_parts, MAX(total_parts) AS total_parts,
                   ROUND((MAX(total_scrap)::float/NULLIF(MAX(total_parts),0)*100)::numeric,2) AS scrap_pct
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── STOPS / DOWNTIME ─────────────────────────────────────────
  if (metric === 'stops') {
    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift, MAX(total_stops) AS stops, MAX(total_stop_min) AS stop_minutes
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY stops DESC`,
        params, label: p.label, metric, intent
      };
    }
    return {
      sql: `SELECT MAX(total_stops) AS stops, MAX(total_stop_min) AS stop_minutes FROM plant_readings
            WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── ENERGY ────────────────────────────────────────────────────
  if (metric === 'energy') {
    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift,
                ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh,
                ROUND(AVG(em1_kw+em2_kw+em3_kw+em4_kw+em5_kw)::numeric,1) AS avg_kw,
                ROUND(AVG((em1_pf+em2_pf+em3_pf+em4_pf+em5_pf)/5)::numeric,3) AS avg_pf
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY total_kwh DESC`,
        params, label: p.label, metric, intent
      };
    }
    if (meter) {
      const i = meter;
      return {
        sql: `SELECT ROUND((MAX(em${i}_kwh)-MIN(em${i}_kwh))::numeric,2) AS total_kwh,
                     ROUND(AVG(em${i}_kw)::numeric,2) AS avg_kw,
                     ROUND(MAX(em${i}_kw)::numeric,2) AS peak_kw,
                     ROUND(AVG(em${i}_pf)::numeric,3) AS avg_pf,
                     ROUND(AVG(em${i}_voltage)::numeric,1) AS avg_voltage
              FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
        params, label: `${p.label} — Meter ${i}`, metric, intent
      };
    }
    return {
      sql: `SELECT
              ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh,
              ROUND(AVG(em1_kw+em2_kw+em3_kw+em4_kw+em5_kw)::numeric,1) AS avg_kw,
              ROUND(MAX(em1_kw+em2_kw+em3_kw+em4_kw+em5_kw)::numeric,1) AS peak_kw,
              ROUND((MAX(em1_kwh)-MIN(em1_kwh))::numeric,1) AS em1_kwh,
              ROUND((MAX(em2_kwh)-MIN(em2_kwh))::numeric,1) AS em2_kwh,
              ROUND((MAX(em3_kwh)-MIN(em3_kwh))::numeric,1) AS em3_kwh,
              ROUND((MAX(em4_kwh)-MIN(em4_kwh))::numeric,1) AS em4_kwh,
              ROUND((MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS em5_kwh
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── WATER ──────────────────────────────────────────────────────
  if (metric === 'water') {
    if (intent === 'by_shift') {
      return {
        sql: `SELECT shift,
                ROUND(AVG(w1_flow+w2_flow+w3_flow+w4_flow+w5_flow)::numeric,1) AS avg_flow,
                ROUND(MAX(w1_total+w2_total+w3_total+w4_total+w5_total)::numeric,1) AS total_volume
              FROM plant_readings WHERE time>=$1 AND time<=$2 AND shift IS NOT NULL${shiftFilter}
              GROUP BY shift ORDER BY total_volume DESC`,
        params, label: p.label, metric, intent
      };
    }
    if (meter) {
      const i = meter;
      return {
        sql: `SELECT ROUND(AVG(w${i}_flow)::numeric,2) AS avg_flow,
                     ROUND(MAX(w${i}_flow)::numeric,2) AS peak_flow,
                     ROUND(MAX(w${i}_total)::numeric,1) AS total_volume
              FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
        params, label: `${p.label} — Water Meter ${i}`, metric, intent
      };
    }
    return {
      sql: `SELECT
              ROUND(AVG(w1_flow+w2_flow+w3_flow+w4_flow+w5_flow)::numeric,1) AS combined_flow,
              ROUND(MAX(w1_total)::numeric,1) AS w1_total, ROUND(MAX(w2_total)::numeric,1) AS w2_total,
              ROUND(MAX(w3_total)::numeric,1) AS w3_total, ROUND(MAX(w4_total)::numeric,1) AS w4_total,
              ROUND(MAX(w5_total)::numeric,1) AS w5_total
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── MACHINE HEALTH / VIBRATION / TEMPERATURE ──────────────────
  if (['machine','vibration','temperature'].includes(metric) || machine) {
    const m = machine || 0;
    if (m) {
      return {
        sql: `SELECT ROUND(AVG(m${m}_vib)::numeric,2) AS avg_vib,
                     ROUND(MAX(m${m}_vib)::numeric,2) AS max_vib,
                     ROUND(AVG(m${m}_temp)::numeric,1) AS avg_temp,
                     ROUND(MAX(m${m}_temp)::numeric,1) AS max_temp,
                     ROUND(AVG(m${m}_bearing_temp)::numeric,1) AS avg_bearing,
                     ROUND(AVG(m${m}_current)::numeric,2) AS avg_current,
                     ROUND(AVG(m${m}_speed)::numeric,0) AS avg_speed,
                     MODE() WITHIN GROUP (ORDER BY m${m}_status) AS status,
                     SUM(CASE WHEN m${m}_status='ALERT' THEN 1 ELSE 0 END) AS alert_count
              FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
        params, label: `${p.label} — Machine ${m}`, metric, intent, machine: m
      };
    }
    if (intent === 'get_best' || intent === 'get_worst') {
      const col = metric === 'vibration' ? 'vib' : metric === 'temperature' ? 'temp' : 'vib';
      return {
        sql: `SELECT
                ROUND(AVG(m1_${col})::numeric,2) AS m1, ROUND(AVG(m2_${col})::numeric,2) AS m2,
                ROUND(AVG(m3_${col})::numeric,2) AS m3, ROUND(AVG(m4_${col})::numeric,2) AS m4,
                ROUND(AVG(m5_${col})::numeric,2) AS m5
              FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
        params, label: p.label, metric, intent, compare_machines: true, compare_col: col
      };
    }
    return {
      sql: `SELECT
              ROUND(AVG(m1_vib)::numeric,2) AS m1_vib, ROUND(AVG(m1_temp)::numeric,1) AS m1_temp, MODE() WITHIN GROUP (ORDER BY m1_status) AS m1_status,
              ROUND(AVG(m2_vib)::numeric,2) AS m2_vib, ROUND(AVG(m2_temp)::numeric,1) AS m2_temp, MODE() WITHIN GROUP (ORDER BY m2_status) AS m2_status,
              ROUND(AVG(m3_vib)::numeric,2) AS m3_vib, ROUND(AVG(m3_temp)::numeric,1) AS m3_temp, MODE() WITHIN GROUP (ORDER BY m3_status) AS m3_status,
              ROUND(AVG(m4_vib)::numeric,2) AS m4_vib, ROUND(AVG(m4_temp)::numeric,1) AS m4_temp, MODE() WITHIN GROUP (ORDER BY m4_status) AS m4_status,
              ROUND(AVG(m5_vib)::numeric,2) AS m5_vib, ROUND(AVG(m5_temp)::numeric,1) AS m5_temp, MODE() WITHIN GROUP (ORDER BY m5_status) AS m5_status
            FROM plant_readings WHERE time>=$1 AND time<=$2${shiftFilter}`,
      params, label: p.label, metric, intent
    };
  }

  // ── ALERTS ────────────────────────────────────────────────────
  if (metric === 'alerts') {
    return {
      sql: `SELECT
              SUM(CASE WHEN m1_status='ALERT' THEN 1 ELSE 0 END) AS m1_alerts,
              SUM(CASE WHEN m2_status='ALERT' THEN 1 ELSE 0 END) AS m2_alerts,
              SUM(CASE WHEN m3_status='ALERT' THEN 1 ELSE 0 END) AS m3_alerts,
              SUM(CASE WHEN m4_status='ALERT' THEN 1 ELSE 0 END) AS m4_alerts,
              SUM(CASE WHEN m5_status='ALERT' THEN 1 ELSE 0 END) AS m5_alerts,
              SUM(CASE WHEN m1_status='WARN' OR m1_status='WARNING' THEN 1 ELSE 0 END +
                  CASE WHEN m2_status='WARN' OR m2_status='WARNING' THEN 1 ELSE 0 END +
                  CASE WHEN m3_status='WARN' OR m3_status='WARNING' THEN 1 ELSE 0 END +
                  CASE WHEN m4_status='WARN' OR m4_status='WARNING' THEN 1 ELSE 0 END +
                  CASE WHEN m5_status='WARN' OR m5_status='WARNING' THEN 1 ELSE 0 END) AS total_warnings
            FROM plant_readings WHERE time>=$1 AND time<=$2`,
      params, label: p.label, metric, intent
    };
  }

  // ── SUMMARY (default) ─────────────────────────────────────────
  return {
    sql: `SELECT
            ROUND(AVG(plant_oee)::numeric,2) AS avg_oee,
            ROUND(AVG(plant_availability)::numeric,2) AS avg_availability,
            ROUND(AVG(plant_performance)::numeric,2) AS avg_performance,
            ROUND(AVG(plant_quality)::numeric,2) AS avg_quality,
            MAX(total_good) AS good_parts, MAX(total_scrap) AS scrap_parts,
            MAX(total_stops) AS stops, MAX(total_stop_min) AS stop_min,
            ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh,
            ROUND(AVG(w1_flow+w2_flow+w3_flow+w4_flow+w5_flow)::numeric,1) AS avg_water_flow,
            ROUND(AVG(l1_oee)::numeric,2) AS l1_oee,
            ROUND(AVG(l2_oee)::numeric,2) AS l2_oee,
            MODE() WITHIN GROUP (ORDER BY shift) AS dominant_shift,
            COUNT(*) AS readings
          FROM plant_readings WHERE time>=$1 AND time<=$2`,
    params, label: p.label, metric: 'summary', intent
  };
}

// ── ANSWER FORMATTER ──────────────────────────────────────────────
function formatAnswer(parsed, query, rows) {
  const { metric, intent, period, machine, meter } = parsed;
  const r = rows[0];
  const p = periodToSQL(period);
  // Include shift filter in display label when a specific shift was requested
  const shiftSuffix = parsed.shiftFilter ? ` — ${parsed.shiftFilter.replace('_',' ')}` : '';
  const pLabel = (query.label || p.label) + shiftSuffix;
  const f1 = v => v != null ? parseFloat(v).toFixed(1) : '—';
  const f2 = v => v != null ? parseFloat(v).toFixed(2) : '—';
  const f0 = v => v != null ? parseInt(v).toLocaleString() : '—';
  const pct= v => v != null ? parseFloat(v).toFixed(1)+'%' : '—';

  if (!r || !rows.length) return `📭 No data found for **${pLabel}**. Make sure Node-RED is writing data to the database.`;

  // ── SUMMARY ──────────────────────────────────────────────────
  if (metric === 'summary') {
    const oee = parseFloat(r.avg_oee||0);
    const icon = oee>=80?'🟢':oee>=65?'🟡':'🔴';
    return `📊 **Plant Summary — ${pLabel}**\n\n` +
      `${icon} OEE: **${pct(r.avg_oee)}** | Avail: ${pct(r.avg_availability)} | Perf: ${pct(r.avg_performance)} | Quality: ${pct(r.avg_quality)}\n` +
      `📍 Line 1 OEE: **${pct(r.l1_oee)}** | Line 2 OEE: **${pct(r.l2_oee)}**\n` +
      `✅ Good Parts: **${f0(r.good_parts)}**  ❌ Scrap: **${f0(r.scrap_parts)}**\n` +
      `⛔ Stops: **${f0(r.stops)}** (${f0(r.stop_min)} min downtime)\n` +
      `⚡ Energy: **${f1(r.total_kwh)} kWh**\n` +
      `💧 Avg Water Flow: **${f1(r.avg_water_flow)} L/min**\n` +
      `🕐 Active Shift: **${r.dominant_shift || '—'}**  |  ${r.readings} readings\n\n` +
      `💡 _Ask "why is OEE low?" or "why is Line 1 performance low?" for root cause analysis_`;
  }

  // ── BY SHIFT (multiple rows) ───────────────────────────────────
  if (intent === 'by_shift' && rows.length > 1) {
    let out = `📊 **${METRIC_LABELS[metric]||metric} by Shift — ${pLabel}**\n\n`;
    const UNITS = { oee:'%', availability:'%', performance:'%', quality:'%', energy:' kWh', water:' L', production:' pcs', scrap:' pcs', stops:'' };
    rows.forEach(row => {
      const val = row.value ?? row.good_parts ?? row.scrap_parts ?? row.total_kwh ?? row.total_volume ?? row.stops ?? '—';
      const shift = row.shift || '—';
      const icon  = shift.includes('A')?'🌅':shift.includes('B')?'☀️':shift.includes('C')?'🌙':'🔄';
      out += `${icon} **${shift}**: ${f1(val)}${UNITS[metric]||''}\n`;
      if (row.readings)    out += `   Readings: ${row.readings}\n`;
      if (row.quality_pct) out += `   Quality: ${row.quality_pct}%\n`;
      if (row.scrap_pct)   out += `   Scrap Rate: ${row.scrap_pct}%\n`;
      if (row.avg_kw)      out += `   Avg kW: ${f1(row.avg_kw)} | PF: ${f2(row.avg_pf)}\n`;
    });
    const best = [...rows].sort((a,b) => parseFloat(b.value??b.good_parts??0)-parseFloat(a.value??a.good_parts??0))[0];
    if (best?.shift) out += `\n🏆 Best shift: **${best.shift}**`;
    return out;
  }

  // ── BY LINE ───────────────────────────────────────────────────
  if (intent === 'by_line' || parsed.line) {
    const l1v = parseFloat(r.line_1||0), l2v = parseFloat(r.line_2||0);
    const winner = l1v >= l2v ? 'Line 1' : 'Line 2';
    const loser  = l1v >= l2v ? 'Line 2' : 'Line 1';
    const diff   = Math.abs(l1v - l2v).toFixed(1);
    let out = `📊 **Line Comparison — ${METRIC_LABELS[metric]||metric} — ${pLabel}**\n\n` +
      `📍 Line 1: **${pct(r.line_1)}**\n` +
      `📍 Line 2: **${pct(r.line_2)}**\n` +
      `🏭 Plant Average: **${pct(r.plant_oee || r.line_1)}**\n\n`;
    if (parseFloat(diff) > 1) {
      out += `🏆 **${winner}** is performing better by **${diff}%**\n`;
      out += `⚠️ **${loser}** is underperforming — ask "why is ${loser} performance low?" for root cause analysis.`;
    } else {
      out += `✅ Both lines performing at similar levels.`;
    }
    if (r.stops) out += `\n\n⛔ Total stops: ${f0(r.stops)} (${f0(r.stop_min)} min downtime) — may be impacting the lower line.`;
    return out;
  }

  // ── OEE / AVAILABILITY / PERFORMANCE / QUALITY ───────────────
  if (['oee','availability','performance','quality'].includes(metric)) {
    const emoji = metric==='oee'?'🏭':metric==='availability'?'⏱️':metric==='performance'?'⚡':'✅';
    const val = parseFloat(r.avg_val||0);
    const color = val>=80?'🟢':val>=65?'🟡':'🔴';
    let out = `${emoji} **${METRIC_LABELS[metric]} — ${pLabel}**\n\n` +
      `${color} Average: **${pct(r.avg_val)}**\n` +
      `📈 Maximum: ${pct(r.max_val)}\n` +
      `📉 Minimum: ${pct(r.min_val)}\n`;
    if (r.l1_oee) out += `📍 Line 1 OEE: ${pct(r.l1_oee)} | Line 2 OEE: ${pct(r.l2_oee)}\n`;
    out += `🕐 Dominant shift: ${r.dominant_shift || '—'}\n` +
      `📊 Based on ${r.readings} readings`;
    if (val < 80) out += `\n\n💡 _Ask "why is ${METRIC_LABELS[metric]} low?" for a full root cause analysis_`;
    return out;
  }

  // ── PRODUCTION ───────────────────────────────────────────────
  if (metric === 'production') {
    const qpct = parseFloat(r.quality_pct||0);
    return `🏭 **Production — ${pLabel}**\n\n` +
      `✅ Good Parts: **${f0(r.good_parts)}**\n` +
      `❌ Scrap Parts: **${f0(r.scrap_parts)}**\n` +
      `📦 Total Parts: **${f0(r.total_parts)}**\n` +
      `${qpct>=95?'🟢':qpct>=90?'🟡':'🔴'} Quality Rate: **${f1(r.quality_pct)}%**\n` +
      `⛔ Stops: ${f0(r.total_stops)} (${f0(r.stop_minutes)} min lost)`;
  }

  // ── SCRAP ────────────────────────────────────────────────────
  if (metric === 'scrap') {
    const spct = parseFloat(r.scrap_pct||0);
    return `❌ **Scrap / Rejection — ${pLabel}**\n\n` +
      `Rejected Parts: **${f0(r.scrap_parts)}** of ${f0(r.total_parts)} total\n` +
      `${spct<=2?'🟢':spct<=5?'🟡':'🔴'} Scrap Rate: **${f1(r.scrap_pct)}%**` +
      (rows.length > 1 ? '\n\nBy Shift:\n' + rows.map(x=>`  ${x.shift}: ${f0(x.scrap_parts)} pcs (${f1(x.scrap_pct)}%)`).join('\n') : '') +
      `\n\n💡 _Ask "why is scrap rate high?" for root cause analysis_`;
  }

  // ── STOPS ────────────────────────────────────────────────────
  if (metric === 'stops') {
    const stops = parseInt(r.stops||0);
    const stopMin = parseInt(r.stop_minutes||0);
    return `⛔ **Stops / Downtime — ${pLabel}**\n\n` +
      `Number of Stops: **${f0(r.stops)}**\n` +
      `Total Downtime: **${f0(r.stop_minutes)} minutes**\n` +
      `Avg per Stop: ${stops>0?(stopMin/stops).toFixed(0):0} minutes\n` +
      `${stops>5?'🔴 High stop frequency — check machine health':'🟢 Stop frequency within normal range'}`;
  }

  // ── ENERGY ───────────────────────────────────────────────────
  if (metric === 'energy') {
    if (meter) {
      return `⚡ **Energy Meter ${meter} — ${pLabel}**\n\n` +
        `Total Consumed: **${f1(r.total_kwh)} kWh**\n` +
        `Avg Demand: ${f1(r.avg_kw)} kW\n` +
        `Peak Demand: ${f1(r.peak_kw)} kW\n` +
        `Avg Power Factor: ${f2(r.avg_pf)}\n` +
        `Avg Voltage: ${f1(r.avg_voltage)} V`;
    }
    return `⚡ **Energy Consumption — ${pLabel}**\n\n` +
      `Total: **${f1(r.total_kwh)} kWh**\n` +
      `Avg Demand: ${f1(r.avg_kw)} kW | Peak: ${f1(r.peak_kw)} kW\n\n` +
      `Per Meter:\n` +
      [1,2,3,4,5].map(i => `  EM${i}: ${f1(r[`em${i}_kwh`])} kWh`).join('\n');
  }

  // ── WATER ────────────────────────────────────────────────────
  if (metric === 'water') {
    if (meter) {
      return `💧 **Water Meter ${meter} — ${pLabel}**\n\n` +
        `Avg Flow: **${f1(r.avg_flow)} L/min**\n` +
        `Peak Flow: ${f1(r.peak_flow)} L/min\n` +
        `Total Volume: **${f1(r.total_volume)} L**`;
    }
    return `💧 **Water Consumption — ${pLabel}**\n\n` +
      `Combined Flow: **${f1(r.combined_flow)} L/min**\n\n` +
      `Per Meter Totalizer:\n` +
      [1,2,3,4,5].map(i => `  W${i}: ${f1(r[`w${i}_total`])} L`).join('\n');
  }

  // ── MACHINE ──────────────────────────────────────────────────
  if (metric === 'machine' || machine) {
    if (query.compare_machines) {
      const col = query.compare_col || 'vib';
      const vals = [1,2,3,4,5].map(i => ({ id:`M${i}`, val: parseFloat(r[`m${i}`]||0) }));
      const sorted = [...vals].sort((a,b) => intent==='get_best' ? a.val-b.val : b.val-a.val);
      return `🔧 **Machine ${intent==='get_best'?'Best':'Worst'} — ${col==='vib'?'Vibration':'Temperature'} — ${pLabel}**\n\n` +
        sorted.map((m,i) => `${i===0?'🏆':'  '}${i+1}. **${m.id}**: ${f1(m.val)} ${col==='vib'?'mm/s':'°C'}`).join('\n');
    }
    if (machine) {
      const statusEmoji = r.status==='OK'?'🟢':r.status==='WARN'||r.status==='WARNING'?'🟡':'🔴';
      return `🔧 **Machine ${machine} Health — ${pLabel}**\n\n` +
        `${statusEmoji} Status: **${r.status}** (${r.alert_count} alerts)\n` +
        `Vibration: ${f1(r.avg_vib)} mm/s (max: ${f1(r.max_vib)})\n` +
        `Temperature: ${f1(r.avg_temp)} °C (max: ${f1(r.max_temp)})\n` +
        `Bearing Temp: ${f1(r.avg_bearing)} °C\n` +
        `Current: ${f1(r.avg_current)} A\n` +
        `Speed: ${f0(r.avg_speed)} RPM`;
    }
    return `🔧 **All Machines — ${pLabel}**\n\n` +
      [1,2,3,4,5].map(i => {
        const st = r[`m${i}_status`] || '—';
        const e = st==='OK'?'🟢':st==='WARN'||st==='WARNING'?'🟡':'🔴';
        return `${e} M${i}: Vib ${f1(r[`m${i}_vib`])} mm/s | Temp ${f1(r[`m${i}_temp`])} °C | **${st}**`;
      }).join('\n');
  }

  // ── ALERTS ───────────────────────────────────────────────────
  if (metric === 'alerts') {
    const totalAlerts = [1,2,3,4,5].reduce((a,i) => a + parseInt(r[`m${i}_alerts`]||0), 0);
    return `🚨 **Machine Alerts — ${pLabel}**\n\n` +
      `Total ALERT events: **${totalAlerts}**\n` +
      `Total WARNING events: **${r.total_warnings}**\n\n` +
      [1,2,3,4,5].filter(i => parseInt(r[`m${i}_alerts`]||0) > 0)
        .map(i => `🔴 Machine ${i}: ${r[`m${i}_alerts`]} alerts`)
        .join('\n') || '✅ No machine alerts in this period.';
  }

  return `📊 Data retrieved for **${pLabel}**. Here's what I found: ${JSON.stringify(r).substring(0,300)}`;
}

const METRIC_LABELS = {
  oee:'OEE', availability:'Availability', performance:'Performance', quality:'Quality',
  production:'Production', scrap:'Scrap/Rejection', energy:'Energy', water:'Water',
  machine:'Machine Health', vibration:'Vibration', temperature:'Temperature',
  stops:'Stops/Downtime', alerts:'Machine Alerts', summary:'Plant Summary',
};

// ── MAIN: ANSWER A QUESTION ───────────────────────────────────────
async function answer(question, db) {
  try {
    const parsed = parseQuestion(question);

    // ── "Why" intent → run full diagnostic ──────────────────────
    if (parsed.intent === 'why') {
      const { row, period } = await runDiagnostic(db, parsed);
      if (!row || !row.readings) {
        return { ok: true, text: `📭 No data available for root cause analysis. Ensure Node-RED is writing data to the database.` };
      }
      const text = formatRootCause(parsed, row, period);
      return { ok: true, text, parsed, diagnostic: true };
    }

    // ── Standard query path ──────────────────────────────────────
    const query  = buildQuery(parsed);
    const result = await db.query(query.sql, query.params);
    const text   = formatAnswer(parsed, query, result.rows);
    return { ok: true, text, parsed, rows: result.rows.length };

  } catch(e) {
    console.error('[Facto-Bot] Error:', e.message);
    return {
      ok: false,
      text: `⚠️ I encountered an error: ${e.message}\n\nTry asking: "What is today's OEE?", "Why is Line 1 performance low?", or "Show machine health status".`
    };
  }
}

// ── SUGGESTED QUESTIONS (updated with why-type) ───────────────────
const SUGGESTIONS = [
  "Why is Line 1 performance low today?",
  "Why is OEE below target?",
  "What is today's OEE?",
  "Compare Line 1 and Line 2 performance",
  "Which machine has the highest vibration?",
  "Show energy consumption by shift",
  "What is the scrap rate today?",
  "How many stops happened today and why?",
  "What is current machine health status?",
  "Show me plant summary for last 8 hours",
];

module.exports = { answer, parseQuestion, SUGGESTIONS };
