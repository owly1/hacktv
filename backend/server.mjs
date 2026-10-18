// Emberwatch backend — emberwatch.v1 contract.
// Node 22 built-in http only; `pg` is an optional dependency used when
// DATABASE_URL is configured. Every dependency below is injectable so tests
// can exercise the API without TigerData, Gemini, or a drone.
//
// Data flow: the Python bridge (bridge/anafi_bridge.py) POSTs telemetry,
// live video frames, fire detections and flight events here with the ingest
// token. The dashboard (dist/) reads everything back with the dashboard
// token. TigerData stores the time series; Gemini analyses detections and
// writes operational plans.

import http from 'node:http';
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PersonSearch, validatePersonObservation, describeLeadsForPlan, MAX_CROP_BYTES } from './people.mjs';
import {validateCameraSighting, recordCameraSighting} from './person-sightings.mjs';
import SITE_LANDMARKS from './site-landmarks.json' with { type: 'json' };
import { PersonSearchSim, scenarioFromExample } from './people-sim.mjs';
import { AutonomousResponse } from './autonomy.mjs';
import {DiveRuntime} from './dive-runtime.mjs';
import {
  ApiError,
  MAX_FRAME_BYTES,
  ageMs,
  isFresh,
  isOriginAllowed,
  parseAllowedOrigins,
  validateDetection,
  validateFlightEvent,
  validateFrame,
  validateOverlays,
  validateSnapshotEnvelope,
  validateTelemetry,
  parseIsoTimestamp,
  assertWithinClockWindow,
} from './validation.mjs';

const CONTRACT = 'emberwatch.v1';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_JSON_BODY = 8 * 1024 * 1024; // fits a 5 MB base64 snapshot envelope
const GEMINI_MIN_INTERVAL_MS = 30_000;  // one started analysis per 30 s
const PLAN_MIN_INTERVAL_MS = 10_000;
// Per-call cap on one generateContent request; a tool-calling loop can exceed
// shorter caps on a cold first call. Env override for slower upstreams.
const GEMINI_UPSTREAM_TIMEOUT_MS =
  Number(process.env.GEMINI_UPSTREAM_TIMEOUT_MS) || 60_000;
const GEMINI_PLAN_TIMEOUT_MS = 45_000;    // plans are long structured outputs
const INCIDENT_ACTIVE_MS = 30 * 60_000;  // a fire stays on the map 30 min after its last sighting
const VIDEO_BOUNDARY = 'emberframe';

// Sam Ibrahim Building, University of Toronto Scarborough (north campus).
export const DEFAULT_SITE = Object.freeze({
  name: 'UTSC · Sam Ibrahim Building',
  latitude: 43.7866,
  longitude: -79.1903,
});

// Map tiles are proxied and cached on disk (data/tiles), so any area viewed
// once while online keeps working on the drone's internet-less Wi-Fi. Only
// tiles a viewer actually requests are fetched (no bulk prefetching), per
// the OpenStreetMap tile usage policy.
// sat (Esri World Imagery) backs Demo mode's satellite map and the simulated
// drone camera; note its {y}/{x} order.
const TILE_SOURCES = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ---------------------------------------------------------------- storage

const MEMORY_TELEMETRY_CAP = 50_000;

/** Aggregate telemetry into per-minute summaries for the in-memory storage path. */
function bucketRows(samples, sinceMs) {
  const buckets = new Map();
  for (const s of samples) {
    const t = Date.parse(s.observed_at);
    if (t < sinceMs) continue;
    const key = Math.floor(t / 60_000) * 60_000;
    const b = buckets.get(key) ?? { bucket: new Date(key).toISOString(), samples: 0, alt: [], speed: [], battery: [] };
    b.samples++;
    if (s.altitude_m != null) b.alt.push(s.altitude_m);
    if (s.ground_speed_mps != null) b.speed.push(s.ground_speed_mps);
    if (s.battery_pct != null) b.battery.push(s.battery_pct);
    buckets.set(key, b);
  }
  /** Average available numeric measurements in the telemetry bucket. */
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return [...buckets.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((b) => ({
      bucket: b.bucket,
      samples: b.samples,
      avg_altitude_m: avg(b.alt),
      max_altitude_m: b.alt.length ? Math.max(...b.alt) : null,
      avg_ground_speed_mps: avg(b.speed),
      min_battery_pct: b.battery.length ? Math.min(...b.battery) : null,
    }));
}

/** Combine related detection rows into one incident summary. */
function summarizeEpisode(rows) {
  if (rows.length === 0) return null;
  const sorted = rows.slice().sort((a, b) => a.detected_at.localeCompare(b.detected_at));
  const latest = sorted[sorted.length - 1];
  return {
    episode_id: latest.episode_id,
    first_detected_at: sorted[0].detected_at,
    last_seen_at: latest.detected_at,
    sightings: sorted.length,
    max_confidence: Math.max(...sorted.map((r) => r.confidence)),
    status: latest.status,
    latest,
  };
}

export class MemoryStorage {
  /** Initialize this storage adapter's backing state. */
  constructor() {
    this.telemetry = [];
    this.analyses = [];
    this.detections = [];
    this.plans = [];
    this.kind = 'memory only';
  }
  /** Report configured storage health without claiming an unverified connection. */
  status() {
    return this.kind;
  }
  /** Store a validated timestamped telemetry sample in this adapter. */
  async insertTelemetry(sample) {
    this.telemetry.push(sample);
    if (this.telemetry.length > MEMORY_TELEMETRY_CAP) this.telemetry.splice(0, 1000);
  }
  /** Return the newest stored telemetry sample, or no sample. */
  async latestTelemetry() {
    if (this.telemetry.length === 0) return null;
    return this.telemetry.reduce((a, b) =>
      Date.parse(a.observed_at) >= Date.parse(b.observed_at) ? a : b);
  }
  /** Read recent telemetry in newest-first order with optional time/row limits. */
  async telemetryHistory({ limit = 50, sinceMs = null } = {}) {
    let rows = this.telemetry.slice().sort(
      (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at),
    );
    if (sinceMs !== null) rows = rows.filter((r) => Date.parse(r.observed_at) >= sinceMs);
    return rows.slice(0, limit);
  }
  /** Return per-minute telemetry statistics since the requested cutoff. */
  async telemetrySummary({ sinceMs }) {
    return bucketRows(this.telemetry, sinceMs);
  }
  /** Preserve measurement provenance and missing-position gaps in the received GPS trail. */
  async flightPath({ sinceMs, limit = 600 }) {
    return this.telemetry
      .filter((s) => Date.parse(s.observed_at) >= sinceMs)
      .sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at))
      .slice(-limit)
      .map((s) => ({ t: s.observed_at, latitude: s.latitude, longitude: s.longitude, altitude_m: s.altitude_m,
        provenance:s.provenance,drone_id:s.drone_id,gps_fix:s.gps_fix,
        position_source:s.extra?.position_source??null,gps_observed_at:s.extra?.gps_observed_at??null,
        gps_accuracy_m:s.extra?.gps_accuracy_m??null,
        heading_deg: s.extra?.heading_deg ?? null, gimbal_pitch_deg: s.extra?.gimbal_pitch_deg ?? null }));
  }
  /** Persist a validated Gemini analysis record. */
  async insertAnalysis(record) {
    this.analyses.push(record);
  }
  /** Return the newest stored analysis records up to the requested limit. */
  async latestAnalyses(limit = 10) {
    return this.analyses.slice(-limit).reverse();
  }
  /** Store an accepted fire sighting and its episode identity. */
  async insertDetection(record) {
    this.detections.push(record);
  }
  /** Check whether any sighting already belongs to the requested episode. */
  async episodeExists(episodeId) {
    return this.detections.some((d) => d.episode_id === episodeId);
  }
  /** Build the latest incident from its stored episode sightings. */
  async latestIncident() {
    if (this.detections.length === 0) return null;
    const last = this.detections.reduce((a, b) => (a.detected_at >= b.detected_at ? a : b));
    return summarizeEpisode(this.detections.filter((d) => d.episode_id === last.episode_id));
  }
  /** Read recent detection records in newest-first order. */
  async detectionHistory({ limit = 50 } = {}) {
    return this.detections.slice().sort((a, b) => b.detected_at.localeCompare(a.detected_at)).slice(0, limit);
  }
  /** Look up a stored sighting by its evidence identifier. */
  async detectionById(id) {
    return this.detections.find((d) => d.id === id) ?? null;
  }
  /** Apply an incident status such as dismissal to the matching episode. */
  async setEpisodeStatus(episodeId, status) {
    let n = 0;
    for (const d of this.detections) if (d.episode_id === episodeId) { d.status = status; n++; }
    return n;
  }
  /** Persist a validated operational-plan record. */
  async insertPlan(record) {
    this.plans.push(record);
  }
  /** Return the newest stored plans up to the requested limit. */
  async latestPlans(limit = 5) {
    return this.plans.slice(-limit).reverse();
  }
}

