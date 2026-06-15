#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-databases.sh
# Creates both databases and seeds them with realistic demo data
# Run as root: bash scripts/setup-databases.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Factory-MIOS — Database Setup"
echo "  Creates: oee_db (main) + delhi001_db (AC Manufacturing)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Create delhi001_db and user ───────────────────────────────────────────
echo "► Creating delhi001_db database and user..."
sudo -u postgres psql <<'PGSQL'
-- Create user if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'delhi001_user') THEN
    CREATE USER delhi001_user WITH PASSWORD 'delhi001_pass123';
    RAISE NOTICE 'Created user delhi001_user';
  ELSE
    ALTER USER delhi001_user WITH PASSWORD 'delhi001_pass123';
    RAISE NOTICE 'Updated password for delhi001_user';
  END IF;
END $$;

-- Create database if not exists
SELECT 'CREATE DATABASE delhi001_db OWNER delhi001_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'delhi001_db')\gexec

GRANT ALL PRIVILEGES ON DATABASE delhi001_db TO delhi001_user;
PGSQL

echo "✅ delhi001_db user ready"

# ── 2. Create tables in delhi001_db ──────────────────────────────────────────
echo ""
echo "► Creating TimescaleDB tables in delhi001_db..."
PGPASSWORD=delhi001_pass123 psql -h 127.0.0.1 -U delhi001_user -d delhi001_db <<'PGSQL'

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Line-level OEE readings ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_line_readings (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  line_id         TEXT          NOT NULL,
  line_name       TEXT,
  oee             NUMERIC(5,2),
  availability    NUMERIC(5,2),
  performance     NUMERIC(5,2),
  quality         NUMERIC(5,2),
  units_produced  INTEGER       DEFAULT 0,
  units_rejected  INTEGER       DEFAULT 0,
  downtime_min    NUMERIC(6,1)  DEFAULT 0,
  shift           TEXT          DEFAULT 'SHIFT_A'
);
SELECT create_hypertable('delhi001_line_readings','time',chunk_time_interval=>INTERVAL '1 hour',if_not_exists=>TRUE);
CREATE INDEX IF NOT EXISTS idx_d001_line_id_time ON delhi001_line_readings (line_id, time DESC);

-- ── Stage-level OEE readings ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_stage_readings (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  line_id         TEXT          NOT NULL,
  stage_id        TEXT          NOT NULL,
  stage_name      TEXT,
  oee             NUMERIC(5,2),
  availability    NUMERIC(5,2),
  performance     NUMERIC(5,2),
  quality         NUMERIC(5,2),
  units_produced  INTEGER       DEFAULT 0,
  units_rejected  INTEGER       DEFAULT 0,
  downtime_min    NUMERIC(6,1)  DEFAULT 0
);
SELECT create_hypertable('delhi001_stage_readings','time',chunk_time_interval=>INTERVAL '1 hour',if_not_exists=>TRUE);
CREATE INDEX IF NOT EXISTS idx_d001_stage_line_time ON delhi001_stage_readings (line_id, stage_id, time DESC);

-- ── Alarms ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_alarms (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  alarm_id        TEXT          NOT NULL,
  severity        TEXT          NOT NULL,
  line_id         TEXT,
  stage_id        TEXT,
  message         TEXT,
  oee             NUMERIC(5,2),
  acknowledged    BOOLEAN       DEFAULT FALSE,
  ack_time        TIMESTAMPTZ,
  ack_by          TEXT,
  CONSTRAINT delhi001_alarms_pkey PRIMARY KEY (alarm_id)
);
CREATE INDEX IF NOT EXISTS idx_d001_alarms_time ON delhi001_alarms (time DESC);

-- ── Energy readings (Schneider iEM3355) ───────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_energy (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  line_id         TEXT          NOT NULL,
  device          TEXT,
  kw              NUMERIC(8,3),
  kwh             NUMERIC(12,3),
  kvar            NUMERIC(8,3),
  voltage_rn      NUMERIC(6,1),
  current_r       NUMERIC(6,2),
  pf              NUMERIC(5,4),
  freq            NUMERIC(5,2),
  kva             NUMERIC(8,3)
);
SELECT create_hypertable('delhi001_energy','time',chunk_time_interval=>INTERVAL '1 hour',if_not_exists=>TRUE);
CREATE INDEX IF NOT EXISTS idx_d001_energy_line_time ON delhi001_energy (line_id, time DESC);

