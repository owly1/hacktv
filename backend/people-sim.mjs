/* Simulated person search for demo mode. Deterministic (seeded), and labelled
 * "simulated" everywhere. It drives the real PersonSearch pipeline: the drone
 * surveys, the planner proposes a revisit for every one-angle candidate, the
 * drone flies it, and observations pass through the same geolocation, error
 * model and fusion as live ones. Includes a radio outage so delayed
 * (store-and-forward) alerts can be seen.
 *
 * The survey is planned around the fire: legs run across the wind, ordered by
 * how soon the projected fire reaches the ground under them (people there have
 * the least time), and nothing is flown over ground the fire reaches within
 * 10 minutes or closer than a fixed standoff from it.
 */
import { PersonSearch, DEFAULT_ERRORS, toLatLon, toLocal, projectToImage, rayToGround, compass, fireArrival, FIRE_STANDOFF_MIN, FIRE_PATH_MIN, FIRE_STANDOFF_M } from './people.mjs';

const EM = globalThis.EmberModel;

const RAD = Math.PI / 180;
export const SIM_DURATION_S = 560;
const ALT = 70, PITCH = -55, CRUISE = 9, HFOV = 69, ASPECT = 16 / 9;
const OUTAGE = [200, 265];
const HALF = 270;                             // the assigned sector: a square this far either side of its centre
const FIRE_BACK = 130;                        // the fire sits this far upwind of the sector centre
const LEG_SPACING = 75;
const STANDOFF_M = FIRE_STANDOFF_M;
const ORBIT_POINTS = 16;

/** Return a deterministic uniform random generator from the scenario seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Draw a standard normal sample from the supplied seeded random generator. */
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
/** Normalize a bearing to the 0–360 degree range. */
const wrap = (a) => ((a % 360) + 360) % 360;
/** Test whether a bearing lies in a wrapped visibility arc. */
const inArc = (deg, [a, b]) => { const x = wrap(deg - a), w = wrap(b - a); return x < w; };

/* Ground truth in the fire's wind frame: u metres downwind of the fire, v metres across
   (to the right of the wind). Directions are relative to the wind. Never shown as truth. */
const TARGETS = [
  // Trapped at the fire's flank: the reason the search starts at the fire.
  { id: 'trapped', /* Return the target's downwind position in metres at simulated time. */ u: () => 18, /* Return the target's crosswind position in metres at simulated time. */ v: () => 40, hiddenRel: [], thermal: 0.6, visible: 0.3 },   // inside the fire's edge
  { id: 'injured', /* Return the target's downwind position in metres at simulated time. */ u: () => 175, /* Return the target's crosswind position in metres at simulated time. */ v: () => -20, hiddenRel: [[135, 215]], thermal: 0.85, visible: 0.35 },
  { id: 'walker', /* Return the target's downwind position in metres at simulated time. */ u: (t) => 230 + 55 * Math.min(1, t * 1.1 / 240), /* Return the target's crosswind position in metres at simulated time. */ v: (t) => 185 - 190 * Math.min(1, t * 1.1 / 240), hiddenRel: [], thermal: 0.8, visible: 0.5 },
  // A sun-heated rock: hot only on its downwind face, and the hot spot sits on a slope, so its
  // apparent ground position shifts with the viewing angle (it fails multi-view agreement).
  { id: 'hot-rock', /* Return the target's downwind position in metres at simulated time. */ u: () => 131, /* Return the target's crosswind position in metres at simulated time. */ v: () => -18, seenFromRel: [-12, 12], thermal: 0.9, visible: 0, parallax: 7 },
];

/* The UTSC scenario: a small ravine fire near the Sam Ibrahim Building, spreading south-west. */
export const SIM_FIRE_DETAILS = Object.freeze({
  name: 'Ravine fire (simulated)', area_ha: 0.8, intensity: 'high', spread_m_per_min: 4,
  fuel: 'mixed forest and brush', wind_kmh: 24, wind_dir_deg: 225, temp_c: 28, rh_pct: 35,
});

/**
 * A simulated search at one of the project's historical fires: its real ignition point,
 * spread direction and recorded weather. The fire is simulated at its first minutes, and
 * its spread speed is scaled down so the front stays within a drone-sized search area.
 */