// TigerData / Timescale PostgreSQL adapter. A configured database failure
// must never silently switch to memory: errors surface as 503 and the status
// endpoint reports the database as unavailable.
export class PgStorage {
  /** Initialize this storage adapter's backing state. */
  constructor(pool) {
    this.pool = pool;
    this.kind = 'postgres';
    this.lastError = null;
  }
  /** Report configured storage health without claiming an unverified connection. */
  status() {
    return this.lastError ? 'postgres-unavailable' : 'postgres';
  }
  /** Run a PostgreSQL query while retaining connection health/error state. */
  async q(sql, params = []) {
    try {
      const result = await this.pool.query(sql, params);
      this.lastError = null;
      return result.rows;
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
  /** Store a validated timestamped telemetry sample in this adapter. */
  async insertTelemetry(s) {
    await this.q(
      `INSERT INTO telemetry (observed_at, drone_id, provenance, battery_pct, altitude_m,
         ground_speed_mps, latitude, longitude, state, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [s.observed_at, s.drone_id, s.provenance, s.battery_pct, s.altitude_m,
        s.ground_speed_mps, s.latitude, s.longitude, s.state, JSON.stringify(s)],
    );
  }
  /** Return the newest stored telemetry sample, or no sample. */
  async latestTelemetry() {
    const rows = await this.q('SELECT payload FROM telemetry ORDER BY observed_at DESC LIMIT 1');
    return rows.length ? rows[0].payload : null;
  }
  /** Read recent telemetry in newest-first order with optional time/row limits. */
  async telemetryHistory({ limit = 50, sinceMs = null } = {}) {
    const since = sinceMs !== null ? new Date(sinceMs).toISOString() : null;
    const rows = await this.q(
      `SELECT payload FROM telemetry
       WHERE ($1::timestamptz IS NULL OR observed_at >= $1)
       ORDER BY observed_at DESC LIMIT $2`,
      [since, limit],
    );
    return rows.map((r) => r.payload);
  }
  // Reads the telemetry_1m continuous aggregate (real-time, so the current
  // minute is included).
  async telemetrySummary({ sinceMs }) {
    const rows = await this.q(
      `SELECT bucket, sum(samples)::int AS samples, avg(avg_altitude_m) AS avg_altitude_m,
              max(max_altitude_m) AS max_altitude_m, avg(avg_ground_speed_mps) AS avg_ground_speed_mps,
              min(min_battery_pct) AS min_battery_pct
       FROM telemetry_1m WHERE bucket >= $1 GROUP BY bucket ORDER BY bucket`,
      [new Date(sinceMs).toISOString()],
    );
    return rows.map((r) => ({ ...r, bucket: new Date(r.bucket).toISOString() }));
  }
  /** Preserve original GPS provenance and missing-position gaps in database-backed trails. */
  async flightPath({ sinceMs, limit = 600 }) {
    const rows = await this.q(
      `SELECT * FROM (
         SELECT observed_at, latitude, longitude, altitude_m, provenance, drone_id,
                payload->>'gps_fix' AS gps_fix,
                payload->'extra'->>'position_source' AS position_source,
                payload->'extra'->>'gps_observed_at' AS gps_observed_at,
                payload->'extra'->'gps_accuracy_m' AS gps_accuracy_m,
                (payload->'extra'->>'heading_deg')::float8 AS heading_deg,
                (payload->'extra'->>'gimbal_pitch_deg')::float8 AS gimbal_pitch_deg
         FROM telemetry
         WHERE observed_at >= $1
         ORDER BY observed_at DESC LIMIT $2) recent
       ORDER BY observed_at`,
      [new Date(sinceMs).toISOString(), limit],
    );
    return rows.map((r) => ({
      t: new Date(r.observed_at).toISOString(), latitude: r.latitude, longitude: r.longitude, altitude_m: r.altitude_m,
      provenance:r.provenance,drone_id:r.drone_id,gps_fix:r.gps_fix,
      position_source:r.position_source,gps_observed_at:r.gps_observed_at,gps_accuracy_m:r.gps_accuracy_m,
      heading_deg: r.heading_deg, gimbal_pitch_deg: r.gimbal_pitch_deg,
    }));
  }
  /** Persist a validated Gemini analysis record. */
  async insertAnalysis(record) {
    await this.q(
      'INSERT INTO analyses (id, created_at, evidence_at, episode_id, payload) VALUES ($1, $2, $3, $4, $5)',
      [record.id, record.created_at, record.evidence_at, record.episode_id ?? null, JSON.stringify(record)],
    );
  }
  /** Return the newest stored analysis records up to the requested limit. */
  async latestAnalyses(limit = 10) {
    const rows = await this.q('SELECT payload FROM analyses ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map((r) => r.payload);
  }
  /** Store an accepted fire sighting and its episode identity. */
  async insertDetection(d) {
    await this.q(
      `INSERT INTO detections (id, detected_at, episode_id, source, label, confidence,
         latitude, longitude, status, image_path, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [d.id, d.detected_at, d.episode_id, d.source, d.label, d.confidence,
        d.fire.latitude, d.fire.longitude, d.status, d.image_path, JSON.stringify(d)],
    );
  }
  /** Check whether any sighting already belongs to the requested episode. */
  async episodeExists(episodeId) {
    const rows = await this.q('SELECT 1 FROM detections WHERE episode_id = $1 LIMIT 1', [episodeId]);
    return rows.length > 0;
  }
  /** Build the latest incident from its stored episode sightings. */
  async latestIncident() {
    const rows = await this.q(
      `SELECT payload, status FROM detections
       WHERE episode_id = (SELECT episode_id FROM detections ORDER BY detected_at DESC LIMIT 1)
       ORDER BY detected_at`,
    );
    return summarizeEpisode(rows.map((r) => ({ ...r.payload, status: r.status })));
  }
  /** Read recent detection records in newest-first order. */
  async detectionHistory({ limit = 50 } = {}) {
    const rows = await this.q(
      'SELECT payload, status FROM detections ORDER BY detected_at DESC LIMIT $1', [limit],
    );
    return rows.map((r) => ({ ...r.payload, status: r.status }));
  }
  /** Look up a stored sighting by its evidence identifier. */
  async detectionById(id) {
    const rows = await this.q('SELECT payload, status FROM detections WHERE id = $1 LIMIT 1', [id]);
    return rows.length ? { ...rows[0].payload, status: rows[0].status } : null;
  }
  /** Apply an incident status such as dismissal to the matching episode. */
  async setEpisodeStatus(episodeId, status) {
    const rows = await this.q(
      'UPDATE detections SET status = $2 WHERE episode_id = $1 RETURNING id', [episodeId, status],
    );
    return rows.length;
  }
  /** Persist a validated operational-plan record. */
  async insertPlan(record) {
    await this.q(
      'INSERT INTO plans (id, created_at, episode_id, payload) VALUES ($1, $2, $3, $4)',
      [record.id, record.created_at, record.episode_id ?? null, JSON.stringify(record)],
    );
  }
  /** Return the newest stored plans up to the requested limit. */
  async latestPlans(limit = 5) {
    const rows = await this.q('SELECT payload FROM plans ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map((r) => r.payload);
  }
}

/** Create a TLS-configured pool with idle-error recovery and bounded connection startup. */
export async function createPgPool({ databaseUrl, pgCaFile }) {
  const pg = await import('pg');
  const config = { connectionString: databaseUrl };
  if (pgCaFile) {
    config.ssl = { ca: await readFile(pgCaFile, 'utf8'), rejectUnauthorized: true };
  }
  // Drop idle connections before networks (eduroam, phone tethers) silently kill them,
  // and detect dead ones with keep-alives.
  Object.assign(config, { idleTimeoutMillis: 30_000, keepAlive: true, connectionTimeoutMillis: 10_000 });
  const pool = new pg.default.Pool(config);
  // An idle connection dying (e.g. ETIMEDOUT on a Wi-Fi blip) is reported here. Without a
  // listener Node treats it as fatal and the whole backend exits. The pool replaces the
  // connection on the next query; the failing query (if any) still gets its own error.
  pool.on('error', (err) => {
    console.error(`database: idle connection lost (${err.code || err.message}); it will reconnect on the next query`);
  });
  return pool;
}

/** Select explicit memory storage or configured PostgreSQL, preserving unavailable-database errors. */
export async function createStorage({ databaseUrl, pgCaFile } = {}) {
  if (!databaseUrl) return new MemoryStorage();
  let pool;
  try {
    pool = await createPgPool({ databaseUrl, pgCaFile });
  } catch {
    // DATABASE_URL is set but the driver is missing — report an unavailable
    // configured database rather than silently falling back to memory.
    const broken = new PgStorage({ /* Raise the configured database-unavailable error instead of silently using memory. */ query: async () => { throw new Error('pg package not installed'); } });
    broken.lastError = 'pg package not installed';
    return broken;
  }
  return new PgStorage(pool);
}

// ------------------------------------------------------------------ gemini

export const ANALYSIS_INSTRUCTIONS = [
  'You are the scene-analysis officer for Emberwatch, a drone wildfire-monitoring system flying a Parrot ANAFI.',
  'Analyze the supplied drone evidence: describe the visible fire and smoke, then estimate fire size, intensity, severity and the most likely spread direction',
  'using the detection details, the estimated fire position, scenario conditions and drone telemetry.',
  'Set severity to one of: low, moderate, high, extreme.',
  'People come first: if the data lists person-search rescue leads, the plan must address every unacknowledged lead (who goes, how they get there, what is still unknown), ahead of property and containment.',
  'Never describe any route, road, area, zone or corridor as "safe" or "clear". Fire behaviour changes and the drone cannot verify ground conditions. Instead state the observed hazards, what was not observed, how recent the observation is, and the trigger that would close the route.',
  'Treat lead positions as areas: quote the ±metres uncertainty, and never present a detector score or any percentage as the chance that a person is there.',
  'Direction convention: every direction in the data (wind_dir_deg, direction, toward_deg, bearing_deg) is the direction the fire spreads or the wind blows TOWARD, in degrees clockwise from north (60 = toward the east-northeast) — never the direction the wind comes from.',
  'List what this evidence cannot establish under "unknowns" and the specific observations that would overturn your assessment under "falsifiers".',
  'If only telemetry is supplied (no image), say plainly that this sample contains no visual fire evidence.',
  'The drone has no anemometer, but its flight controller estimates wind onboard: telemetry extra.fc_wind_speed_mps / fc_wind_direction_deg / fc_wind_state come from that onboard estimator — when they are present, treat them as the wind reading and cite them rather than re-deriving. When they are absent you may still derive an APPROXIMATE wind vector from its stabilization behavior. Sign convention: while holding position a multirotor tilts INTO the wind (toward its source) so rotor thrust balances wind drag — the wind therefore blows TOWARD the azimuth opposite the sustained tilt; GPS wander between position corrections drifts downwind (in the TOWARD direction); and in forward flight the difference between heading and achieved ground track reveals the crosswind. Tilt magnitude and wander rate correlate loosely with wind speed, not precisely — report an approximate value with honest confidence. Stabilization is only visible over time — call get_telemetry_history before estimating; a single sample is not evidence of stabilization. When you estimate wind this way, fill wind_estimate and state the method; it is a derived estimate, never a sensor measurement. If the telemetry lacks attitude data or enough history to observe stabilization, omit wind_estimate and list wind conditions under unknowns.',
].join(' ');

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    severity: { type: 'STRING', enum: ['low', 'moderate', 'high', 'extreme'] },
    observations: { type: 'ARRAY', items: { type: 'STRING' } },
    spread_outlook: { type: 'STRING' },
    unknowns: { type: 'ARRAY', items: { type: 'STRING' } },
    falsifiers: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Specific evidence or observations that would overturn this assessment — the model states how it could be wrong.',
    },
    wind_estimate: {
      type: 'OBJECT',
      description: 'Wind vector derived from drone stabilization behavior (no wind sensor is fitted). A derived estimate — never report it as a sensor measurement.',
      properties: {
        speed_mps: { type: 'NUMBER', description: 'Approximate wind speed in m/s.' },
        direction_deg: { type: 'NUMBER', description: 'Direction the wind blows TOWARD, degrees clockwise from north.' },
        method: { type: 'STRING', description: 'The stabilization behavior the estimate was derived from (e.g. hover tilt, position-hold GPS wander, ground-track drift).' },
        confidence: { type: 'STRING', description: 'low / medium / high, with the limiting factor.' },
      },
      required: ['method', 'confidence'],
    },
    limitations: { type: 'STRING' },
  },
  required: ['summary', 'unknowns', 'limitations'],
};

// The Gemini-track differentiator: the model is an evidence-seeking agent.
// It may call these tools to pull fresh observations before writing its
// structured assessment; every call lands in the record's tool_trace.
const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_latest_telemetry',
      description: 'Returns the most recent drone telemetry observation (battery, altitude, ground speed, GPS, flight state) with its source timestamp.',
    },
    {
      name: 'get_telemetry_history',
      description: 'Returns recent drone telemetry observations, newest first, for trend analysis.',
      parameters: {
        type: 'OBJECT',
        properties: {
          limit: { type: 'INTEGER', description: 'Max samples, default 20' },
          since_minutes: { type: 'NUMBER', description: 'Only samples observed within the last N minutes' },
        },
      },
    },
    {
      name: 'get_snapshot',
      description: 'Returns the latest drone camera JPEG as image content plus its capture timestamp.',
    },
    {
      name: 'get_detection_history',
      description: 'Returns recent fire sightings (time, confidence, estimated fire position) from the drone camera, newest first.',
    },
  ],
}];

const MAX_TOOL_ROUNDS = 2; // then a forced tool-free final answer

