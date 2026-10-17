/* BOSCO person search — finding people who cannot ask for help.
 *
 * Pure logic, no I/O:
 *   - geolocate(): one detection becomes a ground point by casting the image
 *     ray through the timestamped drone + gimbal pose onto the terrain, with a
 *     covariance propagated from an explicit error model (GPS, altitude,
 *     heading, gimbal pitch, box centre, terrain). No confidence percentages:
 *     every number shown to a responder comes from this model.
 *   - PersonSearch: associates detections over time into rescue leads, fuses
 *     their positions, counts genuinely distinct viewpoints (a hot rock or a
 *     reflection rarely geolocates to the same spot from two angles), tracks
 *     movement, records "looked again, not seen", keeps an observability map
 *     of the ground and suggests the next viewpoint for each lead.
 *
 * Advisory only: nothing here commands the aircraft, and nothing here ever
 * labels ground or a route as safe. A responder acknowledges every lead.
 */
import { ApiError, parseIsoTimestamp } from './validation.mjs';
import '../dist/model.js'; // the dashboard's spread model, shared so both project the same fire
const EM = globalThis.EmberModel;

export const M_PER_DEG = 111_320;
const RAD = Math.PI / 180;

/** 1-sigma error model. Tunable; documented in docs/PERSON_SEARCH.md. */
export const DEFAULT_ERRORS = Object.freeze({
  gps_m: 2.5,          // horizontal position, GPS fix
  odometry_m: 1.0,     // horizontal position, home + commanded moves (indoor)
  altitude_m: 1.0,     // height above the ground under the drone (GPS/baro)
  altitude_indoor_m: 0.3,
  heading_deg: 3.0,    // magnetometer heading
  pitch_deg: 1.5,      // gimbal pitch
  pixel_frac: 0.25,    // box-centre error as a fraction of the box size
  terrain_flat_m: 2.0, // flat-ground assumption (no elevation model)
  terrain_dem_m: 1.0,  // caller supplied the ground height at the target
});

const CHI2_2D_99 = 9.21;
const K95 = Math.sqrt(5.991);              // 95 % ellipse scale for 2 dof
const MIN_DEPRESSION_DEG = 3;              // shallower rays never meet the ground reliably
const MAX_RANGE_M = 1500;
export const DISTINCT_VIEW_DEG = 25;       // two looks this far apart in azimuth are different viewpoints
const WALK_MPS = 1.5;
export const STATIONARY_MIN_S = 60;
const MAX_WALK_GATE_M = 15;
const RECHECK_AFTER_S = 90;          // a possible person unseen this long gets a re-check suggestion
const MIN_LOOK_DEPRESSION_DEG = 15;        // grazing looks don't see under canopy: they don't count as coverage
const LOOK_GAP_MS = 8_000;                 // a look counts as "not seen" only this long after the last sighting
const LOOK_INTERVAL_MS = 5_000;
export const NOT_RESEEN_LOOKS = 3;
export const FIRE_STANDOFF_MIN = 10;       // never suggest flying over ground the fire reaches this soon
export const FIRE_PATH_MIN = 60;           // "in the fire's path" for trail colouring

/**
 * Minutes until the projected fire covers a point, from a spread context
 * { origin: [lat, lon], scenario, details }. 0 = inside now, null = not within 3 h.
 */
export function fireArrival(spread, lat, lon) {
  if (!spread?.origin) return undefined;
  return EM.arrivalMinutes(spread.origin, [lat, lon], spread.scenario, spread.details);
}
export const DELAYED_MS = 15_000;          // received this long after capture -> delayed alert
export const STORE_FORWARD_MAX_MS = 6 * 3600_000;
const MAX_OBS_PER_LEAD = 200;
const AZ_BINS = 12;                        // 30 degree azimuth bins for coverage
const CLOSE_OUTCOMES = new Set(['found', 'not-a-person', 'duplicate', 'handed-off']);

// ------------------------------------------------------------------ geometry

const wrap360 = (d) => ((d % 360) + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(wrap360(a) - wrap360(b)); return d > 180 ? 360 - d : d; };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round(wrap360(deg) / 45) % 8];

export function toLocal(ref, lat, lon) {
  return [(lon - ref.lon) * M_PER_DEG * Math.cos(ref.lat * RAD), (lat - ref.lat) * M_PER_DEG];
}
export function toLatLon(ref, e, n) {
  return [ref.lat + n / M_PER_DEG, ref.lon + e / (M_PER_DEG * Math.cos(ref.lat * RAD))];
}

const det2 = (m) => m[0] * m[3] - m[1] * m[2];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
function inv2(m) {
  const d = det2(m);
  if (!(Math.abs(d) > 1e-12)) return null;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d];
}
function mahal2(dx, dy, cov) {
  const i = inv2(cov);
  if (!i) return Infinity;
  return dx * (i[0] * dx + i[1] * dy) + dy * (i[2] * dx + i[3] * dy);
}
const iso = (cov, s) => [cov[0] + s, cov[1], cov[2], cov[3] + s];