export function scenarioFromExample(f) {
  const d = f.drivers ?? {};
  const base = { wind_kmh: d.windKmh ?? 30, wind_dir_deg: f.directionDeg, temp_c: d.tempC ?? 25, rh_pct: d.rhPct ?? 20 };
  const recorded = EM.spreadRate(EM.scenarioFrom(base), null);
  return {
    id: f.id, name: f.name, latitude: f.lat, longitude: f.lon,
    note: `Recorded location, wind (${base.wind_kmh} km/h toward ${compass(f.directionDeg)}) and weather; spread speed scaled to a drone-sized search area.`,
    details: Object.freeze({
      name: `${f.name}: ignition area (simulated)`, area_ha: 0.8, intensity: 'extreme',
      spread_m_per_min: Math.round(Math.min(6, Math.max(3, recorded / 8)) * 2) / 2,
      fuel: d.fuel ?? null, ...base,
    }),
  };
}

export class PersonSearchSim {
  /**
   * @param {object} opts
   * @param {object} opts.site       { latitude, longitude } for the UTSC scenario
   * @param {object} [opts.scenario] a scenarioFromExample() result; UTSC when omitted
   */
  constructor({ site, startMs, seed = 17, scenario = null }) {
    this.site = site;
    this.scenario = scenario ?? { id: 'utsc', name: 'UTSC · Highland Creek ravine', latitude: null, longitude: null, note: 'Simulated fire near the Sam Ibrahim Building.', details: SIM_FIRE_DETAILS };
    this.details = this.scenario.details;
    const th = this.details.wind_dir_deg * RAD;
    this.d = [Math.sin(th), Math.cos(th)];          // downwind
    this.p = [this.d[1], -this.d[0]];               // across the wind
    this.F = [-this.d[0] * FIRE_BACK, -this.d[1] * FIRE_BACK];
    // Local frame origin = sector centre; the fire sits FIRE_BACK upwind of it.
    if (this.scenario.latitude != null) {
      const [la, lo] = EM.destPoint(this.scenario.latitude, this.scenario.longitude, this.details.wind_dir_deg, FIRE_BACK);
      this.origin = { lat: la, lon: lo };
    } else {
      this.origin = { lat: site.latitude - 0.0012, lon: site.longitude + 0.0018 };
    }
    this.startMs = startMs;
    this.r = rng(seed);
    const [sw, ne] = [toLatLon(this.origin, -HALF, -HALF), toLatLon(this.origin, HALF, HALF)];
    this.search = new PersonSearch({ hfovDeg: HFOV, aspect: ASPECT, cellM: 6, sector: [sw[0], sw[1], ne[0], ne[1]], cruiseMps: CRUISE });
    this.t = -1;
    const [flat, flon] = this.ll(...this.F);
    this.spread = { origin: [flat, flon], scenario: EM.scenarioFrom(this.details), details: this.details };
    this.fireEdge = EM.footprint(this.spread.origin, 0, this.spread.scenario, this.details)
      .filter((_, i) => i % 6 === 0).map(([la, lo]) => toLocal(this.origin, la, lo));
    this.fireEdge.push([...this.F]);
    this.pos = this.launchPoint(); this.heading = 0; this.pitch = PITCH;
    this.orbit = this.planOrbit();
    this.legs = this.planSurvey(this.orbit.at(-1));
    this.waypoints = this.legs.flatMap((l) => [l.a, l.b]);
    this.ow = 0; this.wp = 0; this.phase = 'orbit'; this.mode = 'survey'; this.revisit = null; this.revisited = new Map();
    this.queue = []; this.log = []; this.track = []; this.lastSeen = new Map();
    this.say(0, `Searching the fire first: circling it about ${Math.round(this.orbitRadius)} m out, outside the standoff, with the camera on its edge. Then its path: ${this.legs.length} legs across the wind, soonest-reached first.`);
  }

  /** Local point from wind-frame (u downwind of the fire, v across). */
  wf(u, v) { return [this.F[0] + u * this.d[0] + v * this.p[0], this.F[1] + u * this.d[1] + v * this.p[1]]; }