// ---- "ask the incident": map-grounded Q&A ----
// The model answers in the venue's own language — named buildings, roads and
// terrain — because the server computes real distance/bearing/projected-arrival
// facts for every gazetteer place and hands them over as tools. This is what
// keeps answers specific instead of generic LLM guesses.
const ASK_MIN_INTERVAL_MS = 15_000;
const ASK_INSTRUCTIONS = [
  'You are the incident analyst for a drone wildfire-monitoring dashboard at the mapped site.',
  'Answer the commander\'s question briefly and concretely, in the place names and numbers provided below — not generic statements.',
  'Every named place in PLACE FACTS has real computed values: distance from the fire, compass bearing from the fire, whether it is inside the burn now, and the projected minutes until the spread outline reaches it (null = not projected within the horizon).',
  'Directions are degrees clockwise from north; wind direction is the direction the wind blows TOWARD; projected arrival uses the illustrative spread model on this dashboard, so give times as approximate ("~35 min") and flag when the question outruns the model\'s honesty (e.g. beyond 180 min).',
  'You may call landmark_query for a place\'s facts, point_query for any raw coordinates, and the telemetry/detection/snapshot tools for live evidence. Only claim what the facts or tools support; anything unknowable belongs in confidence_note.',
  'In landmarks_mentioned, list the id of every named place your answer refers to (use only ids present in PLACE FACTS).',
].join(' ');
const ASK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING', description: 'Concrete answer citing named places, distances, bearings and/or projected arrival times.' },
    landmarks_mentioned: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Gazetteer ids of named places cited in the answer.' },
    confidence_note: { type: 'STRING', description: 'What limits this answer (model is illustrative, telemetry gaps, horizon), or empty.' },
  },
  required: ['answer'],
};
const ASK_EXTRA_TOOLS = [{
  functionDeclarations: [
    {
      name: 'landmark_query',
      description: 'Returns computed facts (distance, bearing, inside-fire-now, projected arrival minutes) for a named place at this site.',
      parameters: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING', description: 'Place name or id, e.g. "Instructional Centre" or "ic".' } },
        required: ['name'],
      },
    },
    {
      name: 'point_query',
      description: 'Returns projected-arrival facts for an arbitrary lat/lon point near the site.',
      parameters: {
        type: 'OBJECT',
        properties: {
          latitude: { type: 'NUMBER' },
          longitude: { type: 'NUMBER' },
        },
        required: ['latitude', 'longitude'],
      },
    },
  ],
}];

/* Metres between two geographic points (equirectangular, matches destPoint). */
function geoDistanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}
/* Clockwise-from-north bearing from point 1 to point 2. */
function geoBearingDeg(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1;
  const dLon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
}

/** Computed facts for one place vs the current fire projection (origin may be null — then only site-relative distance is honest). */
export function placeFacts(place, origin, scenario, details, site) {
  const M = globalThis.EmberModel;
  const anchor = origin ?? [site.latitude, site.longitude];
  const pt = [place.latitude, place.longitude];
  const facts = {
    id: place.id, name: place.name, kind: place.kind,
    latitude: place.latitude, longitude: place.longitude,
    distance_m: Math.round(geoDistanceM(anchor[0], anchor[1], pt[0], pt[1])),
  };
  if (!origin) { facts.fire_context = 'no active fire — distance is from the configured site anchor'; return facts; }
  facts.bearing_deg = Math.round(geoBearingDeg(origin[0], origin[1], pt[0], pt[1]));
  facts.bearing_compass = M.compass(facts.bearing_deg);
  facts.inside_fire_now = M.insidePolygon(pt, M.footprint(origin, 0, scenario, details));
  facts.projected_arrival_min = M.arrivalMinutes(origin, pt, scenario, details);
  return facts;
}

function describeDetection(detection) {
  if (!detection) return null;
  const testNote = detection.source === 'qr-test'
    ? ' This sighting comes from the Emberwatch test marker, which stands in for a real fire: the image shows the printed marker, and "details" lists the properties of the fire it represents. Treat those details as the fire\'s observed properties.'
    : '';
  return `Fire detection from the drone camera (${detection.source}, label "${detection.label}", confidence ${detection.confidence.toFixed(2)}).`
    + ` Estimated fire position and drone state: ${JSON.stringify({ fire: detection.fire, drone: detection.drone })}.`
    + ` Fire details: ${JSON.stringify(detection.details ?? null)}.${testNote}`;
}

/** Build Gemini text/image inputs from the selected fresh evidence and detection context. */
export function buildAnalysisParts(evidence) {
  const parts = [{ text: ANALYSIS_INSTRUCTIONS }];
  const detectionText = describeDetection(evidence.detection);
  if (detectionText) parts.push({ text: detectionText });
  if (evidence.scenario) parts.push({ text: `Scenario conditions: ${JSON.stringify(evidence.scenario)}` });
  if (evidence.kind === 'rgb-snapshot') {
    parts.push({
      text: `Telemetry accompanying the image: ${JSON.stringify(evidence.telemetry ?? null)}`,
    });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: evidence.jpeg.toString('base64'),
      },
    });
  } else {
    parts.push({
      text: `Telemetry-only evidence (no image supplied): ${JSON.stringify(evidence.telemetry)}`,
    });
  }
  return parts;
}

/** Read the first Gemini candidate's content parts, defaulting to an empty list. */
function candidateParts(apiResponse) {
  return apiResponse?.candidates?.[0]?.content?.parts ?? [];
}

/** Collect model text and reject responses that contain no usable text output. */
function extractGeminiText(apiResponse) {
  const text = candidateParts(apiResponse).map((p) => p.text ?? '').join('');
  if (!text) throw new ApiError(502, 'Gemini response contained no text content');
  return text;
}

/** Parse the model's structured JSON and surface malformed output as an upstream error. */
function parseGeminiJson(apiResponse) {
  try {
    return JSON.parse(extractGeminiText(apiResponse));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'Gemini returned non-JSON content');
  }
}

/** Check the string-array fields required by the response contract. */
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Optional derived-wind block: absent is fine, present must be well-formed.
// speed_mps / direction_deg stay optional inside it — a confident
// "moving air, direction unknown" estimate is legitimate.
function validateWindEstimate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(502, 'Gemini output "wind_estimate" must be an object');
  }
  for (const key of ['method', 'confidence']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new ApiError(502, `Gemini output "wind_estimate.${key}" must be a non-empty string`);
    }
  }
  for (const key of ['speed_mps', 'direction_deg']) {
    if (value[key] !== undefined && value[key] !== null
        && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      throw new ApiError(502, `Gemini output "wind_estimate.${key}" must be a finite number or absent`);
    }
  }
  // Sanity bounds: negative speed is meaningless, and ~60 m/s exceeds anything
  // an ANAFI can operate in — a larger claim is a model error, not evidence.
  if (value.speed_mps !== undefined && value.speed_mps !== null
      && (value.speed_mps < 0 || value.speed_mps > 60)) {
    throw new ApiError(502, 'Gemini output "wind_estimate.speed_mps" must be 0–60');
  }
  if (value.direction_deg !== undefined && value.direction_deg !== null
      && (value.direction_deg < 0 || value.direction_deg >= 360)) {
    throw new ApiError(502, 'Gemini output "wind_estimate.direction_deg" must be 0–360');
  }
  return {
    speed_mps: value.speed_mps ?? null,
    direction_deg: value.direction_deg ?? null,
    method: value.method,
    confidence: value.confidence,
  };
}

// The flight controller's own wind estimate (flight_data WindSpeed, forwarded
// by the bridge as telemetry extra.fc_wind_*) outranks any model-derived
// estimate: same physics, fused onboard from motor commands + IMU at high
// rate. Still an estimate, not a sensor — the method string says so.
export function fcWindEstimate(sample) {
  const extra = sample?.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  // null means "the drone hasn't streamed it yet" — do not coerce to 0
  if (extra.fc_wind_speed_mps == null) return null;
  const speed = Number(extra.fc_wind_speed_mps);
  // same operational bound as validateWindEstimate: >60 m/s is a bad value,
  // not evidence
  if (!Number.isFinite(speed) || speed < 0 || speed > 60) return null;
  const dir = extra.fc_wind_direction_deg == null ? NaN : Number(extra.fc_wind_direction_deg);
  const windState = typeof extra.fc_wind_state === 'string' ? extra.fc_wind_state : null;
  return {
    speed_mps: speed,
    direction_deg: Number.isFinite(dir) && dir >= 0 && dir < 360 ? dir : null,
    method: 'flight-controller estimate (ANAFI onboard EKF — not a sensor reading)',
    confidence: windState ? `FC wind alert state: ${windState}` : 'FC estimate',
  };
}

/** Validate and normalize scene analysis, uncertainty and optional derived-wind fields. */
export function validateAnalysisContent(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(502, 'Gemini output is not a JSON object');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) {
    throw new ApiError(502, 'Gemini output missing "summary"');
  }
  if (!isStringArray(parsed.unknowns)) {
    throw new ApiError(502, 'Gemini output "unknowns" must be an array of strings');
  }
  if (parsed.falsifiers !== undefined && !isStringArray(parsed.falsifiers)) {
    throw new ApiError(502, 'Gemini output "falsifiers" must be an array of strings');
  }
  const wind = validateWindEstimate(parsed.wind_estimate);
  if (typeof parsed.limitations !== 'string' || parsed.limitations.length === 0) {
    throw new ApiError(502, 'Gemini output missing "limitations"');
  }
  return {
    summary: parsed.summary,
    severity: ['low', 'moderate', 'high', 'extreme'].includes(parsed.severity) ? parsed.severity : null,
    observations: isStringArray(parsed.observations) ? parsed.observations : [],
    spread_outlook: typeof parsed.spread_outlook === 'string' ? parsed.spread_outlook : null,
    unknowns: parsed.unknowns,
    falsifiers: parsed.falsifiers ?? [],
    ...(wind ? { wind_estimate: wind } : {}),
    limitations: parsed.limitations,
  };
}

export const PLAN_INSTRUCTIONS = [
  'You are the incident planning officer for Emberwatch, a drone wildfire-monitoring system.',
  'Write an operational plan for the detected fire that gives the incident team a concrete operational advantage over standard planning.',
  'Exploit what standard planning lacks: the drone\'s live position and camera evidence, the projected spread direction and timing, and the scenario conditions.',
  'Be specific and decisive: prioritized actions with an owner and a timing window, resource staging, explicit trigger points that force re-planning, and the key risks.',
  'In "advantage", state exactly how this plan outperforms a standard plan built without live drone data.',
  'Direction convention: every direction in the data (wind_dir_deg, direction, toward_deg, bearing_deg) is the direction the fire spreads or the wind blows TOWARD, in degrees clockwise from north (60 = toward the east-northeast) — never the direction the wind comes from.',
].join(' ');

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    situation: { type: 'STRING' },
    objectives: { type: 'ARRAY', items: { type: 'STRING' } },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          priority: { type: 'INTEGER' },
          action: { type: 'STRING' },
          owner: { type: 'STRING' },
          timing: { type: 'STRING' },
          rationale: { type: 'STRING' },
        },
        required: ['priority', 'action', 'timing'],
      },
    },
    resources: { type: 'ARRAY', items: { type: 'STRING' } },
    triggers: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    advantage: { type: 'STRING' },
    next_update: { type: 'STRING' },
  },
  required: ['title', 'situation', 'objectives', 'actions', 'advantage'],
};

/** Phrases a plan must not contain: nothing the drone sees can certify ground as safe. */
const UNSAFE_WORDING = /\b(safe|safer|clear|cleared|pre-cleared|secure|secured)(?:[\s/-]+(?!(?:the|a|an|this|that|all|any|of)\b)[a-z]+){0,2}?[\s/-]+(routes?|roads?|paths?|corridors?|zones?|areas?|passages?|exits?|ways? out)\b|\b(routes?|roads?|paths?|corridors?|zones?|areas?)\s+(is|are)\s+(now\s+)?(safe|clear|cleared)\b/gi;
/** Flag claims that a route or area is safe/clear for human review. */
export function findUnsafeWording(plan) {
  const text = JSON.stringify(plan);
  return [...new Set((text.match(UNSAFE_WORDING) ?? []).map((m) => m.toLowerCase()))];
}

