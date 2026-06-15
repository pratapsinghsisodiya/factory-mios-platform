'use strict';
/**
 * predictive.js — AI Predictive Maintenance Engine
 * ──────────────────────────────────────────────────
 * Calculates:
 *   1. Machine Health Score (0-100)
 *   2. Z-score Anomaly Detection
 *   3. Remaining Useful Life (RUL) estimate
 *   4. Trend direction (improving/degrading/stable)
 *   5. Predictive alert recommendations
 */

// ── THRESHOLDS per signal (based on typical industrial ranges) ────
const THRESHOLDS = {
  vibration:    { warn: 6.0,  crit: 9.0,  max: 15.0  },
  temperature:  { warn: 75.0, crit: 88.0, max: 100.0 },
  bearing_temp: { warn: 80.0, crit: 90.0, max: 110.0 },
  current:      { warn: 55.0, crit: 65.0, max: 80.0  },
  coolant_temp: { warn: 45.0, crit: 55.0, max: 70.0  },
  air_pressure: { warn: 5.0,  crit: 4.0,  max: 8.0   }, // low pressure is bad
};

// ── HEALTH SCORE (0-100) per machine ─────────────────────────────
// Higher = healthier
function calcHealthScore(machineData) {
  const scores = [];

  const addScore = (val, thresholds, inverted = false) => {
    if (val == null || isNaN(val)) return;
    const { warn, crit, max } = thresholds;
    let s;
    if (!inverted) {
      if (val <= warn)      s = 100;
      else if (val <= crit) s = 100 - ((val - warn) / (crit - warn)) * 40;
      else                  s = Math.max(0, 60 - ((val - crit) / (max - crit)) * 60);
    } else {
      // Inverted: lower value = worse (e.g. air pressure)
      if (val >= warn)      s = 100;
      else if (val >= crit) s = 100 - ((warn - val) / (warn - crit)) * 40;
      else                  s = Math.max(0, 60 - ((crit - val) / crit) * 60);
    }
    scores.push(s);
  };

  addScore(parseFloat(machineData.vib),          THRESHOLDS.vibration);
  addScore(parseFloat(machineData.temp),         THRESHOLDS.temperature);
  addScore(parseFloat(machineData.bearing_temp), THRESHOLDS.bearing_temp);
  addScore(parseFloat(machineData.current),      THRESHOLDS.current);
  addScore(parseFloat(machineData.coolant_temp), THRESHOLDS.coolant_temp);
  addScore(parseFloat(machineData.air_pressure), THRESHOLDS.air_pressure, true);

  if (!scores.length) return 50;

  // Weighted average — vibration and temp have higher weight
  const weighted = scores.reduce((a, s, i) => a + s * (i < 2 ? 1.5 : 1.0), 0);
  const totalWeight = scores.length * 1.0 + Math.min(2, scores.length) * 0.5;
  return Math.round(weighted / totalWeight);
}

// ── STATUS from health score ──────────────────────────────────────
function healthStatus(score) {
  if (score >= 80) return { label: 'HEALTHY',   color: '#22C55E', bg: '#dcfce7' };
  if (score >= 60) return { label: 'WARNING',   color: '#F59E0B', bg: '#fef3c7' };
  if (score >= 40) return { label: 'CRITICAL',  color: '#EF4444', bg: '#fee2e2' };
  return              { label: 'FAILURE RISK', color: '#DC2626', bg: '#fecaca' };
}

// ── Z-SCORE ANOMALY DETECTION ─────────────────────────────────────
// Returns anomaly score (0 = normal, >2 = anomaly, >3 = severe)
function detectAnomalies(readings, field) {
  const values = readings.map(r => parseFloat(r[field])).filter(v => !isNaN(v));
  if (values.length < 5) return { score: 0, mean: 0, std: 0, latest: 0 };

  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const variance = values.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  const latest = values[values.length - 1];
  const score = std > 0 ? Math.abs(latest - mean) / std : 0;

  return { score: parseFloat(score.toFixed(2)), mean: parseFloat(mean.toFixed(2)), std: parseFloat(std.toFixed(2)), latest };
}

// ── TREND ANALYSIS ────────────────────────────────────────────────
// Returns 'rising' | 'falling' | 'stable'
function detectTrend(readings, field, window = 10) {
  const values = readings.slice(-window).map(r => parseFloat(r[field])).filter(v => !isNaN(v));
  if (values.length < 3) return 'stable';

  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));
  const firstAvg = firstHalf.reduce((a,v)=>a+v,0)/firstHalf.length;
  const secondAvg = secondHalf.reduce((a,v)=>a+v,0)/secondHalf.length;
  const diff = secondAvg - firstAvg;
  const threshold = firstAvg * 0.02; // 2% change = trend

  if (diff > threshold) return 'rising';
  if (diff < -threshold) return 'falling';
  return 'stable';
}