  /** Take off from the sector corner nearest the fire that is clear of it. */
  launchPoint() {
    const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([a, b]) => [a * (HALF - 15), b * (HALF - 15)]).filter((c) => !this.excluded(...c));
    corners.sort((a, b) => Math.hypot(a[0] - this.F[0], a[1] - this.F[1]) - Math.hypot(b[0] - this.F[0], b[1] - this.F[1]));
    return [...corners[0]];
  }

  /** A full circle round the fire, pushed out wherever the standoff or the 10-minute front reaches further. */
  planOrbit() {
    const base = EM.startRadius(this.details) + STANDOFF_M;
    const start = Math.atan2(this.pos[0] - this.F[0], this.pos[1] - this.F[1]);
    const pts = [];
    let maxR = 0;
    for (let k = 0; k <= ORBIT_POINTS; k++) {
      const a = start + (k / ORBIT_POINTS) * 2 * Math.PI;
      let r = base;
      /** Convert an orbit angle into a waypoint around the simulated fire. */
      const at = (rr) => [this.F[0] + rr * Math.sin(a), this.F[1] + rr * Math.cos(a)];
      // Clear of the fire, and so is the straight hop from the previous orbit point.
      while ((this.excluded(...at(r)) || (pts.length && !this.clear(pts.at(-1), at(r)))) && r < 400) r += 5;
      r += 5;
      maxR = Math.max(maxR, r);
      pts.push([this.F[0] + r * Math.sin(a), this.F[1] + r * Math.cos(a)]);
    }
    this.orbitRadius = base + 5;
    this.safeRadius = maxR + 10;   // the circle the drone uses to go round the fire
    return pts;
  }

  /** Minutes until the projected fire reaches local point (e, n); null if not within 3 h. */
  arrivalAt(e, n) { return fireArrival(this.spread, ...this.ll(e, n)); }

  /** Too close to fly: within the standoff of the fire, or ground it reaches within 10 minutes. */
  excluded(e, n) {
    if (Math.hypot(e - this.F[0], n - this.F[1]) < EM.startRadius(this.details) + STANDOFF_M) return true;
    if (!this.spread) return false;
    const a = this.arrivalAt(e, n);
    return a != null && a < FIRE_STANDOFF_MIN;
  }

  /**
   * After the fire itself: legs across the wind, clipped to the sector and the standoff,
   * ordered by projected fire arrival (soonest first); ground the fire does not reach
   * within 3 h comes last, nearest the fire first.
   */
  planSurvey(from) {
    const { d, p } = this;
    const lim = HALF - 15;
    const legs = [];
    for (let u = -600; u <= 800; u += LEG_SPACING) {
      const base = [this.F[0] + u * d[0], this.F[1] + u * d[1]];
      let vmin = -Infinity, vmax = Infinity;
      for (const k of [0, 1]) {
        if (Math.abs(p[k]) < 1e-9) { if (Math.abs(base[k]) > lim) vmax = -Infinity; continue; }
        let a = (-lim - base[k]) / p[k], b = (lim - base[k]) / p[k];
        if (a > b) [a, b] = [b, a];
        vmin = Math.max(vmin, a); vmax = Math.min(vmax, b);
      }
      if (!(vmax - vmin >= 40)) continue;
      // The longest stretch of this line that stays clear of the fire.
      let best = [], run = [];
      for (let v = vmin; v <= vmax + 1e-6; v += 10) {
        const pt = [base[0] + v * p[0], base[1] + v * p[1]];
        if (this.excluded(...pt)) { run = []; continue; }
        run.push(pt);
        if (run.length > best.length) best = [...run];
      }
      if (best.length < 5) continue;
      const arrivals = best.map((pt) => this.arrivalAt(...pt)).filter((a) => a != null);
      legs.push({ u, a: best[0], b: best.at(-1), arrival: arrivals.length ? Math.min(...arrivals) : null });
    }
    legs.sort((x, y) => (x.arrival ?? 1e9) - (y.arrival ?? 1e9) || Math.abs(x.u) - Math.abs(y.u));
    let at = from;
    for (const leg of legs) {
      if (Math.hypot(leg.b[0] - at[0], leg.b[1] - at[1]) < Math.hypot(leg.a[0] - at[0], leg.a[1] - at[1])) [leg.a, leg.b] = [leg.b, leg.a];
      at = leg.b;
    }
    return legs;
  }

  /** What the camera was doing at this point of the trail. */
  trailClass(cam) {
    if (this.fireEdge.some(([e, n]) => projectToImage(cam, e - this.pos[0], n - this.pos[1]))) return 'fire';
    const g = rayToGround({ ...cam, u: 0.5, v: 0.5 });
    if (!g) return 'other';
    const a = this.arrivalAt(this.pos[0] + g.e, this.pos[1] + g.n);
    return a != null && a <= FIRE_PATH_MIN ? 'path' : 'other';
  }

  /** Return the fire/spread context used to rank simulated rescue leads. */
  context() { return { fire: this.fireLL(), spread: this.spread }; }

  /** Append a timestamped mission-log event using the simulation clock. */
  say(t, text) { this.log.push({ at: new Date(this.startMs + t * 1000).toISOString(), t, text }); }
  /** Convert local east/north metres to scenario latitude/longitude. */
  ll(e, n) { return toLatLon(this.origin, e, n); }

  /** Advance deterministic one-second steps up to the requested simulation time. */
  advanceTo(tTarget) {
    const until = Math.min(Math.floor(tTarget), SIM_DURATION_S);
    while (this.t < until) this.step(++this.t);
  }

  /** Is the straight line from a to b clear of the fire? */
  clear(a, b) {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8);
    for (let i = 1; i < n; i++) if (this.excluded(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)) return false;
    return true;
  }

  /**
   * Fly toward target, going round the fire when the straight line would cross it:
   * out to a safe circle, along it the short way, then in to the target.
   */
  goTo(target, t) {
    const key = `${target[0].toFixed(1)},${target[1].toFixed(1)}`;
    if (this.routeKey !== key) {
      this.routeKey = key;
      this.route = [];
      if (!this.clear(this.pos, target)) {
        const R = this.safeRadius;
        /** Calculate a waypoint's angle about the simulated fire for a detour. */
        const ang = (q) => Math.atan2(q[0] - this.F[0], q[1] - this.F[1]);
        let a0 = ang(this.pos), a1 = ang(target), da = a1 - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(da) / (20 * RAD)));
        for (let k = 0; k <= steps; k++) {
          const a = a0 + da * k / steps;
          this.route.push([this.F[0] + R * Math.sin(a), this.F[1] + R * Math.cos(a)]);
        }
      }
    }
    while (this.route.length) {
      if (!this.fly(this.route[0], t)) return false;
      this.route.shift();
    }
    return this.fly(target, t);
  }

  /** Move the simulated drone toward a waypoint at its bounded cruise speed. */
  fly(target, t) {
    const dx = target[0] - this.pos[0], dy = target[1] - this.pos[1], d = Math.hypot(dx, dy);
    if (d > 0.5) this.heading = (Math.atan2(dx, dy) / RAD + 360) % 360;
    if (d <= CRUISE) { this.pos = [...target]; return true; }
    this.pos = [this.pos[0] + dx / d * CRUISE, this.pos[1] + dy / d * CRUISE];
    return false;
  }

  /** Advance the simulated mission, sensor views, radio outage and revisit decisions. */
  step(t) {
    const nowMs = this.startMs + t * 1000;
    const linkUp = t < OUTAGE[0] || t >= OUTAGE[1];
    if (t === OUTAGE[0]) this.say(t, 'Radio link lost — the aircraft keeps searching and stores observations on board.');
    if (t === OUTAGE[1]) { this.say(t, `Link restored — ${this.queue.length} stored observation${this.queue.length === 1 ? '' : 's'} delivered, marked delayed.`); }

    // ---- mission: survey, propose, revisit, resolve, report, continue
    if (this.mode === 'survey' && this.phase === 'orbit') {
      // First: the fire itself. Circle it outside the standoff, camera on the fire's edge.
      const target = this.orbit[this.ow];
      if ((this.ow === 0 ? this.goTo(target, t) : this.fly(target, t))) this.ow++;
      const dx = this.F[0] - this.pos[0], dy = this.F[1] - this.pos[1];
      if (this.ow > 0) {
        this.heading = wrap(Math.atan2(dx, dy) / RAD);
        this.pitch = -Math.round(Math.atan2(ALT, Math.max(1, Math.hypot(dx, dy) - EM.startRadius(this.details) * 0.5)) / RAD);
      }
      if (this.ow >= this.orbit.length) {
        this.phase = 'legs'; this.pitch = PITCH;
        const first = this.legs.find((l) => l.arrival != null);
        this.say(t, `Fire area searched from all sides. Now its path${first ? `: leg 1 is about ${first.arrival} min ahead of the front` : ''}.`);
      } else if (this.ow === 1 && !this.orbitStarted) {
        this.orbitStarted = true;
        this.say(t, 'At the fire: circling it with the camera on its edge.');
      }
    } else if (this.mode === 'survey') {
      const lead = linkUp && this.pickRevisit();
      if (lead) {
        this.mode = 'revisit'; this.revisit = { id: lead.id, look: lead.next_look, hold: 0 };
        this.revisited.set(lead.id, (this.revisited.get(lead.id) ?? 0) + 1);
        this.say(t, `Proposed: ${lead.next_look.kind === 'recheck' ? 're-check' : 'revisit'} Target ${lead.number} from the ${lead.next_look.from} (${lead.next_look.flight_s} s away). Survey paused.`);
      } else if (this.wp < this.waypoints.length) {
        this.pitch = PITCH;
        if (this.goTo(this.waypoints[this.wp], t)) {
          this.wp++;
          if (this.wp % 2 === 0 && this.wp < this.waypoints.length) {
            const leg = this.legs[this.wp / 2 - 1];
            this.say(t, `Survey leg ${this.wp / 2} of ${this.legs.length} done${leg.arrival != null ? ` — ground the fire reaches in about ${leg.arrival} min` : ' — outside the projected path'}.`);
          }
        }
      } else if (this.mode !== 'done') { this.mode = 'done'; this.say(t, 'Survey complete. Holding; remaining candidates are listed for responders.'); }
    } else if (this.mode === 'revisit') {
      const L = this.revisit.look;
      const [e, n] = toLocal(this.origin, L.latitude, L.longitude);
      if (this.goTo([e, n], t)) {
        this.heading = L.look_heading_deg; this.pitch = L.gimbal_pitch_deg;
        if (++this.revisit.hold >= 6) {
          const lead = this.search.snapshot(nowMs).leads.find((l) => l.id === this.revisit.id);
          this.say(t, lead ? `Resolved look at Target ${lead.number}: ${lead.status_text.toLowerCase()}.` : 'Look complete.');
          this.mode = 'survey'; this.revisit = null;
        }
      }
    }
    const altNow = ALT;
    const [lat, lon] = this.ll(...this.pos);
    const cam = { alt: altNow, heading: this.heading, pitch: this.pitch, hfov: HFOV, vfov: 2 * Math.atan(Math.tan(HFOV * RAD / 2) / ASPECT) / RAD };
    if (t % 2 === 0) this.track.push([+lat.toFixed(7), +lon.toFixed(7), this.trailClass(cam)]);
    if (this.track.length > 400) this.track.shift();
    const pose = { latitude: lat, longitude: lon, altitude_m: altNow, heading_deg: this.heading, gimbal_pitch_deg: this.pitch };
    this.search.observePose(pose, nowMs); // the aircraft logs its own footprints, link or not

    // ---- detections from the true pose; reported with pose errors drawn from the error model
    const wind = this.details.wind_dir_deg;
    for (const tg of TARGETS) {
      if (t - (this.lastSeen.get(tg.id) ?? -99) < 2) continue;
      let [te, tn] = this.wf(tg.u(t), tg.v(t));
      const lookAz = (Math.atan2(te - this.pos[0], tn - this.pos[1]) / RAD + 360) % 360;
      const from = wrap(lookAz + 180 - wind);   // where the drone is, relative to the wind
      if (tg.hiddenRel?.some((arc) => inArc(from, arc))) continue;
      if (tg.seenFromRel && !inArc(from, tg.seenFromRel)) continue;
      if (tg.parallax) { te += tg.parallax * Math.sin(lookAz * RAD); tn += tg.parallax * Math.cos(lookAz * RAD); }
      const img = projectToImage(cam, te - this.pos[0], tn - this.pos[1]);
      if (!img || img.dep < 20) continue;
      const sensor = tg.visible > 0 && this.r() < 0.3 ? 'visible' : 'thermal';
      if (this.r() > (sensor === 'thermal' ? tg.thermal : tg.visible)) continue;
      this.lastSeen.set(tg.id, t);
      const E = DEFAULT_ERRORS;
      const bw = Math.max(0.003, 0.6 / (2 * img.slant * Math.tan(HFOV * RAD / 2))), bh = bw * 1.6;
      const u = img.u + gauss(this.r) * 0.25 * bw, v = img.v + gauss(this.r) * 0.25 * bh;
      const [nlat, nlon] = this.ll(this.pos[0] + gauss(this.r) * E.gps_m, this.pos[1] + gauss(this.r) * E.gps_m);
      const obs = {
        obs_id: `sim-${tg.id}-${t}`, observed_at: new Date(nowMs).toISOString(), provenance: 'simulated',
        sensor, label: 'person', detector: sensor === 'thermal' ? 'sim-thermal-shape' : 'sim-yolo-person', detector_score: null, track_id: null,
        bbox: [u - bw / 2, v - bh / 2, u + bw / 2, v + bh / 2].map((x) => Math.min(1, Math.max(0, x))),
        drone: { latitude: nlat, longitude: nlon, altitude_m: altNow + gauss(this.r) * E.altitude_m, heading_deg: this.heading + gauss(this.r) * E.heading_deg, gimbal_pitch_deg: this.pitch + gauss(this.r) * E.pitch_deg, position_source: 'gps' },
        camera: { hfov_deg: HFOV, vfov_deg: cam.vfov }, terrain_m: null,
      };
      if (linkUp) this.deliver(obs, nowMs, t); else this.queue.push(obs);
    }
    if (t === OUTAGE[1]) { for (const o of this.queue.splice(0)) this.deliver(o, nowMs, t); }
  }

  /** Deliver a simulated person observation through the same search logic as live ingest. */
  deliver(obs, receivedMs, t) {
    let res;
    try { res = this.search.addObservation(obs, receivedMs); } catch { return; }
    if (res.new_lead) this.say(t, `New candidate: Target ${res.lead.number} (${obs.sensor}). Seen from one direction — another angle requested.`);
    else if (!res.duplicate) {
      const s = this.search.summarize(res.lead, receivedMs, this.context());
      if (s.status === 'possible-person' && !res.lead.announced) {
        res.lead.announced = true;
        this.say(t, s.at_fire
          ? `TOP PRIORITY: Target ${s.number} is at the fire and seen from ${s.views} angles — possible person. Alert sent to responders.`
          : `Target ${s.number} seen from ${s.views} angles at the same spot — now a possible person. Alert sent to responders.`);
      }
    }
  }

  /** Choose the next useful candidate viewpoint without entering the modeled fire standoff. */
  pickRevisit() {
    // Leads are already ordered: anyone at the fire's edge first, then by status, then by fire arrival.
    const snap = this.search.snapshot(this.startMs + this.t * 1000, this.context());
    return snap.leads.find((l) => l.status === 'needs-another-view' && l.next_look && (this.revisited.get(l.id) ?? 0) < 2 && l.last_seen_age_s >= 4)
      ?? snap.leads.find((l) => l.status === 'possible-person' && l.next_look?.kind === 'recheck' && (this.revisited.get(l.id) ?? 0) < 3);
  }

  /** Return the simulated fire centre in geographic coordinates. */
  fireLL() { const [lat, lon] = this.ll(...this.F); return { latitude: lat, longitude: lon }; }

  /** Return the labeled simulation state, leads, coverage, drone and mission log. */
  snapshot() {
    const nowMs = this.startMs + Math.max(0, this.t) * 1000;
    const fire = this.fireLL();
    const [lat, lon] = this.ll(...this.pos);
    return {
      simulated: true, t: this.t, duration_s: SIM_DURATION_S,
      scenario: { id: this.scenario.id, name: this.scenario.name, note: this.scenario.note },
      ...this.search.snapshot(nowMs, this.context()),
      fire,
      fire_model: { origin: this.spread.origin, scenario: this.spread.scenario, details: this.details },
      drone: { latitude: lat, longitude: lon, altitude_m: ALT, heading_deg: Math.round(this.heading), gimbal_pitch_deg: this.pitch },
      track: this.track,
      mission: { phase: this.phase, mode: this.mode, revisit: this.revisit?.id ?? null, link: this.t >= OUTAGE[0] && this.t < OUTAGE[1] ? 'down' : 'up', stored: this.queue.length, log: this.log.slice(-14).reverse(), heading_text: compass(this.heading) },
    };
  }
}
