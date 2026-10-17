// emberwatch.v1 validation: units, time and provenance checks.
// An authenticated sender can still report incorrect data — a token does not
// establish sensor truth — so every field is checked before it is stored.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const INGEST_CLOCK_WINDOW_MS = 30_000; // +/-30 s server clock window
export const EVIDENCE_FRESH_MS = 30_000;      // analysis needs evidence < 30 s old
export const UI_STALE_MS = 10_000;            // informational: UI marks >10 s stale
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// Synthetic samples must never be posted as `live`; they belong in Simulation
// mode or explicitly isolated automated tests.
const FORBIDDEN_INGEST_PROVENANCE = new Set([
  'sim', 'simulation', 'synthetic', 'fixture', 'demo', 'sample', 'test',
]);

export function parseIsoTimestamp(value, field = 'timestamp') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, `${field} must be a non-empty ISO 8601 string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ApiError(400, `${field} is not a valid ISO 8601 timestamp`);
  }
  // Require an explicit timezone offset or trailing Z — a bare local datetime
  // would silently be read in the server's timezone.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw new ApiError(400, `${field} must carry an explicit timezone`);
  }
  return ms;
}

export function assertWithinClockWindow(tsMs, nowMs, field = 'timestamp') {
  if (Math.abs(tsMs - nowMs) > INGEST_CLOCK_WINDOW_MS) {
    throw new ApiError(
      400,
      `${field} is outside the ±${INGEST_CLOCK_WINDOW_MS / 1000}s server clock window; synchronize clocks for live testing`,
    );
  }
}

export function ageMs(tsMs, nowMs) {
  return nowMs - tsMs;
}

export function isFresh(tsMs, nowMs, maxAgeMs = EVIDENCE_FRESH_MS) {
  return ageMs(tsMs, nowMs) <= maxAgeMs;
}

function checkNumberOrNull(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, `${name} must be a finite number or null`);
  }
  if (value < min || value > max) {
    throw new ApiError(400, `${name} is outside the allowed range ${min}..${max}`);
  }
}

// Validates a telemetry observation against the emberwatch.v1 contract.
// Returns the sanitized sample on success, throws ApiError otherwise.
export function validateTelemetry(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'telemetry must be a JSON object');
  }
  const sample = body;

  const observedAtMs = parseIsoTimestamp(sample.observed_at, 'observed_at');
  assertWithinClockWindow(observedAtMs, nowMs, 'observed_at');

  if (typeof sample.provenance !== 'string' || sample.provenance.length === 0) {
    throw new ApiError(400, 'provenance must be a non-empty string');
  }
  if (FORBIDDEN_INGEST_PROVENANCE.has(sample.provenance.toLowerCase())) {
    throw new ApiError(
      400,
      `provenance "${sample.provenance}" is not a live source; synthetic samples must not be posted as live`,
    );
  }

  if (sample.drone_id !== undefined && sample.drone_id !== null
      && (typeof sample.drone_id !== 'string' || sample.drone_id.length === 0)) {
    throw new ApiError(400, 'drone_id must be a non-empty string when present');
  }

  checkNumberOrNull(sample.battery_pct, 'battery_pct', { min: 0, max: 100 });
  checkNumberOrNull(sample.altitude_m, 'altitude_m');
  checkNumberOrNull(sample.ground_speed_mps, 'ground_speed_mps', { min: 0 });
  checkNumberOrNull(sample.latitude, 'latitude', { min: -90, max: 90 });
  checkNumberOrNull(sample.longitude, 'longitude', { min: -180, max: 180 });

  // GPS is a pair: unknown GPS must stay null on both axes, never (0, 0).
  const hasLat = sample.latitude !== null && sample.latitude !== undefined;
  const hasLon = sample.longitude !== null && sample.longitude !== undefined;
  if (hasLat !== hasLon) {
    throw new ApiError(400, 'latitude and longitude must be provided together or both be null');
  }

  const measurements = [
    sample.battery_pct,
    sample.altitude_m,
    sample.ground_speed_mps,
    hasLat && hasLon ? sample.latitude : null,
  ];
  if (!measurements.some((m) => m !== null && m !== undefined)) {
    throw new ApiError(400, 'at least one measurement must be present');
  }

  return {
    drone_id: sample.drone_id ?? null,
    provenance: sample.provenance,
    observed_at: new Date(observedAtMs).toISOString(),
    battery_pct: sample.battery_pct ?? null,
    altitude_m: sample.altitude_m ?? null,
    ground_speed_mps: sample.ground_speed_mps ?? null,
    latitude: sample.latitude ?? null,
    longitude: sample.longitude ?? null,
  };
}

// Validates a snapshot ingest envelope:
//   { captured_at: ISO8601, jpeg_base64: base64 JPEG bytes }
// Returns { capturedAtMs, jpeg } where jpeg is a Buffer.
export function validateSnapshotEnvelope(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'snapshot must be a JSON object');
  }
  const capturedAtMs = parseIsoTimestamp(body.captured_at, 'captured_at');
  assertWithinClockWindow(capturedAtMs, nowMs, 'captured_at');

  if (typeof body.jpeg_base64 !== 'string' || body.jpeg_base64.length === 0) {
    throw new ApiError(400, 'jpeg_base64 must be a non-empty base64 string');
  }
  let jpeg;
  try {
    jpeg = Buffer.from(body.jpeg_base64, 'base64');
  } catch {
    throw new ApiError(400, 'jpeg_base64 is not valid base64');
  }
  if (jpeg.length > MAX_SNAPSHOT_BYTES) {
    throw new ApiError(413, `snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte limit`);
  }
  // JPEG magic: SOI FF D8 followed by a marker byte FF.
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
    throw new ApiError(400, 'payload is not a JPEG image');
  }
  return { capturedAtMs, jpeg };
}

// Exact origin allowlist for browser access. Non-browser requests carry no
// Origin header and are not subject to this check; CORS headers below are what
// a browser enforces, this is the server-side guard for credentialed fetches.
export function isOriginAllowed(originHeader, allowedOrigins) {
  if (originHeader === undefined || originHeader === null) return true;
  return allowedOrigins.includes(originHeader);
}

export function parseAllowedOrigins(envValue) {
  // :8787 is the backend's own origin; :8000 covers the README's
  // `python3 -m http.server -d dist 8000` dev path.
  const defaults = [
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
  ];
  if (!envValue) return defaults;
  const list = envValue.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : defaults;
}
