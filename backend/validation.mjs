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
  checkNumberOrNull(sample.vertical_speed_mps, 'vertical_speed_mps');
  checkNumberOrNull(sample.latitude, 'latitude', { min: -90, max: 90 });
  checkNumberOrNull(sample.longitude, 'longitude', { min: -180, max: 180 });

  // Flight-state fields the ANAFI/Olympe feed reports. Optional; validated
  // when present so a malformed bridge payload can't poison the record.
  if (sample.state !== undefined && sample.state !== null
      && (typeof sample.state !== 'string' || sample.state.length === 0)) {
    throw new ApiError(400, 'state must be a non-empty string when present');
  }

  let gpsFix = null;
  if (typeof sample.gps_fix === 'boolean') {
    gpsFix = sample.gps_fix ? 'fix' : 'no fix';
  } else if (typeof sample.gps_fix === 'string' && sample.gps_fix.length > 0) {
    gpsFix = sample.gps_fix;
  } else if (sample.gps_fix !== undefined && sample.gps_fix !== null) {
    throw new ApiError(400, 'gps_fix must be a non-empty string or boolean when present');
  }

  let attitude = null;
  if (sample.attitude_deg !== undefined && sample.attitude_deg !== null) {
    const a = sample.attitude_deg;
    if (typeof a !== 'object' || Array.isArray(a)) {
      throw new ApiError(400, 'attitude_deg must be an object {roll, pitch, yaw}');
    }
    for (const axis of ['roll', 'pitch', 'yaw']) {
      if (a[axis] !== undefined && a[axis] !== null
          && (typeof a[axis] !== 'number' || !Number.isFinite(a[axis]))) {
        throw new ApiError(400, `attitude_deg.${axis} must be a finite number or null`);
      }
    }
    attitude = {
      roll: a.roll ?? null,
      pitch: a.pitch ?? null,
      yaw: a.yaw ?? null,
    };
  }

  // `extra` is a free-form JSON bag for fields the contract does not name
  // yet (gimbal angles, link quality, ...). Unknown top-level keys are
  // still dropped — `extra` is the deliberate pass-through.
  let extra = null;
  if (sample.extra !== undefined && sample.extra !== null) {
    if (typeof sample.extra !== 'object' || Array.isArray(sample.extra)) {
      throw new ApiError(400, 'extra must be a JSON object when present');
    }
    extra = JSON.parse(JSON.stringify(sample.extra));
  }

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
    vertical_speed_mps: sample.vertical_speed_mps ?? null,
    latitude: sample.latitude ?? null,
    longitude: sample.longitude ?? null,
    state: sample.state ?? null,
    gps_fix: gpsFix,
    attitude_deg: attitude,
    extra,
  };
}

