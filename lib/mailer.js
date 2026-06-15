'use strict';
/**
 * mailer.js — Email delivery via Nodemailer
 * Supports any SMTP provider: Gmail, Outlook, custom
 */
const nodemailer = require('nodemailer');

let transporter = null;

// ── Build transporter from config ─────────────────────────────────
function buildTransporter(smtp) {
  transporter = nodemailer.createTransport({
    host:   smtp.host,
    port:   smtp.port || 587,
    secure: smtp.port === 465,
    auth:   { user: smtp.user, pass: smtp.pass },
    tls:    { rejectUnauthorized: false },
  });
  return transporter;
}

// ── Send plain alert email ────────────────────────────────────────
async function sendAlertEmail({ smtp, to, subject, rule, value, liveData }) {
  const t = buildTransporter(smtp);
  const fromName  = smtp.from_name  || 'Factory-MIOS';
  const fromEmail = smtp.from_email || smtp.user;

  const condLabels = { lt:'dropped below', lte:'dropped to or below', gt:'exceeded', gte:'reached or exceeded', eq:'equals' };
  const cond = condLabels[rule.condition] || rule.condition;
  const severity = (rule.severity||'warning').toUpperCase();
  const sevColor  = severity==='CRITICAL'?'#DC2626':severity==='WARNING'?'#B45309':'#2563EB';
  const sevEmoji  = severity==='CRITICAL'?'🔴':severity==='WARNING'?'🟡':'🔵';

  // Use custom message or default
  let msg = rule.message || `⚠️ OEE Alert! {signal} has {condition} the threshold of {threshold}.`;
  msg = msg
    .replace('{value}',     value)
    .replace('{signal}',    rule.signal)
    .replace('{threshold}', rule.threshold)
    .replace('{condition}', cond)
    .replace('{shift}',     liveData?.SHIFT||'—')
    .replace('{time}',      new Date().toLocaleString('en-IN'))
    .replace('{plant}',     liveData?.plant_name||'Plant');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#F1F5F9;padding:0;margin:0;">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.1);">

  <!-- HEADER -->
  <div style="background:#1B3A5C;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;">
    <div style="font-size:18px;font-weight:800;color:#fff;">OEE<span style="color:#60A5FA;">.</span>Platform</div>
    <div style="background:${sevColor};color:#fff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;">${sevEmoji} ${severity}</div>
  </div>

  <!-- ALERT TITLE -->
  <div style="padding:24px 28px 16px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:20px;font-weight:700;color:#1B3A5C;margin-bottom:6px;">${rule.name}</div>
    <div style="font-size:13px;color:#64748B;">${new Date().toLocaleString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
  </div>

  <!-- ALERT VALUE -->
  <div style="padding:20px 28px;background:#FEF2F2;border-bottom:1px solid #FECACA;">
    <div style="font-size:13px;color:#991B1B;margin-bottom:4px;">TRIGGERED CONDITION</div>
    <div style="font-size:32px;font-weight:800;color:${sevColor};">${value}</div>
    <div style="font-size:13px;color:#64748B;margin-top:4px;">${rule.signal} ${cond} ${rule.threshold}</div>
  </div>

  <!-- MESSAGE -->
  <div style="padding:20px 28px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:14px;color:#1E293B;line-height:1.6;">${msg}</div>
  </div>

  <!-- LIVE DATA SNAPSHOT -->
  <div style="padding:16px 28px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">Live Snapshot at Alert Time</div>
    <table style="width:100%;border-collapse:collapse;">
      ${[
        ['OEE',          (liveData?.PLANT_OEE||'—')+'%',          '#1B3A5C'],
        ['Availability', (liveData?.PLANT_AVAILABILITY||'—')+'%', '#1B3A5C'],
        ['Performance',  (liveData?.PLANT_PERFORMANCE||'—')+'%',  '#1B3A5C'],
        ['Quality',      (liveData?.PLANT_QUALITY||'—')+'%',      '#1B3A5C'],
        ['Shift',        liveData?.SHIFT||'—',                    '#1B3A5C'],
        ['Good Parts',   liveData?.TOTAL_GOOD||'—',               '#166534'],
        ['Scrap Parts',  liveData?.TOTAL_SCRAP||'—',              '#991B1B'],
      ].map(([k,v,c])=>`<tr><td style="padding:5px 0;font-size:12px;color:#64748B;width:50%">${k}</td><td style="font-weight:700;color:${c};font-size:12px;">${v}</td></tr>`).join('')}
    </table>
  </div>

  <!-- FOOTER -->
  <div style="padding:16px 28px;background:#F8FAFC;">
    <div style="font-size:11px;color:#94A3B8;">This alert was triggered by rule: <strong>${rule.id}</strong></div>
    <div style="font-size:11px;color:#94A3B8;margin-top:3px;">Cooldown: ${rule.cooldown} minutes | Next alert earliest at: ${new Date(Date.now()+rule.cooldown*60000).toLocaleTimeString('en-IN')}</div>
    <div style="margin-top:8px;"><a href="http://localhost:3000" style="font-size:12px;color:#2563EB;text-decoration:none;">→ Open OEE Dashboard</a></div>
  </div>
</div>
</body></html>`;

  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const info = await t.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to:      recipients,
    subject: `${sevEmoji} ${severity}: ${rule.name} — ${value}`,
    html,
  });
  console.log(`[Mail] ✅ Alert sent to ${recipients} — ${info.messageId}`);
  return info;
}

// ── Send scheduled report email ───────────────────────────────────
async function sendReportEmail({ smtp, to, cc, subject, schedule, reportHTML, reportBuffer, format }) {
  const t = buildTransporter(smtp);
  const fromName  = smtp.from_name  || 'Factory-MIOS';
  const fromEmail = smtp.from_email || smtp.user;

  const resolvedSubject = (subject || 'OEE Report — {date}')
    .replace('{plant}', schedule.plant_id || 'All Plants')
    .replace('{date}',  new Date().toLocaleDateString('en-IN'))
    .replace('{shift}', schedule.trigger_config?.shift || '')
    .replace('{type}',  schedule.report_type || 'OEE');

  const attachments = [];
  if (reportBuffer && (format === 'excel' || format === 'both')) {
    attachments.push({
      filename: `oee_${schedule.report_type}_${new Date().toISOString().slice(0,10)}.xlsx`,
      content:  reportBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  const emailHTML = format === 'html' || format === 'both'
    ? reportHTML
    : `<p style="font-family:Arial;color:#1B3A5C;">Please find the OEE report attached.</p><p style="font-size:12px;color:#94A3B8;">Generated by Factory-MIOS — Factory-MIOS</p>`;

  const info = await t.sendMail({
    from:        `"${fromName}" <${fromEmail}>`,
    to:          Array.isArray(to) ? to.join(', ') : to,
    cc:          Array.isArray(cc) ? cc.join(', ') : cc || undefined,
    subject:     resolvedSubject,
    html:        emailHTML,
    attachments,
  });
  console.log(`[Mail] ✅ Report sent to ${to} — ${info.messageId}`);
  return info;
}

// ── Send test email ───────────────────────────────────────────────
async function sendTestEmail({ smtp, to }) {
  const t = buildTransporter(smtp);
  await t.verify();
  const info = await t.sendMail({
    from:    `"${smtp.from_name||'Factory-MIOS'}" <${smtp.from_email||smtp.user}>`,
    to,
    subject: '✅ Factory-MIOS — Email Test Successful',
    html: `<div style="font-family:Arial;padding:24px;color:#1B3A5C;">
      <h2>✅ Email Configuration Working!</h2>
      <p style="margin-top:12px;">Your Factory-MIOS email alerts are correctly configured.</p>
      <p style="color:#64748B;font-size:12px;margin-top:16px;">Sent: ${new Date().toLocaleString('en-IN')}</p>
    </div>`,
  });
  return info;
}

// ── Send end-of-shift summary report email ────────────────────────
async function sendShiftReportEmail({ smtp, to, report }) {
  const t = buildTransporter(smtp);
  const fromName  = smtp.from_name  || 'Factory-MIOS';
  const fromEmail = smtp.from_email || smtp.user;

  const { shift, shiftDate, shiftLabel, machineId, oee, availability,
          performance, quality, attainment, partsProd, targetParts,
          goodParts, rejections, rejectRate, runningMin, downtimeMin,
          majorDownMin, minorDownMin, avgCycleSec, targetCycleSec,
          bestCycleSec, worstCycleSec, cycleEff, alarmCount,
          programs, downtimeEvents, stateBreakdown } = report;

  const shiftDur = 720; // 12-hour shift in minutes
  const runPct   = Math.round((runningMin / shiftDur) * 100);
  const dtPct    = Math.round((downtimeMin / shiftDur) * 100);

  function oeeColor(v) {
    return v >= 75 ? '#16A34A' : v >= 50 ? '#D97706' : '#DC2626';
  }
  function bar(pct, color) {
    const w = Math.min(100, Math.max(0, Math.round(pct)));
    return `<div style="background:#E2E8F0;border-radius:4px;height:10px;width:100%;overflow:hidden;">
      <div style="background:${color};height:10px;width:${w}%;border-radius:4px;"></div></div>`;
  }
  function kpi(label, value, unit='%', color='#1B3A5C') {
    return `<td style="text-align:center;padding:10px 8px;border-right:1px solid #E2E8F0;">
      <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">${label}</div>
      <div style="font-size:22px;font-weight:800;color:${color};">${value}<span style="font-size:13px;font-weight:400;">${unit}</span></div>
    </td>`;
  }

  const oeeVal  = parseFloat(oee  || 0).toFixed(1);
  const availVal = parseFloat(availability || 0).toFixed(1);
  const perfVal  = parseFloat(performance  || 0).toFixed(1);
  const qualVal  = parseFloat(quality      || 0).toFixed(1);
  const attVal   = parseFloat(attainment   || 0).toFixed(1);

  // Programs table rows
  const progRows = (programs || []).map(p =>
    `<tr style="border-bottom:1px solid #F1F5F9;">
      <td style="padding:7px 10px;font-size:13px;font-weight:600;color:#1B3A5C;">${p.program_no||'—'}</td>
      <td style="padding:7px 10px;font-size:13px;color:#334155;">${p.part_name||'—'}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:right;font-weight:700;color:#0F6E56;">${p.parts_made||0}</td>
      <td style="padding:7px 10px;font-size:12px;color:#64748B;">${parseFloat(p.avg_cycle||0).toFixed(1)}s</td>
    </tr>`
  ).join('');

  // Downtime events rows
  const dtRows = (downtimeEvents || []).slice(0, 5).map((d, i) =>
    `<tr style="border-bottom:1px solid #F1F5F9;">
      <td style="padding:6px 10px;font-size:12px;color:#64748B;">${i+1}</td>
      <td style="padding:6px 10px;font-size:13px;color:#334155;font-weight:500;">${d.reason||d.machine_state||'—'}</td>
      <td style="padding:6px 10px;font-size:13px;text-align:right;font-weight:700;color:#DC2626;">${d.duration_min||0} min</td>
      <td style="padding:6px 10px;font-size:12px;color:#64748B;">${d.start_time||'—'}</td>
    </tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>body{margin:0;padding:0;background:#F1F5F9;font-family:'Segoe UI',Arial,sans-serif;}
@media(max-width:600px){.main{width:100%!important;} .kpi-tbl td{padding:8px 4px!important;font-size:18px!important;}}</style>
</head>
<body>
<div style="max-width:620px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);" class="main">

  <!-- HEADER BAND -->
  <div style="background:linear-gradient(135deg,#1B3A5C 0%,#0F6E56 100%);padding:22px 28px;display:flex;align-items:center;justify-content:space-between;">
    <div>
      <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:.02em;">OEE<span style="color:#6EE7B7;">.</span>Platform</div>
      <div style="font-size:12px;color:#A7F3D0;margin-top:2px;">Factory-MIOS · ${machineId}</div>
    </div>
    <div style="text-align:right;">
      <div style="background:rgba(255,255,255,.15);color:#fff;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700;">${shiftLabel}</div>
      <div style="font-size:11px;color:#A7F3D0;margin-top:4px;">${shiftDate}</div>
    </div>
  </div>

  <!-- OEE HERO -->
  <div style="padding:20px 28px 0;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px;">Overall OEE Score</div>
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:14px;">
      <div style="font-size:56px;font-weight:900;line-height:1;color:${oeeColor(oeeVal)};">${oeeVal}<span style="font-size:24px;">%</span></div>
      <div style="flex:1;">
        ${bar(oeeVal, oeeColor(oeeVal))}
        <div style="margin-top:6px;font-size:12px;color:#64748B;">Parts Attainment: <strong style="color:#1B3A5C;">${attVal}%</strong> &nbsp;|&nbsp; Target: <strong>${targetParts||'—'}</strong> &nbsp;|&nbsp; Produced: <strong style="color:#0F6E56;">${partsProd||0}</strong></div>
      </div>
    </div>

    <!-- 4 KPI BAND -->
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E2E8F0;" class="kpi-tbl">
      <tr>
        ${kpi('Availability', availVal, '%', oeeColor(availVal))}
        ${kpi('Performance',  perfVal,  '%', oeeColor(perfVal))}
        ${kpi('Quality',      qualVal,  '%', oeeColor(qualVal))}
        ${kpi('Cycle Eff.',   parseFloat(cycleEff||0).toFixed(1), '%', '#185FA5')}
      </tr>
    </table>
  </div>

  <!-- PRODUCTION + QUALITY SECTION -->
  <div style="padding:16px 28px;border-bottom:1px solid #E2E8F0;background:#F8FAFC;">
    <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Production &amp; Quality</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:#64748B;margin-bottom:3px;">Parts Made</div>
        <div style="font-size:22px;font-weight:800;color:#0F6E56;">${partsProd||0}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:#64748B;margin-bottom:3px;">Good Parts</div>
        <div style="font-size:22px;font-weight:800;color:#166534;">${goodParts||0}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:#64748B;margin-bottom:3px;">Rejects</div>
        <div style="font-size:22px;font-weight:800;color:#DC2626;">${rejections||0}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:#64748B;margin-bottom:3px;">Reject Rate</div>
        <div style="font-size:22px;font-weight:800;color:${parseFloat(rejectRate||0)>2?'#DC2626':'#D97706'};">${parseFloat(rejectRate||0).toFixed(1)}%</div>
      </div>
    </div>
  </div>

  <!-- TIME ANALYSIS -->
  <div style="padding:16px 28px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Time Analysis (Shift = 720 min)</div>
    <div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
        <span style="color:#166534;font-weight:600;">Running: ${parseFloat(runningMin||0).toFixed(0)} min (${runPct}%)</span>
        <span style="color:#DC2626;font-weight:600;">Downtime: ${parseFloat(downtimeMin||0).toFixed(0)} min (${dtPct}%)</span>
      </div>
      <div style="background:#E2E8F0;border-radius:6px;height:14px;overflow:hidden;display:flex;">
        <div style="background:#16A34A;width:${runPct}%;height:14px;"></div>
        <div style="background:#DC2626;width:${dtPct}%;height:14px;"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px;">
      <div style="text-align:center;">
        <div style="font-size:10px;color:#64748B;">Avg Cycle</div>
        <div style="font-size:15px;font-weight:700;color:#1B3A5C;">${parseFloat(avgCycleSec||0).toFixed(1)}s</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:10px;color:#64748B;">Target Cycle</div>
        <div style="font-size:15px;font-weight:700;color:#185FA5;">${parseFloat(targetCycleSec||45).toFixed(0)}s</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:10px;color:#64748B;">Best Cycle</div>
        <div style="font-size:15px;font-weight:700;color:#0F6E56;">${parseFloat(bestCycleSec||0).toFixed(1)}s</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:10px;color:#64748B;">Alarms</div>
        <div style="font-size:15px;font-weight:700;color:${(alarmCount||0)>0?'#DC2626':'#16A34A'};">${alarmCount||0}</div>
      </div>
    </div>
    ${(majorDownMin||0) > 0 ? `<div style="margin-top:8px;font-size:12px;color:#64748B;">Major Downtime: <strong style="color:#991B1B;">${parseFloat(majorDownMin||0).toFixed(0)} min</strong> &nbsp;|&nbsp; Minor Stops: <strong>${parseFloat(minorDownMin||0).toFixed(0)} min</strong></div>` : ''}
  </div>

  <!-- PROGRAMS RUN -->
  ${progRows ? `<div style="padding:16px 28px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Programs Run This Shift</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#F8FAFC;">
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#64748B;font-weight:600;">Program</th>
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#64748B;font-weight:600;">Part Name</th>
        <th style="padding:7px 10px;text-align:right;font-size:11px;color:#64748B;font-weight:600;">Parts</th>
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#64748B;font-weight:600;">Avg Cycle</th>
      </tr>
      ${progRows}
    </table>
  </div>` : ''}

  <!-- TOP DOWNTIME EVENTS -->
  ${dtRows ? `<div style="padding:16px 28px;border-bottom:1px solid #E2E8F0;">
    <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Top Downtime Events</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr style="background:#FEF2F2;">
        <th style="padding:6px 10px;text-align:left;font-size:11px;color:#991B1B;font-weight:600;">#</th>
        <th style="padding:6px 10px;text-align:left;font-size:11px;color:#991B1B;font-weight:600;">Reason / State</th>
        <th style="padding:6px 10px;text-align:right;font-size:11px;color:#991B1B;font-weight:600;">Duration</th>
        <th style="padding:6px 10px;text-align:left;font-size:11px;color:#991B1B;font-weight:600;">Time</th>
      </tr>
      ${dtRows}
    </table>
  </div>` : ''}

  <!-- FOOTER -->
  <div style="padding:16px 28px;background:#F8FAFC;display:flex;align-items:center;justify-content:space-between;">
    <div>
      <div style="font-size:11px;color:#94A3B8;">Auto-generated by Factory-MIOS · Factory-MIOS</div>
      <div style="font-size:11px;color:#94A3B8;margin-top:2px;">Report for ${shiftDate} — ${shiftLabel}</div>
    </div>
    <a href="http://localhost:3000" style="background:#1B3A5C;color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;">Open Dashboard →</a>
  </div>

</div>
</body></html>`;

  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const shiftEmoji = shift === 'A' ? '🌅' : '🌙';
  const info = await t.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to:      recipients,
    subject: `${shiftEmoji} Shift ${shift} Report — ${shiftDate} | OEE ${oeeVal}% | ${partsProd} parts`,
    html,
  });
  console.log(`[Mail] ✅ Shift ${shift} report sent to ${recipients} — ${info.messageId}`);
  return info;
}

module.exports = { sendAlertEmail, sendReportEmail, sendTestEmail, sendShiftReportEmail };