-- ── Water meter (Aichi Tokei) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_water (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  line_id         TEXT          NOT NULL,
  device          TEXT,
  flow_lpm        NUMERIC(8,2),
  flow_m3h        NUMERIC(8,4),
  total_liters    NUMERIC(12,1),
  total_m3        NUMERIC(10,3)
);
SELECT create_hypertable('delhi001_water','time',chunk_time_interval=>INTERVAL '1 hour',if_not_exists=>TRUE);
CREATE INDEX IF NOT EXISTS idx_d001_water_line_time ON delhi001_water (line_id, time DESC);

-- ── Reports ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delhi001_reports (
  time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  report_type     TEXT          NOT NULL,
  report_date     DATE          NOT NULL,
  shift           TEXT,
  plant_oee       NUMERIC(5,2),
  total_produced  INTEGER,
  total_rejects   INTEGER,
  fpy             NUMERIC(5,2),
  generated_by    TEXT          DEFAULT 'Node-RED OEE Engine'
);
CREATE INDEX IF NOT EXISTS idx_d001_reports_date ON delhi001_reports (report_date DESC);

PGSQL
echo "✅ Tables created in delhi001_db"

# ── 3. Seed demo data into delhi001_db (last 24h) ────────────────────────────
echo ""
echo "► Seeding 24h of demo data into delhi001_db..."
PGPASSWORD=delhi001_pass123 psql -h 127.0.0.1 -U delhi001_user -d delhi001_db <<'PGSQL'

-- Seed line readings — 5 lines × 144 readings (every 10 min for 24h)
DO $$
DECLARE
  i       INTEGER;
  ln      TEXT;
  lines   TEXT[] := ARRAY['L1','L2','L3','L4','L5'];
  lnames  TEXT[] := ARRAY['Compressor Assembly','Body & Cabinet','Condenser Assembly','Evaporator Assembly','Final QC & Packing'];
  shifts  TEXT[] := ARRAY['SHIFT_A','SHIFT_B','SHIFT_C'];
  t       TIMESTAMPTZ;
  oee     NUMERIC;
  avail   NUMERIC;
  perf    NUMERIC;
  qual    NUMERIC;
  prod    INTEGER;
  rej     INTEGER;
  down    NUMERIC;
  sh      TEXT;
  hr      INTEGER;
BEGIN
  FOR li IN 1..5 LOOP
    ln := lines[li];
    FOR i IN 0..143 LOOP
      t := NOW() - ((143-i) * INTERVAL '10 minutes');
      hr := EXTRACT(HOUR FROM t);
      -- Shift based on hour
      IF hr >= 6 AND hr < 14 THEN sh := 'SHIFT_A';
      ELSIF hr >= 14 AND hr < 22 THEN sh := 'SHIFT_B';
      ELSE sh := 'SHIFT_C';
      END IF;
      -- Realistic OEE with some variation per line
      avail := ROUND((80 + random()*16 + (li-1)*0.5)::numeric, 2);
      perf  := ROUND((75 + random()*18 + (li-1)*0.3)::numeric, 2);
      qual  := ROUND((92 + random()*7)::numeric, 2);
      oee   := ROUND((avail * perf * qual / 10000)::numeric, 2);
      prod  := (180 + (random()*80)::INTEGER);
      rej   := (random()*12)::INTEGER;
      down  := ROUND((random()*25)::numeric, 1);
      INSERT INTO delhi001_line_readings
        (time,line_id,line_name,oee,availability,performance,quality,units_produced,units_rejected,downtime_min,shift)
      VALUES (t, ln, lnames[li], oee, avail, perf, qual, prod, rej, down, sh);
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Seeded line_readings: 5 lines × 144 readings = 720 rows';
END $$;

