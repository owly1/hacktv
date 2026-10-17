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
import { PersonSearch, DEFAULT_ERRORS, toLatLon, toLocal, projectToImage, rayToGround, compass, fireArrival, FIRE_STANDOFF_MIN, FIRE_PATH_MIN } from './people.mjs';

const EM = globalThis.EmberModel;

const RAD = Math.PI / 180;
export const SIM_DURATION_S = 420;
const ALT = 70, PITCH = -55, CRUISE = 9, HFOV = 69, ASPECT = 16 / 9;
const OUTAGE = [140, 205];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/* Ground truth, metres east/north of the sim origin. Never shown as truth on the dashboard. */
const TARGETS = [
  { id: 'injured', kind: 'person', pos: () => [70, -45], hidden: [[0, 80]], thermal: 0.85, visible: 0.35 },
  { id: 'walker', kind: 'person', pos: (t) => { const k = Math.min(1, t * 1.1 / 240); return [-150 + 130 * k, 90 - 200 * k]; }, hidden: [], thermal: 0.8, visible: 0.5 },
  // A sun-heated rock: hot only on its south-west face, and the hot spot sits on a slope, so its
  // apparent ground position shifts with the viewing angle (it fails multi-view agreement).
  { id: 'hot-rock', kind: 'false', pos: () => [95, -10], seenFrom: [195, 255], thermal: 0.9, visible: 0, parallax: 7 },
];
const FIRE = [175, 95];
/* The simulated fire, as a detection would report it: spreading toward the south-west. */
export const SIM_FIRE_DETAILS = Object.freeze({
  name: 'Ravine fire (simulated)', area_ha: 0.8, intensity: 'high', spread_m_per_min: 4,
  fuel: 'mixed forest and brush', wind_kmh: 24, wind_dir_deg: 225, temp_c: 28, rh_pct: 35,
});
const SECTOR = [-230, 230, -170, 170];        // west, east, south, north (metres)
const LEG_SPACING = 75;
const STANDOFF_M = 60;                        // beyond the fire's edge, whatever the wind

export class PersonSearchSim {
  constructor({ site, startMs, seed = 17 }) {
    this.site = site;
    this.origin = { lat: site.latitude - 0.0012, lon: site.longitude + 0.0018 };
    this.startMs = startMs;
    this.r = rng(seed);
    const [sw, ne] = [toLatLon(this.origin, -230, -170), toLatLon(this.origin, 230, 170)];
    this.search = new PersonSearch({ hfovDeg: HFOV, aspect: ASPECT, cellM: 6, sector: [sw[0], sw[1], ne[0], ne[1]], cruiseMps: CRUISE });
    this.t = -1;
    const [flat, flon] = this.ll(...FIRE);
    this.spread = { origin: [flat, flon], scenario: EM.scenarioFrom(SIM_FIRE_DETAILS), details: SIM_FIRE_DETAILS };
    this.fireEdge = EM.footprint(this.spread.origin, 0, this.spread.scenario, SIM_FIRE_DETAILS)
      .filter((_, i) => i % 6 === 0).map(([la, lo]) => toLocal(this.origin, la, lo));
    this.fireEdge.push([...FIRE]);
    this.pos = [-215, 155]; this.heading = 135; this.pitch = PITCH;   // launch point: upwind flank, north-west corner
    this.legs = this.planSurvey();
    this.waypoints = this.legs.flatMap((l) => [l.a, l.b]);
    this.wp = 0; this.mode = 'survey'; this.revisit = null; this.revisited = new Map();
    this.queue = []; this.log = []; this.track = []; this.lastSeen = new Map();
    const first = this.legs.find((l) => l.arrival != null);
    this.say(0, `Survey planned around the fire: ${this.legs.length} legs across the wind at 70 m, ground the fire reaches soonest first${first ? ` (first leg: about ${first.arrival} min ahead of the front)` : ''}. Nothing within ${FIRE_STANDOFF_MIN} min of the front.`);
  }

  /** Minutes until the projected fire reaches local point (e, n); null if not within 3 h. */
  arrivalAt(e, n) { return fireArrival(this.spread, ...this.ll(e, n)); }

  /** Too close to fly: within the standoff of the fire, or ground it reaches within 10 minutes. */
  excluded(e, n) {
    if (Math.hypot(e - FIRE[0], n - FIRE[1]) < EM.startRadius(SIM_FIRE_DETAILS) + STANDOFF_M) return true;
    const a = this.arrivalAt(e, n);
    return a != null && a < FIRE_STANDOFF_MIN;
  }

