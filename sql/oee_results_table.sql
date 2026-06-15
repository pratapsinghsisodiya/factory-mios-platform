-- ═══════════════════════════════════════════════════════════════════════
--  FACTORY-MIOS — oee_results table
--  Database : cnc_db
--  Purpose  : Pre-calculated OEE per shift, saved from machine_live raw data
--
--  Run once:
--    PGPASSWORD=cnc_pass123 psql -U cnc_user -d cnc_db -f sql/oee_results_table.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. THE TABLE ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oee_results (
  id                  BIGSERIAL     PRIMARY KEY,
  machine_id          TEXT          NOT NULL DEFAULT 'MACHINE001',
  shift_date          DATE          NOT NULL,
  shift               CHAR(1)       NOT NULL CHECK (shift IN ('A','B')),
  shift_start         TIMESTAMPTZ   NOT NULL,
  shift_end           TIMESTAMPTZ   NOT NULL,

  -- ── OEE Components ─────────────────────────────────────────────
  oee                 NUMERIC(6,2)  DEFAULT 0,   -- Overall OEE %
  availability        NUMERIC(6,2)  DEFAULT 0,   -- A = running / net_available
  performance         NUMERIC(6,2)  DEFAULT 0,   -- P = (parts × target_cycle) / running
  quality             NUMERIC(6,2)  DEFAULT 100, -- Q = good_parts / total_parts × 100

  -- ── Time Buckets (seconds) ──────────────────────────────────────
  net_available_sec   NUMERIC(10,1) DEFAULT 40500, -- 675 min per shift
  running_sec         NUMERIC(10,1) DEFAULT 0,   -- total available time
  downtime_sec        NUMERIC(10,1) DEFAULT 0,   -- machine_state ≠ RUNNING
  producing_sec       NUMERIC(10,1) DEFAULT 0,   -- raw_cycle_time advancing
  minor_stop_sec      NUMERIC(10,1) DEFAULT 0,   -- RUNNING + spindle=0 + feed=0
  idle_sec            NUMERIC(10,1) DEFAULT 0,   -- RUNNING but not producing

  -- ── Downtime Classification ──────────────────────────────────────
  -- Major = machine completely stopped (machine_state ≠ RUNNING)
  -- Minor = machine RUNNING but spindle & feed both zero (between cuts)
  major_downtime_sec  NUMERIC(10,1) DEFAULT 0,   -- = downtime_sec
  minor_downtime_sec  NUMERIC(10,1) DEFAULT 0,   -- = minor_stop_sec
  downtime_min        NUMERIC(8,1)  DEFAULT 0,
  major_downtime_min  NUMERIC(8,1)  DEFAULT 0,
  minor_downtime_min  NUMERIC(8,1)  DEFAULT 0,
  running_min         NUMERIC(8,1)  DEFAULT 0,

  -- ── Production ──────────────────────────────────────────────────
  parts_produced      INT           DEFAULT 0,   -- MAX(part_count) - MIN(part_count)
  target_parts        INT           DEFAULT 900,
  parts_attainment    NUMERIC(6,2)  DEFAULT 0,   -- parts / target × 100
  rejection_count     INT           DEFAULT 0,   -- from cnc_rejection_log
  good_parts          INT           DEFAULT 0,   -- parts_produced - rejection_count
  scrap_rate          NUMERIC(6,2)  DEFAULT 0,   -- rejection / parts × 100

  -- ── Cycle Time ──────────────────────────────────────────────────
  target_cycle_sec    NUMERIC(6,2)  DEFAULT 45,
  avg_cycle_sec       NUMERIC(8,2)  DEFAULT 0,
  best_cycle_sec      NUMERIC(8,2)  DEFAULT 0,
  worst_cycle_sec     NUMERIC(8,2)  DEFAULT 0,
  cycle_efficiency    NUMERIC(6,2)  DEFAULT 0,   -- target / avg × 100

  -- ── Alarms ──────────────────────────────────────────────────────
  alarm_count         INT           DEFAULT 0,
  alarm_duration_sec  NUMERIC(10,1) DEFAULT 0,

  -- ── Metadata ────────────────────────────────────────────────────
  rows_count          BIGINT        DEFAULT 0,   -- readings from cnc_data
  calculated_at       TIMESTAMPTZ   DEFAULT NOW(),

  -- One row per machine + date + shift
  UNIQUE (machine_id, shift_date, shift)
);

