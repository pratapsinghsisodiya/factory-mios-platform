'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const ASSIGNMENTS_PATH = path.join(CONFIG_DIR, 'tenant_module_assignments.json');
const KPI_PATH = path.join(CONFIG_DIR, 'kpi_config.json');
const DASHBOARD_PATH = path.join(CONFIG_DIR, 'published-dashboards.json');

const COMMON_SHIFT_TEMPLATES = [
  { name: 'Shift A', label: 'Morning', start: '06:00', end: '14:00', planned_min: 480, break_min: 30 },
  { name: 'Shift B', label: 'Afternoon', start: '14:00', end: '22:00', planned_min: 480, break_min: 30 },
  { name: 'Shift C', label: 'Night', start: '22:00', end: '06:00', planned_min: 480, break_min: 30 },
];

const MODULE_TEMPLATES = {
  realtime_monitoring: {
    key: 'realtime_monitoring',
    name: 'Real-Time Monitoring',
    description: 'Live equipment, line, and plant monitoring with status, alarms, and trends.',
    pages: ['dashboard', 'machine-live', 'operator', 'supervisor', 'connectivity'],
    tags: [
      tag('machine_state', 'Machine State', 'status', '', 'machine', 'Live running/idle/alarm state'),
      tag('is_running', 'Is Running', 'boolean', '', 'machine', 'True when machine is producing'),
      tag('alarm_active', 'Alarm Active', 'boolean', '', 'machine', 'True when active alarm exists'),
      tag('cycle_time_sec', 'Cycle Time', 'number', 'sec', 'machine', 'Last cycle time'),
      tag('parts_count', 'Parts Count', 'counter', 'parts', 'machine', 'Cumulative part counter'),
    ],
    shift_calculations: [
      calc('runtime_min', 'Runtime Minutes', 'sum_duration_where', 'min', { state_field: 'is_running', equals: true }),
      calc('parts_produced', 'Parts Produced', 'delta_counter', 'parts', { field: 'parts_count' }),
      calc('alarm_count', 'Alarm Count', 'count_events', 'events', { field: 'alarm_active', equals: true }),
    ],
    dashboards: [dashboard('realtime-overview', 'Real-Time Monitoring Overview', 'Live machine status, parts, alarms, and runtime.', ['machine_state', 'parts_count', 'runtime_min', 'alarm_count'])],
  },
  production_oee: {
    key: 'production_oee',
    name: 'Production OEE',
    description: 'OEE, availability, performance, quality, target-vs-actual production.',
    pages: ['dashboard', 'oee-drilldown', 'reports', 'shift-log', 'shift-input'],
    tags: [
      tag('availability_pct', 'Availability', 'number', '%', 'oee', 'Availability percentage'),
      tag('performance_pct', 'Performance', 'number', '%', 'oee', 'Performance percentage'),
      tag('quality_pct', 'Quality', 'number', '%', 'oee', 'Quality percentage'),
      tag('oee_pct', 'OEE', 'number', '%', 'oee', 'Overall Equipment Effectiveness'),
      tag('target_parts', 'Target Parts', 'number', 'parts', 'production', 'Shift target production'),
      tag('good_parts', 'Good Parts', 'counter', 'parts', 'quality', 'Good part count'),
      tag('rejected_parts', 'Rejected Parts', 'counter', 'parts', 'quality', 'Rejected part count'),
    ],
    shift_calculations: [
      calc('oee_pct', 'OEE %', 'formula', '%', { formula: 'availability_pct * performance_pct * quality_pct / 10000' }),
      calc('parts_attainment_pct', 'Parts Attainment', 'formula', '%', { formula: 'parts_produced / target_parts * 100' }),
      calc('rejection_rate_pct', 'Rejection Rate', 'formula', '%', { formula: 'rejected_parts / (good_parts + rejected_parts) * 100' }),
    ],
    dashboards: [dashboard('production-oee', 'Production OEE Dashboard', 'OEE, production attainment, and quality by shift.', ['oee_pct', 'availability_pct', 'performance_pct', 'quality_pct'])],
  },
  ems: {
    key: 'ems',
    name: 'Energy Management System (EMS)',
    description: 'Energy consumption, demand, power quality, and shift-wise kWh accounting.',
    pages: ['dashboard', 'reports', 'parameter-report', 'alerts', 'widgets'],
    tags: [
      tag('kwh_total', 'Energy Totalizer', 'counter', 'kWh', 'energy', 'Cumulative imported energy totalizer'),
      tag('kw', 'Active Power', 'number', 'kW', 'energy', 'Instantaneous active power'),
      tag('kva', 'Apparent Power', 'number', 'kVA', 'energy', 'Instantaneous apparent power'),
      tag('power_factor', 'Power Factor', 'number', 'PF', 'energy', 'Power factor'),
      tag('voltage_ll', 'Line Voltage', 'number', 'V', 'energy', 'Line-to-line voltage'),
      tag('current_avg', 'Average Current', 'number', 'A', 'energy', 'Average current'),
    ],
    shift_calculations: [
      calc('kwh_consumption_shift', 'Shift kWh Consumption', 'delta_counter', 'kWh', { field: 'kwh_total', note: 'max(kwh_total) - min(kwh_total) within shift' }),
      calc('max_demand_kw_shift', 'Shift Maximum Demand', 'max', 'kW', { field: 'kw' }),
      calc('avg_power_factor_shift', 'Average Power Factor', 'avg', 'PF', { field: 'power_factor' }),
      calc('specific_energy_kwh_per_part', 'Specific Energy', 'formula', 'kWh/part', { formula: 'kwh_consumption_shift / parts_produced' }),
    ],
    dashboards: [dashboard('ems-overview', 'EMS Energy Dashboard', 'Shift kWh, demand, PF, and specific energy.', ['kwh_consumption_shift', 'max_demand_kw_shift', 'avg_power_factor_shift', 'specific_energy_kwh_per_part'])],
  },
  wms: {
    key: 'wms',
    name: 'Water Management System (WMS)',
    description: 'Water flow, totalizer, consumption, and shift-wise water accounting.',
    pages: ['dashboard', 'reports', 'parameter-report', 'alerts', 'widgets'],
    tags: [
      tag('water_totalizer', 'Water Totalizer', 'counter', 'm3', 'water', 'Cumulative water totalizer'),
      tag('water_flow', 'Water Flow', 'number', 'm3/h', 'water', 'Instantaneous flow'),
      tag('water_pressure', 'Water Pressure', 'number', 'bar', 'water', 'Line pressure'),
      tag('water_level', 'Tank Level', 'number', '%', 'water', 'Tank level percentage'),
      tag('water_quality_tds', 'TDS', 'number', 'ppm', 'water', 'Water quality TDS'),
    ],
    shift_calculations: [
      calc('water_consumption_shift', 'Shift Water Consumption', 'delta_counter', 'm3', { field: 'water_totalizer', note: 'max(water_totalizer) - min(water_totalizer) within shift' }),
      calc('avg_water_flow_shift', 'Average Flow', 'avg', 'm3/h', { field: 'water_flow' }),
      calc('specific_water_m3_per_part', 'Specific Water', 'formula', 'm3/part', { formula: 'water_consumption_shift / parts_produced' }),
    ],
    dashboards: [dashboard('wms-overview', 'WMS Water Dashboard', 'Shift water consumption, flow, pressure, and quality.', ['water_consumption_shift', 'avg_water_flow_shift', 'water_pressure', 'water_quality_tds'])],
  },
  utilities: {
    key: 'utilities',
    name: 'Utilities Monitoring',
    description: 'Compressed air, gas, steam, HVAC, pumps, chillers, and auxiliary utility monitoring.',
    pages: ['dashboard', 'reports', 'alerts', 'predictive', 'digital-twin'],
    tags: [
      tag('air_pressure', 'Compressed Air Pressure', 'number', 'bar', 'utility', 'Compressed air header pressure'),
      tag('air_flow', 'Compressed Air Flow', 'number', 'Nm3/h', 'utility', 'Compressed air flow'),
      tag('gas_totalizer', 'Gas Totalizer', 'counter', 'Nm3', 'utility', 'Gas cumulative totalizer'),
      tag('steam_flow', 'Steam Flow', 'number', 'TPH', 'utility', 'Steam flow rate'),
      tag('chiller_temp', 'Chiller Temperature', 'number', 'C', 'utility', 'Chilled water temperature'),
    ],
    shift_calculations: [
      calc('gas_consumption_shift', 'Shift Gas Consumption', 'delta_counter', 'Nm3', { field: 'gas_totalizer' }),
      calc('avg_air_pressure_shift', 'Average Air Pressure', 'avg', 'bar', { field: 'air_pressure' }),
      calc('avg_air_flow_shift', 'Average Air Flow', 'avg', 'Nm3/h', { field: 'air_flow' }),
    ],
    dashboards: [dashboard('utilities-overview', 'Utilities Dashboard', 'Compressed air, gas, steam, and chiller utility overview.', ['gas_consumption_shift', 'avg_air_pressure_shift', 'avg_air_flow_shift', 'chiller_temp'])],
  },
  quality: {
    key: 'quality',
    name: 'Quality Intelligence',
    description: 'Rejections, defects, quality trends, and quality alerts.',
    pages: ['quality-entry', 'rejection-log', 'reports', 'dashboard'],
    tags: [
      tag('defect_count', 'Defect Count', 'number', 'defects', 'quality', 'Defects recorded'),
      tag('rejection_reason', 'Rejection Reason', 'text', '', 'quality', 'Reason/category for rejection'),
      tag('quality_gate_status', 'Quality Gate Status', 'status', '', 'quality', 'Pass/fail/rework state'),
    ],
    shift_calculations: [calc('defect_count_shift', 'Shift Defects', 'sum', 'defects', { field: 'defect_count' })],
    dashboards: [dashboard('quality-overview', 'Quality Dashboard', 'Defects, rejection trends, and quality status.', ['defect_count_shift', 'rejection_reason', 'quality_gate_status'])],
  },
  downtime: {
    key: 'downtime',
    name: 'Downtime & RCA',
    description: 'Downtime logging, RCA, reason analysis, and escalation.',
    pages: ['downtime-log', 'downtime-analysis', 'reports', 'alerts'],
    tags: [
      tag('downtime_reason', 'Downtime Reason', 'text', '', 'downtime', 'Reason code or text'),
      tag('downtime_duration_min', 'Downtime Duration', 'number', 'min', 'downtime', 'Downtime duration'),
      tag('rca_status', 'RCA Status', 'status', '', 'downtime', 'Open/in-progress/closed'),
    ],
    shift_calculations: [calc('downtime_min_shift', 'Shift Downtime', 'sum', 'min', { field: 'downtime_duration_min' })],
    dashboards: [dashboard('downtime-overview', 'Downtime Dashboard', 'Downtime minutes, reasons, and RCA status.', ['downtime_min_shift', 'downtime_reason', 'rca_status'])],
  },
};

