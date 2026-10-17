import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  PersonSearch, geolocate, rayToGround, projectToImage, ellipse95, validatePersonObservation, toLocal, toLatLon,
} from '../backend/people.mjs';
import { PersonSearchSim, SIM_DURATION_S } from '../backend/people-sim.mjs';
import { createApp, MemoryStorage, findUnsafeWording } from '../backend/server.mjs';

const REF = { lat: 43.78, lon: -79.19 };
const T0 = Date.parse('2026-10-17T12:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const CAM = { hfov_deg: 69, vfov_deg: 2 * Math.atan(Math.tan(34.5 * Math.PI / 180) / (16 / 9)) * 180 / Math.PI };

/** An observation of ground point (e, n) from a drone at (de, dn), aimed straight at it. */
function obsOf(e, n, { de, dn, alt = 60, t = 0, sensor = 'thermal', id, track } = {}) {
  const heading = (Math.atan2(e - de, n - dn) * 180 / Math.PI + 360) % 360;
  const pitch = -Math.atan2(alt, Math.hypot(e - de, n - dn)) * 180 / Math.PI;
  const [lat, lon] = toLatLon(REF, de, dn);
  return {
    obs_id: id ?? null, observed_at: at(t), provenance: 'live', sensor, label: 'person', detector: 'test', detector_score: null,
    track_id: track ?? null, bbox: [0.495, 0.49, 0.505, 0.51],
    drone: { latitude: lat, longitude: lon, altitude_m: alt, heading_deg: heading, gimbal_pitch_deg: pitch, position_source: 'gps' },
    camera: CAM, terrain_m: null,
  };
}

test('a straight-down detection lands under the drone with GPS-sized uncertainty', () => {
  const g = geolocate(obsOf(0, 0.001, { de: 0, dn: 0, alt: 50 }));
  const [e, n] = toLocal(REF, g.latitude, g.longitude);
  assert.ok(Math.hypot(e, n) < 0.5);
  const ell = ellipse95(g.cov);
  assert.ok(ell.major_95_m > 5 && ell.major_95_m < 12, `major ${ell.major_95_m}`);
});

test('an oblique ray meets the ground at altitude / tan(depression), and projectToImage inverts it', () => {
  const g = rayToGround({ alt: 50, heading: 90, pitch: -45, u: 0.5, v: 0.5, hfov: 69, vfov: 41 });
  assert.ok(Math.abs(g.e - 50) < 1e-6 && Math.abs(g.n) < 1e-6);
  const img = projectToImage({ alt: 50, heading: 90, pitch: -45, hfov: 69, vfov: 41 }, 60, 10);
  const back = rayToGround({ alt: 50, heading: 90, pitch: -45, u: img.u, v: img.v, hfov: 69, vfov: 41 });
  assert.ok(Math.hypot(back.e - 60, back.n - 10) < 0.5);
  assert.equal(rayToGround({ alt: 50, heading: 0, pitch: 0, u: 0.5, v: 0.4, hfov: 69, vfov: 41 }), null, 'above the horizon');
});

test('uncertainty grows with range: oblique looks are less precise than steep ones', () => {
  const steep = ellipse95(geolocate(obsOf(0, 30, { de: 0, dn: 0 })).cov).major_95_m;
  const shallow = ellipse95(geolocate(obsOf(0, 300, { de: 0, dn: 0 })).cov).major_95_m;
  assert.ok(shallow > 3 * steep, `${steep} vs ${shallow}`);
});

test('two agreeing views from different angles make a possible person with a tighter location', () => {
  const s = new PersonSearch();
  const a = s.addObservation(obsOf(100, 100, { de: 100, dn: 40, t: 0 }), T0);
  const single = s.summarize(a.lead, T0);
  assert.equal(single.status, 'needs-another-view');
  assert.match(single.title, /^Candidate — Target 1/);
  assert.equal(single.next_look.adds_new_angle, true);
  const b = s.addObservation(obsOf(100.5, 100, { de: 40, dn: 100, t: 20 }), T0 + 20_000);
  assert.equal(b.lead, a.lead, 'associated with the same lead');
  const both = s.summarize(b.lead, T0 + 20_000);
  assert.equal(both.status, 'possible-person');
  assert.equal(both.views, 2);
  assert.ok(both.uncertainty.major_95_m < single.uncertainty.major_95_m);
  assert.ok(!JSON.stringify(both).match(/confidence/i), 'no confidence fields on a lead');
});

test('detections that disagree between angles stay separate one-view candidates (hot rock, reflection)', () => {
  const s = new PersonSearch();
  s.addObservation(obsOf(100, 100, { de: 100, dn: 40, t: 0 }), T0);
  s.addObservation(obsOf(135, 100, { de: 40, dn: 100, t: 5 }), T0 + 5_000);
  const snap = s.snapshot(T0 + 5_000);
  assert.equal(snap.leads.length, 2);
  assert.ok(snap.leads.every((l) => l.status === 'needs-another-view'));
});

test('repeat obs_id is idempotent; late arrivals are marked delayed', () => {
  const s = new PersonSearch();
  const first = s.addObservation(obsOf(0, 50, { de: 0, dn: 0, id: 'obs-1' }), T0 + 60_000);
  assert.equal(first.observation.delayed, true);
  assert.equal(s.addObservation(obsOf(0, 50, { de: 0, dn: 0, id: 'obs-1' }), T0 + 61_000).duplicate, true);
  assert.equal(s.snapshot(T0 + 61_000).leads[0].delayed.max_delay_s, 60);
});

test('looking again without a detection turns a candidate into "not re-seen", never into a dismissal', () => {
  const s = new PersonSearch();
  const [lat, lon] = toLatLon(REF, 0, 0);
  s.addObservation(obsOf(0, 60, { de: 0, dn: 0 }), T0);
  for (let k = 1; k <= 4; k++) s.observePose({ latitude: lat, longitude: lon, altitude_m: 60, heading_deg: 0, gimbal_pitch_deg: -45 }, T0 + 10_000 * k);
  const lead = s.snapshot(T0 + 40_000).leads[0];
  assert.equal(lead.status, 'not-re-seen');
  assert.equal(lead.closed, null);
  assert.ok(s.coverage().cells.length > 0);
});

test('stationary is claimed only after a long enough window', () => {
  const s = new PersonSearch();
  s.addObservation(obsOf(0, 60, { de: 0, dn: 0, t: 0 }), T0);
  s.addObservation(obsOf(0, 60, { de: 60, dn: 60, t: 30 }), T0 + 30_000);
  assert.equal(s.snapshot(T0 + 30_000).leads[0].movement.status, 'unknown');
  s.addObservation(obsOf(0, 60, { de: -60, dn: 60, t: 90 }), T0 + 90_000);
  const lead = s.snapshot(T0 + 90_000).leads[0];
  assert.equal(lead.movement.status, 'stationary');
  assert.equal(lead.priority.tier, 1);
});

test('a responder must name themselves to acknowledge or close a lead', () => {
  const s = new PersonSearch();
  const { lead } = s.addObservation(obsOf(0, 60, { de: 0, dn: 0 }), T0);
  assert.throws(() => s.acknowledge(lead.id, { by: '' }, T0), /by/);
  s.acknowledge(lead.id, { by: 'Crew 4' }, T0);
  assert.throws(() => s.close(lead.id, { by: 'Crew 4', outcome: 'safe' }, T0), /outcome/);
  s.close(lead.id, { by: 'Crew 4', outcome: 'found' }, T0);
  assert.equal(s.snapshot(T0).leads[0].status, 'closed');
});

test('validation: live provenance only, a full pose, 6 h store-and-forward window', () => {
  const body = { ...obsOf(0, 60, { de: 0, dn: 0 }) };
  assert.ok(validatePersonObservation(body, T0).obs);
  assert.throws(() => validatePersonObservation({ ...body, provenance: 'simulated' }, T0), /provenance/);
  assert.throws(() => validatePersonObservation({ ...body, drone: { ...body.drone, heading_deg: undefined } }, T0), /heading/);
  assert.ok(validatePersonObservation(body, T0 + 3600_000).obs, 'one hour late is accepted');
  assert.throws(() => validatePersonObservation(body, T0 + 7 * 3600_000), /6 h/);
});

test('plans that call a route safe are flagged', () => {
  assert.deepEqual(findUnsafeWording({ actions: [{ action: 'Use the safe route along Ellesmere' }] }), ['safe route']);
  assert.deepEqual(findUnsafeWording({ situation: 'The north road is clear.' }), ['road is clear']);
  assert.deepEqual(findUnsafeWording({ objectives: ['Establish pre-cleared ingress/evacuation corridors'] }), ['pre-cleared ingress/evacuation corridors']);
  assert.deepEqual(findUnsafeWording({ situation: 'Hazards observed on the north road at 12:04.' }), []);
  assert.deepEqual(findUnsafeWording({ situation: 'Clear the area of spectators. A clear view of the ridge.' }), []);
});

test('the simulated search confirms people from several angles and does not confirm the hot rock', () => {
  const sim = new PersonSearchSim({ site: { latitude: 43.7866, longitude: -79.1903 }, startMs: T0 });
  sim.advanceTo(SIM_DURATION_S);
  const snap = sim.snapshot();
  assert.equal(snap.simulated, true);
  const confirmed = snap.leads.filter((l) => l.views >= 2);
  assert.ok(confirmed.length >= 2);
  assert.ok(snap.leads.some((l) => l.views === 1), 'the hot rock stays a one-angle candidate');
  assert.ok(snap.leads.some((l) => l.delayed.any), 'outage produced delayed alerts');
  assert.ok(snap.coverage.sector.well_pct > 30);
  assert.ok(snap.mission.log.length > 5);
});

// ------------------------------------------------------------------ HTTP

const INGEST = 'ingest-token-aaa', DASH = 'dashboard-token-bbb', ORIGIN = 'http://127.0.0.1:8787';
function listen(app) {
  return new Promise((resolve) => { const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv)); });
}
async function call(base, path, { method = 'GET', token = DASH, body } = {}) {
  const res = await fetch(base + path, { method, headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

test('person ingest, lead listing, acknowledgement and the demo endpoint over HTTP', async () => {
  const nowMs = Date.now();
  const srv = await listen(createApp({ ingestToken: INGEST, dashboardToken: DASH, allowedOrigins: [ORIGIN], storage: new MemoryStorage(), now: () => nowMs }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const obs = { ...obsOf(0, 60, { de: 0, dn: 0 }), observed_at: new Date(nowMs - 1000).toISOString() };
    assert.equal((await call(base, '/api/ingest/person', { method: 'POST', token: DASH, body: obs })).status, 401);
    const r = await call(base, '/api/ingest/person', { method: 'POST', token: INGEST, body: obs });
    assert.equal(r.status, 200);
    assert.equal(r.body.new_lead, true);
    const list = await call(base, '/api/people');
    assert.equal(list.body.leads.length, 1);
    assert.equal(list.body.leads[0].acknowledged, null);
    assert.equal((await call(base, '/api/people/ack', { method: 'POST', body: { lead_id: r.body.lead_id } })).status, 400);
    const ack = await call(base, '/api/people/ack', { method: 'POST', body: { lead_id: r.body.lead_id, by: 'Sector B lead' } });
    assert.equal(ack.body.lead.acknowledged.by, 'Sector B lead');
    const status = await call(base, '/api/status');
    assert.equal(status.body.people.open_leads, 1);
    const demo = await call(base, '/api/demo/people?t=120');
    assert.equal(demo.body.simulated, true);
    assert.ok(demo.body.leads.length >= 1);
  } finally {
    srv.close();
  }
});
