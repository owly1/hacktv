import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../dist/model.js';
import '../dist/demo-scout.js';
import {FIRES} from '../examples/historical-fires.mjs';
const S = globalThis.BoscoScout;

/** Independently measure ground distance to the exact forecast polygon used by the map. */
function borderDistance(scene, t, point) {
  const polygon = S.outline(scene.fire, t, 20).map(([lat,lon]) => ({e:(lon-scene.lon)*111320*Math.cos(scene.lat*Math.PI/180),n:(lat-scene.lat)*111320}));
  return Math.min(...polygon.map((a,i) => {
    const b = polygon[(i+1)%polygon.length], dx=b.e-a.e, dy=b.n-a.n;
    const k = Math.max(0,Math.min(1,((point.e-a.e)*dx+(point.n-a.n)*dy)/(dx*dx+dy*dy)));
    return Math.hypot(point.e-a.e-k*dx,point.n-a.n-k*dy);
  }));
}

test('historical cases pace the actual +20-minute border with continuous coordinated descents', () => {
  for (const f of FIRES) {
    const scene = S.create(f, 42, 1000);
    assert.equal(scene.drones.length, 4);
    assert.ok(scene.targets.length >= 4 && scene.targets.length <= 8);
    let descending = false, searching = false, ascending = false;
    for (let t = 0; t <= 420; t += .5) {
      const fleet = scene.drones.map(d => S.pose(scene, t, d.id));
      assert.ok(fleet.filter(p => p.phase !== 'Observing').length <= 1, 'three drones always retain observation');
      for (const p of fleet) {
        const a = Math.min(300, 90 + t * .8), wd = f.directionDeg * Math.PI / 180;
        const u = p.e * Math.sin(wd) + p.n * Math.cos(wd) - a * .45;
        const v = -p.e * Math.cos(wd) + p.n * Math.sin(wd);
        assert.ok((u / a) ** 2 + (v / (a / 2.4)) ** 2 > 1, 'flight remains outside the current burning footprint');
        assert.ok(S.clearance(scene, t, p) > 110, 'drones retain over 110 m of ground clearance from the fire');
        const distance = borderDistance(scene,t,p);
        assert.ok(distance >= 40 && distance <= 115, `drone stays beside the forecast contour while weaving: ${distance}`);
        assert.equal(globalThis.EmberModel.insidePolygon([p.lat,p.lon],S.outline(scene.fire,t,20)),false);
        assert.ok(Math.abs(p.climbRate) < 4, 'vertical speed is in simulation seconds');
        const next = S.pose(scene, t + .01, p.drone_id);
        assert.ok(Math.hypot(p.e - next.e, p.n - next.n) < .15);
        assert.ok(Math.abs(p.alt - next.alt) < .041);
        if (p.phase === 'Descending' && p.climbRate < -1) descending = true;
        if (p.phase === 'Searching perimeter' && p.alt < 40) searching = true;
        if (p.phase === 'Ascending' && p.climbRate > 1) ascending = true;
      }
    }
    assert.ok(descending && searching && ascending);
  }
});

test('forest exercise waits indefinitely, triggers once and flies continuously to the incident before searching', () => {
  const f = S.forestCase(FIRES[0]), scene = S.create(f,42,1000), t = 90;
  assert.equal(f.manualDetection,true);
  assert.equal(S.snapshot(scene,t).leads.length,0);
  assert.equal(S.fireTime(scene,9999),0);
  const before=scene.drones.map(d=>S.pose(scene,t,d.id));
  assert.ok(before.every(p=>p.phase==='Holding high' && p.depth===0 && p.alt>=150 && p.speed===0));
  assert.equal(S.pose(scene,t+999).e,before[0].e);
  for(const a of before) for(const b of before) if(a.drone_id!==b.drone_id) assert.ok(Math.hypot(a.e-b.e,a.n-b.n)>1500);
  assert.equal(S.detect(scene,t),true);
  assert.equal(S.detect(scene,t+10),false);
  for(const d of scene.drones) {
    const a=before[d.index], b=S.pose(scene,t,d.id), end=S.pose(scene,t+scene.transitDuration,d.id);
    assert.ok(Math.hypot(a.e-b.e,a.n-b.n)<1e-8,'button does not teleport an aircraft');
    assert.ok(Math.hypot(end.e,end.n)<Math.hypot(a.e,a.n),'each aircraft approaches the incident');
    for(let u=0;u<scene.transitDuration;u+=.5) {
      const p=S.pose(scene,t+u,d.id), next=S.pose(scene,t+u+.01,d.id);
      assert.ok(p.speed<=12.01,'approach speed is bounded in metres per second');
      assert.ok(Math.abs(p.climbRate)<=2.01,'approach descent is bounded');
      assert.ok(Math.hypot(p.e-next.e,p.n-next.n)<.121);
      assert.ok(S.clearance(scene,t+u,p)>100,'approach stays outside the actual fire');
    }
  }
  assert.equal(S.snapshot(scene,t+scene.transitDuration).leads.length,0);
  const snap=S.snapshot(scene,t+scene.transitDuration+210);
  assert.equal(snap.leads.length,scene.targets.length);
  assert.ok(snap.fleet.every(d=>d.people>0));
  assert.ok(S.create(f,42).detectedAt==null,'a fresh exercise rearms detection');
});