-- Index for fast date-range queries
CREATE INDEX IF NOT EXISTS idx_oee_results_date  ON oee_results (shift_date DESC);
CREATE INDEX IF NOT EXISTS idx_oee_results_mach  ON oee_results (machine_id, shift_date DESC);

-- ── Migrate column types if table was created with older schema ────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='oee_results' AND column_name='target_cycle_sec'
      AND data_type='integer'
  ) THEN
    ALTER TABLE oee_results ALTER COLUMN target_cycle_sec TYPE NUMERIC(6,2);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='oee_results' AND column_name='avg_cycle_sec'
      AND data_type='integer'
  ) THEN
    ALTER TABLE oee_results ALTER COLUMN avg_cycle_sec TYPE NUMERIC(8,2);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='oee_results' AND column_name='best_cycle_sec'
      AND data_type='integer'
  ) THEN
    ALTER TABLE oee_results ALTER COLUMN best_cycle_sec TYPE NUMERIC(8,2);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='oee_results' AND column_name='worst_cycle_sec'
      AND data_type='integer'
  ) THEN
    ALTER TABLE oee_results ALTER COLUMN worst_cycle_sec TYPE NUMERIC(8,2);
  END IF;
END
$$;

-- ── 2. POPULATE FUNCTION ──────────────────────────────────────────────
-- Call: SELECT populate_oee_shift('MACHINE001', '2025-05-21', 'A');
-- Call: SELECT populate_oee_today();   ← refreshes both shifts for today