/** Validate the structured plan and normalize actions, lists and required text fields. */
export function validatePlanContent(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(502, 'Gemini plan is not a JSON object');
  }
  for (const key of ['title', 'situation', 'advantage']) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new ApiError(502, `Gemini plan missing "${key}"`);
    }
  }
  if (!isStringArray(parsed.objectives)) throw new ApiError(502, 'Gemini plan "objectives" must be strings');
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    throw new ApiError(502, 'Gemini plan has no actions');
  }
  const actions = parsed.actions
    .filter((a) => a && typeof a.action === 'string')
    .map((a, i) => ({
      priority: Number.isInteger(a.priority) ? a.priority : i + 1,
      action: a.action,
      owner: typeof a.owner === 'string' ? a.owner : null,
      timing: typeof a.timing === 'string' ? a.timing : null,
      rationale: typeof a.rationale === 'string' ? a.rationale : null,
    }))
    .sort((a, b) => a.priority - b.priority);
  /** Keep an optional plan string list, or return an empty list for invalid/missing input. */
  const list = (v) => (isStringArray(v) ? v : []);
  return {
    title: parsed.title,
    situation: parsed.situation,
    objectives: parsed.objectives,
    actions,
    resources: list(parsed.resources),
    triggers: list(parsed.triggers),
    risks: list(parsed.risks),
    advantage: parsed.advantage,
    next_update: typeof parsed.next_update === 'string' ? parsed.next_update : null,
  };
}

// Incident replays run the same analysis as a live detection: the dashboard
// sends the incident record, the drone's current telemetry and camera frame.
export const DEMO_CONTEXT = [
  'This fire has just been detected by ANAFI-01. The incident record gives its location, the observed conditions and the drone\'s current telemetry and detection;',
  'the attached image, when present, is the drone\'s current camera frame with its on-screen display.',
  'Write the assessment for the incident commander exactly as for any live detection.',
].join(' ');

/** Copy JSON object input while rejecting arrays and scalar values. */
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : null);

// Default transport: real Gemini generateContent call. Takes the full request
// body (contents + generationConfig + tools/toolConfig) and resolves to the
// parsed API response. In tests an injected fake transport replaces this — a
// passing fixture test is not a live call.
// Overloaded (503), rate-limited (429) or failing (500) upstream models are
// retried once, then the next model in `fallbackModels` is tried, so a busy
// model does not take analysis down mid-demo.
const RETRYABLE_UPSTREAM = new Set([429, 500, 502, 503, 504]);
const SILENT_MODEL_COOLDOWN_MS = 5 * 60_000; // a model that stopped answering is skipped this long

function upstreamMessage(status, detail) {
  let message = detail.slice(0, 200);
  try {
    message = JSON.parse(detail)?.error?.message ?? message;
  } catch { /* not JSON */ }
  return `Gemini upstream returned HTTP ${status}${message ? `: ${message}` : ''}`;
}

/** Build bounded Gemini calls with transient retries, model fallback and silence cooldown. */
export function makeGeminiTransport({ apiKey, model, fallbackModels = [], fetchImpl = fetch, retryDelayMs = 1500, timeoutMs: defaultTimeoutMs = GEMINI_UPSTREAM_TIMEOUT_MS, now = () => Date.now() }) {
  const silentUntil = new Map();
  /** Call one model and keep its abort deadline active through response-body decoding. */
  async function callModel(name, requestBody, timeoutMs) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new ApiError(502, upstreamMessage(res.status, detail));
        err.retryable = RETRYABLE_UPSTREAM.has(res.status);
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Prefer the next model on silence; retry when only one model is configured.
      const silent = err.name === 'AbortError'
        ? new ApiError(502, `Gemini ${name} gave no answer within ${timeoutMs / 1000}s`)
        : new ApiError(502, `Gemini request failed (no internet connection?): ${err.message}`);
      silent.silent = true;
      silent.retryable = true;
      throw silent;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Try available models, record the actual respondent and preserve per-request timeouts. */
  async function geminiTransport(requestBody, { timeoutMs = defaultTimeoutMs } = {}) {
    const chain = [model, ...fallbackModels];
    // Skip models that recently went silent, unless every model has.
    const awake = chain.filter((m) => !(silentUntil.get(m) > now()));
    let lastError;
    for (const name of awake.length ? awake : chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const reply = await callModel(name, requestBody, timeoutMs);
          silentUntil.delete(name);
          geminiTransport.lastModel = (typeof reply?.modelVersion === 'string' && reply.modelVersion) || name;
          return reply;
        } catch (err) {
          lastError = err;
          if (err.silent && chain.length > 1) { silentUntil.set(name, now() + SILENT_MODEL_COOLDOWN_MS); break; }
          if (!err.retryable) throw err;
          if (attempt === 0) await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    if (lastError?.silent && chain.length > 1) {
      throw new ApiError(502, `No Gemini model answered (${chain.join(', ')}). ${lastError.message}`);
    }
    throw lastError;
  }
  geminiTransport.lastModel = null;
  return geminiTransport;
}

// -------------------------------------------------------------------- http

/** Read request bytes up to the explicit size limit and reject oversized bodies. */
async function readBody(req, maxBytes = MAX_JSON_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Decode a bounded request body as JSON and report a client error for invalid syntax. */
async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'request body is not valid JSON');
  }
}

/** Extract the bearer token from the Authorization header. */
function tokenFrom(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

/** Compare token bytes with a timing-safe equality check. */
function tokenEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Send uncached JSON with the requested status and additional response headers. */
function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/** Expose intentional API errors while hiding internal exception details. */
function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof ApiError ? err.message : 'internal error';
  sendJson(res, status, { error: message });
}

/** Stream a file only when its normalized path stays inside the configured static directory. */
async function serveStatic(res, staticDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.normalize(path.join(staticDir, rel));
  if (!target.startsWith(path.normalize(staticDir + path.sep))) {
    throw new ApiError(404, 'not found');
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new ApiError(404, 'not found');
  }
  if (info.isDirectory()) throw new ApiError(404, 'not found');
  const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// True only for a request made on this machine to a loopback hostname — the
// Host check stops DNS-rebinding pages from reading the session token.
function isLocalRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress) && LOOPBACK_HOSTS.has(host);
}

/** Identify PNG versus JPEG for archived detection-image delivery. */
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}

