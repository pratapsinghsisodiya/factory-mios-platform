-- ═══════════════════════════════════════════════════════════════════════
--  FACTORY-MIOS — Database-side OEE Calculation Functions & Views
--  Database : cnc_db
--  Table    : cnc_data
--  Run this once on server:
--    psql -U cnc_user -d cnc_db -f oee_functions.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── STEP 1: Core OEE calculation function ────────────────────────────
-- Accepts any time range and returns all OEE components.
-- Uses LAG() window function to compare consecutive rows —
-- same logic as the JavaScript calculation, now 100% in SQL.

CREATE OR REPLACE FUNCTION calc_oee(
  p_machine_id        TEXT,
  p_from              TIMESTAMPTZ,
  p_to                TIMESTAMPTZ,
  p_target_cycle_sec  NUMERIC DEFAULT 45,      -- target cycle time in seconds
  p_net_available_sec NUMERIC DEFAULT 40500    -- 675 min = 12h shift − 45min break
)
RETURNS TABLE (
  running_sec      NUMERIC,   -- seconds machine was RUNNING (available)
  downtime_sec     NUMERIC,   -- seconds machine_state ≠ RUNNING
  producing_sec    NUMERIC,   -- seconds actively cutting (raw_cycle advancing)
  minor_stop_sec   NUMERIC,   -- seconds RUNNING but spindle=0 & feed=0
  idle_sec         NUMERIC,   -- seconds RUNNING, spindle active but cycle not advancing
  parts_produced   INT,       -- MAX(part_count) − MIN(part_count) in window
  availability     NUMERIC,   -- %
  performance      NUMERIC,   -- %
  quality          NUMERIC,   -- % (100 unless rejection data added)
  oee              NUMERIC,   -- %
  rows_count       BIGINT
)
LANGUAGE SQL STABLE AS $$
  WITH
  -- Auto-detect ideal cycle time from dominant program in window
  prog_cycle AS (
    SELECT COALESCE(
      (SELECT pm.target_cycle_sec
       FROM program_master pm
       WHERE pm.machine_id = p_machine_id
         AND pm.target_cycle_sec IS NOT NULL
         AND pm.program_no = (
           SELECT NULLIF(REGEXP_REPLACE(program_no::TEXT, '[^0-9]', '', 'g'), '')::INT
           FROM cnc_data
           WHERE machine_id = p_machine_id
             AND time >= p_from AND time < p_to
             AND program_no IS NOT NULL
             AND NULLIF(REGEXP_REPLACE(program_no::TEXT, '[^0-9]', '', 'g'), '') IS NOT NULL
           GROUP BY program_no
           ORDER BY COUNT(*) DESC
           LIMIT 1
         )
       LIMIT 1
      ),
      COALESCE(p_target_cycle_sec, 45)
    ) AS ideal_cycle
  ),

  -- ── Pull consecutive rows with LAG ──────────────────────────────
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

  -- ── Calculate gap and classify each interval ─────────────────────
  --
  --  Rule                                          → classified as
  --  ──────────────────────────────────────────────────────────────────
  --  prev_ts IS NULL                               → FIRST (skip)
  --  gap > 600 sec                                 → SKIP  (machine off)
  --  prev machine_state NOT IN RUNNING/AUTO/BUSY   → DOWNTIME
  --  idle_time_sec increasing (Industrial CNC idle counter) → DOWNTIME (idle = lost time)
  --  raw_cycle_time_sec increasing                 → PRODUCING (active cut)
  --  spindle=0 AND feed=0                          → MINOR_STOP (setup/wait)
  --  otherwise                                     → IDLE (between cycles)
  --
  --  PRODUCING + MINOR_STOP → running_sec (available time)
  --  DOWNTIME + IDLE        → downtime_sec (availability loss)
  --
  gaps AS (
    SELECT
      EXTRACT(EPOCH FROM (time - prev_ts))::NUMERIC AS gap_sec,
      CASE
        WHEN prev_ts IS NULL
          THEN 'FIRST'
        WHEN EXTRACT(EPOCH FROM (time - prev_ts)) > 600
          THEN 'SKIP'
        WHEN UPPER(COALESCE(prev_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
          THEN 'DOWNTIME'
        -- Industrial CNC idle_time_sec counter incrementing = machine tracking idle → downtime
        WHEN COALESCE(idle_time_sec, 0) > COALESCE(prev_idle_sec, 0)
          THEN 'DOWNTIME'
        WHEN COALESCE(raw_cycle_time_sec, 0) > COALESCE(prev_raw_cycle, 0)
          THEN 'PRODUCING'
        WHEN COALESCE(prev_spindle, 0) = 0 AND COALESCE(prev_feed, 0) = 0
          THEN 'MINOR_STOP'
        ELSE 'IDLE'
      END AS state
    FROM raw
  ),

  -- ── Aggregate seconds per state ──────────────────────────────────
  agg AS (
    SELECT
      COALESCE(SUM(CASE WHEN state IN ('PRODUCING','MINOR_STOP') THEN gap_sec END), 0) AS running_sec,
      COALESCE(SUM(CASE WHEN state IN ('DOWNTIME','IDLE')        THEN gap_sec END), 0) AS downtime_sec,
      COALESCE(SUM(CASE WHEN state = 'PRODUCING'  THEN gap_sec END), 0) AS producing_sec,
      COALESCE(SUM(CASE WHEN state = 'MINOR_STOP' THEN gap_sec END), 0) AS minor_stop_sec,
      COALESCE(SUM(CASE WHEN state = 'IDLE'       THEN gap_sec END), 0) AS idle_sec,
      COUNT(*) FILTER (WHERE state NOT IN ('FIRST','SKIP'))              AS rows_count
    FROM gaps
  ),

  -- ── Part count: delta (max − min) within window ──────────────────
  parts AS (
    SELECT
      GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT)) AS parts_produced
    FROM cnc_data
    WHERE machine_id = p_machine_id
      AND time >= p_from
      AND time <  p_to
  )

  -- ── Final OEE calculation ─────────────────────────────────────────
  --
  --  Availability = LEAST(running_sec, net_available) / net_available × 100
  --  Performance  = (parts × target_cycle) / running_sec × 100
  --  Quality      = 100 (no rejection source yet — add later)
  --  OEE          = Availability × Performance × Quality / 10000
  --
  SELECT
    a.running_sec,
    a.downtime_sec,
    a.producing_sec,
    a.minor_stop_sec,
    a.idle_sec,
    p.parts_produced,

    -- Availability (cap at 100)
    ROUND(
      LEAST(100,
        LEAST(a.running_sec, p_net_available_sec)
        / NULLIF(p_net_available_sec, 0) * 100
      ), 2
    ) AS availability,

    -- Performance (cap at 100)
    ROUND(
      LEAST(100,
        CASE WHEN a.running_sec > 0
          THEN p.parts_produced * pc.ideal_cycle / a.running_sec * 100
          ELSE 0
        END
      ), 2
    ) AS performance,

    -- Quality (fixed 100 until rejection log is wired in)
    100.00 AS quality,

    -- OEE = A × P × Q / 10000
    ROUND(
      LEAST(100,
        LEAST(a.running_sec, p_net_available_sec)
        / NULLIF(p_net_available_sec, 0) * 100
      )
      *
      LEAST(100,
        CASE WHEN a.running_sec > 0
          THEN p.parts_produced * pc.ideal_cycle / a.running_sec * 100
          ELSE 0
        END
      ) / 100,
      2
    ) AS oee,

    a.rows_count

  FROM agg a, parts p, prog_cycle pc;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- ── STEP 2: Shift-level OEE view (last 14 days, both shifts) ─────────
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_oee_shifts AS
WITH shift_bounds AS (
  -- Shift A: 07:00–19:00
  -- Note: generate_series(date, date, interval) returns TIMESTAMPTZ → cast to date first
  SELECT
    d::date                                                          AS shift_date,
    'A'::TEXT                                                        AS shift,
    (d::date::text || 'T07:00:00+05:30')::TIMESTAMPTZ               AS shift_start,
    (d::date::text || 'T19:00:00+05:30')::TIMESTAMPTZ               AS shift_end
  FROM generate_series(
    (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 13,
    (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
    '1 day'::interval
  ) AS d

  UNION ALL

  -- Shift B: 19:00 – 07:00 next day
  SELECT
    d::date                                                          AS shift_date,
    'B'::TEXT                                                        AS shift,
    (d::date::text         || 'T19:00:00+05:30')::TIMESTAMPTZ       AS shift_start,
    ((d::date + 1)::text   || 'T07:00:00+05:30')::TIMESTAMPTZ       AS shift_end
  FROM generate_series(
    (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 13,
    (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
    '1 day'::interval
  ) AS d
)
SELECT
  sb.shift_date,
  sb.shift,
  sb.shift_start,
  sb.shift_end,
  oee.running_sec,
  oee.downtime_sec,
  oee.producing_sec,
  oee.minor_stop_sec,
  oee.idle_sec,
  oee.parts_produced,
  oee.availability,
  oee.performance,
  oee.quality,
  oee.oee,
  oee.rows_count,
  -- Human-readable columns
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
WHERE oee.rows_count > 0        -- only show shifts that have data
ORDER BY sb.shift_date DESC, sb.shift;


-- ═══════════════════════════════════════════════════════════════════════
-- ── STEP 3: Daily OEE rollup view ────────────────────────────────────
-- Merges Shift A + B into one row per calendar day
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_oee_daily AS
SELECT
  shift_date                             AS day,
  SUM(running_sec)                       AS running_sec,
  SUM(downtime_sec)                      AS downtime_sec,
  SUM(parts_produced)                    AS parts_produced,
  ROUND(
    LEAST(SUM(running_sec), 81000)       -- 2 shifts × 40500 sec
    / 81000 * 100, 2
  )                                      AS availability,
  ROUND(
    LEAST(100,
      CASE WHEN SUM(running_sec) > 0
        THEN SUM(performance * running_sec) / NULLIF(SUM(running_sec), 0)
        ELSE 0
      END
    ), 2
  )                                      AS performance,
  ROUND(
    CASE WHEN SUM(parts_produced) > 0
      THEN SUM(quality * parts_produced) / NULLIF(SUM(parts_produced), 0)
      ELSE 100
    END, 2
  )                                      AS quality,
  ROUND(
    CASE WHEN SUM(running_sec) > 0
      THEN SUM(oee * running_sec) / NULLIF(SUM(running_sec), 0)
      ELSE 0
    END, 2
  )                                      AS oee,
  SUM(rows_count)                        AS total_rows
FROM v_oee_shifts
GROUP BY shift_date
ORDER BY shift_date DESC;


-- ═══════════════════════════════════════════════════════════════════════
-- ── STEP 4: Live/current-shift view ──────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_oee_current AS
WITH bounds AS (
  SELECT
    CASE
      WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
       AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
      THEN 'A'
      ELSE 'B'
    END AS current_shift,
    CASE
      WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
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
SELECT
  b.current_shift    AS shift,
  b.shift_start,
  b.shift_end,
  oee.*
FROM bounds b
CROSS JOIN LATERAL calc_oee('MACHINE001', b.shift_start, b.shift_end) AS oee;


-- ═══════════════════════════════════════════════════════════════════════
-- ── STEP 5: Materialized snapshot table (optional, faster for APIs) ───
-- Refresh this every 5 minutes via pg_cron or from Node.js
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS oee_summary (
  id               BIGSERIAL PRIMARY KEY,
  machine_id       TEXT          NOT NULL DEFAULT 'MACHINE001',
  shift_date       DATE          NOT NULL,
  shift            CHAR(1)       NOT NULL CHECK (shift IN ('A','B')),
  shift_start      TIMESTAMPTZ   NOT NULL,
  shift_end        TIMESTAMPTZ   NOT NULL,
  -- Time buckets (seconds)
  running_sec      NUMERIC(10,1),
  downtime_sec     NUMERIC(10,1),
  producing_sec    NUMERIC(10,1),
  minor_stop_sec   NUMERIC(10,1),
  idle_sec         NUMERIC(10,1),
  -- Production
  parts_produced   INT,
  target_parts     INT           DEFAULT 900,
  -- OEE components (%)
  availability     NUMERIC(6,2),
  performance      NUMERIC(6,2),
  quality          NUMERIC(6,2)  DEFAULT 100,
  oee              NUMERIC(6,2),
  -- Metadata
  rows_count       BIGINT,
  calculated_at    TIMESTAMPTZ   DEFAULT NOW(),
  -- Unique: one row per machine+date+shift
  UNIQUE (machine_id, shift_date, shift)
);

-- Function to refresh oee_summary for a given date
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
      )
      VALUES (
        'MACHINE001', p_date, v_shift, v_start, v_end,
        v_row.running_sec, v_row.downtime_sec, v_row.producing_sec,
        v_row.minor_stop_sec, v_row.idle_sec,
        v_row.parts_produced,
        v_row.availability, v_row.performance, v_row.quality, v_row.oee,
        v_row.rows_count, NOW()
      )
      ON CONFLICT (machine_id, shift_date, shift) DO UPDATE SET
        running_sec    = EXCLUDED.running_sec,
        downtime_sec   = EXCLUDED.downtime_sec,
        producing_sec  = EXCLUDED.producing_sec,
        minor_stop_sec = EXCLUDED.minor_stop_sec,
        idle_sec       = EXCLUDED.idle_sec,
        parts_produced = EXCLUDED.parts_produced,
        availability   = EXCLUDED.availability,
        performance    = EXCLUDED.performance,
        quality        = EXCLUDED.quality,
        oee            = EXCLUDED.oee,
        rows_count     = EXCLUDED.rows_count,
        calculated_at  = NOW();

      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- ── QUICK TEST QUERIES (run in DBeaver to verify) ─────────────────────
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Current shift OEE right now:
--    SELECT * FROM v_oee_current;

-- 2) All shifts last 7 days:
--    SELECT shift_date, shift, availability, performance, quality, oee,
--           parts_produced, ROUND(downtime_sec/60,1) AS downtime_min
--    FROM v_oee_shifts
--    ORDER BY shift_date DESC, shift;

-- 3) Daily rollup:
--    SELECT * FROM v_oee_daily LIMIT 7;

-- 4) Refresh today's summary table:
--    SELECT refresh_oee_summary(CURRENT_DATE);
--    SELECT * FROM oee_summary ORDER BY shift_date DESC, shift;

-- 5) Ad-hoc: OEE for any custom time range:
--    SELECT * FROM calc_oee('MACHINE001',
--      '2025-01-01 07:00:00+05:30',
--      '2025-01-01 19:00:00+05:30');