CREATE OR REPLACE FUNCTION populate_oee_shift(
  p_machine   TEXT    DEFAULT 'MACHINE001',
  p_date      DATE    DEFAULT CURRENT_DATE,
  p_shift     CHAR(1) DEFAULT 'A'
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_start         TIMESTAMPTZ;
  v_end           TIMESTAMPTZ;
  v_net           NUMERIC := 40500;   -- 675 min
  v_target_cycle  NUMERIC := 45;
  v_target_parts  INT     := 900;

  -- raw counts
  v_running_sec       NUMERIC := 0;
  v_downtime_sec      NUMERIC := 0;
  v_producing_sec     NUMERIC := 0;
  v_minor_stop_sec    NUMERIC := 0;
  v_idle_sec          NUMERIC := 0;
  v_alarm_dur_sec     NUMERIC := 0;
  v_rows              BIGINT  := 0;

  -- production
  v_parts_produced    INT := 0;
  v_rejection_count   INT := 0;
  v_good_parts        INT := 0;

  -- cycle
  v_avg_cycle         NUMERIC := 0;
  v_best_cycle        NUMERIC := 0;
  v_worst_cycle       NUMERIC := 0;
  v_alarm_count       INT := 0;

  -- OEE
  v_availability      NUMERIC := 0;
  v_performance       NUMERIC := 0;
  v_quality           NUMERIC := 100;
  v_oee               NUMERIC := 0;
  v_eff_avail         NUMERIC;

BEGIN
  -- ── Shift window ─────────────────────────────────────────────────
  IF p_shift = 'A' THEN
    v_start := (p_date::text || 'T07:00:00+05:30')::TIMESTAMPTZ;
    v_end   := (p_date::text || 'T19:00:00+05:30')::TIMESTAMPTZ;
  ELSE
    v_start := (p_date::text         || 'T19:00:00+05:30')::TIMESTAMPTZ;
    v_end   := ((p_date + 1)::text   || 'T07:00:00+05:30')::TIMESTAMPTZ;
  END IF;

  -- ── Check data exists ────────────────────────────────────────────
  SELECT COUNT(*) INTO v_rows
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end;

  IF v_rows = 0 THEN
    RETURN 'NO DATA for ' || p_date || ' Shift ' || p_shift;
  END IF;

  -- ── Lookup ideal cycle time from dominant program in this shift ───────
  -- Try 1: dominant program_no from cnc_data matched against program_master
  WITH dominant AS (
    SELECT NULLIF(REGEXP_REPLACE(program_no::TEXT, '[^0-9]', '', 'g'), '')::INT AS prog_int,
           COUNT(*) AS cnt
    FROM cnc_data
    WHERE machine_id = p_machine
      AND time >= v_start AND time < v_end
      AND program_no IS NOT NULL
      AND NULLIF(REGEXP_REPLACE(program_no::TEXT, '[^0-9]', '', 'g'), '') IS NOT NULL
    GROUP BY program_no
    ORDER BY cnt DESC
    LIMIT 1
  )
  SELECT COALESCE(
    -- Primary: match dominant program from this shift
    (SELECT pm.target_cycle_sec
     FROM program_master pm
     INNER JOIN dominant d ON pm.program_no = d.prog_int
     WHERE pm.target_cycle_sec IS NOT NULL
     LIMIT 1),
    -- Fallback: best match by closest target_cycle to actual avg cycle in this shift
    (SELECT pm.target_cycle_sec
     FROM program_master pm
     CROSS JOIN (
       SELECT ROUND(AVG(last_cycle_time_sec)::NUMERIC, 1) AS ac
       FROM cnc_data
       WHERE machine_id = p_machine AND time >= v_start AND time < v_end
         AND last_cycle_time_sec > 0
     ) avg_data
     WHERE pm.target_cycle_sec IS NOT NULL
       AND avg_data.ac > 0
     ORDER BY ABS(pm.target_cycle_sec - avg_data.ac) LIMIT 1),
    -- Last resort: most recently updated program for this machine
    (SELECT pm.target_cycle_sec
     FROM program_master pm
     WHERE pm.machine_id = p_machine AND pm.target_cycle_sec IS NOT NULL
     ORDER BY pm.updated_at DESC NULLS LAST LIMIT 1),
    v_target_cycle  -- absolute fallback: 45s default
  ) INTO v_target_cycle;

  -- Dynamic target parts: 12-hour shift × 90% availability ÷ ideal cycle time
  v_target_parts := GREATEST(1, FLOOR(43200.0 / v_target_cycle)::INT);

  -- ── Time buckets via LAG (same logic as calc_oee) ────────────────
  WITH raw AS (
    SELECT time, machine_state, spindle_speed, feed_rate,
           raw_cycle_time_sec, alarm_active,
           LAG(time)               OVER(ORDER BY time) AS prev_ts,
           LAG(machine_state)      OVER(ORDER BY time) AS prev_state,
           LAG(spindle_speed)      OVER(ORDER BY time) AS prev_spindle,
           LAG(feed_rate)          OVER(ORDER BY time) AS prev_feed,
           LAG(raw_cycle_time_sec) OVER(ORDER BY time) AS prev_raw
    FROM cnc_data
    WHERE machine_id = p_machine AND time >= v_start AND time < v_end
  ),
  gaps AS (
    SELECT
      EXTRACT(EPOCH FROM(time - prev_ts))::NUMERIC AS gap,
      CASE
        WHEN prev_ts IS NULL THEN 'FIRST'
        WHEN EXTRACT(EPOCH FROM(time - prev_ts)) > 600 THEN 'SKIP'
        WHEN UPPER(COALESCE(prev_state,'')) <> 'RUNNING' THEN 'DOWNTIME'
        WHEN COALESCE(raw_cycle_time_sec,0) > COALESCE(prev_raw,0) THEN 'PRODUCING'
        WHEN COALESCE(prev_spindle,0)=0 AND COALESCE(prev_feed,0)=0 THEN 'MINOR_STOP'
        ELSE 'IDLE'
      END AS state,
      alarm_active
    FROM raw
  )
  SELECT
    COALESCE(SUM(CASE WHEN state IN('PRODUCING','MINOR_STOP','IDLE') THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'DOWNTIME'   THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'PRODUCING'  THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'MINOR_STOP' THEN gap END),0),
    COALESCE(SUM(CASE WHEN state = 'IDLE'       THEN gap END),0),
    COALESCE(SUM(CASE WHEN alarm_active THEN gap ELSE 0 END),0),
    COUNT(*) FILTER(WHERE alarm_active)
  INTO
    v_running_sec, v_downtime_sec, v_producing_sec,
    v_minor_stop_sec, v_idle_sec, v_alarm_dur_sec, v_alarm_count
  FROM gaps
  WHERE state NOT IN ('FIRST','SKIP');

  -- ── Parts produced (delta of part_count) ─────────────────────────
  SELECT GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT))
  INTO v_parts_produced
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end;

  -- ── Rejections from log (if table has data for this shift) ───────
  SELECT COALESCE(SUM(rejected_parts), 0)
  INTO v_rejection_count
  FROM cnc_rejection_log
  WHERE machine_id = p_machine
    AND shift_date = p_date
    AND shift = p_shift;

  v_good_parts := GREATEST(0, v_parts_produced - v_rejection_count);

  -- ── Cycle time stats ─────────────────────────────────────────────
  SELECT
    COALESCE(ROUND(AVG(last_cycle_time_sec)::numeric, 2), 0),
    COALESCE(ROUND(MIN(last_cycle_time_sec)::numeric, 2), 0),
    COALESCE(ROUND(MAX(last_cycle_time_sec)::numeric, 2), 0)
  INTO v_avg_cycle, v_best_cycle, v_worst_cycle
  FROM cnc_data
  WHERE machine_id = p_machine AND time >= v_start AND time < v_end
    AND last_cycle_time_sec > 0;

  -- ── OEE Calculation ──────────────────────────────────────────────
  -- ── Availability denominator: elapsed shift time, not always full 675 min ──
  -- For live shifts (still running): use elapsed time so mid-shift OEE is correct
  -- For completed shifts: elapsed = full shift = 40500 sec
  v_eff_avail := LEAST(
    GREATEST(EXTRACT(EPOCH FROM (LEAST(NOW(), v_end) - v_start))::NUMERIC, 1),
    v_net
  );

  -- Availability = Running / Elapsed (correct for live AND completed shifts)
  v_availability := ROUND(LEAST(100, v_running_sec / NULLIF(v_eff_avail, 0) * 100), 2);

  -- Performance = (Parts × Target Cycle) / Running time
  v_performance  := ROUND(LEAST(100,
    CASE WHEN v_running_sec > 0
      THEN v_parts_produced * v_target_cycle / v_running_sec * 100
      ELSE 0 END), 2);
  v_quality      := CASE
    WHEN v_parts_produced > 0
      THEN ROUND(LEAST(100, v_good_parts::NUMERIC / v_parts_produced * 100), 2)
      ELSE 100 END;
  v_oee          := ROUND(v_availability * v_performance * v_quality / 10000, 2);

  -- ── Upsert into oee_results ───────────────────────────────────────
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
    cycle_efficiency,
    alarm_count, alarm_duration_sec,
    rows_count, calculated_at
  ) VALUES (
    p_machine, p_date, p_shift, v_start, v_end,
    v_oee, v_availability, v_performance, v_quality,
    v_net, v_running_sec, v_downtime_sec,
    v_producing_sec, v_minor_stop_sec, v_idle_sec,
    v_downtime_sec,   -- major = fully stopped
    v_minor_stop_sec, -- minor = running but spindle/feed zero
    ROUND(v_downtime_sec / 60, 1),
    ROUND(v_downtime_sec / 60, 1),
    ROUND(v_minor_stop_sec / 60, 1),
    ROUND(v_running_sec / 60, 1),
    v_parts_produced, v_target_parts,
    ROUND(v_parts_produced::NUMERIC / v_target_parts * 100, 1),
    v_rejection_count, v_good_parts,
    CASE WHEN v_parts_produced > 0
      THEN ROUND(v_rejection_count::NUMERIC / v_parts_produced * 100, 2)
      ELSE 0 END,
    v_target_cycle, v_avg_cycle, v_best_cycle, v_worst_cycle,
    CASE WHEN v_avg_cycle > 0
      THEN ROUND(v_target_cycle / v_avg_cycle * 100, 2)
      ELSE 0 END,
    v_alarm_count, v_alarm_dur_sec,
    v_rows, NOW()
  )
  ON CONFLICT (machine_id, shift_date, shift) DO UPDATE SET
    oee                = EXCLUDED.oee,
    availability       = EXCLUDED.availability,
    performance        = EXCLUDED.performance,
    quality            = EXCLUDED.quality,
    running_sec        = EXCLUDED.running_sec,
    downtime_sec       = EXCLUDED.downtime_sec,
    producing_sec      = EXCLUDED.producing_sec,
    minor_stop_sec     = EXCLUDED.minor_stop_sec,
    idle_sec           = EXCLUDED.idle_sec,
    major_downtime_sec = EXCLUDED.major_downtime_sec,
    minor_downtime_sec = EXCLUDED.minor_downtime_sec,
    downtime_min       = EXCLUDED.downtime_min,
    major_downtime_min = EXCLUDED.major_downtime_min,
    minor_downtime_min = EXCLUDED.minor_downtime_min,
    running_min        = EXCLUDED.running_min,
    parts_produced     = EXCLUDED.parts_produced,
    target_parts       = EXCLUDED.target_parts,
    target_cycle_sec   = EXCLUDED.target_cycle_sec,
    parts_attainment   = EXCLUDED.parts_attainment,
    rejection_count    = EXCLUDED.rejection_count,
    good_parts         = EXCLUDED.good_parts,
    scrap_rate         = EXCLUDED.scrap_rate,
    avg_cycle_sec      = EXCLUDED.avg_cycle_sec,
    best_cycle_sec     = EXCLUDED.best_cycle_sec,
    worst_cycle_sec    = EXCLUDED.worst_cycle_sec,
    cycle_efficiency   = EXCLUDED.cycle_efficiency,
    alarm_count        = EXCLUDED.alarm_count,
    alarm_duration_sec = EXCLUDED.alarm_duration_sec,
    rows_count         = EXCLUDED.rows_count,
    calculated_at      = NOW();

  RETURN 'OK: Shift ' || p_shift || ' | OEE=' || v_oee ||
         '% | Avail=' || v_availability ||
         '% | Perf=' || v_performance ||
         '% | Parts=' || v_parts_produced ||
         ' | Downtime=' || ROUND(v_downtime_sec/60,1) || 'min';
