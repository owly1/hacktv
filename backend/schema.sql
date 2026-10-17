-- Emberwatch TigerData/Timescale schema — emberwatch.v1
-- Apply with `npm run db:init` (needs DATABASE_URL), or paste into the
-- TigerData SQL editor. Every statement is idempotent.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------- telemetry
-- One row per drone observation (~1 Hz). Typed columns feed the aggregates;
-- payload keeps the full validated sample.
CREATE TABLE IF NOT EXISTS telemetry (
  observed_at       TIMESTAMPTZ NOT NULL,
  drone_id          TEXT,
  provenance        TEXT NOT NULL,
  battery_pct       DOUBLE PRECISION,
  altitude_m        DOUBLE PRECISION,
  ground_speed_mps  DOUBLE PRECISION,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  state             TEXT,
  payload           JSONB NOT NULL
);
SELECT create_hypertable('telemetry', 'observed_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetry_drone_time_idx ON telemetry (drone_id, observed_at DESC);

-- Per-minute flight summary, maintained incrementally by TimescaleDB.
-- Real-time aggregation (materialized_only = false) includes the newest,
-- not-yet-materialized minute, so the dashboard chart is always current.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 minute', observed_at) AS bucket,
       drone_id,
       count(*)              AS samples,
       avg(altitude_m)       AS avg_altitude_m,
       max(altitude_m)       AS max_altitude_m,
       avg(ground_speed_mps) AS avg_ground_speed_mps,
       min(battery_pct)      AS min_battery_pct,
       last(state, observed_at) AS last_state
FROM telemetry
GROUP BY bucket, drone_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1m',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE);

-- Older raw telemetry is compressed column-wise; the aggregate keeps serving it.
ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'drone_id');
SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- --------------------------------------------------------------- detections
-- Every fire sighting from the drone's camera (YOLO fire/smoke model or the
-- QR test marker). Sightings of the same fire share an episode_id. The frame
-- that triggered each sighting is archived on disk; image_path references it.
CREATE TABLE IF NOT EXISTS detections (
  id           UUID NOT NULL,
  detected_at  TIMESTAMPTZ NOT NULL,
  episode_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  label        TEXT NOT NULL,
  confidence   DOUBLE PRECISION NOT NULL,
  latitude     DOUBLE PRECISION,
  longitude    DOUBLE PRECISION,
  status       TEXT NOT NULL DEFAULT 'active',
  image_path   TEXT,
  payload      JSONB NOT NULL,
  PRIMARY KEY (id, detected_at)
);
SELECT create_hypertable('detections', 'detected_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS detections_episode_idx ON detections (episode_id, detected_at DESC);

-- ------------------------------------------------------- analyses and plans
-- Gemini scene analyses and operational plans. The partition column must be
-- part of the primary key on a hypertable.
CREATE TABLE IF NOT EXISTS analyses (
  id           UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  evidence_at  TIMESTAMPTZ,
  episode_id   TEXT,
  payload      JSONB NOT NULL,
  PRIMARY KEY (id, created_at)
);
SELECT create_hypertable('analyses', 'created_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS plans (
  id           UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  episode_id   TEXT,
  payload      JSONB NOT NULL,
  PRIMARY KEY (id, created_at)
);
SELECT create_hypertable('plans', 'created_at', if_not_exists => TRUE);
