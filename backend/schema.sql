-- Emberwatch TigerData/Timescale schema — emberwatch.v1
-- Apply to the provisioned TigerData service before enabling DATABASE_URL.
-- No image/personnel/review tables exist by design: only the latest JPEG is
-- kept in backend memory and reviews are local to the browser.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Timestamped drone observations, time-partitioned for the TigerData challenge.
CREATE TABLE IF NOT EXISTS telemetry (
  observed_at  TIMESTAMPTZ NOT NULL,
  drone_id     TEXT,
  provenance   TEXT NOT NULL,
  payload      JSONB NOT NULL
);

SELECT create_hypertable('telemetry', 'observed_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS telemetry_observed_at_idx
  ON telemetry (observed_at DESC);

-- Gemini analysis records. payload holds the full record including
-- summary/unknowns/limitations, model, evidence_kind and provenance.
CREATE TABLE IF NOT EXISTS analyses (
  id           UUID PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL,
  evidence_at  TIMESTAMPTZ,
  payload      JSONB NOT NULL
);

SELECT create_hypertable('analyses', 'created_at', if_not_exists => TRUE);