/** Construct the authenticated HTTP handler with injectable storage, clock and external services. */
export function createApp({
  ingestToken,
  dashboardToken,
  allowedOrigins,
  storage,
  geminiTransport = null,
  geminiModel = null,
  now = () => Date.now(),
  staticDir = null,
  dataDir = null,
  site = DEFAULT_SITE,
  demoFires = [],
  tileFetch = fetch,
  autoAnalyze = false,
  personSearch = {},
  divePersonDetector = null,
}) {
  if (!ingestToken || !dashboardToken || ingestToken === dashboardToken) {
    throw new Error('INGEST_TOKEN and DASHBOARD_TOKEN must be non-empty and different');
  }
  const state = {
    latestSnapshot: null, // { jpeg, capturedAtMs } — latest frame or snapshot, used as Gemini evidence
    latestFrame: null,    // { jpeg, capturedAtMs, detections }
    overlays: null,       // laptop inference, expires independently of the incident
    frameTimes: [],
    videoClients: new Set(),
    lastGeminiStart: -Infinity,
    lastPlanStart: -Infinity,
    lastAskStart: -Infinity,
    lastDemoStart: -Infinity,
    gemini: { lastError: null, lastErrorAt: null, lastOkAt: null, pending: false },
    flightEvents: [],
    autoTimer: null,
    vision: null,
    peopleSaveTimer: null,
    unlocatedPeople: new Map(),
    demoSims: new Map(), // scenario id -> PersonSearchSim
  };
  const autonomy = new AutonomousResponse(now);
  const dive = new DiveRuntime({now, detector:divePersonDetector});
  /** Keep dive authorization tied to the original QR flight and actual live evidence. */
  async function diveContext() {
    const telemetry=await storage.latestTelemetry();
    const age=telemetry?now()-Date.parse(telemetry.observed_at):Infinity;
    const videoAge=state.latestFrame?now()-state.latestFrame.capturedAtMs:Infinity;
    const a=autonomy.snapshot();
    return {telemetry_fresh:age>=0&&age<3000,video_fresh:videoAge>=0&&videoAge<3000,
      flight_authorized:!!a.enabled&&a.mode==='circle'&&!!a.mission,person_detection:dive.health()};
  }
  const peopleFile = dataDir ? path.join(dataDir, 'people', 'state.json') : null;
  let people = new PersonSearch(personSearch);
  // Leads survive a backend restart: they are written to data/people/state.json.
  const peopleReady = peopleFile
    ? readFile(peopleFile, 'utf8').then((text) => {
      const saved = JSON.parse(text); people = PersonSearch.fromJSON(saved, personSearch);
      for (const record of (saved.unlocated_sightings || []).slice(-200)) state.unlocatedPeople.set(record.track_id, record);
    }).catch(() => {})
    : Promise.resolve();

  /** Debounce an atomic local search-state save without keeping the process alive. */
  function savePeople() {
    if (!peopleFile || state.peopleSaveTimer) return;
    state.peopleSaveTimer = setTimeout(async () => {
      state.peopleSaveTimer = null;
      try {
        await mkdir(path.dirname(peopleFile), { recursive: true });
        await writeFile(`${peopleFile}.tmp`, JSON.stringify({...people.toJSON(), unlocated_sightings: [...state.unlocatedPeople.values()]}));
        await rename(`${peopleFile}.tmp`, peopleFile);
      } catch (err) {
        console.error(`person search: could not save leads: ${err.message}`);
      }
    }, 150);
    state.peopleSaveTimer.unref?.();
  }

  /** Map a validated observation identifier to its local JPEG evidence path. */
  function cropPath(obsId) { return dataDir ? path.join(dataDir, 'people', 'crops', `${obsId.replace(/[^A-Za-z0-9._-]/g, '_')}.jpg`) : null; }
  /** Save an accepted observation crop when persistent data storage is enabled. */
  async function saveCrop(obsId, jpeg) {
    const file = cropPath(obsId);
    if (!file) return false;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jpeg);
    return true;
  }

  // Fire context for the person search: where the fire is, and how it is projected to spread.
  async function peopleContext() {
    const incident = await activeIncident().catch(() => null);
    const f = incident?.active ? incident.latest?.fire : null;
    if (f?.latitude == null) return { fire: null, spread: null };
    const details = incident.latest.details ?? null;
    return {
      fire: { latitude: f.latitude, longitude: f.longitude },
      spread: { origin: [f.latitude, f.longitude], scenario: globalThis.EmberModel.scenarioFrom(details), details },
    };
  }

  // Simulated person searches: UTSC, or one at each historical fire in examples/.
  function demoScenario(id) {
    if (!id || id === 'utsc') return null;
    const fire = demoFires.find((f) => f.id === id);
    if (!fire) throw new ApiError(404, 'no demo fire with that id');
    return scenarioFromExample(fire);
  }
  /** Create/reset the chosen deterministic search and advance it to the requested time. */
  function demoSimAt(t, id = 'utsc') {
    let sim = state.demoSims.get(id);
    if (!sim || t < sim.t) {
      sim = new PersonSearchSim({ site, startMs: now() - t * 1000, scenario: demoScenario(id) });
      state.demoSims.set(id, sim);
    }
    sim.advanceTo(t);
    return sim;
  }

  /** Enforce the distinct ingest or dashboard token for this request. */
  function requireAuth(req, kind) {
    const token = tokenFrom(req);
    const expected = kind === 'ingest' ? ingestToken : dashboardToken;
    if (token === null || !tokenEquals(token, expected)) {
      throw new ApiError(401, 'missing or invalid credentials');
    }
  }

  /** Reject browser API calls from origins outside the configured allowlist. */
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, allowedOrigins)) {
      throw new ApiError(403, 'origin not allowed');
    }
    return origin;
  }

  /** Build CORS response headers for an allowed requesting origin. */
  function corsHeaders(origin) {
    return isOriginAllowed(origin, allowedOrigins) && origin
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {};
  }

  /** Update service health timestamps and the latest inference failure. */
  function recordGeminiResult(err) {
    if (err) {
      state.gemini.lastError = err.message;
      state.gemini.lastErrorAt = new Date(now()).toISOString();
    } else {
      state.gemini.lastError = null;
      state.gemini.lastOkAt = new Date(now()).toISOString();
    }
  }

  /** Read the latest incident and evaluate activity against dismissal/age limits. */
  async function activeIncident() {
    const incident = await storage.latestIncident();
    if (!incident) return null;
    const active = incident.status !== 'false_alarm'
      && now() - Date.parse(incident.last_seen_at) < INCIDENT_ACTIVE_MS;
    return { ...incident, active };
  }

  /** Archive an accepted sighting's image and return its stored evidence reference. */
  async function saveDetectionImage(id, jpeg) {
    if (!dataDir || !jpeg) return null;
    const dir = path.join(dataDir, 'detections');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jpg`);
    await writeFile(file, jpeg);
    return path.relative(dataDir, file).split(path.sep).join('/');
  }

  /** Load archived detection evidence when it is available locally. */
  async function loadDetectionImage(record) {
    if (!record?.image_path || !dataDir) return null;
    try {
      return await readFile(path.join(dataDir, record.image_path));
    } catch {
      return null;
    }
  }

  /** Serve a bounded Gemini read-only evidence tool using the selected storage adapter. Shared by analysis and ask-the-incident. */
  async function evidenceTool(name, args = {}) {
    if (name === 'get_latest_telemetry') {
      return { sample: await storage.latestTelemetry() };
    }
    if (name === 'get_telemetry_history') {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const sinceMs = Number.isFinite(Number(args.since_minutes)) && Number(args.since_minutes) > 0
        ? now() - Number(args.since_minutes) * 60_000
        : null;
      const samples = await storage.telemetryHistory({ limit, sinceMs });
      return { samples, count: samples.length };
    }
    if (name === 'get_snapshot') {
      const s = state.latestSnapshot;
      return s
        ? { available: true, captured_at: new Date(s.capturedAtMs).toISOString() }
        : { available: false };
    }
    if (name === 'get_detection_history') {
      const rows = await storage.detectionHistory({ limit: 20 });
      return {
        detections: rows.map((d) => ({
          detected_at: d.detected_at, source: d.source, label: d.label,
          confidence: d.confidence, fire: d.fire, status: d.status,
        })),
      };
    }
    return { error: `unknown tool ${name}` };
  }

  // ---- evidence-seeking Gemini analysis ----
  // Gemini may call the declared tools; each round appends the model's
  // functionCall turn and our functionResponse turn. After MAX_TOOL_ROUNDS
  // we forbid further calls and require the structured assessment.
  async function runAnalysis(evidence, { trigger, episodeId = null }) {
    const executeTool = evidenceTool;

    const contents = [{ role: 'user', parts: buildAnalysisParts(evidence) }];
    const toolTrace = [];
    let apiResponse = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      apiResponse = await geminiTransport({
        contents,
        tools: lastRound ? undefined : GEMINI_TOOLS,
        toolConfig: lastRound
          ? { functionCallingConfig: { mode: 'NONE' } }
          : { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      });
      const parts = candidateParts(apiResponse);
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (calls.length === 0 || lastRound) break;

      contents.push({ role: 'model', parts });
      const responseParts = [];
      for (const call of calls.slice(0, 4)) {
        const result = await executeTool(call.name, call.args ?? {});
        toolTrace.push({ tool: call.name, args: call.args ?? {}, ok: !result.error });
        responseParts.push({ functionResponse: { name: call.name, response: result } });
        // Image payloads ride the follow-up turn as inline content — the
        // model receives the actual frame it asked for.
        if (call.name === 'get_snapshot' && result.available && state.latestSnapshot) {
          responseParts.push({
            inline_data: { mime_type: 'image/jpeg', data: state.latestSnapshot.jpeg.toString('base64') },
          });
        }
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    const content = validateAnalysisContent(parseGeminiJson(apiResponse));
    // The FC's onboard estimate outranks the model's tilt-derived inference;
    // when both exist and disagree, that disagreement is disclosed, not hidden.
    const fcWind = fcWindEstimate(evidence.telemetry);
    if (fcWind) {
      const derived = content.wind_estimate;
      if (derived?.speed_mps != null) {
        const dSpeed = Math.abs(derived.speed_mps - fcWind.speed_mps);
        const dDir = derived.direction_deg != null && fcWind.direction_deg != null
          ? Math.min(Math.abs(derived.direction_deg - fcWind.direction_deg),
                     360 - Math.abs(derived.direction_deg - fcWind.direction_deg))
          : 0;
        if (dSpeed > 3 || dDir > 30) {
          /** Format each competing wind estimate with metres/second and an available toward-bearing. */
          const fmt = (w) => `${w.speed_mps} m/s` + (w.direction_deg != null ? ` toward ${Math.round(w.direction_deg)}°` : '');
          content.unknowns = [...content.unknowns,
            `Wind disagreement — flight-controller estimate ${fmt(fcWind)} vs tilt-derived estimate ${fmt(derived)}.`];
        }
      }
      content.wind_estimate = fcWind;
    }
    const record = {
      id: crypto.randomUUID(),
      created_at: new Date(now()).toISOString(),
      model: geminiTransport.lastModel ?? geminiModel,
      evidence_at: new Date(evidence.at).toISOString(),
      evidence_kind: evidence.kind,
      trigger,
      episode_id: episodeId,
      provenance: 'gemini-unverified',
      tool_trace: toolTrace,
      ...content,
    };
    await storage.insertAnalysis(record);
    return record;
  }

  /** Keep the ask response honest: a real answer, landmark ids as strings, bounded lengths. */
  function validateAskContent(content) {
    if (typeof content?.answer !== 'string' || !content.answer.trim()) {
      throw new ApiError(502, 'Gemini response missing answer');
    }
    return {
      answer: content.answer.trim().slice(0, 2000),
      landmarks_mentioned: Array.isArray(content.landmarks_mentioned)
        ? content.landmarks_mentioned.filter((x) => typeof x === 'string')
        : [],
      confidence_note: typeof content.confidence_note === 'string'
        ? content.confidence_note.trim().slice(0, 500) : '',
    };
  }

  /* Ask-the-incident: the model gets every gazetteer place pre-computed against
     the current projection, plus tools to query more. Answers are map-specific
     because the facts are computed here, not guessed by the model. */
  async function runAsk({ question, scenario, origin, details }) {
    const facts = SITE_LANDMARKS.places.map((p) => placeFacts(p, origin, scenario, details, site));
    const executeTool = async (name, args = {}) => {
      if (name === 'landmark_query') {
        const q = String(args.name ?? '').trim().toLowerCase();
        const hit = SITE_LANDMARKS.places.find((p) => p.id === q || p.name.toLowerCase().includes(q));
        return hit ? placeFacts(hit, origin, scenario, details, site) : { error: `no landmark matches "${args.name}"` };
      }
      if (name === 'point_query') {
        const la = Number(args.latitude), lo = Number(args.longitude);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) return { error: 'latitude and longitude are required numbers' };
        return placeFacts({ id: 'point', name: `(${la.toFixed(5)},${lo.toFixed(5)})`, kind: 'point', latitude: la, longitude: lo }, origin, scenario, details, site);
      }
      return evidenceTool(name, args);
    };

    const parts = [
      { text: ASK_INSTRUCTIONS },
      { text: `Site: ${JSON.stringify(site)}. Current time: ${new Date(now()).toISOString()}.` },
      { text: `Question: ${question}` },
      { text: origin
          ? `Fire context: ${JSON.stringify({ origin, details: details ?? null })}`
          : 'No fire is currently projected — arrival facts are unavailable and distances are from the configured site anchor.' },
      { text: `Scenario conditions: ${JSON.stringify(scenario)}.` },
      { text: `PLACE FACTS:\n${facts.map((f) => `- ${f.id} · ${f.name} (${f.kind}): ${JSON.stringify(f)}`).join('\n')}` },
    ];
    const contents = [{ role: 'user', parts }];
    const tools = [{ functionDeclarations: [...GEMINI_TOOLS[0].functionDeclarations, ...ASK_EXTRA_TOOLS[0].functionDeclarations] }];
    const toolTrace = [];
    let apiResponse = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      apiResponse = await geminiTransport({
        contents,
        tools: lastRound ? undefined : tools,
        toolConfig: lastRound
          ? { functionCallingConfig: { mode: 'NONE' } }
          : { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { responseMimeType: 'application/json', responseSchema: ASK_SCHEMA },
      });
      const callParts = candidateParts(apiResponse);
      const calls = callParts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (calls.length === 0 || lastRound) break;
      contents.push({ role: 'model', parts: callParts });
      const responseParts = [];
      for (const call of calls.slice(0, 4)) {
        const result = await executeTool(call.name, call.args ?? {});
        toolTrace.push({ tool: call.name, args: call.args ?? {}, ok: !result.error });
        responseParts.push({ functionResponse: { name: call.name, response: result } });
        if (call.name === 'get_snapshot' && result.available && state.latestSnapshot) {
          responseParts.push({ inline_data: { mime_type: 'image/jpeg', data: state.latestSnapshot.jpeg.toString('base64') } });
        }
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    const content = validateAskContent(parseGeminiJson(apiResponse));
    // Highlightable ids only: declared ids ∩ gazetteer, plus any place the answer names verbatim (the model sometimes returns the name instead of the id).
    const mentioned = new Set(content.landmarks_mentioned.filter((id) => SITE_LANDMARKS.places.some((p) => p.id === id)));
    const low = content.answer.toLowerCase();
    for (const p of SITE_LANDMARKS.places) if (low.includes(p.name.toLowerCase())) mentioned.add(p.id);
    return { content, toolTrace, mentioned: [...mentioned] };
  }

  // One automatic analysis per newly detected fire, inside the shared
  // one-per-30-s Gemini limit: if the window is closed, it runs when it opens.
  function scheduleAutoAnalysis(detection, jpeg) {
    if (!autoAnalyze || !geminiTransport) return;
    clearTimeout(state.autoTimer);
    const wait = Math.max(0, state.lastGeminiStart + GEMINI_MIN_INTERVAL_MS - now());
    state.gemini.pending = true;
    state.autoTimer = setTimeout(async () => {
      state.lastGeminiStart = now();
      try {
        const telemetry = await storage.latestTelemetry();
        const image = jpeg ?? state.latestSnapshot?.jpeg ?? null;
        const evidence = image
          ? { kind: 'rgb-snapshot', at: Date.parse(detection.detected_at), jpeg: image, telemetry, detection }
          : { kind: 'telemetry-only', at: Date.parse(detection.detected_at), telemetry, detection };
        await runAnalysis(evidence, { trigger: 'auto-detection', episodeId: detection.episode_id });
        recordGeminiResult(null);
      } catch (err) {
        recordGeminiResult(err);
      } finally {
        state.gemini.pending = false;
      }
    }, wait);
    state.autoTimer.unref?.();
  }

  /** Send one MJPEG part to current viewers, handling disconnected/slow clients. */
  function broadcastFrame(frame) {
    const overlay = state.overlays;
    const lag = overlay ? frame.capturedAtMs - overlay.capturedAtMs : Infinity;
    const detections = frame.detections === '[]' && lag >= 0 && lag < 1500
      && now() - overlay.capturedAtMs < 2000 ? JSON.stringify(overlay.detections) : frame.detections;
    const head = `--${VIDEO_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n`
      + `X-Captured-At: ${new Date(frame.capturedAtMs).toISOString()}\r\n`
      + `X-Detections: ${detections}\r\n\r\n`;
    for (const client of state.videoClients) {
      if (client.writableNeedDrain) continue; // slow viewer: drop this frame for them only
      client.write(head);
      client.write(frame.jpeg);
      client.write('\r\n');
    }
  }

  /** Estimate recent delivered video rate from the frame-arrival window. */
  function videoFps() {
    const cutoff = now() - 2000;
    state.frameTimes = state.frameTimes.filter((t) => t >= cutoff);
    return state.frameTimes.length / 2;
  }

  /** Update the latest JPEG/freshness state and feed existing multipart viewers. */
  function acceptCameraFrame(jpeg, capturedAtMs, detections = '[]') {
    const frame = { jpeg, capturedAtMs, detections };
    state.latestFrame = frame;
    void dive.frame(jpeg,capturedAtMs);
    state.latestSnapshot = { jpeg, capturedAtMs };
    state.frameTimes.push(now());
    broadcastFrame(frame);
  }

  /** Validate tile coordinates, serve cached imagery or fetch and cache a bounded upstream tile. */
  async function handleTile(res, layer, z, x, y) {
    const zi = Number(z), xi = Number(x), yi = Number(y);
    if (!TILE_SOURCES[layer] || !Number.isInteger(zi) || zi < 0 || zi > 19
        || !Number.isInteger(xi) || !Number.isInteger(yi) || xi < 0 || yi < 0 || xi >= 2 ** zi || yi >= 2 ** zi) {
      throw new ApiError(404, 'not found');
    }
    const cacheFile = dataDir ? path.join(dataDir, 'tiles', layer, String(zi), String(xi), `${yi}.tile`) : null;
    if (cacheFile) {
      try {
        const cached = await readFile(cacheFile);
        res.writeHead(200, { 'content-type': imageType(cached), 'cache-control': 'max-age=86400' });
        res.end(cached);
        return;
      } catch { /* not cached yet */ }
    }
    let body;
    try {
      const url = TILE_SOURCES[layer].replace('{z}', zi).replace('{x}', xi).replace('{y}', yi);
      const upstream = await tileFetch(url, {
        headers: { 'user-agent': 'Emberwatch/0.2 (wildfire drone dashboard; hackathon prototype)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      body = Buffer.from(await upstream.arrayBuffer());
    } catch {
      throw new ApiError(504, 'map tile unavailable (offline and not cached)');
    }
    if (cacheFile) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, body).catch(() => {});
    }
    res.writeHead(200, { 'content-type': imageType(body), 'cache-control': 'max-age=86400' });
    res.end(body);
  }

  /** Dispatch authenticated API routes for evidence, incidents, planning, leads and replay. */
  async function handleApi(req, res, url) {
    const pathname = url.pathname;

    if (req.method==='GET' && pathname==='/api/dive') {
      requireAuth(req,'dashboard'); sendJson(res,200,{workflow:'qr-circle-dive-v1',...dive.control.snapshot(await diveContext())});return;
    }
    if (req.method==='POST' && pathname==='/api/dive/land') {
      requireAuth(req,'dashboard'); autonomy.control({action:'land'});sendJson(res,200,dive.control.land());return;
    }
    if (req.method==='POST' && pathname==='/api/ingest/dive/status') {
      requireAuth(req,'ingest'); const body=await readJson(req);dive.control.status(body);
      sendJson(res,200,dive.control.control(body.receiver_id,body.command_id,await diveContext()));return;
    }
    if (req.method==='POST' && pathname==='/api/commands') {
      requireAuth(req,'dashboard');sendJson(res,200,dive.control.enqueue(await readJson(req),await diveContext()));return;
    }
    if (req.method==='GET' && pathname==='/api/commands') {
      requireAuth(req,'dashboard');sendJson(res,200,{commands:dive.control.snapshot(await diveContext()).commands});return;
    }
    if (req.method==='GET' && pathname==='/api/commands/next') {
      requireAuth(req,'ingest');sendJson(res,200,{command:dive.control.next(url.searchParams.get('receiver_id'))});return;
    }
    const diveAction=/^\/api\/commands\/([0-9a-f-]{36})\/(heartbeat|ack)$/.exec(pathname);
    if(req.method==='POST'&&diveAction){
      const [,id,action]=diveAction;requireAuth(req,action==='heartbeat'?'dashboard':'ingest');
      const body=await readJson(req);sendJson(res,200,action==='heartbeat'?dive.control.heartbeat(id,body.session_id):dive.control.ack(id,body));return;
    }
    if (pathname === '/api/autonomy') {
      requireAuth(req, 'dashboard');
      if (req.method === 'GET') { sendJson(res,200,autonomy.snapshot()); return; }
      if (req.method === 'POST') { sendJson(res,200,autonomy.control(await readJson(req))); return; }
    }
    if (pathname.startsWith('/api/ingest/autonomy')) {
      requireAuth(req, 'ingest');
      if (req.method === 'GET' && pathname === '/api/ingest/autonomy') {
        sendJson(res,200,autonomy.snapshot()); return;
      }
      if (req.method === 'POST' && pathname === '/api/ingest/autonomy/status') {
        sendJson(res,200,autonomy.status(await readJson(req))); return;
      }
      if (req.method === 'POST' && pathname === '/api/ingest/autonomy/target') {
        autonomy.observe(await readJson(req)); sendJson(res,200,{accepted:true}); return;
      }
      if (req.method === 'POST' && pathname === '/api/ingest/autonomy/claim') {
        sendJson(res,200,autonomy.claim(await readJson(req))); return;
      }
    }

    // The dashboard served from this machine fetches its session token here,
    // so localhost opens straight into live mode with no token pasting.
    if (req.method === 'GET' && pathname === '/api/session') {
      if (!isLocalRequest(req)) throw new ApiError(403, 'session bootstrap is only available on localhost');
      sendJson(res, 200, { token: dashboardToken, contract: CONTRACT });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      requireAuth(req, 'dashboard');
      const nowMs = now();
      let latest = null;
      let incident = null;
      try {
        latest = await storage.latestTelemetry();
        incident = await activeIncident();
      } catch {
        // A configured-but-failing store must not take the status endpoint
        // down — status is how the dashboard learns it is down.
      }
      const frame = state.latestFrame;
      // Availability means a stored sample exists; freshness establishes a
      // currently observed link and must expire even while HTTP stays healthy.
      const fresh = (at, limit) => Number.isFinite(at) && at <= nowMs + 1000 && nowMs - at < limit;
      const telemetryFresh = Boolean(latest && fresh(Date.parse(latest.observed_at), 10_000));
      const cameraFresh = Boolean(state.latestSnapshot && fresh(state.latestSnapshot.capturedAtMs, 3000));
      const videoFresh = Boolean(frame && fresh(frame.capturedAtMs, 3000));
      const lastFlight = state.flightEvents.at(-1) ?? null;
      sendJson(res, 200, {
        contract: CONTRACT,
        server_time: new Date(nowMs).toISOString(),
        connection: {
          connected: telemetryFresh || videoFresh,
          state: telemetryFresh && videoFresh ? 'live' : telemetryFresh ? 'telemetry-only'
            : videoFresh ? 'video-only' : latest || frame ? 'disconnected' : 'waiting',
        },
        vision: state.vision
          ? { ...state.vision, fresh: fresh(Date.parse(state.vision.observed_at), 10_000) }
          : { fresh: false, model_status: 'unknown', camera_state: 'waiting' },
        site,
        storage: { status: storage.status() },
        gemini: {
          configured: Boolean(geminiTransport),
          automatic_analysis: autoAnalyze,
          model: geminiModel,
          last_ok_at: state.gemini.lastOkAt,
          last_error: state.gemini.lastError,
          last_error_at: state.gemini.lastErrorAt,
          pending: state.gemini.pending,
        },
        telemetry: latest
          ? { available: true, fresh: telemetryFresh, observed_at: latest.observed_at, age_ms: ageMs(Date.parse(latest.observed_at), nowMs) }
          : { available: false, fresh: false },
        camera: state.latestSnapshot
          ? { available: true, fresh: cameraFresh, captured_at: new Date(state.latestSnapshot.capturedAtMs).toISOString(), age_ms: ageMs(state.latestSnapshot.capturedAtMs, nowMs) }
          : { available: false, fresh: false },
        video: frame
          ? { available: true, fresh: videoFresh, captured_at: new Date(frame.capturedAtMs).toISOString(), age_ms: ageMs(frame.capturedAtMs, nowMs), fps: videoFresh ? videoFps() : 0, viewers: state.videoClients.size }
          : { available: false, fresh: false },
        detection: incident
          ? { active: incident.active, episode_id: incident.episode_id, last_seen_at: incident.last_seen_at }
          : { active: false },
        flight: lastFlight,
        people: (() => { const c = people.snapshot(nowMs).counts; return { open_leads: c.open, possible_people: c.possible_people, unacknowledged: c.unacknowledged }; })(),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/vision') {
      requireAuth(req, 'ingest');
      const body = await readJson(req);
      const at = parseIsoTimestamp(body?.observed_at, 'observed_at');
      assertWithinClockWindow(at, now(), 'observed_at');
      if (!['ready', 'missing', 'error', 'disabled'].includes(body.model_status)
          || !['live', 'waiting', 'stale'].includes(body.camera_state)) {
        throw new ApiError(400, 'invalid vision health state');
      }
      state.vision = { observed_at: new Date(at).toISOString(), model_status: body.model_status,
        people_model_status: ['ready', 'missing', 'error', 'disabled'].includes(body.people_model_status) ? body.people_model_status : 'disabled',
        last_person_at: typeof body.last_person_at === 'string' ? body.last_person_at.slice(0, 40) : null,
        camera_state: body.camera_state,
        last_frame_at: typeof body.last_frame_at === 'string' ? body.last_frame_at.slice(0, 40) : null,
        last_detection_at: typeof body.last_detection_at === 'string' ? body.last_detection_at.slice(0, 40) : null,
        last_source: ['qr-test', 'yolo'].includes(body.last_source) ? body.last_source : null,
        error: typeof body.error === 'string' ? body.error.slice(0, 100) : null };
      sendJson(res, 200, { accepted: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/telemetry') {
      requireAuth(req, 'ingest');
      const body = await readJson(req);
      const sample = validateTelemetry(body, now());
      await storage.insertTelemetry(sample);
      await peopleReady;
      people.observePose({ ...sample, heading_deg: sample.extra?.heading_deg ?? sample.attitude_deg?.yaw ?? null, gimbal_pitch_deg: sample.extra?.gimbal_pitch_deg ?? null }, Date.parse(sample.observed_at));
      if (people.leads.size || people.cells.size) savePeople();
      sendJson(res, 200, { accepted: true, stored: storage.status() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry/latest') {
      requireAuth(req, 'dashboard');
      const sample = await storage.latestTelemetry();
      sendJson(res, 200, {
        sample,
        age_ms: sample ? ageMs(Date.parse(sample.observed_at), now()) : null,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry/history') {
      requireAuth(req, 'dashboard');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
      const sinceMinutes = Number(url.searchParams.get('since_minutes'));
      const sinceMs = Number.isFinite(sinceMinutes) && sinceMinutes > 0
        ? now() - sinceMinutes * 60_000
        : null;
      const samples = await storage.telemetryHistory({ limit, sinceMs });
      sendJson(res, 200, { samples, count: samples.length });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry/summary') {
      requireAuth(req, 'dashboard');
      const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 60, 1), 24 * 60);
      const buckets = await storage.telemetrySummary({ sinceMs: now() - minutes * 60_000 });
      sendJson(res, 200, { minutes, buckets, source: storage.kind === 'postgres' ? 'telemetry_1m continuous aggregate' : 'memory' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/flight') {
      requireAuth(req, 'ingest');
      const event = validateFlightEvent(await readJson(req), now());
      state.flightEvents.push(event);
      if (state.flightEvents.length > 100) state.flightEvents.shift();
      sendJson(res, 200, { accepted: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/flight') {
      requireAuth(req, 'dashboard');
      const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 15, 1), 240);
      const pathPoints = await storage.flightPath({ sinceMs: now() - minutes * 60_000 });
      sendJson(res, 200, { events: state.flightEvents.slice(-20), path: pathPoints });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/snapshot') {
      requireAuth(req, 'ingest');
      const body = await readJson(req);
      const { capturedAtMs, jpeg } = validateSnapshotEnvelope(body, now());
      // The tested Pi observer sends low-rate snapshots. Relay these to the
      // same dashboard viewers as the higher-rate /ingest/frame bridge.
      acceptCameraFrame(jpeg, capturedAtMs);
      sendJson(res, 200, { accepted: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      requireAuth(req, 'dashboard');
      const snap = state.latestSnapshot;
      if (!snap) throw new ApiError(404, 'no snapshot available');
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'x-captured-at': new Date(snap.capturedAtMs).toISOString(),
      });
      res.end(snap.jpeg);
      return;
    }

    // Live video: the bridge POSTs raw JPEG frames (~15 fps); each one is
    // relayed to every open /api/video viewer and kept as Gemini evidence.
    if (req.method === 'POST' && pathname === '/api/ingest/frame') {
      requireAuth(req, 'ingest');
      if (!/^image\/jpeg\b/.test(req.headers['content-type'] ?? '')) {
        throw new ApiError(400, 'frame content-type must be image/jpeg');
      }
      const jpeg = await readBody(req, MAX_FRAME_BYTES + 1);
      const capturedAtMs = validateFrame(jpeg, req.headers['x-captured-at'], now());
      let detections = '[]';
      try {
        const parsed = JSON.parse(req.headers['x-detections'] ?? '[]');
        if (Array.isArray(parsed)) detections = JSON.stringify(parsed.slice(0, 10));
      } catch { /* malformed overlay data is dropped, the frame still counts */ }
      acceptCameraFrame(jpeg, capturedAtMs, detections);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/overlays') {
      requireAuth(req, 'ingest');
      const overlay = validateOverlays(await readJson(req), now());
      const accepted = now() - overlay.capturedAtMs < 2000
        && overlay.capturedAtMs <= now() + 1000
        && (!state.overlays || overlay.capturedAtMs > state.overlays.capturedAtMs);
      if (accepted) {
        state.overlays = overlay;
        // Redraw the latest image after inference finishes; do not refresh
        // its capture time, evidence freshness or the camera FPS counter.
        if (state.latestFrame) broadcastFrame(state.latestFrame);
      }
      sendJson(res, 200, {accepted});
      return;
    }

    if (req.method === 'GET' && pathname === '/api/video') {
      requireAuth(req, 'dashboard');
      res.writeHead(200, {
        'content-type': `multipart/x-mixed-replace; boundary=${VIDEO_BOUNDARY}`,
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // viewers connect before the first frame exists
      state.videoClients.add(res);
      req.on('close', () => state.videoClients.delete(res));
      if (state.latestFrame) broadcastFrame(state.latestFrame);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/detection') {
      requireAuth(req, 'ingest');
      const { detection, jpeg } = validateDetection(await readJson(req), now());
      const isNewEpisode = !(await storage.episodeExists(detection.episode_id));
      const id = crypto.randomUUID();
      const image = jpeg ?? state.latestFrame?.jpeg ?? null;
      const record = {
        id, ...detection, status: 'active', image_path: await saveDetectionImage(id, image),
      };
      await storage.insertDetection(record);
      autonomy.incident(record);
      if (isNewEpisode) scheduleAutoAnalysis(record, image);
      sendJson(res, 200, { accepted: true, id, new_episode: isNewEpisode });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/incident') {
      requireAuth(req, 'dashboard');
      const incident = await activeIncident();
      sendJson(res, 200, {
        incident: incident && {
          ...incident,
          image_url: incident.latest.image_path ? `/api/detections/${incident.latest.id}/image` : null,
        },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/incident/dismiss') {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      if (typeof body.episode_id !== 'string') throw new ApiError(400, 'episode_id is required');
      const updated = await storage.setEpisodeStatus(body.episode_id, 'false_alarm');
      if (updated === 0) throw new ApiError(404, 'no detection with that episode_id');
      sendJson(res, 200, { dismissed: true, sightings: updated });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/detections') {
      requireAuth(req, 'dashboard');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
      sendJson(res, 200, { detections: await storage.detectionHistory({ limit }) });
      return;
    }

    const imageMatch = /^\/api\/detections\/([0-9a-f-]{36})\/image$/.exec(pathname);
    if (req.method === 'GET' && imageMatch) {
      requireAuth(req, 'dashboard');
      const jpeg = await loadDetectionImage(await storage.detectionById(imageMatch[1]));
      if (!jpeg) throw new ApiError(404, 'no image for that detection');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      res.end(jpeg);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/analyze') {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      if (Object.keys(body).length !== 0) {
        throw new ApiError(400, 'request body must be an empty JSON object');
      }
      if (!geminiTransport) {
        throw new ApiError(503, 'Gemini is not configured on this backend');
      }
      const nowMs = now();
      if (nowMs - state.lastGeminiStart < GEMINI_MIN_INTERVAL_MS) {
        throw new ApiError(429, 'Gemini is limited to one request per 30 seconds');
      }
      const telemetry = await storage.latestTelemetry();
      const snap = state.latestSnapshot;
      const snapFresh = snap && isFresh(snap.capturedAtMs, nowMs);
      const teleFresh = telemetry && isFresh(Date.parse(telemetry.observed_at), nowMs);
      if (!snapFresh && !teleFresh) {
        throw new ApiError(409, 'no fresh evidence (≤30s) is available for analysis');
      }
      state.lastGeminiStart = nowMs;
      const incident = await activeIncident().catch(() => null);
      const detection = incident?.active ? incident.latest : null;
      const evidence = snapFresh
        ? { kind: 'rgb-snapshot', at: snap.capturedAtMs, jpeg: snap.jpeg, telemetry, detection }
        : { kind: 'telemetry-only', at: Date.parse(telemetry.observed_at), telemetry, detection };
      try {
        const record = await runAnalysis(evidence, { trigger: 'manual', episodeId: detection?.episode_id ?? null });
        recordGeminiResult(null);
        sendJson(res, 200, record);
      } catch (err) {
        recordGeminiResult(err);
        throw err;
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/analysis/latest') {
      requireAuth(req, 'dashboard');
      const [analysis] = await storage.latestAnalyses(1);
      sendJson(res, 200, {
        analysis: analysis ?? null,
        configured: Boolean(geminiTransport),
        pending: state.gemini.pending,
        error: state.gemini.lastError
          ? { message: state.gemini.lastError, at: state.gemini.lastErrorAt }
          : null,
      });
      return;
    }

    // Ask-the-incident: map-grounded Q&A. The fire context is the live incident
    // when one exists; in demo mode the client supplies the replayed fire.
    if (req.method === 'POST' && pathname === '/api/ask') {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (question.length < 3 || question.length > 600) {
        throw new ApiError(400, 'question must be 3–600 characters');
      }
      if (!geminiTransport) throw new ApiError(503, 'Gemini is not configured on this backend');
      const nowMs = now();
      if (nowMs - state.lastAskStart < ASK_MIN_INTERVAL_MS) {
        throw new ApiError(429, 'questions are limited to one per 15 seconds');
      }
      state.lastAskStart = nowMs;
      const incident = await activeIncident().catch(() => null);
      const live = Boolean(incident?.active && incident.latest?.fire?.latitude != null);
      const details = live ? incident.latest.details ?? null : plainObject(body.details);
      const clientFire = plainObject(body.fire);
      const origin = live
        ? [incident.latest.fire.latitude, incident.latest.fire.longitude]
        : (clientFire && Number.isFinite(clientFire.latitude) && Number.isFinite(clientFire.longitude)
            ? [clientFire.latitude, clientFire.longitude]
            : null);
      const scenario = plainObject(body.scenario) ?? globalThis.EmberModel.scenarioFrom(details);
      let asked;
      try {
        asked = await runAsk({ question, scenario, origin, details });
        recordGeminiResult(null);
      } catch (err) {
        recordGeminiResult(err);
        throw err;
      }
      sendJson(res, 200, {
        id: crypto.randomUUID(),
        created_at: new Date(now()).toISOString(),
        model: geminiTransport.lastModel ?? geminiModel,
        provenance: live ? 'gemini' : 'gemini-demo',
        question,
        ...asked.content,
        landmarks: SITE_LANDMARKS.places
          .filter((p) => asked.mentioned.includes(p.id))
          .map((p) => placeFacts(p, origin, scenario, details, site)),
        tool_trace: asked.toolTrace,
        context: { fire_projected: Boolean(origin), live_incident: live, scenario },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/plan') {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      const objective = typeof body.objective === 'string' ? body.objective.slice(0, 80) : 'initial-attack';
      const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1500) : '';
      const scenario = body.scenario && typeof body.scenario === 'object' && !Array.isArray(body.scenario)
        ? JSON.parse(JSON.stringify(body.scenario)) : null;
      const projection = body.projection && typeof body.projection === 'object' && !Array.isArray(body.projection)
        ? JSON.parse(JSON.stringify(body.projection)) : null;
      if (!geminiTransport) throw new ApiError(503, 'Gemini is not configured on this backend');
      const nowMs = now();
      if (nowMs - state.lastPlanStart < PLAN_MIN_INTERVAL_MS) {
        throw new ApiError(429, 'plans are limited to one request per 10 seconds');
      }
      state.lastPlanStart = nowMs;
      const [incident, telemetry, analyses] = await Promise.all([
        activeIncident(), storage.latestTelemetry(), storage.latestAnalyses(1),
      ]);
      const detection = incident?.active ? incident.latest : null;
      const parts = [
        { text: PLAN_INSTRUCTIONS },
        { text: `Plan objective: ${objective}.${notes ? ` Incident commander notes: ${notes}` : ''}` },
        { text: `Site: ${JSON.stringify(site)}. Current time: ${new Date(nowMs).toISOString()}.` },
        { text: detection
          ? `${describeDetection(detection)} First sighted ${incident.first_detected_at}; ${incident.sightings} sightings; latest ${incident.last_seen_at}.`
          : 'No fire is currently detected by the drone; plan for readiness and surveillance.' },
        { text: `Scenario conditions: ${JSON.stringify(scenario)}. Projected spread: ${JSON.stringify(projection)}.` },
        { text: `Latest drone telemetry: ${JSON.stringify(telemetry)}.` },
        { text: describeLeadsForPlan(people.snapshot(nowMs, await peopleContext())) },
        { text: `Unlocated person camera sightings (no verified map location): ${JSON.stringify([...state.unlocatedPeople.values()].slice(-10))}` },
        { text: `Latest Gemini scene analysis: ${JSON.stringify(analyses[0] ? {
          summary: analyses[0].summary, severity: analyses[0].severity, spread_outlook: analyses[0].spread_outlook,
        } : null)}.` },
      ];
      const image = detection ? await loadDetectionImage(detection) : state.latestSnapshot?.jpeg;
      if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image.toString('base64') } });
      let content;
      try {
        const apiResponse = await geminiTransport({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA },
        }, { timeoutMs: GEMINI_PLAN_TIMEOUT_MS });
        content = validatePlanContent(parseGeminiJson(apiResponse));
        content.wording_flags = findUnsafeWording(content);
        recordGeminiResult(null);
      } catch (err) {
        recordGeminiResult(err);
        throw err;
      }
      const record = {
        id: crypto.randomUUID(),
        created_at: new Date(nowMs).toISOString(),
        model: geminiTransport.lastModel ?? geminiModel,
        objective,
        notes,
        scenario,
        projection,
        episode_id: detection?.episode_id ?? null,
        provenance: 'gemini',
        ...content,
      };
      await storage.insertPlan(record);
      sendJson(res, 200, record);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/plan/latest') {
      requireAuth(req, 'dashboard');
      const [plan] = await storage.latestPlans(1);
      sendJson(res, 200, { plan: plan ?? null });
      return;
    }

    // ---- person search: rescue leads for people who cannot ask for help
    if (req.method === 'POST' && pathname === '/api/ingest/person/sighting') {
      requireAuth(req, 'ingest');
      await peopleReady;
      const sighting = validateCameraSighting(await readJson(req), now());
      const accepted = recordCameraSighting(state.unlocatedPeople, sighting);
      if (accepted) savePeople();
      sendJson(res, 200, {accepted, track_id: sighting.track_id, location_status: 'unavailable'});
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/person') {
      requireAuth(req, 'ingest');
      await peopleReady;
      const nowMs = now();
      const { obs, crop } = validatePersonObservation(await readJson(req), nowMs);
      const result = people.addObservation(obs, nowMs);
      if (obs.track_id) state.unlocatedPeople.delete(obs.track_id);
      if (!result.duplicate && crop && await saveCrop(result.observation.id, crop)) people.attachCrop(result.observation.id);
      savePeople();
      const summary = people.summarize(result.lead, nowMs, await peopleContext());
      sendJson(res, 200, {
        accepted: true, duplicate: result.duplicate, obs_id: result.observation?.id ?? obs.obs_id,
        lead_id: summary.id, lead_number: summary.number, new_lead: Boolean(result.new_lead), status: summary.status,
        delayed: Boolean(result.observation?.delayed),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/person/crop') {
      requireAuth(req, 'ingest');
      await peopleReady;
      const obsId = url.searchParams.get('obs_id') ?? '';
      const jpeg = await readBody(req, MAX_CROP_BYTES);
      if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new ApiError(400, 'body must be a JPEG');
      if (!people.obsIndex.has(obsId)) throw new ApiError(404, 'no observation with that obs_id');
      if (await saveCrop(obsId, jpeg)) people.attachCrop(obsId);
      savePeople();
      res.writeHead(204); res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/api/people') {
      requireAuth(req, 'dashboard');
      await peopleReady;
      sendJson(res, 200, { simulated: false, ...people.snapshot(now(), await peopleContext()),
        unlocated_sightings: [...state.unlocatedPeople.values()].reverse() });
      return;
    }

    if (req.method === 'POST' && ['/api/people/sighting/ack', '/api/people/sighting/close'].includes(pathname)) {
      requireAuth(req, 'dashboard');
      await peopleReady;
      const body = await readJson(req), record = state.unlocatedPeople.get(body.track_id);
      if (!record) throw new ApiError(404, 'no camera sighting with that track_id');
      if (typeof body.by !== 'string' || !body.by.trim()) throw new ApiError(400, 'a named responder is required');
      const review = {by: body.by.trim().slice(0, 80), at: new Date(now()).toISOString()};
      if (pathname.endsWith('/ack')) record.acknowledged = review;
      else {
        if (!['found', 'not-a-person', 'duplicate', 'handed-off'].includes(body.outcome)) throw new ApiError(400, 'choose a supported outcome');
        record.closed = {...review, outcome: body.outcome};
      }
      savePeople(); sendJson(res, 200, {accepted: true}); return;
    }

    if (req.method === 'POST' && (pathname === '/api/people/ack' || pathname === '/api/people/close')) {
      requireAuth(req, 'dashboard');
      await peopleReady;
      const body = await readJson(req);
      if (typeof body.lead_id !== 'string') throw new ApiError(400, 'lead_id is required');
      const demoSim = body.demo === true ? state.demoSims.get(typeof body.scenario === 'string' ? body.scenario : 'utsc') : null;
      const target = body.demo === true ? demoSim?.search : people;
      if (!target) throw new ApiError(404, 'no demo search is running');
      // The simulation keeps its own clock; stamp demo actions with it so times line up.
      const atMs = target === people ? now() : demoSim.startMs + Math.max(0, demoSim.t) * 1000;
      const lead = pathname.endsWith('/ack')
        ? target.acknowledge(body.lead_id, { by: body.by, note: body.note }, atMs)
        : target.close(body.lead_id, { by: body.by, outcome: body.outcome, note: body.note }, atMs);
      if (target === people) savePeople();
      sendJson(res, 200, { lead: target.summarize(lead, now(), body.demo ? demoSim.context() : await peopleContext()) });
      return;
    }

    const cropMatch = /^\/api\/people\/crop\/([A-Za-z0-9._:-]{1,64})$/.exec(pathname);
    if (req.method === 'GET' && cropMatch) {
      requireAuth(req, 'dashboard');
      const file = cropPath(cropMatch[1]);
      const jpeg = file ? await readFile(file).catch(() => null) : null;
      if (!jpeg) throw new ApiError(404, 'no crop for that observation');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      res.end(jpeg);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/demo/people') {
      requireAuth(req, 'dashboard');
      const t = Math.max(0, Math.min(Number(url.searchParams.get('t')) || 0, 3600));
      sendJson(res, 200, demoSimAt(t, url.searchParams.get('scenario') || 'utsc').snapshot());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/demo/fires') {
      requireAuth(req, 'dashboard');
      sendJson(res, 200, { fires: demoFires, source: 'examples/historical-fires.mjs' });
      return;
    }

    // Demo cases: live Gemini calls on a recorded historical fire whose drone
    // data is simulated. The case comes from the dashboard's hardcoded set;
    // results are returned, never stored, so they cannot mix with real flights.
    if (req.method === 'POST' && (pathname === '/api/demo/analyze' || pathname === '/api/demo/plan')) {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      const demoCase = plainObject(body.case);
      if (!demoCase || typeof demoCase.name !== 'string') throw new ApiError(400, 'case is required');
      if (!geminiTransport) throw new ApiError(503, 'Gemini is not configured on this backend');
      const nowMs = now();
      if (nowMs - state.lastDemoStart < PLAN_MIN_INTERVAL_MS) {
        throw new ApiError(429, 'Gemini requests are limited to one per 10 seconds');
      }
      state.lastDemoStart = nowMs;
      const isPlan = pathname === '/api/demo/plan';
      const scenario = plainObject(body.scenario);
      const parts = [
        { text: isPlan ? PLAN_INSTRUCTIONS : ANALYSIS_INSTRUCTIONS },
        { text: DEMO_CONTEXT },
        { text: `Incident record: ${JSON.stringify(demoCase)}` },
        { text: `Scenario conditions: ${JSON.stringify(scenario)}` },
      ];
      // The drone camera frame, as a base64 JPEG (≤ 2 MB).
      const image = typeof body.image === 'string' && /^[A-Za-z0-9+/=]+$/.test(body.image) && body.image.length <= 2_800_000 ? body.image : null;
      if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
      if (isPlan) {
        const objective = typeof body.objective === 'string' ? body.objective.slice(0, 80) : 'initial-attack';
        const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1500) : '';
        parts.push(
          { text: `Plan objective: ${objective}.${notes ? ` Incident commander notes: ${notes}` : ''}` },
          { text: `Projected spread: ${JSON.stringify(plainObject(body.projection))}.` },
          { text: `Latest Gemini scene analysis: ${JSON.stringify(plainObject(body.analysis))}.` },
        );
      }
      let content;
      try {
        const apiResponse = await geminiTransport({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: isPlan ? PLAN_SCHEMA : GEMINI_RESPONSE_SCHEMA },
        }, { timeoutMs: isPlan ? GEMINI_PLAN_TIMEOUT_MS : GEMINI_UPSTREAM_TIMEOUT_MS });
        content = isPlan ? validatePlanContent(parseGeminiJson(apiResponse)) : validateAnalysisContent(parseGeminiJson(apiResponse));
        if (isPlan) content.wording_flags = findUnsafeWording(content);
        recordGeminiResult(null);
      } catch (err) {
        recordGeminiResult(err);
        throw err;
      }
      sendJson(res, 200, {
        id: crypto.randomUUID(),
        created_at: new Date(nowMs).toISOString(),
        model: geminiTransport.lastModel ?? geminiModel,
        case_id: typeof demoCase.id === 'string' ? demoCase.id : null,
        provenance: 'gemini-demo',
        ...(isPlan ? { objective: body.objective ?? 'initial-attack', scenario, projection: plainObject(body.projection) } : { trigger: body.trigger === 'auto-detection' ? 'auto-detection' : 'manual', evidence_kind: image ? 'rgb-snapshot' : 'telemetry' }),
        ...content,
      });
      return;
    }

    throw new ApiError(404, 'route not found');
  }

  return /* Apply CORS/error handling and dispatch tiles, API calls or static frontend files. */ async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const origin = req.headers.origin;

    if (req.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        sendError(res, new ApiError(403, 'origin not allowed'));
        return;
      }
      res.writeHead(204, {
        ...corsHeaders(origin),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-captured-at, x-detections',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    try {
      checkOrigin(req);
      const acao = corsHeaders(origin);
      for (const [k, v] of Object.entries(acao)) res.setHeader(k, v);
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      const tile = /^\/tiles\/(osm|sat)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
      if (req.method === 'GET' && tile) {
        await handleTile(res, tile[1], tile[2], tile[3], tile[4]);
        return;
      }
      if (req.method === 'GET' && staticDir) {
        await serveStatic(res, staticDir, pathname);
        return;
      }
      throw new ApiError(404, 'route not found');
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  };
}

/** Read local configuration, select services and start the loopback HTTP server. */
async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const ingestToken = process.env.INGEST_TOKEN;
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  const databaseUrl = process.env.DATABASE_URL || null;
  const pgCaFile = process.env.PG_CA_FILE || null;
  const geminiApiKey = process.env.GEMINI_API_KEY || null;
  const geminiModel = process.env.GEMINI_MODEL || null;
  const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.7-flash')
    .split(',').map((m) => m.trim()).filter((m) => m && m !== geminiModel);
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  const staticDir = path.resolve(process.env.STATIC_DIR || path.join(repoRoot, 'dist'));
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, 'data'));
  const site = {
    name: process.env.SITE_NAME || DEFAULT_SITE.name,
    latitude: Number(process.env.SITE_LAT) || DEFAULT_SITE.latitude,
    longitude: Number(process.env.SITE_LON) || DEFAULT_SITE.longitude,
  };
  const { FIRES } = await import('../examples/historical-fires.mjs');

  const storage = await createStorage({ databaseUrl, pgCaFile });
  const geminiTransport = geminiApiKey
    ? makeGeminiTransport({ apiKey: geminiApiKey, model: geminiModel, fallbackModels })
    : null;

  const sector = (process.env.SEARCH_SECTOR || '').split(',').map(Number);
  const personSearch = {
    hfovDeg: Number(process.env.CAMERA_HFOV_DEG) || 69,
    cellM: Number(process.env.COVERAGE_CELL_M) || 5,
    sector: sector.length === 4 && sector.every(Number.isFinite) ? sector : null,
  };

  const handler = createApp({
    divePersonDetector: process.env.BOSCO_DIVE_PERSON_CV==='1'?'worker':null,
    personSearch,
    ingestToken,
    dashboardToken,
    allowedOrigins,
    storage,
    geminiTransport,
    geminiModel,
    staticDir,
    dataDir,
    site,
    demoFires: FIRES,
  });

  http.createServer(handler).listen(port, host, () => {
    console.log(`emberwatch backend listening on http://${host}:${port}`);
    console.log(`storage: ${storage.status()} | gemini: ${geminiApiKey ? `configured (${geminiModel})` : 'not configured'} | data: ${dataDir}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`startup failed: ${err.message}`);
    process.exit(1);
  });
}