END;
$$;


-- ── 3. REFRESH TODAY (both shifts) ───────────────────────────────────
CREATE OR REPLACE FUNCTION populate_oee_today(p_machine TEXT DEFAULT 'MACHINE001')
RETURNS TABLE(shift TEXT, result TEXT) LANGUAGE plpgsql AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
  v_yesterday DATE := v_today - 1;
BEGIN
  -- Today's Shift A
  shift  := 'A'; result := populate_oee_shift(p_machine, v_today, 'A'); RETURN NEXT;
  -- Today's Shift B (started yesterday evening)
  shift  := 'B'; result := populate_oee_shift(p_machine, v_yesterday, 'B'); RETURN NEXT;
  -- Yesterday's Shift A (for historical completeness)
  shift  := 'A_yesterday'; result := populate_oee_shift(p_machine, v_yesterday, 'A'); RETURN NEXT;
END;
$$;


-- ── 4. USEFUL VIEWS ──────────────────────────────────────────────────
-- Drop views first so we can change column types without error
DROP VIEW IF EXISTS v_oee_daily_summary CASCADE;
DROP VIEW IF EXISTS v_oee_detail CASCADE;

-- Full detail per shift
CREATE OR REPLACE VIEW v_oee_detail AS
SELECT
  shift_date,
  shift,
  -- OEE
  oee,
  availability,
  performance,
  quality,
  -- Downtime
  ROUND(downtime_sec / 60, 1)       AS total_downtime_min,
  ROUND(major_downtime_sec / 60, 1) AS major_downtime_min,  -- machine STOPPED
  ROUND(minor_stop_sec / 60, 1)     AS minor_stop_min,      -- between cuts
  ROUND(idle_sec / 60, 1)           AS idle_min,
  ROUND(running_sec / 60, 1)        AS running_min,
  -- Production
  parts_produced,
  target_parts,
  parts_attainment                   AS attainment_pct,
  rejection_count,
  good_parts,
  scrap_rate,
  -- Cycle time
  avg_cycle_sec,
  best_cycle_sec,
  worst_cycle_sec,
  target_cycle_sec,
  cycle_efficiency                   AS cycle_vs_target_pct,
  -- Alarms
  alarm_count,
  ROUND(alarm_duration_sec / 60, 1) AS alarm_min,
  -- Status
  CASE
    WHEN oee >= 80 THEN '🟢 WORLD CLASS'
    WHEN oee >= 65 THEN '🟡 ACCEPTABLE'
    WHEN oee >  0  THEN '🔴 NEEDS WORK'
    ELSE '⚫ NO DATA'
  END AS oee_grade,
  calculated_at