/** 95 % ellipse of a 2x2 ENU covariance [ee, en, ne, nn]. */
export function ellipse95(cov) {
  const a = cov[0], b = (cov[1] + cov[2]) / 2, c = cov[3];
  const mid = (a + c) / 2, rad = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = Math.max(mid + rad, 0), l2 = Math.max(mid - rad, 0);
  const thetaFromEast = 0.5 * Math.atan2(2 * b, a - c) / RAD;
  return {
    major_95_m: +(K95 * Math.sqrt(l1)).toFixed(1),
    minor_95_m: +(K95 * Math.sqrt(l2)).toFixed(1),
    bearing_deg: Math.round(wrap360(90 - thetaFromEast)) % 180,
    area_95_m2: Math.round(Math.PI * K95 * K95 * Math.sqrt(Math.max(det2(cov), 0))),
  };
}

/** Where the ray through image point (u, v) meets the ground, relative to the drone (metres E, N). */
export function rayToGround({ alt, heading, pitch, u, v, hfov, vfov, terrain = 0 }) {
  const alpha = Math.atan((u - 0.5) * 2 * Math.tan(hfov * RAD / 2)) / RAD;  // right of centre
  const beta = Math.atan((v - 0.5) * 2 * Math.tan(vfov * RAD / 2)) / RAD;   // below centre
  let az = wrap360(heading + alpha);
  let dep = -pitch + beta;
  if (dep > 90) { dep = 180 - dep; az = wrap360(az + 180); } // tilted past straight down: looking behind
  const height = alt - terrain;
  if (dep < MIN_DEPRESSION_DEG || height <= 0) return null;
  const range = height / Math.tan(Math.min(dep, 89.999) * RAD);
  if (range > MAX_RANGE_M) return null;
  return { e: range * Math.sin(az * RAD), n: range * Math.cos(az * RAD), range, az, dep };
}

/** Image point of a ground target seen from a pose (inverse of rayToGround), or null if off-frame. */
export function projectToImage({ alt, heading, pitch, hfov, vfov }, de, dn, terrain = 0) {
  const range = Math.hypot(de, dn);
  const az = wrap360(Math.atan2(de, dn) / RAD);
  const dep = Math.atan2(alt - terrain, range) / RAD;
  let alpha = az - heading; alpha = ((alpha + 540) % 360) - 180;
  const beta = dep + pitch;
  if (Math.abs(alpha) >= 89 || Math.abs(beta) >= 89) return null;
  const u = 0.5 + Math.tan(alpha * RAD) / (2 * Math.tan(hfov * RAD / 2));
  const v = 0.5 + Math.tan(beta * RAD) / (2 * Math.tan(vfov * RAD / 2));
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v, range, az, dep, slant: Math.hypot(range, alt - terrain) };
}

function poseSigmas(obs, errors) {
  const indoor = obs.drone.position_source && obs.drone.position_source !== 'gps';
  return {
    pos: indoor ? errors.odometry_m : errors.gps_m,
    alt: indoor ? errors.altitude_indoor_m : errors.altitude_m,
    heading: errors.heading_deg,
    pitch: errors.pitch_deg,
    u: errors.pixel_frac * (obs.bbox[2] - obs.bbox[0]),
    v: errors.pixel_frac * (obs.bbox[3] - obs.bbox[1]),
    terrain: obs.terrain_m != null ? errors.terrain_dem_m : indoor ? 0 : errors.terrain_flat_m,
  };
}

/**
 * Ground position and covariance of one detection.
 * Linearised propagation: J Σ Jᵀ over the pose/pixel/terrain errors plus the
 * drone's own horizontal position error.
 */
export function geolocate(obs, errors = DEFAULT_ERRORS) {
  const { drone, camera, bbox } = obs;
  const base = {
    alt: drone.altitude_m, heading: drone.heading_deg, pitch: drone.gimbal_pitch_deg,
    u: (bbox[0] + bbox[2]) / 2, v: (bbox[1] + bbox[3]) / 2,
    hfov: camera.hfov_deg, vfov: camera.vfov_deg, terrain: obs.terrain_m ?? 0,
  };
  const p0 = rayToGround(base);
  if (!p0) throw new ApiError(422, 'the detection ray does not meet the ground (camera too close to the horizon or drone below the target)');
  const s = poseSigmas(obs, errors);
  const steps = { alt: 0.05, heading: 0.05, pitch: 0.05, u: 0.0005, v: 0.0005, terrain: 0.05 };
  let cov = [s.pos ** 2, 0, 0, s.pos ** 2];
  for (const [k, h] of Object.entries(steps)) {
    if (!s[k]) continue;
    const plus = rayToGround({ ...base, [k]: base[k] + h });
    const minus = rayToGround({ ...base, [k]: base[k] - h });
    if (!plus || !minus) throw new ApiError(422, 'the detection ray is too close to the horizon to locate');
    const je = (plus.e - minus.e) / (2 * h), jn = (plus.n - minus.n) / (2 * h);
    const v2 = s[k] ** 2;
    cov = add2(cov, [je * je * v2, je * jn * v2, je * jn * v2, jn * jn * v2]);
  }
  const [lat, lon] = toLatLon({ lat: drone.latitude, lon: drone.longitude }, p0.e, p0.n);
  return { latitude: lat, longitude: lon, cov, range_m: p0.range, view_az_deg: p0.az, depression_deg: p0.dep };
}

// ---------------------------------------------------------------- validation

const SENSORS = new Set(['thermal', 'visible']);
const FORBIDDEN_PROVENANCE = new Set(['sim', 'simulated', 'demo', 'test', 'mock', 'fake', 'synthetic']);
export const MAX_CROP_BYTES = 300 * 1024;

