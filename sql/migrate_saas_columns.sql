-- ============================================================
-- MIGRATION: Add missing columns to saas_machines
-- Run this ONCE on your PostgreSQL server:
--   psql -h localhost -U postgres -d oee_db -f migrate_saas_columns.sql
-- ============================================================

-- 1. Add make, model, isa95_config to saas_machines
ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS make          TEXT;
ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS model         TEXT;
ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS isa95_config  JSONB;

-- 2. Add user_id to saas_audit_log (was user_email before)
ALTER TABLE saas_audit_log ADD COLUMN IF NOT EXISTS user_id      TEXT;

-- 3. Add permission tables (idempotent)
CREATE TABLE IF NOT EXISTS tenant_page_permissions (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT REFERENCES tenants(id) ON DELETE CASCADE,
  page_key   TEXT NOT NULL,
  page_label TEXT,
  enabled    BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, page_key)
);

CREATE TABLE IF NOT EXISTS tenant_kpi_permissions (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT REFERENCES tenants(id) ON DELETE CASCADE,
  kpi_key    TEXT NOT NULL,
  kpi_label  TEXT,
  enabled    BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, kpi_key)
);

-- 4. Seed Factory-MIOS Demo tenant (idempotent)
INSERT INTO tenants(id, name, slug, industry, contact_email, plan, max_plants, max_users)
VALUES(1, 'Factory-MIOS Demo', 'factory-mios-demo', 'Automotive', 'admin@factory-mios.local', 'pro', 10, 50)
ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, slug=EXCLUDED.slug, plan=EXCLUDED.plan;
SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1));

-- 5. Seed Demo Plant
INSERT INTO saas_plants(id, tenant_id, name, code, location, timezone)
VALUES(1, 1, 'Demo Plant', 'DEMO', 'Factory Site', 'Asia/Kolkata')
ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name;
SELECT setval('saas_plants_id_seq', GREATEST((SELECT MAX(id) FROM saas_plants), 1));

-- 6. Seed default page permissions for tenant 1
INSERT INTO tenant_page_permissions(tenant_id, page_key, page_label, enabled) VALUES
  (1,'dashboard',         'OEE Dashboard',        true),
  (1,'downtime-analysis', 'Downtime Analysis',     true),
  (1,'master-data',       'Master Data',           true),
  (1,'manual-entry',      'Manual Entry',          true),
  (1,'shift-log',         'Shift Log',             true),
  (1,'predictive',        'Predictive Maintenance',true),
  (1,'saas-platform',     'Platform Admin',        true)
ON CONFLICT(tenant_id, page_key) DO NOTHING;

-- 7. Seed default KPI permissions for tenant 1
INSERT INTO tenant_kpi_permissions(tenant_id, kpi_key, kpi_label, enabled) VALUES
  (1,'oee',          'OEE %',          true),
  (1,'availability', 'Availability %', true),
  (1,'performance',  'Performance %',  true),
  (1,'quality',      'Quality %',      true),
  (1,'parts',        'Parts Produced', true),
  (1,'downtime',     'Downtime Chart', true),
  (1,'cycle_time',   'Cycle Time',     true),
  (1,'alarms',       'Alarm Count',    true),
  (1,'spindle',      'Spindle Speed',  true),
  (1,'feed_rate',    'Feed Rate',      true)
ON CONFLICT(tenant_id, kpi_key) DO NOTHING;

-- Done
SELECT 'Migration complete ✅' AS status;
