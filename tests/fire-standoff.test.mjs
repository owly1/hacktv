import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../dist/fire-standoff.js';
const {advisory, describe} = globalThis.FireStandoff;
const NOW = Date.parse('2026-10-18T12:00:00Z');

/** Build synchronized real-camera evidence for an equivalent 100 m fire radius. */
function detection() {
  return {source: 'yolo', label: 'fire', detected_at: new Date(NOW).toISOString(),
    details: {area_ha: Math.PI, area_source: 'camera-box-estimate'},
    fire: {distance_m: 150, position_source: 'gps+camera-ray-flat-ground'},
    drone: {provenance: 'live', gps_fix: true, observed_at: new Date(NOW).toISOString(), extra: {position_source: 'gps'}}};
}

test('100 m edge buffer grows centre target with detected area and never requests an approach', () => {
  const d = detection();
  const a = advisory(d, NOW);
  assert.equal(a.target_center_distance_m, 200);
  assert.equal(a.capture_edge_clearance_m, 50);
  assert.equal(a.capture_shortfall_m, 50);
  d.details.area_ha *= 4;
  assert.equal(advisory(d, NOW).target_center_distance_m, 300);
  d.fire.distance_m = 500;
  assert.equal(advisory(d, NOW).capture_shortfall_m, 0);
  assert.match(describe(a), /At capture/);
  assert.match(describe(a), /Advisory only; no flight command/);
});

test('QR and smoke do not receive real-fire advice', () => {
  assert.equal(advisory({...detection(), source: 'qr-test'}, NOW), null);
  assert.equal(advisory({...detection(), label: 'smoke'}, NOW), null);
  assert.equal(advisory(null, NOW), null);
});

test('expired, future, malformed and unsynchronized evidence cannot keep a numeric target', () => {
  for (const now of [NOW+10001, NOW-1, NaN]) {
    const a = advisory(detection(), now);
    assert.equal(a.status, 'stale');
    assert.equal(a.target_center_distance_m, null);
  }
  for (const at of [undefined, 'bad', new Date(NOW-2001).toISOString()]) {
    const d = detection(); d.drone.observed_at = at;
    assert.equal(advisory(d, NOW).target_center_distance_m, null);
  }
});

test('unknown, simulated, invalid and unlabeled physical sizes stay unavailable', () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, '5', 10000001]) {
    const d = detection(); d.details.area_ha = value;
    assert.equal(advisory(d, NOW).status, 'unavailable');
  }
  for (const change of [
    d => {d.details.position_simulated = true;},
    d => {delete d.details.area_source;},
    d => {d.drone.provenance = 'demo-simulated';},
    d => {d.drone.gps_fix = false;},
    d => {d.drone.extra.position_source = 'home+odometry';},
    d => {d.fire.position_source = 'configured-demo-site-not-measured';},
  ]) {
    const d = detection(); change(d);
    assert.equal(advisory(d, NOW).target_center_distance_m, null);
  }
});

test('missing range retains size-based target without inventing current clearance', () => {
  for (const range of [null, undefined, NaN, -1, '150']) {
    const d = detection(); d.fire.distance_m = range;
    const a = advisory(d, NOW);
    assert.equal(a.target_center_distance_m, 200);
    assert.equal(a.capture_edge_clearance_m, null);
    assert.equal(a.capture_shortfall_m, null);
    assert.match(describe(a), /Range at capture unavailable/);
  }
});