// ── REMAINING USEFUL LIFE ESTIMATE ───────────────────────────────
// Simple linear extrapolation based on degradation rate
function estimateRUL(readings, field, critThreshold) {
  const values = readings.slice(-20).map(r => parseFloat(r[field])).filter(v => !isNaN(v));
  if (values.length < 5) return null;

  const latest = values[values.length - 1];
  const oldest = values[0];
  if (latest >= critThreshold) return 0; // already critical

  // Linear rate per reading (assume 30s per reading)
  const rate = (latest - oldest) / values.length;
  if (rate <= 0) return 999; // not degrading

  const readingsToFail = (critThreshold - latest) / rate;
  const hoursToFail = (readingsToFail * 30) / 3600; // 30s per reading
  return Math.round(Math.max(0, hoursToFail));
}

// ── FULL MACHINE ANALYSIS ─────────────────────────────────────────
function analyzeMachine(machineId, readings) {
  if (!readings || !readings.length) return null;

  const latest = readings[readings.length - 1];
  const prefix = `m${machineId}_`;

  const machineData = {
    vib:          parseFloat(latest[`${prefix}vib`]),
    temp:         parseFloat(latest[`${prefix}temp`]),
    bearing_temp: parseFloat(latest[`${prefix}bearing_temp`]),
    current:      parseFloat(latest[`${prefix}current`]),
    speed:        parseFloat(latest[`${prefix}speed`]),
    coolant_temp: parseFloat(latest[`${prefix}coolant_temp`]),
    air_pressure: parseFloat(latest[`${prefix}air_pressure`]),
    status:       latest[`${prefix}status`] || '—',
  };

  const healthScore = calcHealthScore(machineData);
  const status      = healthStatus(healthScore);

  // Anomaly detection on key signals
  const anomalies = {
    vibration:    detectAnomalies(readings, `${prefix}vib`),
    temperature:  detectAnomalies(readings, `${prefix}temp`),
    bearing_temp: detectAnomalies(readings, `${prefix}bearing_temp`),
    current:      detectAnomalies(readings, `${prefix}current`),
  };

  // Trend analysis
  const trends = {
    vibration:    detectTrend(readings, `${prefix}vib`),
    temperature:  detectTrend(readings, `${prefix}temp`),
    bearing_temp: detectTrend(readings, `${prefix}bearing_temp`),
  };

  // RUL estimate
  const rul = {
    by_vibration:    estimateRUL(readings, `${prefix}vib`,          THRESHOLDS.vibration.crit),
    by_temperature:  estimateRUL(readings, `${prefix}temp`,         THRESHOLDS.temperature.crit),
    by_bearing_temp: estimateRUL(readings, `${prefix}bearing_temp`, THRESHOLDS.bearing_temp.crit),
  };

  // Worst-case RUL
  const rulValues = Object.values(rul).filter(v => v != null && v < 999);
  const minRUL    = rulValues.length ? Math.min(...rulValues) : null;

  // Recommendations
  const recommendations = [];
  if (anomalies.vibration.score > 2)   recommendations.push('🔧 High vibration anomaly detected — check bearing alignment');
  if (anomalies.temperature.score > 2)  recommendations.push('🌡️ Abnormal temperature spike — check cooling system');
  if (anomalies.bearing_temp.score > 2) recommendations.push('🔩 Bearing temperature anomaly — lubrication may be needed');
  if (anomalies.current.score > 2)      recommendations.push('⚡ Abnormal current draw — check motor load');
  if (trends.vibration === 'rising')    recommendations.push('📈 Vibration trending upward — schedule inspection');
  if (trends.temperature === 'rising')  recommendations.push('📈 Temperature trending upward — check cooling');
  if (minRUL != null && minRUL < 48)    recommendations.push(`⏰ Estimated ${minRUL}h until maintenance needed`);
  if (machineData.status === 'ALERT')   recommendations.push('🚨 Machine in ALERT state — immediate attention required');

  return {
    machine_id:      `M${machineId}`,
    health_score:    healthScore,
    status,
    current_values:  machineData,
    anomalies,
    trends,
    rul,
    min_rul_hours:   minRUL,
    recommendations,
    last_updated:    latest.time || new Date().toISOString(),
  };
}

// ── PLANT-WIDE ANALYSIS ───────────────────────────────────────────
function analyzePlant(readings) {
  const results = [];
  for (let i = 1; i <= 5; i++) {
    const analysis = analyzeMachine(i, readings);
    if (analysis) results.push(analysis);
  }

  const avgHealth = results.reduce((a, r) => a + r.health_score, 0) / (results.length || 1);
  const criticalMachines = results.filter(r => r.health_score < 60);
  const urgentRUL        = results.filter(r => r.min_rul_hours != null && r.min_rul_hours < 24);

  return {
    machines:          results,
    avg_health_score:  Math.round(avgHealth),
    critical_count:    criticalMachines.length,
    urgent_rul_count:  urgentRUL.length,
    generated_at:      new Date().toISOString(),
  };
}

module.exports = { analyzePlant, analyzeMachine, calcHealthScore, detectAnomalies, detectTrend, estimateRUL, healthStatus };