-- Seed stage readings — L1+L2 × 5 stages × 144 readings
DO $$
DECLARE
  i        INTEGER;
  ln       TEXT;
  lines    TEXT[] := ARRAY['L1','L2','L3','L4','L5'];
  stages   TEXT[] := ARRAY['S1','S2','S3','S4','S5'];
  snames_L1 TEXT[] := ARRAY['Compressor Sub-Assembly','Refrigerant Brazing','N2 Leak Test','Vacuum Evacuation','Refrigerant Charging'];
  snames_L2 TEXT[] := ARRAY['Cabinet Press & Powder Coat','Foam Injection','Evaporator/Condenser Fit','Electrical & PCB','Final QC & Packing'];
  snames_L3 TEXT[] := ARRAY['Tube Bending & Cutting','Fin Stacking & Expansion','Header Brazing','Pressure Test & Degreasing','Paint & Inspection'];
  snames_L4 TEXT[] := ARRAY['Aluminium Fin Pressing','Tube Insert & Expansion','Header & Distributor Braze','Leak & Pressure Test','Coating & Final Check'];
  snames_L5 TEXT[] := ARRAY['Unit Assembly Line-Off','Performance Testing','Safety & Electrical Test','Cosmetic Inspection AOI','Packing & Dispatch'];
  t         TIMESTAMPTZ;
  oee       NUMERIC;
  avail     NUMERIC;
  perf      NUMERIC;
  qual      NUMERIC;
  sname     TEXT;
BEGIN
  FOR li IN 1..5 LOOP
    ln := lines[li];
    FOR si IN 1..5 LOOP
      FOR i IN 0..143 LOOP
        t    := NOW() - ((143-i) * INTERVAL '10 minutes');
        avail := ROUND((78 + random()*18)::numeric, 2);
        perf  := ROUND((74 + random()*20)::numeric, 2);
        qual  := ROUND((91 + random()*8)::numeric, 2);
        oee   := ROUND((avail*perf*qual/10000)::numeric, 2);
        IF li=1 THEN sname := snames_L1[si];
        ELSIF li=2 THEN sname := snames_L2[si];
        ELSIF li=3 THEN sname := snames_L3[si];
        ELSIF li=4 THEN sname := snames_L4[si];
        ELSE sname := snames_L5[si];
        END IF;
        INSERT INTO delhi001_stage_readings
          (time,line_id,stage_id,stage_name,oee,availability,performance,quality,units_produced,units_rejected,downtime_min)
        VALUES (t, ln, stages[si], sname, oee, avail, perf, qual,
                (150+random()*100)::INTEGER, (random()*10)::INTEGER, ROUND((random()*20)::numeric,1));
      END LOOP;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Seeded stage_readings: 5 lines × 5 stages × 144 = 3600 rows';
END $$;

-- Seed energy readings — 5 lines × 144 readings
DO $$
DECLARE i INTEGER; ln TEXT; lines TEXT[] := ARRAY['L1','L2','L3','L4','L5']; t TIMESTAMPTZ;
BEGIN
  FOR li IN 1..5 LOOP
    ln := lines[li];
    FOR i IN 0..143 LOOP
      t := NOW() - ((143-i) * INTERVAL '10 minutes');
      INSERT INTO delhi001_energy (time,line_id,device,kw,kwh,kvar,voltage_rn,current_r,pf,freq,kva)
      VALUES (t, ln, 'Schneider_iEM3355_'||ln,
        ROUND((80+random()*50)::numeric,3),
        ROUND((1000+(li*200)+random()*500)::numeric,3),
        ROUND((10+random()*20)::numeric,3),
        ROUND((228+random()*10)::numeric,1),
        ROUND((4+random()*3)::numeric,2),
        ROUND((0.91+random()*0.06)::numeric,4),
        ROUND((49.8+random()*0.4)::numeric,2),
        ROUND((90+random()*55)::numeric,3));
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Seeded energy: 5 lines × 144 = 720 rows';
END $$;

-- Seed water meter readings
DO $$
DECLARE i INTEGER; ln TEXT; lines TEXT[] := ARRAY['L1','L2','L3','L4','L5']; t TIMESTAMPTZ; total NUMERIC := 0;
BEGIN
  FOR li IN 1..5 LOOP
    ln := lines[li]; total := 0;
    FOR i IN 0..143 LOOP
      t := NOW() - ((143-i) * INTERVAL '10 minutes');
      total := total + ROUND((5+random()*15)::numeric,1);
      INSERT INTO delhi001_water (time,line_id,device,flow_lpm,flow_m3h,total_liters,total_m3)
      VALUES (t, ln, 'Aichi_Tokei_EMF_'||ln,
        ROUND((5+random()*15)::numeric,2),
        ROUND((0.3+random()*0.9)::numeric,4),
        ROUND(total::numeric,1),
        ROUND((total/1000)::numeric,3));
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Seeded water: 5 lines × 144 = 720 rows';
END $$;