function tag(key, label, type, unit, category, description) {
  return { key, label, type, unit, category, description, required: false, source_field: '', device_id: '', tag_path: '' };
}

function calc(key, label, method, unit, config) {
  return { key, label, method, unit, config };
}

function dashboard(slug, name, description, metrics) {
  return {
    slug,
    name,
    description,
    visibility: 'tenant',
    widgets: metrics.slice(0, 9).map((metric, idx) => ({ zone: idx, type: 'configured-metric', title: metric, metric_key: metric })),
    columns: 3,
    theme: { icon: '🏭', preset: 'dark', accentColor: '#00d4ff' },
  };
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  ensureConfigDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function listModuleTemplates() {
  return Object.values(MODULE_TEMPLATES).map(t => ({
    key: t.key,
    name: t.name,
    description: t.description,
    pages: t.pages,
    tags: t.tags,
    shift_calculations: t.shift_calculations,
    dashboards: t.dashboards.map(d => ({ slug: d.slug, name: d.name, description: d.description })),
  }));
}

function mergeUnique(items, keyFn = x => x) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildTenantConfig(input = {}) {
  const tenant = input.tenant || {};
  const modules = (input.modules && input.modules.length ? input.modules : ['realtime_monitoring', 'production_oee']).filter(m => MODULE_TEMPLATES[m]);
  const selected = modules.map(m => MODULE_TEMPLATES[m]);
  const shifts = input.shifts && input.shifts.length ? input.shifts : COMMON_SHIFT_TEMPLATES;
  const pages = mergeUnique(selected.flatMap(m => m.pages).concat(input.pages || []));
  const tags = mergeUnique(selected.flatMap(m => m.tags).concat(input.tags || []), t => t.key);
  const shift_calculations = mergeUnique(selected.flatMap(m => m.shift_calculations).concat(input.shift_calculations || []), c => c.key);
  const dashboards = selected.flatMap(m => m.dashboards).concat(input.dashboards || []);

  return {
    tenant_id: String(tenant.id || tenant.tenant_id || tenant.slug || 'demo-tenant'),
    tenant_name: tenant.name || 'Demo Tenant',
    tenant_slug: tenant.slug || String(tenant.name || 'demo-tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    modules,
    pages,
    tags,
    shifts,
    shift_calculations,
    dashboards,
    users: input.users || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function previewTenantOnboarding(input = {}) {
  return buildTenantConfig(input);
}

function applyTenantOnboarding(input = {}) {
  const cfg = buildTenantConfig(input);
  const store = readJson(ASSIGNMENTS_PATH, { tenants: [] });
  const idx = store.tenants.findIndex(t => String(t.tenant_id) === String(cfg.tenant_id) || t.tenant_slug === cfg.tenant_slug);
  if (idx >= 0) store.tenants[idx] = { ...store.tenants[idx], ...cfg, updated_at: new Date().toISOString() };
  else store.tenants.push(cfg);
  writeJson(ASSIGNMENTS_PATH, store);

  seedKpis(cfg);
  seedDashboards(cfg);
  return cfg;
}

function seedKpis(cfg) {
  const kpiStore = readJson(KPI_PATH, { _comment: 'Factory-MIOS — Saved KPI definitions. Auto-managed by /api/kpi endpoints.', kpis: [] });
  kpiStore.kpis = kpiStore.kpis || [];
  for (const tagDef of cfg.tags) {
    const id = `${cfg.tenant_slug}_${tagDef.key}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (kpiStore.kpis.some(k => k.id === id)) continue;
    kpiStore.kpis.push({
      id,
      name: tagDef.label,
      plant_id: cfg.tenant_slug,
      device_id: tagDef.device_id || '',
      param_field: tagDef.source_field || tagDef.key,
      widget_type: tagDef.type === 'counter' || tagDef.type === 'number' ? 'kpi_card' : 'status',
      unit: tagDef.unit || '',
      aggregation: tagDef.type === 'counter' ? 'delta' : tagDef.type === 'number' ? 'avg' : 'last',
      category: tagDef.category,
      tenant_id: cfg.tenant_id,
      tenant_slug: cfg.tenant_slug,
      created_at: new Date().toISOString(),
    });
  }
  writeJson(KPI_PATH, kpiStore);
}

function seedDashboards(cfg) {
  const dashboards = readJson(DASHBOARD_PATH, []);
  for (const dash of cfg.dashboards) {
    const slug = `${cfg.tenant_slug}-${dash.slug}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    if (dashboards.some(d => d.slug === slug)) continue;
    dashboards.push({
      ...dash,
      slug,
      name: `${cfg.tenant_name} · ${dash.name}`,
      tenant_id: cfg.tenant_id,
      tenant_slug: cfg.tenant_slug,
      published_at: new Date().toISOString(),
      url: '/view/' + slug,
    });
  }
  writeJson(DASHBOARD_PATH, dashboards);
}

module.exports = {
  MODULE_TEMPLATES,
  COMMON_SHIFT_TEMPLATES,
  listModuleTemplates,
  previewTenantOnboarding,
  applyTenantOnboarding,
};