function num(value, name, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${name} is required`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ApiError(400, `${name} must be a number in [${min}, ${max}]`);
  }
  return value;
}

/** Validate a POST /api/ingest/person body. Observations may arrive late (store-and-forward). */
export function validatePersonObservation(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'body must be a JSON object');
  const observedMs = parseIsoTimestamp(body.observed_at, 'observed_at');
  if (observedMs - nowMs > 30_000) throw new ApiError(400, 'observed_at is in the future');
  if (nowMs - observedMs > STORE_FORWARD_MAX_MS) throw new ApiError(400, 'observed_at is older than 6 h');
  if (typeof body.provenance !== 'string' || FORBIDDEN_PROVENANCE.has(body.provenance.toLowerCase()) || body.provenance !== 'live') {
    throw new ApiError(400, 'provenance must be "live"');
  }
  if (!SENSORS.has(body.sensor)) throw new ApiError(400, 'sensor must be "thermal" or "visible"');
  if (body.label !== 'person') throw new ApiError(400, 'label must be "person"');
  if (!Array.isArray(body.bbox) || body.bbox.length !== 4 || !body.bbox.every((v) => typeof v === 'number' && v >= 0 && v <= 1)
    || body.bbox[2] <= body.bbox[0] || body.bbox[3] <= body.bbox[1]) {
    throw new ApiError(400, 'bbox must be [x1, y1, x2, y2] normalized 0..1 with x2 > x1 and y2 > y1');
  }
  const d = body.drone;
  if (!d || typeof d !== 'object') throw new ApiError(400, 'drone pose is required');
  const drone = {
    latitude: num(d.latitude, 'drone.latitude', { min: -90, max: 90, required: true }),
    longitude: num(d.longitude, 'drone.longitude', { min: -180, max: 180, required: true }),
    altitude_m: num(d.altitude_m, 'drone.altitude_m', { min: 0.1, max: 5000, required: true }),
    heading_deg: num(d.heading_deg, 'drone.heading_deg', { min: -360, max: 360, required: true }),
    gimbal_pitch_deg: num(d.gimbal_pitch_deg, 'drone.gimbal_pitch_deg', { min: -90, max: 30, required: true }),
    position_source: typeof d.position_source === 'string' ? d.position_source.slice(0, 40) : 'gps',
  };
  const c = body.camera && typeof body.camera === 'object' ? body.camera : {};
  const hfov = num(c.hfov_deg, 'camera.hfov_deg', { min: 5, max: 170 }) ?? 69;
  const aspect = num(c.aspect, 'camera.aspect', { min: 0.2, max: 5 }) ?? 16 / 9;
  const vfov = num(c.vfov_deg, 'camera.vfov_deg', { min: 3, max: 170 })
    ?? 2 * Math.atan(Math.tan(hfov * RAD / 2) / aspect) / RAD;
  let crop = null;
  if (body.crop_jpeg_base64 != null) {
    if (typeof body.crop_jpeg_base64 !== 'string') throw new ApiError(400, 'crop_jpeg_base64 must be a string');
    crop = Buffer.from(body.crop_jpeg_base64, 'base64');
    if (crop.length > MAX_CROP_BYTES) throw new ApiError(413, 'crop exceeds 300 KB');
    if (crop.length < 3 || crop[0] !== 0xff || crop[1] !== 0xd8) throw new ApiError(400, 'crop must be a JPEG');
  }
  const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v);
  if (body.obs_id != null && !idOk(body.obs_id)) throw new ApiError(400, 'obs_id must be 1-64 characters [A-Za-z0-9._:-]');
  if (body.track_id != null && !idOk(body.track_id)) throw new ApiError(400, 'track_id must be 1-64 characters [A-Za-z0-9._:-]');
  return {
    obs: {
      obs_id: body.obs_id ?? null,
      observed_at: new Date(observedMs).toISOString(),
      provenance: 'live',
      sensor: body.sensor,
      label: 'person',
      detector: typeof body.detector === 'string' ? body.detector.slice(0, 40) : null,
      detector_score: num(body.detector_score, 'detector_score', { min: 0, max: 1 }),
      track_id: body.track_id ?? null,
      bbox: body.bbox.map((v) => +v.toFixed(4)),
      drone,
      camera: { hfov_deg: hfov, vfov_deg: vfov },
      terrain_m: num(body.terrain_m, 'terrain_m', { min: -2000, max: 2000 }),
    },
    crop,
  };
}

// ---------------------------------------------------------------- the search

function fuse(observations) {
  let info = [0, 0, 0, 0], ie = 0, inn = 0;
  for (const o of observations) {
    const w = inv2(o.cov);
    if (!w) continue;
    info = add2(info, w);
    ie += w[0] * o.e + w[1] * o.n;
    inn += w[2] * o.e + w[3] * o.n;
  }
  const P = inv2(info);
  if (!P) return null;
  return { e: P[0] * ie + P[1] * inn, n: P[2] * ie + P[3] * inn, cov: P };
}

/** Greedy azimuth clustering: how many genuinely different directions has this been seen from? */
function viewClusters(azimuths) {
  const centres = [];
  for (const az of azimuths) if (!centres.some((c) => angDiff(c, az) < DISTINCT_VIEW_DEG)) centres.push(az);
  let span = 0;
  for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) span = Math.max(span, angDiff(centres[i], centres[j]));
  return { centres, span };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const popcount = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

export class PersonSearch {
  /**
   * @param {object} opts
   * @param {object} [opts.errors]   1-sigma error model (DEFAULT_ERRORS)
   * @param {number} [opts.hfovDeg]  camera field of view used for coverage footprints
   * @param {number} [opts.cellM]    coverage grid cell size
   * @param {number[]|null} [opts.sector] assigned search sector [south, west, north, east] from incident aviation
   */
  constructor({ errors = DEFAULT_ERRORS, hfovDeg = 69, aspect = 16 / 9, cellM = 5, sector = null, maxCells = 60_000, cruiseMps = 8 } = {}) {
    this.errors = { ...DEFAULT_ERRORS, ...errors };
    this.hfov = hfovDeg;
    this.vfov = 2 * Math.atan(Math.tan(hfovDeg * RAD / 2) / aspect) / RAD;
    this.cellM = cellM;
    this.sector = sector;
    this.maxCells = maxCells;
    this.cruiseMps = cruiseMps;
    this.ref = sector ? { lat: (sector[0] + sector[2]) / 2, lon: (sector[1] + sector[3]) / 2 } : null;
    this.leads = new Map();
    this.obsIndex = new Map();   // obs_id -> lead id (idempotent store-and-forward retries)
    this.seq = 0;
    this.cells = new Map();      // "i,j" -> { bins, looks, last }
    this.cellsTruncated = false;
    this.lastPose = null;
  }

  _ensureRef(lat, lon) { if (!this.ref) this.ref = { lat, lon }; }

  /** Add one person detection. Returns { lead, observation, new_lead, duplicate }. */
  addObservation(obs, receivedAtMs) {
    if (obs.obs_id && this.obsIndex.has(obs.obs_id)) {
      return { duplicate: true, lead: this.leads.get(this.obsIndex.get(obs.obs_id)) };
    }
    const g = geolocate(obs, this.errors);
    this._ensureRef(obs.drone.latitude, obs.drone.longitude);
    const [e, n] = toLocal(this.ref, g.latitude, g.longitude);
    const atMs = Date.parse(obs.observed_at);
    const record = {
      id: obs.obs_id ?? `o${++this.seq}-${atMs.toString(36)}`,
      at: obs.observed_at,
      at_ms: atMs,
      received_at: new Date(receivedAtMs).toISOString(),
      delayed: receivedAtMs - atMs > DELAYED_MS,
      delay_s: Math.max(0, Math.round((receivedAtMs - atMs) / 1000)),
      sensor: obs.sensor,
      detector: obs.detector,
      detector_score: obs.detector_score,
      track_id: obs.track_id,
      provenance: obs.provenance,
      e, n, cov: g.cov,
      latitude: g.latitude, longitude: g.longitude,
      view_az_deg: g.view_az_deg, range_m: g.range_m, depression_deg: g.depression_deg,
      drone: { latitude: obs.drone.latitude, longitude: obs.drone.longitude, altitude_m: obs.drone.altitude_m, heading_deg: obs.drone.heading_deg, gimbal_pitch_deg: obs.drone.gimbal_pitch_deg },
      crop: false,
    };
    const lead = this._associate(record);
    let isNew = false;
    let target = lead;
    if (!target) {
      isNew = true;
      const number = this.leads.size + 1;
      target = { id: `lead-${number}`, number, created_at: record.at, observations: [], ack: null, closed: null, missed_looks: 0, last_look_ms: 0, fused: null };
      this.leads.set(target.id, target);
    }
    target.observations.push(record);
    target.observations.sort((a, b) => a.at_ms - b.at_ms);
    if (target.observations.length > MAX_OBS_PER_LEAD) target.observations.splice(1, 1); // keep the first sighting
    if (atMs >= this._lastSeenMs(target) - 1) target.missed_looks = 0;
    target.fused = this._estimate(target);
    if (obs.obs_id) this.obsIndex.set(obs.obs_id, target.id);
    else this.obsIndex.set(record.id, target.id);
    return { lead: target, observation: record, new_lead: isNew, duplicate: false };
  }

  attachCrop(obsId) {
    const lead = this.leads.get(this.obsIndex.get(obsId));
    const o = lead?.observations.find((x) => x.id === obsId);
    if (!o) return false;
    o.crop = true;
    return true;
  }

  _lastSeenMs(lead) { return lead.observations.at(-1)?.at_ms ?? 0; }

  _associate(rec) {
    let best = null, bestD = CHI2_2D_99;
    for (const lead of this.leads.values()) {
      if (lead.closed || !lead.fused) continue;
      const last = lead.observations.at(-1);
      const sameTrack = rec.track_id && lead.observations.some((o) => o.track_id === rec.track_id && Math.abs(o.at_ms - rec.at_ms) < 15_000);
      const dt = Math.abs(rec.at_ms - last.at_ms) / 1000;
      const walk = Math.min(WALK_MPS * dt, MAX_WALK_GATE_M);
      const S = iso(add2(rec.cov, lead.fused.cov), walk * walk);
      const d = mahal2(rec.e - lead.fused.e, rec.n - lead.fused.n, S);
      const score = sameTrack && d < 4 * CHI2_2D_99 ? 0 : d;
      if (score < bestD) { bestD = score; best = lead; }
    }
    return best;
  }

  _movement(lead) {
    const obs = lead.observations;
    const span = (obs.at(-1).at_ms - obs[0].at_ms) / 1000;
    if (obs.length < 2 || span < 20) return { status: 'unknown', span_s: Math.round(span), detail: 'Not enough time between sightings to tell' };
    const early = fuse(obs.filter((o) => o.at_ms - obs[0].at_ms <= 15_000));
    const late = fuse(obs.filter((o) => obs.at(-1).at_ms - o.at_ms <= 15_000));
    const dx = late.e - early.e, dy = late.n - early.n, dist = Math.hypot(dx, dy);
    const d = mahal2(dx, dy, add2(early.cov, late.cov));
    if (d > CHI2_2D_99 && dist > 3) {
      return { status: 'moving', span_s: Math.round(span), displacement_m: +dist.toFixed(1), heading_deg: Math.round(wrap360(Math.atan2(dx, dy) / RAD)),
        speed_mps: +(dist / span).toFixed(2), detail: `Moved about ${Math.round(dist)} m toward ${compass(Math.atan2(dx, dy) / RAD)} over ${fmtSpan(span)}` };
    }
    const bound = Math.max(3, ellipse95(add2(early.cov, late.cov)).major_95_m);
    // "Stationary" suggests someone who may be unable to move: claim it only over a long enough window.
    if (span < STATIONARY_MIN_S) return { status: 'unknown', span_s: Math.round(span), detail: `No clear movement yet (${fmtSpan(span)} of sightings; ${STATIONARY_MIN_S} s needed)` };
    return { status: 'stationary', span_s: Math.round(span), detail: `No movement larger than ${Math.round(bound)} m over ${fmtSpan(span)}` };
  }

  _estimate(lead) {
    const obs = lead.observations;
    if (obs.length === 0) return null;
    const mv = obs.length >= 2 ? this._movement(lead) : { status: 'unknown' };
    // A moving person: only the recent sightings describe where they are now.
    const use = mv.status === 'moving' ? obs.filter((o) => obs.at(-1).at_ms - o.at_ms <= 15_000) : obs;
    return fuse(use);
  }

  /** Feed a telemetry pose: updates coverage and "looked again, not seen" counts. */
  observePose(pose, atMs) {
    const { latitude: lat, longitude: lon, altitude_m: alt, heading_deg: heading, gimbal_pitch_deg: pitch } = pose;
    if (lat == null || lon == null || !(alt > 0.5) || heading == null || pitch == null) return;
    this._ensureRef(lat, lon);
    this.lastPose = { latitude: lat, longitude: lon, altitude_m: alt, heading_deg: heading, at_ms: atMs };
    const [de, dn] = toLocal(this.ref, lat, lon);
    const cam = { alt, heading, pitch, hfov: this.hfov, vfov: this.vfov };
    const poly = this._footprint(cam);
    if (!poly) return;
    const pts = poly.map(([e, n]) => [e + de, n + dn]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const c = this.cellM;
    for (let i = Math.floor(Math.min(...xs) / c); i <= Math.floor(Math.max(...xs) / c); i++) {
      for (let j = Math.floor(Math.min(...ys) / c); j <= Math.floor(Math.max(...ys) / c); j++) {
        const cx = (i + 0.5) * c, cy = (j + 0.5) * c;
        if (!pointInPolygon(cx, cy, pts)) continue;
        const ex = cx - de, ny = cy - dn;
        const dep = Math.atan2(alt, Math.hypot(ex, ny)) / RAD;
        if (dep < MIN_LOOK_DEPRESSION_DEG) continue;
        const key = `${i},${j}`;
        let cell = this.cells.get(key);
        if (!cell) {
          if (this.cells.size >= this.maxCells) { this.cellsTruncated = true; continue; }
          cell = { bins: 0, looks: 0, last: 0 };
          this.cells.set(key, cell);
        }
        cell.bins |= 1 << (Math.floor(wrap360(Math.atan2(ex, ny) / RAD) / (360 / AZ_BINS)) % AZ_BINS);
        if (atMs - cell.last > 2000) cell.looks++;
        cell.last = atMs;
      }
    }
    // Negative evidence: the lead's spot was in good view and nothing was detected.
    for (const lead of this.leads.values()) {
      if (lead.closed || !lead.fused) continue;
      if (atMs - this._lastSeenMs(lead) < LOOK_GAP_MS || atMs - lead.last_look_ms < LOOK_INTERVAL_MS) continue;
      const tx = lead.fused.e - de, ty = lead.fused.n - dn;
      if (!projectToImage(cam, tx, ty)) continue;
      if (Math.atan2(alt, Math.hypot(tx, ty)) / RAD < MIN_LOOK_DEPRESSION_DEG) continue;
      lead.missed_looks++;
      lead.last_look_ms = atMs;
    }
  }

  _footprint(cam) {
    const maxRange = Math.min(MAX_RANGE_M, cam.alt * 8);
    const corner = (u, v) => {
      const g = rayToGround({ ...cam, u, v });
      if (g && g.range <= maxRange) return [g.e, g.n];
      // Above the horizon or beyond useful range: clip at maxRange along the corner's azimuth.
      const alpha = Math.atan((u - 0.5) * 2 * Math.tan(cam.hfov * RAD / 2)) / RAD;
      const az = (cam.heading + alpha) * RAD;
      return [maxRange * Math.sin(az), maxRange * Math.cos(az)];
    };
    if (-cam.pitch + this.vfov / 2 < MIN_DEPRESSION_DEG) return null; // the whole frame is sky
    return [corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0)];
  }

  acknowledge(leadId, { by, note = '' }, atMs) {
    const lead = this.leads.get(leadId);
    if (!lead) throw new ApiError(404, 'no lead with that id');
    if (typeof by !== 'string' || !by.trim()) throw new ApiError(400, 'by (the responder acknowledging) is required');
    lead.ack = { by: by.trim().slice(0, 80), note: String(note ?? '').slice(0, 500), at: new Date(atMs).toISOString() };
    return lead;
  }

  close(leadId, { by, outcome, note = '' }, atMs) {
    const lead = this.leads.get(leadId);
    if (!lead) throw new ApiError(404, 'no lead with that id');
    if (typeof by !== 'string' || !by.trim()) throw new ApiError(400, 'by (the responder closing the lead) is required');
    if (!CLOSE_OUTCOMES.has(outcome)) throw new ApiError(400, `outcome must be one of ${[...CLOSE_OUTCOMES].join(', ')}`);
    lead.closed = { by: by.trim().slice(0, 80), outcome, note: String(note ?? '').slice(0, 500), at: new Date(atMs).toISOString() };
    return lead;
  }

  /**
   * Best next viewpoint for a lead: expected uncertainty reduction (and, for a
   * single-view candidate, a genuinely new angle) minus flight time minus
   * exposure to the fire. Suggestions only — the pilot decides.
   */
  nextLook(lead, { fire = null, spread = null, pose = this.lastPose } = {}) {
    if (lead.closed || !lead.fused) return null;
    const views = viewClusters(lead.observations.map((o) => o.view_az_deg));
    const needsAngle = views.span < DISTINCT_VIEW_DEG;
    const now = ellipse95(lead.fused.cov);
    const last = lead.observations.at(-1);
    const unseenS = pose?.at_ms ? (pose.at_ms - last.at_ms) / 1000 : 0;
    const recheck = !needsAngle && unseenS >= RECHECK_AFTER_S;
    if (!needsAngle && !recheck && now.major_95_m <= 8) return null;
    const alt = Math.max(pose?.altitude_m ?? last.drone.altitude_m, 5);
    const standoff = Math.max(alt, 10); // ~45 degree look: sees under canopy edges, keeps geometry well-conditioned
    const bw = last.drone && last.range_m ? Math.max(0.002, (0.6 / (2 * Math.hypot(last.range_m, alt) * Math.tan(this.hfov * RAD / 2)))) : 0.01;
    const [poseE, poseN] = pose ? toLocal(this.ref, pose.latitude, pose.longitude) : [last.e, last.n];
    const fireLocal = fire ? toLocal(this.ref, fire.latitude, fire.longitude) : null;
    // Assigned sector as local bounds: [west e, south n] and [east e, north n].
    const [minE, minN] = this.sector ? toLocal(this.ref, this.sector[0], this.sector[1]) : [];
    const [maxE, maxN] = this.sector ? toLocal(this.ref, this.sector[2], this.sector[3]) : [];
    let best = null;
    for (let az = 0; az < 360; az += 15) {
      const ve = lead.fused.e - standoff * Math.sin(az * RAD), vn = lead.fused.n - standoff * Math.cos(az * RAD);
      if (this.sector && (ve < minE || ve > maxE || vn < minN || vn > maxN)) continue;
      const fireDist = fireLocal ? Math.hypot(ve - fireLocal[0], vn - fireLocal[1]) : Infinity;
      if (fireDist < 40) continue; // hard limit: never suggest hovering over the fire
      const [vlat, vlon] = toLatLon(this.ref, ve, vn);
      const arrives = fireArrival(spread, vlat, vlon);
      if (arrives != null && arrives < FIRE_STANDOFF_MIN) continue; // inside or about to be: smoke and heat
      let predicted;
      try {
        predicted = geolocate({
          drone: { latitude: vlat, longitude: vlon, altitude_m: alt, heading_deg: az, gimbal_pitch_deg: -45, position_source: 'gps' },
          camera: { hfov_deg: this.hfov, vfov_deg: this.vfov }, bbox: [0.5 - bw / 2, 0.5 - bw, 0.5 + bw / 2, 0.5 + bw], terrain_m: null,
        }, this.errors);
      } catch { continue; }
      const info = inv2(lead.fused.cov), infoNew = inv2(predicted.cov);
      const after = info && infoNew ? inv2(add2(info, infoNew)) : lead.fused.cov;
      const afterE = ellipse95(after);
      const novelty = Math.min(...views.centres.map((c) => angDiff(c, az)));
      const newAngle = novelty >= DISTINCT_VIEW_DEG;
      const flightS = Math.hypot(ve - poseE, vn - poseN) / this.cruiseMps;
      const exposure = Number.isFinite(fireDist) ? Math.max(0, (200 - fireDist) / 200) * 120 : 0;
      // Weights are in "seconds of flight" equivalents; documented as tunable.
      const score = 0.5 * Math.max(0, now.area_95_m2 - afterE.area_95_m2) + (needsAngle && newAngle ? 150 : 0) + Math.min(novelty, 90) * 0.5 - flightS - exposure;
      if (!best || score > best.score) {
        best = { score, az, vlat, vlon, flightS, afterE, newAngle, fireDist };
      }
    }
    if (!best) return null;
    return {
      latitude: +best.vlat.toFixed(7), longitude: +best.vlon.toFixed(7), altitude_m: Math.round(alt),
      look_heading_deg: best.az, gimbal_pitch_deg: -45, standoff_m: Math.round(standoff),
      from: compass(best.az + 180), flight_s: Math.round(best.flightS),
      adds_new_angle: best.newAngle, predicted_major_95_m: best.afterE.major_95_m,
      fire_distance_m: Number.isFinite(best.fireDist) ? Math.round(best.fireDist) : null,
      kind: needsAngle ? 'new-angle' : recheck ? 'recheck' : 'narrow',
      reason: needsAngle
        ? `Seen from one direction only. A look from the ${compass(best.az + 180)} can show whether it is the same thing from a second angle.`
        : recheck
        ? `Last seen ${fmtSpan(unseenS)} ago. Look again from the ${compass(best.az + 180)} to see whether they are still there, and whether they are moving.`
        : `Location is uncertain to ±${now.major_95_m} m. A look from the ${compass(best.az + 180)} is predicted to narrow it to ±${best.afterE.major_95_m} m.`,
    };
  }

  summarize(lead, nowMs, ctx = {}) {
    const obs = lead.observations;
    const fused = lead.fused;
    const [lat, lon] = toLatLon(this.ref, fused.e, fused.n);
    const views = viewClusters(obs.map((o) => o.view_az_deg));
    const movement = this._movement(lead);
    const sensors = [...new Set(obs.map((o) => o.sensor))];
    const lastSeen = obs.at(-1);
    const multiView = views.centres.length >= 2 && views.span >= DISTINCT_VIEW_DEG;
    let status;
    if (lead.closed) status = 'closed';
    else if (lead.missed_looks >= NOT_RESEEN_LOOKS) status = 'not-re-seen';
    else if (multiView) status = 'possible-person';
    else status = 'needs-another-view';
    const STATUS_TEXT = {
      'possible-person': `Seen from ${views.centres.length} angles at the same spot`,
      'needs-another-view': 'Seen from one direction only — needs another angle',
      'not-re-seen': multiView
        ? `Seen earlier from ${views.centres.length} angles; looked again ${lead.missed_looks} times since, not seen — may have moved or be hidden`
        : `Looked again ${lead.missed_looks} times, not seen — may have moved, be hidden, or not be a person`,
      closed: `Closed by ${lead.closed?.by}: ${lead.closed?.outcome}`,
    };
    const ell = ellipse95(fused.cov);
    let fireDist = null;
    if (ctx.fire) {
      const [fe, fn] = toLocal(this.ref, ctx.fire.latitude, ctx.fire.longitude);
      fireDist = Math.round(Math.hypot(fe - fused.e, fn - fused.n));
    }
    const reasons = [];
    if (multiView) reasons.push(`seen from ${views.centres.length} angles (${Math.round(views.span)}° apart)`);
    if (sensors.length > 1) reasons.push('seen in thermal and visible');
    if (movement.status === 'stationary' && multiView) reasons.push(`not moving for ${fmtSpan(movement.span_s)} — may be unable to move or call for help`);
    if (movement.status === 'moving') reasons.push('moving — likely able to self-evacuate, keep tracking');
    const arrival = lead.closed ? undefined : fireArrival(ctx.spread, lat, lon);
    if (arrival === 0) reasons.push('inside the projected fire area now');
    else if (arrival != null) reasons.push(`fire projected to reach this spot in about ${arrival} min`);
    if (fireDist != null && fireDist < 300) reasons.push(`${fireDist} m from the detected fire`);
    if (obs.some((o) => o.delayed)) reasons.push('includes delayed observations');
    // Another lead this one could be: it was last seen within walking reach of where this one first appeared.
    const sameAs = [];
    for (const other of this.leads.values()) {
      if (other === lead || other.closed || !other.fused) continue;
      const a = other.observations.at(-1), b = obs[0];
      if (a.at_ms >= b.at_ms) continue;
      const reach = WALK_MPS * (b.at_ms - a.at_ms) / 1000 + ellipse95(other.fused.cov).major_95_m + ellipse95(b.cov).major_95_m;
      if (Math.hypot(other.fused.e - b.e, other.fused.n - b.n) <= reach && (b.at_ms - a.at_ms) < 10 * 60_000) sameAs.push(other.number);
    }
    if (sameAs.length) reasons.push(`may be the same person as Target ${sameAs.join(', ')} (within walking distance)`);
    const tier = lead.closed ? 9
      : status === 'possible-person' && movement.status === 'stationary' ? 1
      : status === 'possible-person' ? 2
      : status === 'not-re-seen' && multiView ? 3
      : status === 'needs-another-view' ? 4 : 5;
    return {
      id: lead.id,
      number: lead.number,
      title: `${multiView ? 'Possible person' : 'Candidate'} — Target ${lead.number}`,
      status,
      status_text: STATUS_TEXT[status],
      latitude: +lat.toFixed(7),
      longitude: +lon.toFixed(7),
      uncertainty: { ...ell, method: '95% ellipse from the pose/pixel/terrain error model' },
      first_seen_at: obs[0].at,
      last_seen_at: lastSeen.at,
      last_seen_age_s: Math.max(0, Math.round((nowMs - lastSeen.at_ms) / 1000)),
      views: views.centres.length,
      angle_span_deg: Math.round(views.span),
      view_azimuths_deg: views.centres.map((a) => Math.round(a)),
      sensors,
      observations: obs.length,
      movement,
      missed_looks: lead.missed_looks,
      delayed: { any: obs.some((o) => o.delayed), max_delay_s: Math.max(0, ...obs.map((o) => o.delay_s)) },
      fire_distance_m: fireDist,
      fire_arrival: arrival === undefined ? null : { minutes: arrival, basis: 'spread model projection at the reported conditions; an estimate, not a forecast' },
      priority: { tier, reasons },
      acknowledged: lead.ack,
      closed: lead.closed,
      possibly_same_as: sameAs,
      provenance: obs.at(-1).provenance,
      evidence: obs.slice(-6).reverse().map((o) => ({
        id: o.id, at: o.at, received_at: o.received_at, delayed: o.delayed, delay_s: o.delay_s,
        sensor: o.sensor, detector: o.detector, detector_score: o.detector_score,
        view_az_deg: Math.round(o.view_az_deg), from: compass(o.view_az_deg + 180), range_m: Math.round(o.range_m), depression_deg: Math.round(o.depression_deg),
        individual_95_m: ellipse95(o.cov).major_95_m, crop: o.crop,
        latitude: +o.latitude.toFixed(7), longitude: +o.longitude.toFixed(7),
      })),
      next_look: this.nextLook(lead, ctx),
    };
  }

  coverage() {
    const cells = [];
    let well = 0, partial = 0;
    for (const [key, cell] of this.cells) {
      const [i, j] = key.split(',').map(Number);
      const cls = popcount(cell.bins) >= 2 ? 2 : 1;
      if (cls === 2) well++; else partial++;
      cells.push([i, j, cls]);
    }
    let sector = null;
    if (this.sector && this.ref) {
      const [s, w] = toLocal(this.ref, this.sector[0], this.sector[1]).reverse();
      const [nn, ee] = toLocal(this.ref, this.sector[2], this.sector[3]).reverse();
      let total = 0, sw = 0, sp = 0;
      for (let i = Math.floor(w / this.cellM); i < Math.ceil(ee / this.cellM); i++) {
        for (let j = Math.floor(s / this.cellM); j < Math.ceil(nn / this.cellM); j++) {
          total++;
          const cell = this.cells.get(`${i},${j}`);
          if (!cell) continue;
          if (popcount(cell.bins) >= 2) sw++; else sp++;
        }
      }
      sector = { bounds: this.sector, cells: total, well_pct: pct(sw, total), partial_pct: pct(sp, total), hidden_pct: pct(total - sw - sp, total) };
    }
    return {
      ref: this.ref, cell_m: this.cellM, cells, truncated: this.cellsTruncated,
      well_cells: well, partial_cells: partial, sector,
      legend: { 2: 'well observed: 2+ directions, steep enough to see under canopy edges', 1: 'partly observed: one direction', 0: 'not drawn: not yet observed (hidden)' },
    };
  }

  snapshot(nowMs, ctx = {}) {
    const leads = [...this.leads.values()].filter((l) => l.fused).map((l) => this.summarize(l, nowMs, ctx))
      // Within a tier: whoever the fire reaches first, then nearest the fire, then most recent.
      .sort((a, b) => a.priority.tier - b.priority.tier || arrivalKey(a) - arrivalKey(b) || (a.fire_distance_m ?? 1e9) - (b.fire_distance_m ?? 1e9) || b.last_seen_at.localeCompare(a.last_seen_at));
    return {
      generated_at: new Date(nowMs).toISOString(),
      leads,
      counts: {
        open: leads.filter((l) => !l.closed).length,
        possible_people: leads.filter((l) => l.status === 'possible-person').length,
        unacknowledged: leads.filter((l) => !l.closed && !l.acknowledged).length,
      },
      coverage: this.coverage(),
      error_model: this.errors,
    };
  }

  toJSON() {
    return { v: 1, ref: this.ref, seq: this.seq, leads: [...this.leads.values()], cells: [...this.cells], cellsTruncated: this.cellsTruncated, lastPose: this.lastPose };
  }

  static fromJSON(data, opts) {
    const s = new PersonSearch(opts);
    if (!data || data.v !== 1) return s;
    s.ref = data.ref ?? s.ref; s.seq = data.seq ?? 0; s.lastPose = data.lastPose ?? null; s.cellsTruncated = Boolean(data.cellsTruncated);
    for (const lead of data.leads ?? []) { s.leads.set(lead.id, lead); for (const o of lead.observations) s.obsIndex.set(o.id, lead.id); }
    for (const [k, v] of data.cells ?? []) s.cells.set(k, v);
    return s;
  }
}

const arrivalKey = (l) => l.fire_arrival?.minutes ?? 1e9;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
function fmtSpan(s) { return s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`; }

/** Plain-language lines for the Gemini planner. Never claims a route or area is safe. */
export function describeLeadsForPlan(snapshot) {
  const open = snapshot.leads.filter((l) => !l.closed);
  if (!open.length) return 'Person search: no open rescue leads.';
  return 'Person search rescue leads (positions are 95% ellipses from the error model, not confidence scores): '
    + open.slice(0, 8).map((l) => `${l.title} at ${l.latitude}, ${l.longitude} ±${l.uncertainty.major_95_m} m; ${l.status_text}; movement: ${l.movement.status}; last seen ${l.last_seen_at}${l.acknowledged ? `; acknowledged by ${l.acknowledged.by}` : '; NOT yet acknowledged'}${l.fire_distance_m != null ? `; ${l.fire_distance_m} m from the fire` : ''}${l.fire_arrival?.minutes != null ? `; fire projected to reach it in about ${l.fire_arrival.minutes} min` : ''}.`).join(' ');
}
