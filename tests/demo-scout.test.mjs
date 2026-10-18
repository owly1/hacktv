import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../dist/demo-scout.js';
import '../dist/model.js';
import {FIRES} from '../examples/historical-fires.mjs';
const S = globalThis.BoscoScout, M = globalThis.EmberModel;
const anchor = {e: -280, n: -30, alt: 38};

test('each historical fire has 3–7 fictional people and a continuous flight inside its footprint', () => {
  for (const f of FIRES) {
    const fire = {lat: f.lat, lon: f.lon, directionDeg: f.directionDeg};
    // The browser dataset and examples use the same lat/lon shape.
    if (!Number.isFinite(fire.lat)) { fire.lat = f.latitude; fire.lon = f.longitude; }
    const scene = S.create(fire, 42, 1000);
    assert.ok(scene.targets.length >= 3 && scene.targets.length <= 7);
    const atStart = S.pose(scene, S.START, anchor);
    assert.equal(atStart.e, anchor.e); assert.equal(atStart.n, anchor.n);
    const snap = S.snapshot(scene, 200, anchor);
    assert.equal(snap.leads.length, scene.targets.length);
    assert.ok(snap.leads.every(l => l.provenance === 'demo-simulated' && l.views >= 2));
    const p = S.pose(scene, 200, anchor), wd = fire.directionDeg * Math.PI / 180;
    const u = p.e * Math.sin(wd) + p.n * Math.cos(wd) - 40.5;
    const v = p.e * Math.cos(wd) - p.n * Math.sin(wd);
    assert.ok((u / 90) ** 2 + (v / 37.5) ** 2 < 1, 'scout actually enters the rendered fire area');
    for (let t = 9; t < 180; t++) {
      const a = S.pose(scene, t, anchor), b = S.pose(scene, t + .01, anchor);
      assert.ok(Math.hypot(a.e - b.e, a.n - b.n) < .2, 'case switching/waypoints do not teleport the drone');
    }
  }
});

test('people are disclosed only after the simulated camera observes them; actions stay in that case', () => {
  const f = {lat: 43.78, lon: -79.19, directionDeg: 60};
  const scene = S.create(f, 123, 1000), other = S.create(f, 999, 1000);
  assert.equal(S.snapshot(scene, 0, anchor).leads.length, 0);
  const snap = S.snapshot(scene, 160, anchor), lead = snap.leads[0];
  const target = scene.targets.find(x => x.id === lead.id);
  for (const sample of target.samples) assert.ok(S.visible(S.pose(scene, sample.t, anchor), target));
  S.action(scene, lead.id, 'ack', 'Demo commander');
  S.action(scene, lead.id, 'close', 'Demo commander', 'found');
  const updated = S.snapshot(scene, 161, anchor).leads.find(x => x.id === lead.id);
  assert.equal(updated.acknowledged.by, 'Demo commander');
  assert.equal(updated.closed.outcome, 'found');
  assert.ok(other.targets.every(x => !x.acknowledged && !x.closed));
  assert.throws(() => S.action(scene, lead.id, 'close', 'Commander', 'unsupported'));
  const counts = new Set(Array.from({length: 20}, (_, seed) => S.create(f, seed).targets.length));
  assert.ok(counts.size > 1, 'different sessions vary the illustrative person count');
});
