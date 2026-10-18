import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

/** Load dashboard modules into a minimal fake DOM to test scenario isolation. */
async function dashboard() {
  const elements = new Map();
  /** Return a stable fake DOM element for a requested dashboard identifier. */
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false,
      classList: {/* Accept a class addition in the minimal DOM fixture. */ add() {}, /* Accept a class/layer removal without invoking a real browser. */ remove() {}, /* Accept a class toggle in the minimal DOM fixture. */ toggle() {}},
      style: {/* Accept a style update in the fake dashboard element. */ setProperty() {}},
      /** Accept an attribute update in the fake dashboard element. */
      setAttribute() {},
    });
    return elements.get(id);
  };
  /** Build a chainable fake Leaflet layer for dashboard-state assertions. */
  const layer = () => ({
    addTo() {return this;}, remove() {}, clearLayers() {}, bindTooltip() {return this;},
    bindPopup() {return this;}, setLatLng() {return this;}, setLatLngs() {return this;}, setOpacity() {return this;}, on() {return this;},
  });
  const context = vm.createContext({
    console, performance, URLSearchParams, AbortSignal,
    document: {getElementById: element, /* Return an empty node list for controls not needed by this fixture. */ querySelectorAll: () => []},
    L: {layerGroup: layer, polyline: layer, polygon: layer, marker: layer, /* Preserve icon options without constructing a real map icon. */ divIcon: value => value},
    window: {}, /* Suppress real timers in the isolated dashboard fixture. */ setTimeout: () => 0, /* Accept fake timer cleanup without scheduling browser work. */ clearTimeout() {},
  });
  for (const name of ['model.js', 'demo-cases.js', 'demo-scout.js', 'people.js', 'app.js']) {
    let source = await readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8');
    if (name === 'app.js') source = source.replace(/\nboot\(\);\s*$/, '\n');
    vm.runInContext(source, context, {filename: name});
  }
  vm.runInContext(`
    state.mode = 'demo'; state.demo.results = {}; state.demo.fires = window.EMBER_DEMO.cases;
    state.map = {setView() {}, closePopup() {}};
    state.droneMarker = L.marker();
    for (const name of ['fire', 'people', 'coverage', 'mission', 'spread', 'wind']) state.layers[name] = L.layerGroup();
    var originalRenderSpread = renderSpread;
    renderSpread = fitToFire = renderPlan = renderPeople = toast = setDemoVideo = () => {};
    camera = () => null;
  `, context);
  return {context, /* Evaluate the selected dashboard operation inside its isolated VM fixture. */ run: source => vm.runInContext(source, context), element};
}

test('replay animation and live connection no longer request or poll scene analysis', async () => {
  const {context, run} = await dashboard();
  const calls = [], polls = [];
  context.fetch = async url => {
    calls.push(url);
    return {ok:true, json:async () => url === '/api/status' ? {contract:'emberwatch.v1'} : {plan:null}};
  };
  context.setInterval = () => 0;
  context.trackPoll = name => polls.push(name);
  run(`selectDemo(state.demo.fires[0].id); state.demo.started = performance.now() - 30000;
    setDronePose = () => {}; animateDemoCase(performance.now());`);
  assert.deepEqual(calls, [], 'replay never automatically submits a Gemini analysis');
  run("state.mode = 'live'; every = (ms, name) => trackPoll(name); streamVideo = () => {};");
  await run('connect()');
  assert.ok(polls.includes('people') && polls.includes('telemetry'));
  assert.ok(!polls.includes('analysis'));
  assert.ok(calls.every(url => !url.includes('analy')));
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="analysis-panel"|id="analyze"|Gemini analysis/);
  assert.match(html, /id="questions-panel"/);
});

test('person search and historical replay switch without reusing a historical drone or plan', async () => {
  const {run} = await dashboard();
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('demoCase().id'), run('state.demo.fires[0].id'));
  assert.ok(run('state.demo.marker'));
  run("demoResults().plan = {title: 'Historical plan'}; selectDemo('people')");
  assert.equal(run('demoCase()'), null, 'person search is not a historical camera case');
  assert.equal(run('state.demo.marker'), null, 'the removed historical marker cannot keep animating');
  assert.equal(run('state.plan'), null);
  run('animateDemoCase(performance.now())');
  run("demoResults().plan = {title: 'UTSC search'}; selectDemo('people:' + state.demo.fires[0].id)");
  assert.equal(run('state.plan'), null, 'each search scenario owns its results');
  run("selectDemo('people')");
  assert.equal(run('state.plan.title'), 'UTSC search');
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('state.plan.title'), 'Historical plan');
  assert.equal(run('peopleDemoActive()'), false);
});

