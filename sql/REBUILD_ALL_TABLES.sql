-- ═══════════════════════════════════════════════════════════════════════
--  FACTORY-MIOS — COMPLETE DATABASE REBUILD
--  Database : cnc_db
--  Run once on VM:
--    PGPASSWORD=cnc_pass123 psql -U cnc_user -h 127.0.0.1 -d cnc_db -f REBUILD_ALL_TABLES.sql
--
--  What this creates:
--    1.  cnc_data         → Raw Industrial CNC data (TimescaleDB hypertable, Node-RED writes here)
--    2.  plant_readings   → Plant-level utility / OEE data (legacy, kept for history)
--    3.  program_master   → Part / program reference data
--    4.  cnc_downtime_log → Operator-entered downtime
--    5.  cnc_rejection_log→ Operator-entered rejections
--    6.  cnc_shift_log    → Shift start/handover log
--    7.  shift_targets    → Shift production targets
--    8.  downtime_events  → Inline downtime capture
--    9.  defect_events    → Inline defect capture
--    10. oee_results      → Pre-calculated OEE per shift (upserted every 5 min)
--    11. oee_summary      → Materialized OEE snapshot
--    Functions & Views    → calc_oee, populate_oee_shift, populate_oee_today,
--                           refresh_oee_summary, v_oee_shifts, v_oee_daily,
--                           v_oee_current, v_oee_detail, v_oee_daily_summary
--
--  Node-RED SQL Builder must write to: cnc_data (time column, machine_id='MACHINE001')
-- ═══════════════════════════════════════════════════════════════════════

-- Ensure TimescaleDB extension is enabled
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Drop legacy empty table
DROP TABLE IF EXISTS machine_live CASCADE;

-- ════════════════════════════════════════════════════════════════════════
--  1. cnc_data  —  PRIMARY RAW DATA TABLE  (Node-RED writes every 5 sec)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cnc_data (
  time                  TIMESTAMPTZ   NOT NULL,          -- timestamp (IST, with +05:30)
  machine_id            TEXT          NOT NULL DEFAULT 'MACHINE001',

  -- Connection / State
  status                TEXT,                            -- 'OK' / 'ERROR' / 'CONNECTING'
  connection_status     TEXT,                            -- 'CONNECTED' / 'DISCONNECTED'
  machine_state         TEXT,                            -- 'RUNNING' / 'STOPPED' / 'ALARM'
  auto_mode             TEXT,                            -- 'AUTO' / 'MDI' / 'JOG'
  run_status            TEXT,                            -- 'START' / 'STOP' / 'HOLD'
  is_running            BOOLEAN       DEFAULT false,
  emergency             BOOLEAN       DEFAULT false,
  alarm_active          BOOLEAN       DEFAULT false,
  motion_status         TEXT,                            -- 'CUTTING' / 'NO-MOTION' / 'DWELL'

  -- Program / Alarm
  program_no            INTEGER       DEFAULT 0,
  alarm_no              INTEGER       DEFAULT 0,

  -- Machine Parameters
  feed_rate             NUMERIC(10,2) DEFAULT 0,         -- mm/min
  spindle_speed         NUMERIC(10,2) DEFAULT 0,         -- RPM

  -- Cycle Tracking (from Node-RED function node)
  raw_cycle_time_sec    NUMERIC(10,2) DEFAULT 0,
  part_count            INTEGER       DEFAULT 0,
  last_cycle_time_sec   NUMERIC(10,2) DEFAULT 0,
  idle_time_sec         NUMERIC(10,2) DEFAULT 0
);