  /**
   * Survey legs across the wind, clipped to the sector and to the standoff,
   * ordered by projected fire arrival (soonest first); ground the fire does not
   * reach within 3 h comes last, nearest the fire first.
   */
  planSurvey() {
    const th = SIM_FIRE_DETAILS.wind_dir_deg * RAD;
    const d = [Math.sin(th), Math.cos(th)], p = [d[1], -d[0]];
    const [W, E, S, N] = SECTOR.map((v) => v - Math.sign(v) * 15);
    const legs = [];
    for (let u = -500; u <= 700; u += LEG_SPACING) {
      const base = [FIRE[0] + u * d[0], FIRE[1] + u * d[1]];
      let vmin = -Infinity, vmax = Infinity;
      for (const [k, lo, hi] of [[0, W, E], [1, S, N]]) {
        if (Math.abs(p[k]) < 1e-9) { if (base[k] < lo || base[k] > hi) vmax = -Infinity; continue; }
        let a = (lo - base[k]) / p[k], b = (hi - base[k]) / p[k];
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
    // Fly each leg from whichever end is nearer the previous one.
    let at = this.pos;
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

  context() { return { fire: this.fireLL(), spread: this.spread }; }

  say(t, text) { this.log.push({ at: new Date(this.startMs + t * 1000).toISOString(), t, text }); }
  ll(e, n) { return toLatLon(this.origin, e, n); }

  advanceTo(tTarget) {
    const until = Math.min(Math.floor(tTarget), SIM_DURATION_S);
    while (this.t < until) this.step(++this.t);
  }

  fly(target, t) {
    const dx = target[0] - this.pos[0], dy = target[1] - this.pos[1], d = Math.hypot(dx, dy);
    if (d > 0.5) this.heading = (Math.atan2(dx, dy) / RAD + 360) % 360;
    if (d <= CRUISE) { this.pos = [...target]; return true; }
    this.pos = [this.pos[0] + dx / d * CRUISE, this.pos[1] + dy / d * CRUISE];
    return false;
  }

  step(t) {
    const nowMs = this.startMs + t * 1000;
    const linkUp = t < OUTAGE[0] || t >= OUTAGE[1];
    if (t === OUTAGE[0]) this.say(t, 'Radio link lost — the aircraft keeps searching and stores observations on board.');
    if (t === OUTAGE[1]) { this.say(t, `Link restored — ${this.queue.length} stored observation${this.queue.length === 1 ? '' : 's'} delivered, marked delayed.`); }

    // ---- mission: survey, propose, revisit, resolve, report, continue
    if (this.mode === 'survey') {
      const lead = linkUp && this.pickRevisit();
      if (lead) {
        this.mode = 'revisit'; this.revisit = { id: lead.id, look: lead.next_look, hold: 0 };
        this.revisited.set(lead.id, (this.revisited.get(lead.id) ?? 0) + 1);
        this.say(t, `Proposed: ${lead.next_look.kind === 'recheck' ? 're-check' : 'revisit'} Target ${lead.number} from the ${lead.next_look.from} (${lead.next_look.flight_s} s away). Survey paused.`);
      } else if (this.wp < this.waypoints.length) {
        this.pitch = PITCH;
        if (this.fly(this.waypoints[this.wp], t)) {
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
      if (this.fly([e, n], t)) {
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
    for (const tg of TARGETS) {
      if (t - (this.lastSeen.get(tg.id) ?? -99) < 2) continue;
      let [te, tn] = tg.pos(t);
      const lookAz = (Math.atan2(te - this.pos[0], tn - this.pos[1]) / RAD + 360) % 360;
      const from = (lookAz + 180) % 360;
      if (tg.hidden?.some(([a, b]) => from >= a && from < b)) continue;
      if (tg.seenFrom && !(from >= tg.seenFrom[0] && from < tg.seenFrom[1])) continue;
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

  deliver(obs, receivedMs, t) {
    let res;
    try { res = this.search.addObservation(obs, receivedMs); } catch { return; }
    if (res.new_lead) this.say(t, `New candidate: Target ${res.lead.number} (${obs.sensor}). Seen from one direction — another angle requested.`);
    else if (!res.duplicate) {
      const s = this.search.summarize(res.lead, receivedMs, this.context());
      if (s.status === 'possible-person' && !res.lead.announced) { res.lead.announced = true; this.say(t, `Target ${s.number} seen from ${s.views} angles at the same spot — now a possible person. Alert sent to responders.`); }
    }
  }

  pickRevisit() {
    const snap = this.search.snapshot(this.startMs + this.t * 1000, this.context());
    return snap.leads.find((l) => l.status === 'needs-another-view' && l.next_look && (this.revisited.get(l.id) ?? 0) < 2 && l.last_seen_age_s >= 4)
      ?? snap.leads.find((l) => l.status === 'possible-person' && l.next_look?.kind === 'recheck' && (this.revisited.get(l.id) ?? 0) < 3);
  }

  fireLL() { const [lat, lon] = this.ll(...FIRE); return { latitude: lat, longitude: lon }; }

  snapshot() {
    const nowMs = this.startMs + Math.max(0, this.t) * 1000;
    const fire = this.fireLL();
    const [lat, lon] = this.ll(...this.pos);
    return {
      simulated: true, t: this.t, duration_s: SIM_DURATION_S,
      ...this.search.snapshot(nowMs, this.context()),
      fire,
      fire_model: { origin: this.spread.origin, scenario: this.spread.scenario, details: SIM_FIRE_DETAILS },
      drone: { latitude: lat, longitude: lon, altitude_m: ALT, heading_deg: Math.round(this.heading), gimbal_pitch_deg: this.pitch },
      track: this.track,
      mission: { mode: this.mode, revisit: this.revisit?.id ?? null, link: this.t >= OUTAGE[0] && this.t < OUTAGE[1] ? 'down' : 'up', stored: this.queue.length, log: this.log.slice(-14).reverse(), heading_text: compass(this.heading) },
    };
  }
}
