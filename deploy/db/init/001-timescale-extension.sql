-- Factory-MIOS TimescaleDB bootstrap.
-- Runs automatically only when the database volume is first created.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