-- Seed alarms
INSERT INTO delhi001_alarms (time,alarm_id,severity,line_id,stage_id,message,oee,acknowledged) VALUES
  (NOW()-INTERVAL '2 hours',  'A001','WARNING', 'L1','S2','Brazing temp trending high: 718°C (limit 720°C)',78.4,false),
  (NOW()-INTERVAL '5 hours',  'A002','CRITICAL','L3','S3','Header brazing furnace temp drop: 562°C (min 580°C)',61.2,true),
  (NOW()-INTERVAL '8 hours',  'A003','WARNING', 'L2','S1','Powder coat thickness below spec: 58μm (min 60μm)',72.1,true),
  (NOW()-INTERVAL '1 hour',   'A004','INFO',    'L4','S4','Leak test cycle time +8% above baseline',82.3,false),
  (NOW()-INTERVAL '30 minutes','A005','WARNING', 'L5','S2','EER reading 3.18 below spec (min 3.2)',79.6,false),
  (NOW()-INTERVAL '4 hours',  'A006','CRITICAL','L1','S4','Vacuum pump time exceeded: 28 min (max 25 min)',63.4,true),
  (NOW()-INTERVAL '15 minutes','A007','INFO',   'L2','S4','PCB temp 56°C (warn threshold 55°C)',84.1,false);

-- Seed shift reports
INSERT INTO delhi001_reports (time,report_type,report_date,shift,plant_oee,total_produced,total_rejects,fpy,generated_by) VALUES
  (NOW()-INTERVAL '2 hours', 'SHIFT','2026-04-28','SHIFT_A',81.4,1240,42,96.6,'Node-RED OEE Engine v2.0'),
  (NOW()-INTERVAL '1 day',   'SHIFT','2026-04-27','SHIFT_A',79.8,1180,56,95.3,'Node-RED OEE Engine v2.0'),
  (NOW()-INTERVAL '1 day',   'SHIFT','2026-04-27','SHIFT_B',77.2,1150,68,94.1,'Node-RED OEE Engine v2.0'),
  (NOW()-INTERVAL '1 day',   'SHIFT','2026-04-27','SHIFT_C',74.6,980,55,94.4,'Node-RED OEE Engine v2.0'),
  (NOW()-INTERVAL '1 day',   'DAILY','2026-04-27','ALL',77.2,3310,179,94.6,'Node-RED OEE Engine v2.0'),
  (NOW()-INTERVAL '2 days',  'DAILY','2026-04-26','ALL',80.1,3480,140,96.0,'Node-RED OEE Engine v2.0');

SELECT 'delhi001_db seeded successfully' AS status;
SELECT tablename, (SELECT COUNT(*) FROM delhi001_line_readings  WHERE tablename='delhi001_line_readings' LIMIT 1) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'delhi001%';
\echo ''
\echo 'Row counts:'
SELECT 'delhi001_line_readings'  AS tbl, COUNT(*) AS rows FROM delhi001_line_readings
UNION ALL SELECT 'delhi001_stage_readings', COUNT(*) FROM delhi001_stage_readings
UNION ALL SELECT 'delhi001_energy',         COUNT(*) FROM delhi001_energy
UNION ALL SELECT 'delhi001_water',          COUNT(*) FROM delhi001_water
UNION ALL SELECT 'delhi001_alarms',         COUNT(*) FROM delhi001_alarms
UNION ALL SELECT 'delhi001_reports',        COUNT(*) FROM delhi001_reports;

PGSQL

echo ""
echo "✅ delhi001_db seeded with 24h of demo data"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Databases ready:"
echo "  oee_db       → oee_user      / oee_pass123      (Main OEE)"
echo "  delhi001_db  → delhi001_user / delhi001_pass123  (AC Mfg)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Next: pm2 restart oee-dashboard"
echo ""
