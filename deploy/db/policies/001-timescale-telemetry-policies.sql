-- Factory-MIOS TimescaleDB policies for high-volume telemetry.
-- Run after the app has created its tables:
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < deploy/db/policies/001-timescale-telemetry-policies.sql

CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
  IF to_regclass('public.cnc_data') IS NOT NULL THEN
    PERFORM create_hypertable('public.cnc_data', 'time', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');
    CREATE INDEX IF NOT EXISTS idx_cnc_data_machine_time_desc ON public.cnc_data (machine_id, time DESC);
    CREATE INDEX IF NOT EXISTS idx_cnc_data_time_desc ON public.cnc_data (time DESC);

    BEGIN
      ALTER TABLE public.cnc_data SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'machine_id',
        timescaledb.compress_orderby = 'time DESC'
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping cnc_data compression settings: %', SQLERRM;
    END;

    BEGIN
      PERFORM add_compression_policy('public.cnc_data', INTERVAL '7 days', if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping cnc_data compression policy: %', SQLERRM;
    END;
  END IF;

  IF to_regclass('public.oee_results') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_oee_results_machine_date_shift ON public.oee_results (machine_id, shift_date DESC, shift);
  END IF;
END $$;

-- Apply to schema-per-plant telemetry tables created by device provisioning.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_name = 'device_readings'
      AND table_schema NOT IN ('pg_catalog', 'information_schema', 'public')
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT create_hypertable(%L, %L, if_not_exists => TRUE, chunk_time_interval => INTERVAL %L)',
        format('%I.%I', r.table_schema, r.table_name),
        'time',
        '1 day'
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (device_id, time DESC)',
        'idx_' || r.table_schema || '_device_readings_device_time', r.table_schema, r.table_name);
      EXECUTE format('ALTER TABLE %I.%I SET (timescaledb.compress, timescaledb.compress_segmentby = %L, timescaledb.compress_orderby = %L)',
        r.table_schema, r.table_name, 'device_id', 'time DESC');
      EXECUTE format('SELECT add_compression_policy(%L, INTERVAL %L, if_not_exists => TRUE)',
        format('%I.%I', r.table_schema, r.table_name), '7 days');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping %.%: %', r.table_schema, r.table_name, SQLERRM;
    END;
  END LOOP;
END $$;
