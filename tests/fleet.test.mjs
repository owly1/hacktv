import test from 'node:test';
import assert from 'node:assert/strict';
import '../dist/model.js';
import '../dist/fleet.js';

const F = globalThis.BoscoFleet;
const NOW = Date.parse('2026-01-01T00:00:00Z');

function sample(id, north, east, ageMs = 0, flight_state = 'hovering') {
  return {drone_id: id, north, east, captured_at: NOW - ageMs, flight_state};
}

test('windConsensus: a single drone is a no-op pass-through', () => {
  const r = F.windConsensus([sample('d1', 3, 4)], NOW);
  assert.equal(r.samples, 1);
  assert.deepEqual(r.rejected, []);
  assert.ok(Math.abs(r.speed_kmh - 18) < .05);
  assert.equal(r.toward_deg, 53); // atan2(east 4, north 3)
  assert.equal(r.sigma_dir_deg, 0);
});

test('windConsensus: agreeing drones keep the shared vector', () => {
  const r = F.windConsensus([
    sample('d1', 5, 0), sample('d2', 5.4, .3), sample('d3', 4.8, -.3)], NOW);
  assert.equal(r.samples, 3);
  assert.deepEqual(r.rejected, []);
  assert.ok(r.speed_kmh > 17 && r.speed_kmh < 20);
  assert.ok(r.sigma_dir_deg < 5);
});

test('windConsensus: one contradictory drone is rejected, consensus holds', () => {
  const r = F.windConsensus([
    sample('d1', 5, 0), sample('d2', 5.2, .2), sample('d3', 4.9, -.1),
    sample('eddy', -4, 1)], NOW); // opposite direction: a local eddy or fault
  assert.equal(r.samples, 4);
  assert.deepEqual(r.rejected, ['eddy']);
  assert.ok(Math.abs(r.toward_deg) < 10, `toward ${r.toward_deg}`);
  assert.ok(r.speed_kmh > 17);
});

test('windConsensus: stale estimates weigh less than fresh ones', () => {
  const fresh = F.windConsensus([sample('d1', 10, 0), sample('d2', 4, 0, 0)], NOW);
  const stale = F.windConsensus([sample('d1', 10, 0), sample('d2', 4, 0, 120000)], NOW);
  // Same-direction disagreement on magnitude: a stale 4 m/s pulls the 10 m/s
  // consensus down far less than a fresh one does (fresh mean ≈ 7).
  assert.ok(Math.abs(fresh.vector.north - 7) < .5, `fresh ${fresh.vector.north}`);
  assert.ok(stale.vector.north > 9, `stale ${stale.vector.north}`);
});

test('windConsensus: a uniformly calm field converges to calm with no rejections', () => {
  const r = F.windConsensus([sample('d1', .1, .05), sample('d2', -.1, .02)], NOW);
  assert.ok(r.speed_kmh < 1);
  assert.deepEqual(r.rejected, []);
});

test('windConsensus: two exactly opposed vectors yield no fabricated wind', () => {
  const r = F.windConsensus([sample('d1', 5, 0), sample('d2', -5, 0)], NOW);
  // Cannot converge to a meaningful direction: result is ~0 rather than a lie.
  assert.ok(r.speed_kmh < 1, `speed ${r.speed_kmh}`);
});

test('windConsensus: landed drones do not vote', () => {
  const r = F.windConsensus([
    sample('d1', 5, 0), sample('grounded', -8, -8, 0, 'landed')], NOW);
  assert.ok(Math.abs(r.toward_deg) < 3);
  assert.ok(r.speed_kmh > 17);
});

test('windConsensus: missing or malformed samples return null', () => {
  assert.equal(F.windConsensus([], NOW), null);
  assert.equal(F.windConsensus([{drone_id: 'x', captured_at: NOW}], NOW), null);
});

test('ellipseStations: circle gives compass-spaced stations', () => {
  const st = F.ellipseStations(43.7866, -79.1903, 100, 100, 0, 4);
  assert.equal(st.length, 4);
  for (const s of st) {
    const d = Math.hypot(...F.llDiff([43.7866, -79.1903], s.latlon));
    assert.ok(Math.abs(d - 100) < .5, `radius ${d}`);
  }
});