-- Convert to TimescaleDB hypertable (skip if already hypertable)
SELECT create_hypertable('cnc_data', 'time', if_not_exists => TRUE);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_cnc_data_machine_time ON cnc_data (machine_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_data_state        ON cnc_data (machine_state, time DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_data_alarm        ON cnc_data (alarm_active, time DESC);


-- ════════════════════════════════════════════════════════════════════════
--  2. plant_readings  —  Plant-level utility data (EM/Water/Machine health)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plant_readings (
  time              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  shift             TEXT,
  elapsed_min       FLOAT,
  remaining_min     FLOAT,

  -- OEE Metrics
  plant_oee           FLOAT,
  plant_availability  FLOAT,
  plant_performance   FLOAT,
  plant_quality       FLOAT,
  l1_oee  FLOAT, l1_avail FLOAT, l1_perf FLOAT, l1_qual FLOAT,
  l2_oee  FLOAT, l2_avail FLOAT, l2_perf FLOAT, l2_qual FLOAT,

  -- Production
  total_good      INTEGER,
  total_scrap     INTEGER,
  total_parts     INTEGER,
  total_stops     INTEGER,
  total_stop_min  INTEGER,

  -- Energy Meters EM1–EM5
  em1_kw FLOAT, em1_kwh FLOAT, em1_pf FLOAT, em1_voltage FLOAT,
  em2_kw FLOAT, em2_kwh FLOAT, em2_pf FLOAT, em2_voltage FLOAT,
  em3_kw FLOAT, em3_kwh FLOAT, em3_pf FLOAT, em3_voltage FLOAT,
  em4_kw FLOAT, em4_kwh FLOAT, em4_pf FLOAT, em4_voltage FLOAT,
  em5_kw FLOAT, em5_kwh FLOAT, em5_pf FLOAT, em5_voltage FLOAT,

  -- Water Meters W1–W5
  w1_flow FLOAT, w1_total FLOAT,
  w2_flow FLOAT, w2_total FLOAT,
  w3_flow FLOAT, w3_total FLOAT,
  w4_flow FLOAT, w4_total FLOAT,
  w5_flow FLOAT, w5_total FLOAT,

  -- Machine Health M1–M5
  m1_vib FLOAT, m1_temp FLOAT, m1_bearing_temp FLOAT,
  m1_current FLOAT, m1_speed FLOAT, m1_coolant_temp FLOAT,
  m1_air_pressure FLOAT, m1_status TEXT,

  m2_vib FLOAT, m2_temp FLOAT, m2_bearing_temp FLOAT,
  m2_current FLOAT, m2_speed FLOAT, m2_coolant_temp FLOAT,
  m2_air_pressure FLOAT, m2_status TEXT,

  m3_vib FLOAT, m3_temp FLOAT, m3_bearing_temp FLOAT,
  m3_current FLOAT, m3_speed FLOAT, m3_coolant_temp FLOAT,
  m3_air_pressure FLOAT, m3_status TEXT,

  m4_vib FLOAT, m4_temp FLOAT, m4_bearing_temp FLOAT,
  m4_current FLOAT, m4_speed FLOAT, m4_coolant_temp FLOAT,
  m4_air_pressure FLOAT, m4_status TEXT,

  m5_vib FLOAT, m5_temp FLOAT, m5_bearing_temp FLOAT,
  m5_current FLOAT, m5_speed FLOAT, m5_coolant_temp FLOAT,
  m5_air_pressure FLOAT, m5_status TEXT
);

SELECT create_hypertable('plant_readings', 'time', if_not_exists => TRUE);


-- ════════════════════════════════════════════════════════════════════════
--  3. program_master  —  Part / Program reference
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS program_master (
  program_no        INTEGER       PRIMARY KEY,
  part_name         TEXT          NOT NULL,
  part_number       TEXT,
  target_cycle_sec  NUMERIC(8,2)  DEFAULT 44,
  material          TEXT,
  machine_id        TEXT          DEFAULT 'MACHINE001',
  description       TEXT,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- Seed default program
INSERT INTO program_master (program_no, part_name, part_number, target_cycle_sec, machine_id)
VALUES (2, 'Hobbing Part – O00002', 'O00002', 44, 'MACHINE001')
ON CONFLICT (program_no) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════
--  4. cnc_downtime_log  —  Operator-entered downtime events
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cnc_downtime_log (
  id            BIGSERIAL     PRIMARY KEY,
  machine_id    TEXT          DEFAULT 'MACHINE001',
  shift_date    DATE          NOT NULL,
  shift         CHAR(1)       NOT NULL,
  start_time    TIMESTAMPTZ   NOT NULL,
  end_time      TIMESTAMPTZ,
  duration_min  NUMERIC(8,2),
  type          TEXT          CHECK(type IN ('PLANNED','UNPLANNED')),
  reason_code   TEXT,
  reason_detail TEXT,
  operator_name TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnc_dt_machine ON cnc_downtime_log (machine_id, shift_date DESC);


-- ════════════════════════════════════════════════════════════════════════
--  5. cnc_rejection_log  —  Operator-entered quality / rejection data
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cnc_rejection_log (
  id               BIGSERIAL   PRIMARY KEY,
  machine_id       TEXT        DEFAULT 'MACHINE001',
  shift_date       DATE        NOT NULL,
  shift            CHAR(1)     NOT NULL,
  log_hour         INTEGER,
  program_no       INTEGER,
  good_parts       INTEGER     DEFAULT 0,
  rejected_parts   INTEGER     DEFAULT 0,
  rejection_reason TEXT,
  operator_name    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnc_rej_machine ON cnc_rejection_log (machine_id, shift_date DESC);


-- ════════════════════════════════════════════════════════════════════════
--  6. cnc_shift_log  —  Shift handover / start log
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cnc_shift_log (
  id            BIGSERIAL   PRIMARY KEY,
  machine_id    TEXT        DEFAULT 'MACHINE001',
  shift_date    DATE        NOT NULL,
  shift         CHAR(1)     NOT NULL,
  operator_name TEXT,
  supervisor    TEXT,
  program_no    INTEGER,
  target_parts  INTEGER     DEFAULT 920,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, shift_date, shift)
);


-- ════════════════════════════════════════════════════════════════════════
--  7. shift_targets  —  Planned production targets per shift
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shift_targets (
  id                  SERIAL        PRIMARY KEY,
  plant_id            TEXT          NOT NULL DEFAULT 'plant_1',
  shift_date          DATE          NOT NULL,
  shift               TEXT          NOT NULL,
  operator_name       TEXT          NOT NULL,
  target_production   INTEGER,
  ideal_cycle_sec     NUMERIC(8,2),
  planned_production  INTEGER,
  actual_production   INTEGER,
  notes               TEXT,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (plant_id, shift_date, shift)
);


-- ════════════════════════════════════════════════════════════════════════
--  8. downtime_events  —  Inline operator downtime capture
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS downtime_events (
  id            SERIAL        PRIMARY KEY,
  plant_id      TEXT          NOT NULL DEFAULT 'plant_1',
  shift_date    DATE          NOT NULL,
  shift         TEXT          NOT NULL,
  operator_name TEXT          NOT NULL,
  start_time    TIMESTAMPTZ,
  end_time      TIMESTAMPTZ,
  duration_min  NUMERIC(8,2)  NOT NULL,
  category      TEXT          NOT NULL CHECK (category IN ('MINOR','MAJOR')),
  reason_code   TEXT          NOT NULL,
  reason_detail TEXT,
  machine_id    TEXT,
  logged_at     TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_downtime_shift ON downtime_events (plant_id, shift_date, shift);


-- ════════════════════════════════════════════════════════════════════════
--  9. defect_events  —  Inline operator defect/rejection capture
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS defect_events (
  id            SERIAL        PRIMARY KEY,
  plant_id      TEXT          NOT NULL DEFAULT 'plant_1',
  shift_date    DATE          NOT NULL,
  shift         TEXT          NOT NULL,
  operator_name TEXT          NOT NULL,
  defect_count  INTEGER       NOT NULL,
  defect_type   TEXT          NOT NULL,
  defect_reason TEXT,
  line_id       TEXT,
  machine_id    TEXT,
  logged_at     TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_defect_shift ON defect_events (plant_id, shift_date, shift);


-- ════════════════════════════════════════════════════════════════════════
--  10. oee_results  —  Pre-calculated OEE per shift (upserted every 5 min)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS oee_results (
  id                  BIGSERIAL     PRIMARY KEY,
  machine_id          TEXT          NOT NULL DEFAULT 'MACHINE001',
  shift_date          DATE          NOT NULL,
  shift               CHAR(1)       NOT NULL CHECK (shift IN ('A','B')),
  shift_start         TIMESTAMPTZ   NOT NULL,
  shift_end           TIMESTAMPTZ   NOT NULL,

  -- OEE Components (%)
  oee                 NUMERIC(6,2)  DEFAULT 0,
  availability        NUMERIC(6,2)  DEFAULT 0,
  performance         NUMERIC(6,2)  DEFAULT 0,
  quality             NUMERIC(6,2)  DEFAULT 100,

  -- Time Buckets (seconds)
  net_available_sec   NUMERIC(10,1) DEFAULT 40500,
  running_sec         NUMERIC(10,1) DEFAULT 0,
  downtime_sec        NUMERIC(10,1) DEFAULT 0,
  producing_sec       NUMERIC(10,1) DEFAULT 0,
  minor_stop_sec      NUMERIC(10,1) DEFAULT 0,
  idle_sec            NUMERIC(10,1) DEFAULT 0,

  -- Downtime Classification
  major_downtime_sec  NUMERIC(10,1) DEFAULT 0,
  minor_downtime_sec  NUMERIC(10,1) DEFAULT 0,
  downtime_min        NUMERIC(8,1)  DEFAULT 0,
  major_downtime_min  NUMERIC(8,1)  DEFAULT 0,
  minor_downtime_min  NUMERIC(8,1)  DEFAULT 0,
  running_min         NUMERIC(8,1)  DEFAULT 0,

  -- Production
  parts_produced      INT           DEFAULT 0,
  target_parts        INT           DEFAULT 900,
  parts_attainment    NUMERIC(6,2)  DEFAULT 0,
  rejection_count     INT           DEFAULT 0,
  good_parts          INT           DEFAULT 0,
  scrap_rate          NUMERIC(6,2)  DEFAULT 0,

  -- Cycle Time
  target_cycle_sec    NUMERIC(6,2)  DEFAULT 45,
  avg_cycle_sec       NUMERIC(8,2)  DEFAULT 0,
  best_cycle_sec      NUMERIC(8,2)  DEFAULT 0,
  worst_cycle_sec     NUMERIC(8,2)  DEFAULT 0,
  cycle_efficiency    NUMERIC(6,2)  DEFAULT 0,

  -- Alarms
  alarm_count         INT           DEFAULT 0,
  alarm_duration_sec  NUMERIC(10,1) DEFAULT 0,

  -- Metadata
  rows_count          BIGINT        DEFAULT 0,
  calculated_at       TIMESTAMPTZ   DEFAULT NOW(),

  UNIQUE (machine_id, shift_date, shift)
);

CREATE INDEX IF NOT EXISTS idx_oee_results_date  ON oee_results (shift_date DESC);
CREATE INDEX IF NOT EXISTS idx_oee_results_mach  ON oee_results (machine_id, shift_date DESC);


-- ════════════════════════════════════════════════════════════════════════
--  11. oee_summary  —  Materialized OEE snapshot (refreshed every 5 min)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS oee_summary (
  id               BIGSERIAL     PRIMARY KEY,
  machine_id       TEXT          NOT NULL DEFAULT 'MACHINE001',
  shift_date       DATE          NOT NULL,
  shift            CHAR(1)       NOT NULL CHECK (shift IN ('A','B')),
  shift_start      TIMESTAMPTZ   NOT NULL,
  shift_end        TIMESTAMPTZ   NOT NULL,
  running_sec      NUMERIC(10,1),
  downtime_sec     NUMERIC(10,1),
  producing_sec    NUMERIC(10,1),
  minor_stop_sec   NUMERIC(10,1),
  idle_sec         NUMERIC(10,1),
  parts_produced   INT,
  target_parts     INT           DEFAULT 900,
  availability     NUMERIC(6,2),
  performance      NUMERIC(6,2),
  quality          NUMERIC(6,2)  DEFAULT 100,
  oee              NUMERIC(6,2),
  rows_count       BIGINT,
  calculated_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (machine_id, shift_date, shift)
);


-- ════════════════════════════════════════════════════════════════════════
--  12. OEE CALCULATION FUNCTION  —  calc_oee(machine, from, to)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION calc_oee(
  p_machine_id        TEXT,
  p_from              TIMESTAMPTZ,
  p_to                TIMESTAMPTZ,
  p_target_cycle_sec  NUMERIC DEFAULT 45,
  p_net_available_sec NUMERIC DEFAULT 40500
)
RETURNS TABLE (
  running_sec      NUMERIC,
  downtime_sec     NUMERIC,
  producing_sec    NUMERIC,
  minor_stop_sec   NUMERIC,
  idle_sec         NUMERIC,
  parts_produced   INT,
  availability     NUMERIC,
  performance      NUMERIC,
  quality          NUMERIC,
  oee              NUMERIC,
  rows_count       BIGINT
)
LANGUAGE SQL STABLE AS $$
  WITH
  raw AS (
    SELECT
      time,
      machine_state,
      spindle_speed,
      feed_rate,
      raw_cycle_time_sec,
      idle_time_sec,
      part_count,
      LAG(time)               OVER (ORDER BY time) AS prev_ts,
      LAG(machine_state)      OVER (ORDER BY time) AS prev_state,
      LAG(spindle_speed)      OVER (ORDER BY time) AS prev_spindle,
      LAG(feed_rate)          OVER (ORDER BY time) AS prev_feed,
      LAG(raw_cycle_time_sec) OVER (ORDER BY time) AS prev_raw_cycle,
      LAG(idle_time_sec)      OVER (ORDER BY time) AS prev_idle_sec
    FROM cnc_data
    WHERE machine_id = p_machine_id
      AND time >= p_from
      AND time <  p_to
  ),
  gaps AS (
    SELECT
      EXTRACT(EPOCH FROM (time - prev_ts))::NUMERIC AS gap_sec,
      CASE
        -- No previous row (first reading)
        WHEN prev_ts IS NULL
          THEN 'FIRST'
        -- Gap > 10 min = data missing, skip this interval
        WHEN EXTRACT(EPOCH FROM (time - prev_ts)) > 600
          THEN 'SKIP'
        -- Machine not in RUNNING state = hard downtime
        WHEN UPPER(COALESCE(prev_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
          THEN 'DOWNTIME'
        -- idle_time_sec incrementing = Industrial CNC controller is counting idle → treat as downtime
        WHEN COALESCE(idle_time_sec, 0) > COALESCE(prev_idle_sec, 0)
          THEN 'DOWNTIME'
        -- raw_cycle_time_sec incrementing = machine actively cutting a part
        WHEN COALESCE(raw_cycle_time_sec, 0) > COALESCE(prev_raw_cycle, 0)
          THEN 'PRODUCING'
        -- Running but spindle=0 AND feed=0 = minor stop (setup, tool change, wait)
        WHEN COALESCE(prev_spindle, 0) = 0 AND COALESCE(prev_feed, 0) = 0
          THEN 'MINOR_STOP'
        -- Running, cutting timer not incrementing, spindle/feed present = between cycles
        ELSE 'IDLE'
      END AS state
    FROM raw
  ),
  agg AS (
    SELECT
      -- IDLE counted as downtime per plant requirement (machine running but not producing = availability loss)
      COALESCE(SUM(CASE WHEN state IN ('PRODUCING','MINOR_STOP') THEN gap_sec END), 0) AS running_sec,
      COALESCE(SUM(CASE WHEN state IN ('DOWNTIME','IDLE')        THEN gap_sec END), 0) AS downtime_sec,
      COALESCE(SUM(CASE WHEN state = 'PRODUCING'  THEN gap_sec END), 0) AS producing_sec,
      COALESCE(SUM(CASE WHEN state = 'MINOR_STOP' THEN gap_sec END), 0) AS minor_stop_sec,
      COALESCE(SUM(CASE WHEN state = 'IDLE'       THEN gap_sec END), 0) AS idle_sec,
      COUNT(*) FILTER (WHERE state NOT IN ('FIRST','SKIP'))               AS rows_count
    FROM gaps
  ),
  parts AS (
    SELECT GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT)) AS parts_produced
    FROM cnc_data
    WHERE machine_id = p_machine_id AND time >= p_from AND time < p_to
  )
  SELECT
    a.running_sec, a.downtime_sec, a.producing_sec, a.minor_stop_sec, a.idle_sec,
    p.parts_produced,
    ROUND(LEAST(100, LEAST(a.running_sec, p_net_available_sec) / NULLIF(p_net_available_sec,0) * 100), 2) AS availability,
    ROUND(LEAST(100, CASE WHEN a.running_sec > 0 THEN p.parts_produced * p_target_cycle_sec / a.running_sec * 100 ELSE 0 END), 2) AS performance,
    100.00 AS quality,
    ROUND(
      LEAST(100, LEAST(a.running_sec, p_net_available_sec) / NULLIF(p_net_available_sec,0) * 100)
      * LEAST(100, CASE WHEN a.running_sec > 0 THEN p.parts_produced * p_target_cycle_sec / a.running_sec * 100 ELSE 0 END)
      / 100, 2
    ) AS oee,
    a.rows_count
  FROM agg a, parts p;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  13. SHIFT OEE VIEW  —  v_oee_shifts (last 14 days, both shifts)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_oee_shifts AS
WITH shift_bounds AS (
  SELECT d::date AS shift_date, 'A'::TEXT AS shift,
    (d::date::text || 'T07:00:00+05:30')::TIMESTAMPTZ AS shift_start,
    (d::date::text || 'T19:00:00+05:30')::TIMESTAMPTZ AS shift_end
  FROM generate_series((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 13,
                       (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '1 day'::interval) AS d
  UNION ALL
  SELECT d::date AS shift_date, 'B'::TEXT AS shift,
    (d::date::text || 'T19:00:00+05:30')::TIMESTAMPTZ AS shift_start,
    ((d::date + 1)::text || 'T07:00:00+05:30')::TIMESTAMPTZ AS shift_end
  FROM generate_series((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 13,
                       (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '1 day'::interval) AS d
)
SELECT
  sb.shift_date, sb.shift, sb.shift_start, sb.shift_end,
  oee.running_sec, oee.downtime_sec, oee.producing_sec,
  oee.minor_stop_sec, oee.idle_sec, oee.parts_produced,
  oee.availability, oee.performance, oee.quality, oee.oee,
  oee.rows_count,
  ROUND(oee.running_sec  / 60, 1) AS running_min,
  ROUND(oee.downtime_sec / 60, 1) AS downtime_min,
  CASE
    WHEN oee.oee >= 80 THEN 'WORLD CLASS'
    WHEN oee.oee >= 65 THEN 'ACCEPTABLE'
    WHEN oee.oee >  0  THEN 'NEEDS IMPROVEMENT'
    ELSE 'NO DATA'
  END AS oee_grade
FROM shift_bounds sb
CROSS JOIN LATERAL calc_oee('MACHINE001', sb.shift_start, sb.shift_end) AS oee
WHERE oee.rows_count > 0
ORDER BY sb.shift_date DESC, sb.shift;


-- ════════════════════════════════════════════════════════════════════════
--  14. DAILY OEE VIEW  —  v_oee_daily
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_oee_daily AS
SELECT
  shift_date AS day,
  SUM(running_sec)                       AS running_sec,
  SUM(downtime_sec)                      AS downtime_sec,
  SUM(parts_produced)                    AS parts_produced,
  ROUND(LEAST(SUM(running_sec), 81000) / 81000 * 100, 2) AS availability,
  ROUND(LEAST(100, CASE WHEN SUM(running_sec)>0
    THEN SUM(parts_produced)*45/SUM(running_sec)*100 ELSE 0 END), 2) AS performance,
  100.00 AS quality,
  ROUND(
    LEAST(SUM(running_sec),81000)/81000*100
    * LEAST(100, CASE WHEN SUM(running_sec)>0
        THEN SUM(parts_produced)*45/SUM(running_sec)*100 ELSE 0 END)
    / 100, 2) AS oee,
  SUM(rows_count) AS total_rows
FROM v_oee_shifts
GROUP BY shift_date
ORDER BY shift_date DESC;


-- ════════════════════════════════════════════════════════════════════════
--  15. CURRENT SHIFT VIEW  —  v_oee_current
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_oee_current AS
WITH bounds AS (
  SELECT
    CASE WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
              AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
         THEN 'A' ELSE 'B' END AS current_shift,
    CASE WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
              AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
         THEN DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata')
                AT TIME ZONE 'Asia/Kolkata' + INTERVAL '7 hours'
         WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 7
         THEN DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata' - INTERVAL '1 day')
                AT TIME ZONE 'Asia/Kolkata' + INTERVAL '19 hours'
         ELSE DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata')
                AT TIME ZONE 'Asia/Kolkata' + INTERVAL '19 hours'
    END AS shift_start,
    NOW() AS shift_end
)
SELECT b.current_shift AS shift, b.shift_start, b.shift_end, oee.*
FROM bounds b
CROSS JOIN LATERAL calc_oee('MACHINE001', b.shift_start, b.shift_end) AS oee;


-- ════════════════════════════════════════════════════════════════════════
--  16. populate_oee_shift  —  Upserts one shift into oee_results
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION populate_oee_shift(
  p_machine   TEXT    DEFAULT 'MACHINE001',
  p_date      DATE    DEFAULT CURRENT_DATE,
  p_shift     CHAR(1) DEFAULT 'A'
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_start         TIMESTAMPTZ;
  v_end           TIMESTAMPTZ;
  v_net           NUMERIC := 40500;
  v_target_cycle  NUMERIC := 45;
  v_target_parts  INT     := 900;
  v_running_sec       NUMERIC := 0;
  v_downtime_sec      NUMERIC := 0;
  v_producing_sec     NUMERIC := 0;
  v_minor_stop_sec    NUMERIC := 0;
  v_idle_sec          NUMERIC := 0;
  v_alarm_dur_sec     NUMERIC := 0;
  v_rows              BIGINT  := 0;
  v_parts_produced    INT := 0;
  v_rejection_count   INT := 0;
  v_good_parts        INT := 0;
  v_avg_cycle         NUMERIC := 0;
  v_best_cycle        NUMERIC := 0;
  v_worst_cycle       NUMERIC := 0;
  v_alarm_count       INT := 0;
  v_availability      NUMERIC := 0;
  v_performance       NUMERIC := 0;
  v_quality           NUMERIC := 100;
  v_oee               NUMERIC := 0;
  v_eff_avail         NUMERIC;
BEGIN
  IF p_shift = 'A' THEN
    v_start := (p_date::text || 'T07:00:00+05:30')::TIMESTAMPTZ;
    v_end   := (p_date::text || 'T19:00:00+05:30')::TIMESTAMPTZ;
  ELSE
    v_start := (p_date::text       || 'T19:00:00+05:30')::TIMESTAMPTZ;
    v_end   := ((p_date + 1)::text || 'T07:00:00+05:30')::TIMESTAMPTZ;
  END IF;

  SELECT COUNT(*) INTO v_rows
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end;

  IF v_rows = 0 THEN
    RETURN 'NO DATA for ' || p_date || ' Shift ' || p_shift;
  END IF;

  WITH raw AS (
    SELECT time, machine_state, spindle_speed, feed_rate,
           raw_cycle_time_sec, idle_time_sec, alarm_active,
           LAG(time)               OVER(ORDER BY time) AS prev_ts,
           LAG(machine_state)      OVER(ORDER BY time) AS prev_state,
           LAG(spindle_speed)      OVER(ORDER BY time) AS prev_spindle,
           LAG(feed_rate)          OVER(ORDER BY time) AS prev_feed,
           LAG(raw_cycle_time_sec) OVER(ORDER BY time) AS prev_raw,
           LAG(idle_time_sec)      OVER(ORDER BY time) AS prev_idle
    FROM cnc_data
    WHERE machine_id = p_machine AND time >= v_start AND time < v_end
  ),
  gaps AS (
    SELECT
      EXTRACT(EPOCH FROM(time - prev_ts))::NUMERIC AS gap,
      CASE
        WHEN prev_ts IS NULL THEN 'FIRST'
        WHEN EXTRACT(EPOCH FROM(time - prev_ts)) > 600 THEN 'SKIP'
        -- machine not in a running/auto state = hard downtime
        WHEN UPPER(COALESCE(prev_state,'')) NOT IN ('RUNNING','AUTO','BUSY') THEN 'DOWNTIME'
        -- Industrial CNC idle_time_sec counter ticking up = machine itself tracking idle → downtime
        WHEN COALESCE(idle_time_sec,0) > COALESCE(prev_idle,0) THEN 'DOWNTIME'
        -- cycle timer counting up = actively cutting
        WHEN COALESCE(raw_cycle_time_sec,0) > COALESCE(prev_raw,0) THEN 'PRODUCING'
        -- no spindle, no feed = minor stop (tool change, setup, load/unload)
        WHEN COALESCE(prev_spindle,0)=0 AND COALESCE(prev_feed,0)=0 THEN 'MINOR_STOP'
        ELSE 'IDLE'
      END AS state,
      alarm_active
    FROM raw
  )
  SELECT
    COALESCE(SUM(CASE WHEN state IN('PRODUCING','MINOR_STOP') THEN gap END),0),
    COALESCE(SUM(CASE WHEN state IN('DOWNTIME','IDLE')        THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'PRODUCING'  THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'MINOR_STOP' THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'IDLE'       THEN gap END),0),
    COALESCE(SUM(CASE WHEN alarm_active THEN gap ELSE 0 END),0),
    COUNT(*) FILTER(WHERE alarm_active)
  INTO v_running_sec, v_downtime_sec, v_producing_sec,
       v_minor_stop_sec, v_idle_sec, v_alarm_dur_sec, v_alarm_count
  FROM gaps
  WHERE state NOT IN ('FIRST','SKIP');

  SELECT GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT))
  INTO v_parts_produced
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end;

  SELECT COALESCE(SUM(rejected_parts), 0) INTO v_rejection_count
  FROM cnc_rejection_log
  WHERE machine_id = p_machine AND shift_date = p_date AND shift = p_shift;

  v_good_parts := GREATEST(0, v_parts_produced - v_rejection_count);

  SELECT
    COALESCE(ROUND(AVG(last_cycle_time_sec)::numeric, 2), 0),
    COALESCE(ROUND(MIN(last_cycle_time_sec)::numeric, 2), 0),
    COALESCE(ROUND(MAX(last_cycle_time_sec)::numeric, 2), 0)
  INTO v_avg_cycle, v_best_cycle, v_worst_cycle
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end AND last_cycle_time_sec > 0;

  v_eff_avail := LEAST(
    GREATEST(EXTRACT(EPOCH FROM (LEAST(NOW(), v_end) - v_start))::NUMERIC, 1),
    v_net
  );
  v_availability := ROUND(LEAST(100, v_running_sec / NULLIF(v_eff_avail, 0) * 100), 2);
  v_performance  := ROUND(LEAST(100,
    CASE WHEN v_running_sec > 0
      THEN v_parts_produced * v_target_cycle / v_running_sec * 100 ELSE 0 END), 2);
  v_quality := CASE WHEN v_parts_produced > 0
    THEN ROUND(LEAST(100, v_good_parts::NUMERIC / v_parts_produced * 100), 2) ELSE 100 END;
  v_oee := ROUND(v_availability * v_performance * v_quality / 10000, 2);

  INSERT INTO oee_results (
    machine_id, shift_date, shift, shift_start, shift_end,
    oee, availability, performance, quality,
    net_available_sec, running_sec, downtime_sec,
    producing_sec, minor_stop_sec, idle_sec,
    major_downtime_sec, minor_downtime_sec,
    downtime_min, major_downtime_min, minor_downtime_min, running_min,
    parts_produced, target_parts, parts_attainment,
    rejection_count, good_parts, scrap_rate,
    target_cycle_sec, avg_cycle_sec, best_cycle_sec, worst_cycle_sec,
    cycle_efficiency, alarm_count, alarm_duration_sec,
    rows_count, calculated_at
  ) VALUES (
    p_machine, p_date, p_shift, v_start, v_end,
    v_oee, v_availability, v_performance, v_quality,
    v_net, v_running_sec, v_downtime_sec,
    v_producing_sec, v_minor_stop_sec, v_idle_sec,
    v_downtime_sec, v_minor_stop_sec,
    ROUND(v_downtime_sec/60,1), ROUND(v_downtime_sec/60,1),
    ROUND(v_minor_stop_sec/60,1), ROUND(v_running_sec/60,1),
    v_parts_produced, v_target_parts,
    ROUND(v_parts_produced::NUMERIC / v_target_parts * 100, 1),
    v_rejection_count, v_good_parts,
    CASE WHEN v_parts_produced > 0
      THEN ROUND(v_rejection_count::NUMERIC / v_parts_produced * 100, 2) ELSE 0 END,
    v_target_cycle, v_avg_cycle, v_best_cycle, v_worst_cycle,
    CASE WHEN v_avg_cycle > 0 THEN ROUND(v_target_cycle / v_avg_cycle * 100, 2) ELSE 0 END,
    v_alarm_count, v_alarm_dur_sec,
    v_rows, NOW()
  )
  ON CONFLICT (machine_id, shift_date, shift) DO UPDATE SET
    oee=EXCLUDED.oee, availability=EXCLUDED.availability,
    performance=EXCLUDED.performance, quality=EXCLUDED.quality,
    running_sec=EXCLUDED.running_sec, downtime_sec=EXCLUDED.downtime_sec,
    producing_sec=EXCLUDED.producing_sec, minor_stop_sec=EXCLUDED.minor_stop_sec,
    idle_sec=EXCLUDED.idle_sec, major_downtime_sec=EXCLUDED.major_downtime_sec,
    minor_downtime_sec=EXCLUDED.minor_downtime_sec,
    downtime_min=EXCLUDED.downtime_min, major_downtime_min=EXCLUDED.major_downtime_min,
    minor_downtime_min=EXCLUDED.minor_downtime_min, running_min=EXCLUDED.running_min,
    parts_produced=EXCLUDED.parts_produced, parts_attainment=EXCLUDED.parts_attainment,
    rejection_count=EXCLUDED.rejection_count, good_parts=EXCLUDED.good_parts,
    scrap_rate=EXCLUDED.scrap_rate, avg_cycle_sec=EXCLUDED.avg_cycle_sec,
    best_cycle_sec=EXCLUDED.best_cycle_sec, worst_cycle_sec=EXCLUDED.worst_cycle_sec,
    cycle_efficiency=EXCLUDED.cycle_efficiency, alarm_count=EXCLUDED.alarm_count,
    alarm_duration_sec=EXCLUDED.alarm_duration_sec,
    rows_count=EXCLUDED.rows_count, calculated_at=NOW();

  RETURN 'OK: Shift '||p_shift||' | OEE='||v_oee||'% | Avail='||v_availability||
         '% | Perf='||v_performance||'% | Parts='||v_parts_produced||
         ' | Downtime='||ROUND(v_downtime_sec/60,1)||'min';
END;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  17. populate_oee_today  —  Refreshes today + yesterday both shifts
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION populate_oee_today(p_machine TEXT DEFAULT 'MACHINE001')
RETURNS TABLE(shift TEXT, result TEXT) LANGUAGE plpgsql AS $$
DECLARE
  v_today     DATE := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
  v_yesterday DATE := v_today - 1;
BEGIN
  shift := 'A';           result := populate_oee_shift(p_machine, v_today, 'A');     RETURN NEXT;
  shift := 'B';           result := populate_oee_shift(p_machine, v_yesterday, 'B'); RETURN NEXT;
  shift := 'A_yesterday'; result := populate_oee_shift(p_machine, v_yesterday, 'A'); RETURN NEXT;
END;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  18. refresh_oee_summary  —  Populates oee_summary snapshot table
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION refresh_oee_summary(p_date DATE DEFAULT CURRENT_DATE)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_count INT := 0;
  v_shift TEXT;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  v_row   RECORD;
BEGIN
  FOREACH v_shift IN ARRAY ARRAY['A','B'] LOOP
    IF v_shift = 'A' THEN
      v_start := (p_date::text || 'T07:00:00+05:30')::TIMESTAMPTZ;
      v_end   := (p_date::text || 'T19:00:00+05:30')::TIMESTAMPTZ;
    ELSE
      v_start := (p_date::text || 'T19:00:00+05:30')::TIMESTAMPTZ;
      v_end   := ((p_date + 1)::text || 'T07:00:00+05:30')::TIMESTAMPTZ;
    END IF;
    SELECT * INTO v_row FROM calc_oee('MACHINE001', v_start, v_end);
    IF v_row.rows_count > 0 THEN
      INSERT INTO oee_summary (
        machine_id, shift_date, shift, shift_start, shift_end,
        running_sec, downtime_sec, producing_sec, minor_stop_sec, idle_sec,
        parts_produced, availability, performance, quality, oee,
        rows_count, calculated_at
      ) VALUES (
        'MACHINE001', p_date, v_shift, v_start, v_end,
        v_row.running_sec, v_row.downtime_sec, v_row.producing_sec,
        v_row.minor_stop_sec, v_row.idle_sec, v_row.parts_produced,
        v_row.availability, v_row.performance, v_row.quality, v_row.oee,
        v_row.rows_count, NOW()
      )
      ON CONFLICT (machine_id, shift_date, shift) DO UPDATE SET
        running_sec=EXCLUDED.running_sec, downtime_sec=EXCLUDED.downtime_sec,
        producing_sec=EXCLUDED.producing_sec, minor_stop_sec=EXCLUDED.minor_stop_sec,
        idle_sec=EXCLUDED.idle_sec, parts_produced=EXCLUDED.parts_produced,
        availability=EXCLUDED.availability, performance=EXCLUDED.performance,
        quality=EXCLUDED.quality, oee=EXCLUDED.oee,
        rows_count=EXCLUDED.rows_count, calculated_at=NOW();
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  19. RICH DETAIL VIEW  —  v_oee_detail
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_oee_detail AS
SELECT
  shift_date, shift, oee, availability, performance, quality,
  ROUND(downtime_sec/60,1) AS total_downtime_min,
  ROUND(major_downtime_sec/60,1) AS major_downtime_min,
  ROUND(minor_stop_sec/60,1) AS minor_stop_min,
  ROUND(idle_sec/60,1) AS idle_min,
  ROUND(running_sec/60,1) AS running_min,
  parts_produced, target_parts, parts_attainment AS attainment_pct,
  rejection_count, good_parts, scrap_rate,
  avg_cycle_sec, best_cycle_sec, worst_cycle_sec, target_cycle_sec,
  cycle_efficiency AS cycle_vs_target_pct,
  alarm_count, ROUND(alarm_duration_sec/60,1) AS alarm_min,
  CASE
    WHEN oee >= 80 THEN '🟢 WORLD CLASS'
    WHEN oee >= 65 THEN '🟡 ACCEPTABLE'
    WHEN oee >  0  THEN '🔴 NEEDS WORK'
    ELSE '⚫ NO DATA'
  END AS oee_grade,
  calculated_at
FROM oee_results
ORDER BY shift_date DESC, shift;


-- ════════════════════════════════════════════════════════════════════════
--  20. DAILY SUMMARY VIEW  —  v_oee_daily_summary
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_oee_daily_summary AS
SELECT
  shift_date AS day,
  ROUND(SUM(oee*running_sec)/NULLIF(SUM(running_sec),0),2) AS oee,
  ROUND(SUM(availability*net_available_sec)/NULLIF(SUM(net_available_sec),0),2) AS availability,
  ROUND(SUM(performance*running_sec)/NULLIF(SUM(running_sec),0),2) AS performance,
  ROUND(SUM(quality*parts_produced)/NULLIF(SUM(parts_produced),0),2) AS quality,
  ROUND(SUM(running_sec)/60,1) AS running_min,
  ROUND(SUM(downtime_sec)/60,1) AS total_downtime_min,
  ROUND(SUM(major_downtime_sec)/60,1) AS major_downtime_min,
  ROUND(SUM(minor_stop_sec)/60,1) AS minor_stop_min,
  SUM(parts_produced) AS parts_produced,
  SUM(target_parts) AS target_parts,
  ROUND(SUM(parts_produced)::NUMERIC/NULLIF(SUM(target_parts),0)*100,1) AS attainment_pct,
  SUM(rejection_count) AS rejections,
  SUM(good_parts) AS good_parts,
  ROUND(AVG(NULLIF(avg_cycle_sec,0)),2) AS avg_cycle_sec,
  ROUND(MIN(NULLIF(best_cycle_sec,0)),2) AS best_cycle_sec,
  45 AS target_cycle_sec,
  SUM(alarm_count) AS alarm_count,
  COUNT(*) AS shifts_calculated
FROM oee_results
GROUP BY shift_date
ORDER BY shift_date DESC;


-- ════════════════════════════════════════════════════════════════════════
--  21. GRANT PERMISSIONS
-- ════════════════════════════════════════════════════════════════════════
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO cnc_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO cnc_user;
GRANT EXECUTE ON ALL FUNCTIONS        IN SCHEMA public TO cnc_user;


-- ════════════════════════════════════════════════════════════════════════
--  22. INITIAL POPULATE (run after tables are created)
-- ════════════════════════════════════════════════════════════════════════
-- Populate today's OEE if any data exists in cnc_data
SELECT * FROM populate_oee_today();
SELECT refresh_oee_summary(CURRENT_DATE);

-- ── VERIFY ───────────────────────────────────────────────────────────────
SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

SELECT 'DATABASE REBUILD COMPLETE ✅' AS status,
       (SELECT COUNT(*) FROM cnc_data) AS cnc_data_rows,
       (SELECT COUNT(*) FROM oee_results) AS oee_results_rows;
