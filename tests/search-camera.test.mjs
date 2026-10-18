import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../dist/model.js';
import {PersonSearchSim, scenarioFromExample} from '../backend/people-sim.mjs';
import {toLocal, projectToImage} from '../backend/people.mjs';
import {FIRES} from '../examples/historical-fires.mjs';

test('fire-first snapshots expose matching drone, camera and scene geometry for every case', () => {
  const site = {latitude:43.7866, longitude:-79.1903};
  for (const scenario of [null, ...FIRES.map(scenarioFromExample)]) {
    const sim = new PersonSearchSim({site, startMs:1700000000000, scenario});
    let objects = 0;
    for (let t=0;t<=560;t+=20) {
      sim.advanceTo(t);
      const snap = sim.snapshot(), {camera:c, drone:d} = snap;
      assert.equal(d.drone_id, 'ANAFI-01');
      assert.equal(d.provenance, 'simulated'); assert.equal(c.provenance, 'simulated');
      const [e,n] = toLocal({lat:c.origin.latitude,lon:c.origin.longitude},d.latitude,d.longitude);
      assert.ok(Math.hypot(e-c.pose.e,n-c.pose.n) < .02);
      assert.equal(d.altitude_m,c.pose.alt);
      assert.equal(d.heading_deg,c.pose.heading);
      assert.equal(d.gimbal_pitch_deg,-c.pose.pitch);
      assert.ok(d.ground_speed_mps >= 0 && d.ground_speed_mps <= 9.001);
      assert.ok(d.battery_pct > 0 && d.battery_pct <= 82);
      assert.equal(d.observed_at,new Date(1700000000000+snap.t*1000).toISOString());
      for (const obj of c.objects) {
        assert.ok(sim.exterior(obj.e+sim.F[0],obj.n+sim.F[1]));
        assert.ok(projectToImage({alt:d.altitude_m,heading:d.heading_deg,pitch:d.gimbal_pitch_deg,hfov:69,vfov:42.2},obj.e-c.pose.e,obj.n-c.pose.n));
        if (obj.kind === 'rock') assert.match(obj.label,/HOT OBJECT/);
      }
      objects += c.objects.length;
    }
    assert.ok(objects > 0);
  }
});

test('fire-first camera and detector reject an injected inside-fire target', () => {
  const sim=new PersonSearchSim({site:{latitude:43.78,longitude:-79.19},startMs:1700000000000});
  sim.targetPosition=()=>[...sim.F];
  sim.advanceTo(120);
  const snap=sim.snapshot();
  assert.equal(snap.leads.length,0);
  assert.equal(snap.camera.objects.length,0);
});