FROM oee_results
ORDER BY shift_date DESC, shift;


-- Daily rollup (both shifts combined)
CREATE OR REPLACE VIEW v_oee_daily_summary AS
SELECT
  shift_date                                          AS day,
  -- OEE (weighted by running time)
  ROUND(SUM(oee * running_sec) / NULLIF(SUM(running_sec),0), 2)          AS oee,
  ROUND(SUM(availability * net_available_sec) / NULLIF(SUM(net_available_sec),0), 2) AS availability,
  ROUND(SUM(performance * running_sec) / NULLIF(SUM(running_sec),0), 2)  AS performance,
  ROUND(SUM(quality * parts_produced)  / NULLIF(SUM(parts_produced),0), 2) AS quality,
  -- Time
  ROUND(SUM(running_sec)  / 60, 1)        AS running_min,
  ROUND(SUM(downtime_sec) / 60, 1)        AS total_downtime_min,
  ROUND(SUM(major_downtime_sec) / 60, 1)  AS major_downtime_min,
  ROUND(SUM(minor_stop_sec)     / 60, 1)  AS minor_stop_min,
  -- Production
  SUM(parts_produced)                     AS parts_produced,
  SUM(target_parts)                       AS target_parts,
  ROUND(SUM(parts_produced)::NUMERIC / NULLIF(SUM(target_parts),0) * 100, 1) AS attainment_pct,
  SUM(rejection_count)                    AS rejections,
  SUM(good_parts)                         AS good_parts,
  -- Cycle time (average across shifts)
  ROUND(AVG(NULLIF(avg_cycle_sec,0)), 2)  AS avg_cycle_sec,
  ROUND(MIN(NULLIF(best_cycle_sec,0)), 2) AS best_cycle_sec,
  ROUND(AVG(NULLIF(target_cycle_sec, 0)), 2) AS target_cycle_sec,
  -- Alarms
  SUM(alarm_count)                        AS alarm_count,
  COUNT(*)                                AS shifts_calculated
FROM oee_results
GROUP BY shift_date
ORDER BY shift_date DESC;


-- ── 5. QUICK VERIFY (run in DBeaver after applying) ───────────────────
-- Step 1: Populate today's data
--   SELECT * FROM populate_oee_today();
--
-- Step 2: See the full table
--   SELECT shift_date, shift, oee, availability, performance, quality,
--          total_downtime_min, major_downtime_min, minor_stop_min,
--          parts_produced, avg_cycle_sec, cycle_vs_target_pct, oee_grade
--   FROM v_oee_detail LIMIT 20;
--
-- Step 3: Daily summary
--   SELECT * FROM v_oee_daily_summary LIMIT 7;
--
-- Step 4: Raw table
--   SELECT * FROM oee_results ORDER BY shift_date DESC, shift LIMIT 20;