test('fleet POV, replay speed and scenario switches preserve shared evidence and selected telemetry', async () => {
  const {run, element} = await dashboard();
  run('selectDemo(state.demo.fires[0].id); state.demo.started = performance.now() - 90000;');
  const time = run('demoT()');
  run("state.minute = 30; demoResults().plan = {title:'shared plan'}; selectFleetDrone('ANAFI-03')");
  assert.ok(Math.abs(run('demoT()') - time) < 1);
  assert.equal(run('state.minute'), 30);
  assert.equal(run('demoResults().plan.title'), 'shared plan');
  assert.equal(run('state.demo.autoPOV'), false);
  assert.equal(run('simCase(demoCase()).drone.telemetry.drone_id'), 'ANAFI-03');
  assert.equal(run('simCase(demoCase()).fleet.length'), 4);
  assert.equal(element('drone-heading').textContent, 'ANAFI-03 · Fleet POV');
  element('fleet-rate').value = '4'; element('fleet-rate').onchange();
  assert.ok(Math.abs(run('demoT()') - time) < 1, 'rate changes rebase the clock');
  run('selectDemo(state.demo.fires[1].id)');
  assert.ok(run('demoT()') < 1);
  run('selectDemo(state.demo.fires[0].id)');
  assert.ok(Math.abs(run('demoT()') - time) < 1, 'returning to a case resumes its own time');
  assert.equal(run('state.demo.scout.selectedId'), 'ANAFI-03');
  run("selectDemo('people')");
  assert.equal(element('fleet-controls').hidden, true);
  assert.equal(run('state.demo.scout'), null);
});

