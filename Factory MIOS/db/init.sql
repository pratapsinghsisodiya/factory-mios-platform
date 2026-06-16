-- Enable TimescaleDB + UUID. Tables are created by SQLAlchemy on backend start;
-- this only ensures required extensions exist before the app boots.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