test('patrol has visible lateral motion and banking while telemetry follows the same continuous pose', () => {
  const scene=S.create(FIRES[0],42), d=scene.drones[3];
  const a=S.pose(scene,0,d.id), b=S.pose(scene,8,d.id);
  assert.ok(Math.hypot(a.e-b.e,a.n-b.n)>20);
  assert.ok(Math.abs(a.roll-b.roll)>1);
  for(let t=0;t<420;t+=.5) assert.ok(S.pose(scene,t,d.id).speed<15);
});

test('every drone finds people for varied seeds and headings, with camera-derived evidence', () => {
  for (let seed = 0; seed < 100; seed++) {
    const scene = S.create({lat: 43.78, lon: -79.19, directionDeg: seed * 7 % 360}, seed, 1000);
    assert.equal(S.snapshot(scene, 0).leads.length, 0);
    const snap = S.snapshot(scene, 210);
    for (const person of scene.targets) for (const t of [0, 30, 100, 300, 7200]) {
      assert.ok(S.clearance(scene, t, person) >= 70, 'fixed people remain at least 70 m outside even after maximum fire growth');
    }
    assert.equal(snap.leads.length, scene.targets.length);
    assert.ok(snap.fleet.every(d => d.people > 0), 'all four cameras contribute');
    assert.equal(new Set(snap.leads.map(l => l.id)).size, snap.leads.length);
    for (const target of scene.targets) for (const s of target.samples) {
      assert.ok(S.visible(S.pose(scene, s.t, s.drone_id), target, scene));
    }
    for (const lead of snap.leads) {
      assert.equal(lead.provenance, 'demo-simulated');
      assert.ok(lead.evidence.every(e => e.drone_id && e.from.includes(e.drone_id)));
      assert.ok(lead.observed_by.length > 0);
    }
  }
});

test('all views of one person share one lead; POV changes preserve time and review state', () => {
  const fire = {lat: 43.78, lon: -79.19, directionDeg: 60};
  const scene = S.create(fire, 42, 1000), other = S.create(fire, 99, 1000);
  // Overlapping camera coverage exercises identity fusion independently of mission scheduling.
  scene.targets = scene.targets.filter(p => p.assignedDrone === 'ANAFI-01');
  scene.drones[1].index = 0; scene.drones[1].firstSearch = scene.drones[0].firstSearch + 2;
  const snap = S.snapshot(scene, 310), lead = snap.leads.find(l => l.observed_by.length > 1);
  assert.ok(lead, 'cross-drone evidence exercises shared identity');
  assert.equal(snap.counts.open, scene.targets.length, 'repeated sightings never inflate the count');
  const ids = snap.leads.map(l => l.id);
  for (const drone of scene.drones) {
    scene.selectedId = drone.id;
    assert.equal(S.pose(scene, 310).drone_id, drone.id);
    assert.deepEqual(S.snapshot(scene, 310).leads.map(l => l.id), ids);
  }
  S.action(scene, lead.id, 'ack', 'Demo commander');
  S.action(scene, lead.id, 'close', 'Demo commander', 'found');
  const updated = S.snapshot(scene, 311);
  assert.equal(updated.leads.find(l => l.id === lead.id).acknowledged.by, 'Demo commander');
  assert.equal(updated.counts.open, snap.counts.open - 1);
  assert.ok(other.targets.every(x => !x.acknowledged && !x.closed));
  assert.throws(() => S.action(scene, lead.id, 'close', 'Commander', 'unsupported'));
  assert.throws(() => S.action(scene, lead.id, 'ack', ' '));
});

test('people are placed beside the forecast border and inside-fire objects never become detections', () => {
  for (const fire of FIRES) {
    const scene = S.create(fire,42);
    for (const target of scene.targets) {
      const drone = scene.drones.find(d=>d.id===target.assignedDrone), t=drone.firstSearch+22;
      const distance=borderDistance(scene,t,target);
      assert.ok(distance>15 && distance<33);
      assert.ok(S.exterior(scene,t,target));
    }
    const bad = {id:'inside-fire',number:99,e:0,n:0,samples:[],seenBy:[],total:0,first:null};
    scene.targets.push(bad);
    const p = {...S.pose(scene,30),e:0,n:-20,alt:30,pitch:60,heading:0,depth:1};
    assert.equal(S.visible(p,bad,scene),null);
    assert.ok(!S.snapshot(scene,210).leads.some(l=>l.id===bad.id));
    assert.equal(bad.samples.length,0);
  }
});

test('displayed clearance measures the fire edge, with a negative distance inside it', () => {
  const scene = S.create({lat:43, lon:-79, directionDeg:0},42);
  assert.ok(Math.abs(S.clearance(scene,300,{e:0,n:555}) - 120) < .1);
  assert.ok(S.clearance(scene,300,{e:0,n:135}) < -124);
});

test('long presentations bound evidence storage and retain original sighting and totals', () => {
  const scene = S.create({lat: 43, lon: -79, directionDeg: 60}, 42, 1000);
  S.snapshot(scene, 210);
  const first = scene.targets[0].first;
  S.snapshot(scene, 7200);
  assert.deepEqual(scene.targets[0].first, first);
  assert.ok(scene.targets.every(x => x.samples.length <= 240 && x.total >= x.samples.length));
  const counts = new Set(Array.from({length: 20}, (_, seed) => S.create({lat: 43, lon: -79, directionDeg: 60}, seed).targets.length));
  assert.ok(counts.size > 1);
});