// Validates a snapshot ingest envelope:
//   { captured_at: ISO8601, jpeg_base64: base64 JPEG bytes }
// Or the grounded Pi observer's earlier envelope:
//   { captured_at, provenance: 'live', mime_type: 'image/jpeg', data: base64 }
// Returns { capturedAtMs, jpeg } where jpeg is a Buffer.
export function validateSnapshotEnvelope(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'snapshot must be a JSON object');
  }
  const capturedAtMs = parseIsoTimestamp(body.captured_at, 'captured_at');
  assertWithinClockWindow(capturedAtMs, nowMs, 'captured_at');

  const observerEnvelope = body.jpeg_base64 === undefined;
  if (observerEnvelope && (body.provenance !== 'live' || body.mime_type !== 'image/jpeg')) {
    throw new ApiError(400, 'observer snapshots require live provenance and image/jpeg');
  }
  const encodedJpeg = observerEnvelope ? body.data : body.jpeg_base64;
  if (typeof encodedJpeg !== 'string' || encodedJpeg.length === 0) {
    throw new ApiError(400, 'jpeg_base64 must be a non-empty base64 string');
  }
  let jpeg;
  try {
    jpeg = Buffer.from(encodedJpeg, 'base64');
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

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DETECTION_SOURCES = new Set(['yolo', 'qr-test']);
const FLIGHT_PHASES = new Set([
  'preflight', 'takeoff', 'climb', 'circle', 'return', 'landing', 'landed', 'aborted', 'error',
]);

function isJpeg(buf) {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// Live video frame: raw JPEG body, capture time in the X-Captured-At header.
export function validateFrame(body, capturedAtHeader, nowMs) {
  const capturedAtMs = parseIsoTimestamp(capturedAtHeader, 'X-Captured-At');
  assertWithinClockWindow(capturedAtMs, nowMs, 'X-Captured-At');
  if (body.length > MAX_FRAME_BYTES) {
    throw new ApiError(413, `frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);
  }
  if (!isJpeg(body)) throw new ApiError(400, 'frame is not a JPEG image');
  return capturedAtMs;
}

function finiteOrNull(value, name, range = {}) {
  checkNumberOrNull(value, name, range);
  return value ?? null;
}

// Fire detection sighting from the bridge. One episode (a continuous run of
// sightings of the same fire) carries the same episode_id; each POST is one
// sighting row in the detections time series.
export function validateDetection(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'detection must be a JSON object');
  }
  const detectedAtMs = parseIsoTimestamp(body.detected_at, 'detected_at');
  assertWithinClockWindow(detectedAtMs, nowMs, 'detected_at');
  if (!DETECTION_SOURCES.has(body.source)) {
    throw new ApiError(400, `source must be one of ${[...DETECTION_SOURCES].join(', ')}`);
  }
  if (typeof body.episode_id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(body.episode_id)) {
    throw new ApiError(400, 'episode_id must be 4-64 characters of [A-Za-z0-9_-]');
  }
  if (typeof body.label !== 'string' || body.label.length === 0 || body.label.length > 40) {
    throw new ApiError(400, 'label must be a non-empty string');
  }
  if (typeof body.confidence !== 'number' || !(body.confidence >= 0 && body.confidence <= 1)) {
    throw new ApiError(400, 'confidence must be a number between 0 and 1');
  }
  const bbox = body.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4
      || !bbox.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
    throw new ApiError(400, 'bbox must be [x1, y1, x2, y2] normalized to 0..1');
  }
  const fire = body.fire ?? {};
  const latitude = finiteOrNull(fire.latitude, 'fire.latitude', { min: -90, max: 90 });
  const longitude = finiteOrNull(fire.longitude, 'fire.longitude', { min: -180, max: 180 });
  if ((latitude === null) !== (longitude === null)) {
    throw new ApiError(400, 'fire.latitude and fire.longitude must be provided together');
  }
  for (const key of ['details', 'drone']) {
    if (body[key] !== undefined && body[key] !== null
        && (typeof body[key] !== 'object' || Array.isArray(body[key]))) {
      throw new ApiError(400, `${key} must be a JSON object when present`);
    }
  }
  let jpeg = null;
  if (body.frame_jpeg_base64 !== undefined && body.frame_jpeg_base64 !== null) {
    if (typeof body.frame_jpeg_base64 !== 'string') {
      throw new ApiError(400, 'frame_jpeg_base64 must be a base64 string');
    }
    jpeg = Buffer.from(body.frame_jpeg_base64, 'base64');
    if (jpeg.length > MAX_SNAPSHOT_BYTES) throw new ApiError(413, 'detection frame too large');
    if (!isJpeg(jpeg)) throw new ApiError(400, 'detection frame is not a JPEG image');
  }
  return {
    detection: {
      detected_at: new Date(detectedAtMs).toISOString(),
      episode_id: body.episode_id,
      source: body.source,
      label: body.label,
      confidence: body.confidence,
      bbox,
      fire: {
        latitude,
        longitude,
        distance_m: finiteOrNull(fire.distance_m, 'fire.distance_m', { min: 0 }),
        bearing_deg: finiteOrNull(fire.bearing_deg, 'fire.bearing_deg', { min: -360, max: 720 }),
        position_source: typeof fire.position_source === 'string' ? fire.position_source : null,
      },
      drone: body.drone ? JSON.parse(JSON.stringify(body.drone)) : null,
      details: body.details ? JSON.parse(JSON.stringify(body.details)) : null,
    },
    jpeg,
  };
}

export function validateFlightEvent(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'flight event must be a JSON object');
  }
  const atMs = parseIsoTimestamp(body.at, 'at');
  assertWithinClockWindow(atMs, nowMs, 'at');
  if (!FLIGHT_PHASES.has(body.phase)) {
    throw new ApiError(400, `phase must be one of ${[...FLIGHT_PHASES].join(', ')}`);
  }
  const step = body.step ?? null;
  const steps = body.steps ?? null;
  if ((step !== null && !Number.isInteger(step)) || (steps !== null && !Number.isInteger(steps))) {
    throw new ApiError(400, 'step and steps must be integers when present');
  }
  return {
    at: new Date(atMs).toISOString(),
    phase: body.phase,
    step,
    steps,
    message: typeof body.message === 'string' ? body.message.slice(0, 200) : '',
  };
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