test('ellipseStations: stations lie on the ellipse at even arc fractions', () => {
  const a = 200, b = 50, rot = 45*Math.PI/180, c = [43.7866, -79.1903];
  const st = F.ellipseStations(c[0], c[1], a, b, 45, 8);
  // Independent quadrature: arc length from E=0 to eccentric anomaly E.
  const arcTo = E => { let s = 0, px = a, py = 0, N = 4000;
    for (let i = 1; i <= N; i++) { const e = E*i/N, x = a*Math.cos(e), y = b*Math.sin(e);
      s += Math.hypot(x - px, y - py); px = x; py = y; } return s; };
  const C = arcTo(2*Math.PI);
  for (let k = 0; k < 8; k++) {
    const [e, n] = st[k].e != null ? [st[k].e, st[k].n] : F.llDiff(c, st[k].latlon);
    const x = e*Math.sin(rot) + n*Math.cos(rot);           // unrotate to frame
    const y = e*Math.cos(rot) - n*Math.sin(rot);
    assert.ok(Math.abs(x*x/(a*a) + y*y/(b*b) - 1) < .02, `off ellipse ${k}`);
    let E = Math.atan2(y/b, x/a); if (E < 0) E += 2*Math.PI; if (E > 2*Math.PI - .02) E = 0;
    assert.ok(Math.abs(arcTo(E)/C - k/8) < .01, `arc fraction ${k}: ${arcTo(E)/C}`);
  }
});

test('contourStations: even spacing on a square and outward margin', () => {
  const sq = [[0, 0], [.0001, 0], [.0001, .0001], [0, .0001]]; // ~11.1 m sides
  const st = F.contourStations(sq, 4);
  assert.equal(st.length, 4);
  const st2 = F.contourStations(sq, 4, 5);
  const c = F.polygonCentroidEN(sq);
  for (let i = 0; i < 4; i++) {
    const d0 = Math.hypot(st[i].e - c[0], st[i].n - c[1]);
    const d1 = Math.hypot(st2[i].e - c[0], st2[i].n - c[1]);
    assert.ok(d1 > d0 + 4, 'margin pushes stations outward');
  }
});

test('hungarian: minimises total assignment cost', () => {
  const cost = [[1, 10, 5], [10, 1, 5], [5, 10, 1]];
  const a = F.hungarian(cost);
  assert.deepEqual(a, [0, 1, 2]);
});

test('assignStations: drones take their nearest stations', () => {
  const stations = [{latlon: [0, 0]}, {latlon: [0, .001]}];
  const drones = [[0, .0009], [0, .0001]];
  assert.deepEqual(F.assignStations(drones, stations), [1, 0]);
});

test('cameraFootprint: straight-down pose projects a centred rectangle', () => {
  const fp = F.cameraFootprint({lat: 43.7866, lon: -79.1903, alt: 50, headingDeg: 0, pitchDeg: 90});
  assert.equal(fp.length, 4);
  const clat = fp.reduce((s, p) => s + p[0]/4, 0), clon = fp.reduce((s, p) => s + p[1]/4, 0);
  assert.ok(Math.abs(clat - 43.7866) < 1e-6 && Math.abs(clon + 79.1903) < 1e-6,
    'footprint centred under the drone');
  // Half-width = alt * tan(34.5°) ≈ 34.4 m → span ≈ 69 m east
  const es = fp.map(p => F.llDiff(fp[0], p)[0]);
  assert.ok(Math.max(...es) - Math.min(...es) > 60);
});

test('cameraFootprint: forward tilt returns null when rays miss the ground', () => {
  const fp = F.cameraFootprint({lat: 0, lon: 0, alt: 50, headingDeg: 0, pitchDeg: 0});
  assert.equal(fp, null);
});

test('sectorROS: a uniformly growing polygon reports positive sector rates', () => {
  const small = [[0, 0], [.0001, 0], [.0001, .0001], [0, .0001]];
  const big = [[-.00005, -.00005], [.00015, -.00005], [.00015, .00015], [-.00005, .00015]];
  const ros = F.sectorROS(small, big, 60);
  // Vertices sit on the diagonals → sectors 1, 3, 5, 7 (NE/SE/SW/NW) get rates.
  for (const s of [1, 3, 5, 7]) assert.ok(ros[s] > 0, `sector ${s} rate ${ros[s]}`);
});

test('sectorROS: unobserved sectors stay null, never invented', () => {
  const arc = [[0, 0], [.0001, 0], [.00005, .0001]];
  const ros = F.sectorROS(arc, arc, 60);
  assert.ok(ros.some(r => r === null));
});

test('fuseExtents: hull encloses all vertex extremes', () => {
  const a = [[0, 0], [.0001, 0], [.0001, .0001], [0, .0001]];
  const b = [[.00005, .00005], [.0002, .00005], [.0002, .00015], [.00005, .00015]];
  const hull = F.fuseExtents([a, b]);
  const es = hull.map(p => p[1]), ns = hull.map(p => p[0]);
  // b spans lat .00005-.0002, lon .00005-.00015 → hull reaches both extremes.
  assert.ok(Math.min(...es) <= 0 && Math.max(...es) >= .00015);
  assert.ok(Math.min(...ns) <= 0 && Math.max(...ns) >= .0002);
  assert.deepEqual(F.fuseExtents([]), []);
});