test('fleet briefs contain the selected telemetry, all aircraft and source-attributed leads', async () => {
  const {run} = await dashboard();
  run(`selectDemo(state.demo.fires[0].id); state.demo.started = performance.now() - 105000;
    selectFleetDrone('ANAFI-03'); peopleState.snap = BoscoScout.snapshot(state.demo.scout, demoT());
    var savedBrief = ''; download = (name, body) => { savedBrief = body; }; exportBrief();`);
  assert.match(run('savedBrief'), /## Simulated fleet/);
  assert.match(run('savedBrief'), /Source drones: ANAFI-/);
  for (const id of ['ANAFI-01', 'ANAFI-02', 'ANAFI-03', 'ANAFI-04']) assert.ok(run('savedBrief').includes(id));
  assert.equal(run('simCase(demoCase()).drone.telemetry.drone_id'), 'ANAFI-03');
});

test('exterior fleet leads are not labeled at the fire merely because it could arrive soon', async () => {
  const {run} = await dashboard();
  run(`selectDemo(state.demo.fires[0].id); peopleState.snap = BoscoScout.snapshot(state.demo.scout, 210);
    fireArrivalAt = () => 5;`);
  assert.equal(run('withArrival(peopleState.snap.leads).some(l => l.atFire)'), false);
  run('fireArrivalAt = () => 0');
  assert.equal(run('withArrival(peopleState.snap.leads).every(l => l.atFire)'), true);
});

const liveIncident = (over = {}) => ({
  active: true, episode_id: 'live-qr', first_detected_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(), sightings: 3, max_confidence: 1,
  latest: {source: 'qr-test', label: 'fire', confidence: 1, detected_at: new Date().toISOString(),
    fire: {latitude: 43.7866, longitude: -79.1903, position_source: 'qr-scenario-site-not-measured'},
    details: {name: 'Alpha', area_ha: 120, spread_m_per_min: 35, wind_kmh: 30,
      wind_dir_deg: 60, temp_c: 31, rh_pct: 18, position_simulated: true}},
  ...over,
});

test('confirmed live QR populates conditions and an interactive projection using its payload', async () => {
  const {run, context, element} = await dashboard();
  context.incident = liveIncident();
  run("state.mode = 'live'; state.incident = incident; renderSpread = originalRenderSpread; renderIncident()");
  assert.equal(run('state.scenario.wind'), 30);
  assert.equal(run('state.scenario.temp'), 31);
  assert.equal(run('state.scenario.rh'), 18);
  assert.ok(Math.abs(run('projection().area_ha') - 120) < 1);
  assert.equal(run('projection().spread_rate_m_per_min'), 35);
  assert.equal(run('projection().origin.simulated'), true);
  const nowArea = run('projection().area_ha');
  run('state.minute = 60; renderSpread()');
  assert.ok(run('projection().area_ha') > nowArea);
  assert.match(element('detection-conditions').textContent, /120 ha.*35 m\/min.*30 km\/h/);
  assert.match(element('detection-location').textContent, /not measured/);
  run('state.scenario.wind = 60; renderSpread()');
  assert.ok(run('projection().spread_rate_m_per_min') > 35);
  run('renderIncident()');
  assert.equal(run('state.scenario.wind'), 60, 'repeat sightings preserve operator adjustments');
});

test('live demo anchors unlocated smoke without changing detection evidence; location recovery updates spread', async () => {
  const {run, context, element} = await dashboard();
  context.incident = liveIncident();
  context.incident.latest = {...context.incident.latest, source: 'yolo', label: 'smoke',
    details: null, fire: {latitude: null, longitude: null, position_source: 'unavailable'}};
  run("state.mode = 'live'; state.incident = incident; renderSpread = originalRenderSpread; renderIncident()");
  assert.equal(run('projection()'), null);
  run('state.liveDemo = true; renderIncident()');
  assert.ok(run('projection().area_ha') > 0);
  assert.equal(run('state.incident.latest.fire.latitude'), null);
  assert.equal(run('projection().origin.simulated'), true);
  assert.match(element('detection-location').textContent, /configured demo site/);
  run('state.incident.latest.fire = {latitude: 43.79, longitude: -79.2}; renderIncident()');
  assert.equal(run('projection().origin.latitude'), 43.79);
  assert.equal(run('projection().origin.simulated'), false);
  assert.notEqual(element('area-value').textContent, '—');
});

test('QR scenario wind is retained when an old derived estimate is supplied', async () => {
  const {run, context} = await dashboard();
  context.incident = liveIncident();
  run("state.mode = 'live'; state.incident = incident; renderIncident()");
  run("applyWindEstimate({created_at:'analysis-1', episode_id:'live-qr', wind_estimate:{speed_mps:20, direction_deg:180}})");
  assert.equal(run('state.scenario.wind'), 30);
  run("applyWindEstimate({created_at:'analysis-2', episode_id:'previous-fire', wind_estimate:{speed_mps:25, direction_deg:180}})");
  assert.equal(run('state.scenario.wind'), 30);
});

test('live plan response cannot overwrite a replay selected during inference', async () => {
  const {run, context, element} = await dashboard();
  context.incident = liveIncident();
  run("state.mode = 'live'; state.incident = incident; renderIncident()");
  let finish;
  context.fetch = () => new Promise(resolve => {finish = resolve;});
  element('objective').value = 'initial-attack';
  const pending = run('generatePlan()');
  run("state.mode = 'demo'; state.plan = {title: 'Replay plan'}");
  finish({ok: true, json: async () => ({title: 'Live plan'})});
  await pending;
  assert.equal(run('state.plan.title'), 'Replay plan');
});

test('simulated rescue plans use the demo endpoint and include that scenario\'s leads', async () => {
  const {context, run, element} = await dashboard();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({url, options: {...options, body: JSON.parse(options.body)}});
    return {ok: true, /* Return the controlled response body for this fake HTTP request. */ json: async () => ({id: 'demo-plan'})};
  };
  run(`
    selectDemo('people');
    state.demo.selected.lat = 43.78; state.demo.selected.lon = -79.19;
    peopleState.snap = {simulated: true, fire: {latitude: 43.78, longitude: -79.19},
      drone: {altitude_m: 60}, leads: [{id: 'simulated-lead'}]};
  `);
  element('objective').value = 'search-and-rescue';
  await run("demoGemini('plan')");
  assert.equal(calls[0].url, '/api/demo/plan');
  assert.equal(calls[0].options.body.case.provenance, 'simulated');
  assert.equal(calls[0].options.body.case.rescue_leads[0].id, 'simulated-lead');
  assert.ok(calls[0].options.body.projection.area_ha > 0);
});

test('an in-flight live lead poll cannot overwrite a newly selected demo', async () => {
  const {context, run} = await dashboard();
  let finish;
  context.fetch = () => new Promise(resolve => {finish = resolve;});
  run("state.mode = 'live'; var rendered = 0; renderPeople = () => rendered++;");
  const pending = run('pollPeople()');
  run("state.mode = 'demo'");
  finish({ok: true, /* Return the controlled response body for this fake HTTP request. */ json: async () => ({leads: [{id: 'live-lead'}]})});
  await pending;
  assert.equal(run('rendered'), 0);
});

test('camera-only person evidence stays unlocated in cards and the exported brief', async () => {
  const {context, run} = await dashboard();
  context.cameraNote = {track_id:'camera-1', observed_at:new Date().toISOString(), sightings:3,
    location_reason:'pose-unavailable', acknowledged:{by:'<observer>',at:new Date().toISOString()}};
  const card = run('cameraSightingCard(cameraNote)');
  assert.match(card, /location unavailable/);
  assert.match(card, /without a map pin/);
  assert.match(card, /&lt;observer&gt;/);
  run("state.mode = 'live'; peopleState.snap = {leads:[],unlocated_sightings:[cameraNote]}");
  assert.match(run('peopleBrief()'), /Camera person sighting \(unlocated\)/);
  assert.match(run('peopleBrief()'), /no geographic pose available/);
});
