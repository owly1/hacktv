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
    bindPopup() {return this;}, setLatLng() {return this;}, setLatLngs() {return this;}, setOpacity() {return this;}, on() {return this;}, bringToFront() {return this;},
  });
  const context = vm.createContext({
    console, performance, URL, URLSearchParams, AbortSignal,
    location: {href: 'http://localhost/?demo', search: '?demo'},
    history: {/** Keep browser navigation out of the isolated state tests. */ replaceState() {}},
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
    renderSpread = fitToFire = renderPeople = toast = setDemoVideo = drawWaiting = () => {};
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
  assert.ok(calls.every(url => !/analy|plan|ask/.test(url)));
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="analysis-panel"|id="analyze"|Gemini analysis/);
  assert.doesNotMatch(html, /questions-panel|response-panel|ask-input|generate-plan|Gemini/);
});

test('scenario links retain unrelated options and leaving replay removes stale replay parameters', async () => {
  const {context, run} = await dashboard();
  const urls = [];
  context.location.href = 'http://localhost/?demo&case=old&demo-wind#map-panel';
  context.history.replaceState = (_state, _title, url) => {
    urls.push(new URL(url));
    context.location.href = String(url);
  };
  run("selectDemo('forest-detection')");
  assert.equal(urls.at(-1).searchParams.get('case'), 'forest-detection');
  assert.ok(urls.at(-1).searchParams.has('demo'));
  assert.ok(urls.at(-1).searchParams.has('demo-wind'));
  assert.equal(urls.at(-1).hash, '#map-panel');
  run("selectDemo('people')");
  assert.equal(urls.at(-1).searchParams.get('case'), 'people');
  run("state.mode = 'live'; state.liveDemo = false; syncWorkspaceUrl()");
  assert.ok(!urls.at(-1).searchParams.has('demo'));
  assert.ok(!urls.at(-1).searchParams.has('case'));
  run('state.liveDemo = true; syncWorkspaceUrl()');
  assert.ok(urls.at(-1).searchParams.has('live-demo'));
  assert.ok(!urls.at(-1).searchParams.has('demo'));
});

test('fire-first camera interpolation shares the map pose and uses the short heading turn', async () => {
  const {context,run,element} = await dashboard();
  run("selectDemo('people'); var fakeCam = {ok:true}; camera = () => fakeCam;");
  const capture = [];
  context.EmberCamera = {setScene() {},render(ctx,cam,pose,opts) {capture.push({pose,opts});}};
  element('camera').getContext = () => ({});
  const make = (t,e,heading) => ({simulated:true,t,duration_s:560,leads:[],camera:{origin:{latitude:43,longitude:-79},wind_deg:60,wind_kmh:25,
    pose:{e,n:10,alt:70,heading,pitch:55},fire:{a:50,b:50,shift:0},objects:[]},
    drone:{latitude:43+e/111320,longitude:-79,ground_speed_mps:9,battery_pct:80},mission:{phase:'orbit',mode:'survey'}});
  context.first = make(0,0,359); context.second = make(3,9,1);
  run('acceptPeopleFrame(first); acceptPeopleFrame(second); var captureAt = peopleState.demo.frame.received;');
  const heading = run('peopleFrame(captureAt + 500).pose.heading');
  assert.ok(heading < .01 || heading > 359.99);
  run('renderPeopleCamera(captureAt + 500)');
  assert.ok(Math.abs(capture[0].pose.e-4.5)<1e-10); assert.equal(capture[0].opts.speed,9);
  assert.ok(Math.abs(run('state.demo.pos[0]')-(43+4.5/111320))<1e-10);
  assert.match(element('power').innerHTML,/80/);
  assert.match(element('video-status').textContent,/Person search camera/);
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('peopleState.demo'),null);
  run('renderPeopleCamera(captureAt+1000)');
  assert.equal(capture.length,1,'leaving the case stops its camera rendering');
});

test('person search and historical replay never reuse a removed drone or stale search frame', async () => {
  const {run} = await dashboard();
  run('selectDemo(state.demo.fires[0].id)');
  assert.ok(run('state.demo.marker'));
  run("selectDemo('people')");
  assert.equal(run('demoCase()'), null);
  assert.equal(run('state.demo.marker'), null);
  assert.equal(run('peopleState.demo.frame'), null);
  run('animateDemoCase(performance.now())');
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('peopleDemoActive()'), false);
  assert.equal(run('peopleState.demo'), null);
});

test('fleet POV, replay speed and scenario switches preserve shared evidence and selected telemetry', async () => {
  const {run, element} = await dashboard();
  run('selectDemo(state.demo.fires[0].id); state.demo.started = performance.now() - 90000;');
  const time = run('demoT()');
  run("state.minute = 30; var savedScene = state.demo.scout; selectFleetDrone('ANAFI-03')");
  assert.ok(Math.abs(run('demoT()') - time) < 1);
  assert.equal(run('state.minute'), 30);
  assert.equal(run('state.demo.scout === savedScene'), true);
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

test('forest UI has no incident or projection before Detected and rearms when selected again', async () => {
  const {run,element}=await dashboard();
  run("selectDemo('forest-detection'); state.demo.started=performance.now()-45000; setDronePose=()=>{}; animateDemoCase(performance.now());");
  assert.equal(element('demo-detected').hidden,false);
  assert.equal(element('demo-detected').disabled,false);
  assert.equal(run('origin()'),null);
  assert.equal(run('projection()'),null);
  assert.equal(run('simCase(demoCase()).drone.detection'),null);
  assert.equal(run('state.demo.located'),false);
  assert.match(element('detect-context').textContent,/no fire/);
  run('detectForestFire()');
  assert.equal(element('demo-detected').disabled,true);
  assert.equal(run('state.demo.located'),true);
  assert.ok(run('projection().area_ha')>0);
  assert.match(run('BoscoScout.pose(state.demo.scout,demoT()).phase'),/Responding/);
  run("selectDemo(state.demo.fires[0].id)");
  assert.equal(element('demo-detected').hidden,true);
  run("selectDemo('forest-detection')");
  assert.equal(run('forestWaiting()'),true);
  assert.equal(element('demo-detected').disabled,false);
});

test('forest camera suppresses fire and smoke inputs until the button and uses matching detection coordinates', async () => {
  const {run,context}=await dashboard();
  const frames=[];
  context.EmberCamera={render:(ctx,cam,pose,opts)=>frames.push({pose,opts})};
  context.canvas={width:960,height:540,getContext:()=>({save(){},scale(){},restore(){}})};
  run("selectDemo('forest-detection'); var p=BoscoScout.pose(state.demo.scout,0); renderFleetCamera(canvas,{w:960,h:540},p,[p],demoCase(),0,0)");
  assert.equal(frames[0].opts.fire,null);
  assert.equal(frames[0].opts.clearance,null);
  assert.equal(frames[0].opts.people.length,0);
  assert.equal(frames[0].opts.forest,true);
  run('detectForestFire(); p=BoscoScout.pose(state.demo.scout,demoT()); renderFleetCamera(canvas,{w:960,h:540},p,[p],demoCase(),demoT(),.94)');
  assert.ok(frames[1].opts.fire.a>0);
  assert.equal(run('simCase(demoCase()).drone.detection.fire.latitude'),56.65);
  assert.equal(run('simCase(demoCase()).drone.detection.fire.longitude'),-111.50);
  assert.equal(run('state.minute'),30);
  assert.ok(run('projection().area_ha') > run('simCase(demoCase()).estimated_area_ha'), 'the trigger displays a future prediction, not just the current footprint');
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


test('forest arrival reframes once and scenario changes clear the accelerated clock', async () => {
  const {run,context,element}=await dashboard();
  let now=1000;
  context.performance={now:()=>now};
  run("selectDemo('forest-detection'); detectForestFire(); setDronePose=()=>{}; var fits=0; fitToFire=()=>fits++;");
  assert.equal(run('state.demo.playbackRate'),8);
  now+=5000;
  assert.ok(Math.abs(run('demoT()')-80)<1e-8);
  element('fleet-rate').value='4';
  run("$('fleet-rate').onchange()");
  assert.ok(Math.abs(run('demoT()')-80)<1e-8,'speed change does not jump');
  now+=30000;
  run('animateDemoCase(performance.now())');
  assert.equal(run('fits'),1);
  now+=1000;
  run('animateDemoCase(performance.now())');
  assert.equal(run('fits'),1);
  assert.match(run('projection().basis'),/illustrative forest/);
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('state.demo.responseClock'),null);
  assert.ok(run('demoT()')<.001);
});

test('located detections appear as person markers at their coordinates on the fire explorer', async () => {
  const {run,context}=await dashboard();
  const markers=[], marker=context.L.marker;
  context.L.marker=(point,options)=>{markers.push({point,options}); return marker();};
  run(`selectDemo(state.demo.fires[0].id); renderCoverage=()=>{};
    var search=state.demo.scout; var empty=BoscoScout.snapshot(search,0);`);
  markers.length=0;
  run('renderPeopleMap(empty)');
  assert.equal(markers.length,0,'no people are mapped before detection');
  run('var detected=BoscoScout.snapshot(search,210); renderPeopleMap(detected)');
  assert.equal(markers.length,run('detected.leads.length'));
  assert.ok(markers.length>0);
  markers.forEach(({point,options},i)=>{
    assert.equal(point[0],run(`detected.leads[${i}].latitude`));
    assert.equal(point[1],run(`detected.leads[${i}].longitude`));
    assert.match(options.icon.html,/#i-person/);
    assert.equal(options.title,`Person ${run(`detected.leads[${i}].number`)}`);
  });
  markers.length=0;
  run("state.mode='live'; renderPeopleMap({leads:[],unlocated_sightings:[{track_id:'unlocated'}],coverage:{cells:[]}})");
  assert.equal(markers.length,0,'camera-only sightings do not receive invented locations');
});

test('autonomous response needs readiness and its owning live page; replay sends LAND', async () => {
  const {context,run,element}=await dashboard(); const calls=[];
  context.fetch=async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;calls.push(body);
    return {ok:true,json:async()=>({enabled:body?.action==='enable',session_id:'test-session',
      receiver:{ready:true,reason:'Ready'}})};
  };
  run("state.mode='live';state.autonomy={enabled:false,receiver:{ready:false}};renderAutonomy()");
  assert.equal(element('autonomy-enable').disabled,true);
  run('Object.assign(state.autonomy.receiver,{ready:true,camera_ready:true,camera_search_supported:true});renderAutonomy()');
  assert.equal(element('autonomy-enable').disabled,false);
  await run("setAutonomy('enable')");
  assert.equal(run('autonomousSession'),'test-session');
  run("state.mode='demo'");await run('pollAutonomy()');
  assert.ok(calls.some(body=>body?.action==='land'));
  assert.equal(run('autonomousSession'),null);
  const before=calls.length;await run("setAutonomy('enable')");assert.equal(calls.length,before);
});

test('BOSCO sends search and flight authorization together and disables its start button while active',async()=>{
  const {context,run,element}=await dashboard();const calls=[];
  context.fetch=async(url,options)=>{
    calls.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({enabled:true,camera_search:true,session_id:'bosco-session',
      receiver:{ready:true,camera_ready:true,camera_search_supported:true,search_state:'scanning'}})};
  };
  run("state.mode='live';state.autonomy={enabled:false,receiver:{ready:true,camera_ready:true,camera_search_supported:true}};renderAutonomy()");
  assert.equal(element('autonomy-enable').textContent,'Start BOSCO');
  await run("setAutonomy('enable',{camera_search:true})");
  assert.deepEqual(calls[0],{action:'enable',camera_search:true});
  assert.equal(run('autonomousSession'),'bosco-session');
  assert.equal(element('autonomy-enable').disabled,true);
  assert.equal(element('autonomy-state').textContent,'SEARCHING');
});

test('a delayed poll cannot erase a newly enabled flight session',async()=>{
  const {context,run}=await dashboard();let finish;
  context.fetch=async(url,options)=>{
    if(!options.body)return new Promise(resolve=>{finish=resolve;});
    return {ok:true,json:async()=>({enabled:true,session_id:'new-session',receiver:{ready:true}})};
  };
  run("state.mode='live'");const polling=run('pollAutonomy()');
  await run("setAutonomy('enable')");
  finish({ok:true,json:async()=>({enabled:false,receiver:{ready:true}})});await polling;
  assert.equal(run('autonomousSession'),'new-session');assert.equal(run('state.autonomy.enabled'),true);
});

test('camera tilt stays available with missing flight calibration but never in an enabled session',async()=>{
  const {context,run,element}=await dashboard();const calls=[];
  context.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({enabled:false,receiver:{ready:false,camera_ready:true}})};};
  run("state.mode='live';state.autonomy={enabled:false,receiver:{ready:false,camera_ready:true}};renderAutonomy()");
  assert.equal(element('autonomy-enable').disabled,true);assert.equal(element('camera-down').disabled,false);
  assert.equal(element('camera-shallow').disabled,false);
  await run("setAutonomy('camera',{pitch_deg:-45})");
  assert.equal(calls[0].action,'camera');assert.equal(calls[0].pitch_deg,-45);
  assert.equal(run('autonomousSession'),null);
  run('state.autonomy.enabled=true;renderAutonomy()');assert.equal(element('camera-down').disabled,true);
  assert.equal(element('camera-shallow').disabled,true);
  await run("setAutonomy('camera',{pitch_deg:-45})");assert.equal(calls.length,1);
});

test('one dropped heartbeat reply retries the same session instead of causing a watchdog landing',async()=>{
  const {context,run,element}=await dashboard();const calls=[];
  run("state.mode='live';autonomousSession='active-session';state.autonomy={enabled:true,session_id:'active-session',receiver:{ready:false},mission:{id:'flying'}}");
  context.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));throw new Error('temporary timeout');};
  await run('pollAutonomy()');
  assert.equal(run('autonomousSession'),'active-session');
  assert.equal(element('autonomy-state').textContent,'CONNECTION LOST');
  context.fetch=async(url,options)=>{
    calls.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({enabled:true,session_id:'active-session',mission:{id:'flying'},receiver:{phase:'recover'}})};
  };
  await run('pollAutonomy()');
  assert.deepEqual(calls,[{action:'heartbeat',session_id:'active-session'},{action:'heartbeat',session_id:'active-session'}]);
  assert.equal(element('autonomy-state').textContent,'REACQUIRING');
  assert.match(element('autonomy-detail').textContent,/Holding position/);
});

test('authoritative expiry clears heartbeat ownership and failed LAND cannot keep renewing it',async()=>{
  const {context,run}=await dashboard();
  run("state.mode='live';autonomousSession='expired-session'");
  context.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Session expired'})});
  await run('pollAutonomy()');assert.equal(run('autonomousSession'),null);
  run("autonomousSession='still-active';state.autonomy={enabled:true}");
  context.fetch=async()=>{throw new Error('offline');};
  await run("setAutonomy('land')");assert.equal(run('autonomousSession'),null);
});

test('emergency telemetry overrides even a newer incorrect landed event',async()=>{
  const {run,element}=await dashboard();
  run(`state.mode='live';state.telemetry={state:'emergency',observed_at:new Date(Date.now()-300).toISOString()};
    state.flight.events=[{phase:'landed',at:new Date().toISOString(),message:'aircraft confirmed landed'}];
    state.autonomy={enabled:false,receiver:{ready:true,camera_ready:true,camera_search_supported:true}};
    renderFlight();renderAutonomy();`);
  assert.match(element('flight-phase').textContent,/emergency · landing not confirmed/);
  assert.equal(element('flight-bar').style.width,'0%');
  assert.equal(element('autonomy-state').textContent,'EMERGENCY');
  assert.equal(element('autonomy-enable').disabled,true);
  run("state.telemetry.state='hovering';renderFlight()");
  assert.match(element('flight-phase').textContent,/Landing unconfirmed/);
  run("state.telemetry.state='landed';renderFlight()");
  assert.match(element('flight-phase').textContent,/Flight pattern · landed/);
});

test('QR readiness does not imply RGB localization readiness',async()=>{
  const {run,element}=await dashboard();
  run(`state.mode='live';state.autonomy={enabled:true,receiver:{ready:true,localization_sources:['qr-test'],
    blocked_source:'yolo',reason:'Ground-plane geometry needs physical verification'}};renderAutonomy()`);
  assert.match(element('autonomy-limits').textContent,/Location verified for QR markers\./);
  assert.match(element('autonomy-detail').textContent,/RGB fire detected; automatic flight unavailable/);
  assert.match(element('autonomy-detail').textContent,/physical verification/);
});

test('preflight displays configured scale and scope without claiming camera-profile verification',async()=>{
  const {run,element}=await dashboard();
  run(`state.mode='live';state.autonomy={enabled:true,waiting_reason:'Fire detected; waiting for its incident record to be accepted',
    receiver:{ready:true,position:{forward_m:.7,right_m:.05},calibration:{qr_side_m:.12,offset_body_m:[.08,0,0],
      image_size:[1280,720],rms_px:.344,qr_verified:true,profile_verified:null}}};renderAutonomy()`);
  assert.match(element('autonomy-calibration').textContent,/12 cm/);
  assert.match(element('autonomy-calibration').textContent,/8 \/ 0 \/ 0 cm/);
  assert.match(element('autonomy-calibration').textContent,/1280 × 720/);
  assert.match(element('autonomy-calibration').textContent,/Grounded QR location verified/);
  assert.match(element('autonomy-calibration').textContent,/Historical camera zoom\/crop match is unknown/);
  assert.match(element('autonomy-detail').textContent,/incident record/);
});

test('a claimed grounded mission is acquiring and expiry remains visible when the receiver is ready again',async()=>{
  const {run,element}=await dashboard();
  run(`state.mode='live';state.autonomy={enabled:true,mission:{id:'claimed'},receiver:{ready:true,phase:'preflight',reason:'Checking position'}};renderAutonomy()`);
  assert.equal(element('autonomy-state').textContent,'ACQUIRING');
  assert.match(element('autonomy-detail').textContent,/checking takeoff readiness/);
  run(`state.autonomy={enabled:false,reason:'Control connection expired; landing requested',receiver:{ready:true,reason:'Ready for a new session'}};renderAutonomy()`);
  assert.match(element('autonomy-detail').textContent,/Control connection expired/);
  assert.match(element('autonomy-detail').textContent,/Ready to search/);
});

test('adaptive scale displays automatic acquisition and only calls current measured geometry verified',async()=>{
  const {run,element}=await dashboard();
  run(`state.mode='live';state.autonomy={enabled:false,receiver:{ready:true,qr_scale_mode:'adaptive',
    localization_sources:['qr-test'],calibration:{qr_side_m:.12,offset_body_m:[.08,0,0],image_size:[1280,720],
    rms_px:.344,qr_verified:true,profile_verified:null}}};renderAutonomy()`);
  assert.match(element('autonomy-calibration').textContent,/QR size estimated automatically during vertical acquisition/);
  assert.doesNotMatch(element('autonomy-calibration').textContent,/12 cm|Configured QR black square/);
  assert.match(element('autonomy-calibration').textContent,/8 \/ 0 \/ 0 cm/);
  assert.match(element('autonomy-calibration').textContent,/1280 × 720/);
  assert.match(element('autonomy-calibration').textContent,/not yet verified/);
  assert.doesNotMatch(element('autonomy-limits').textContent,/Location verified for QR/);
  run("state.autonomy.receiver.position={source:'measured-qr-3d',forward_m:1,right_m:0};renderAutonomy()");
  assert.match(element('autonomy-calibration').textContent,/Metric target scale verified from current observations/);
});

test('live controls bind alongside fleet dashboard polling without starting aircraft on connection', async () => {
  const {context, run, element} = await dashboard();
  const calls = [], polls = [];
  context.setInterval = () => 0;
  context.trackPoll = (ms, name) => polls.push({ms, name});
  context.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({url, body});
    return {ok: true, json: async () => url === '/api/status' ? {contract: 'emberwatch.v1'} : {
      enabled: body?.action === 'enable', session_id: 'owned-live-session',
      receiver: {ready: true, camera_ready: true, camera_search_supported: true},
    }};
  };
  run("state.mode = 'live'; every = (ms, name) => trackPoll(ms, name); streamVideo = () => {};");
  await run('connect()');
  assert.deepEqual(calls.map(call => call.url), ['/api/status']);
  assert.deepEqual(polls.find(poll => poll.name === 'autonomy'), {ms: 250, name: 'autonomy'});
  for (const name of ['people', 'telemetry', 'incident', 'flight', 'status']) {
    assert.ok(polls.some(poll => poll.name === name), `${name} continues polling`);
  }
  for (const [id, pitch] of [['camera-level', 0], ['camera-shallow', -30], ['camera-down', -45], ['camera-steep', -70]]) {
    await element(id).onclick();
    assert.deepEqual(calls.at(-1).body, {action: 'camera', pitch_deg: pitch});
  }
  await element('autonomy-enable').onclick();
  assert.deepEqual(calls.at(-1).body, {action: 'enable', camera_search: true});
  await element('autonomy-land').onclick();
  assert.deepEqual(calls.at(-1).body, {action: 'land'});
  assert.equal(run('autonomousSession'), null);
});

test('an observing dashboard cannot inherit heartbeat ownership from the status response', async () => {
  const {context, run} = await dashboard();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({url, method: options.method, body: options.body});
    return {ok: true, json: async () => ({enabled: true, session_id: 'other-browser-session', receiver: {ready: true}})};
  };
  run("state.mode = 'live'");
  await run('pollAutonomy()');
  await run('pollAutonomy()');
  assert.equal(run('autonomousSession'), null);
  assert.ok(calls.every(call => call.method === 'GET' && call.body === undefined));
});

test('tracked fire status preserves person overlays and original camera capture freshness', async () => {
  const {context, run, element} = await dashboard();
  const labels = [], boxes = [];
  const drawing = {
    /** Accept a decoded camera image without drawing actual pixels in this fixture. */
    drawImage() {},
    /** Record the evidence boxes drawn on the shared camera. */
    strokeRect(...box) { boxes.push(box); },
    /** Record label and colour so person evidence cannot become a fire overlay. */
    fillText(label) { labels.push({label, color: this.fillStyle}); },
  };
  element('camera').getContext = () => drawing;
  context.Blob = Blob;
  context.createImageBitmap = async () => ({width: 1280, height: 720, close() {}});
  const at = Date.now() - 400;
  context.frame = {jpeg: new Uint8Array([1]), captured: new Date(at).toISOString(), detections: [
    {label: 'person', source: 'yolo-person', confidence: .9, bbox: [.6, .2, .7, .5]},
    {label: 'fire', source: 'qr-test', confidence: .99, bbox: [.2, .3, .4, .6]},
  ]};
  context.tracked = {episode_id: 'live-qr', label: 'fire', source: 'qr-test', confidence: .99,
    bbox: [.2, .3, .4, .6], at, first: at - 1000, hits: 6};
  run("state.mode = 'live'; state.autonomy = {observed_target: tracked, receiver: {position: {episode_id: 'live-qr'}}}");
  await run('drawFrame(frame)');
  assert.equal(boxes.length, 2);
  assert.deepEqual(labels, [{label: 'PERSON 90%', color: '#5CC8C0'}, {label: 'FIRE · LOCATED 99%', color: '#E8562A'}]);
  assert.equal(run('state.video.lastAt'), at, 'overlay never refreshes the source capture time');
  await run('drawFrame(frame)');
  assert.equal(run('state.video.times.length'), 1, 'redrawing one capture cannot invent camera FPS');
  labels.length = 0;
  run('state.autonomy.observed_target.at -= 1000');
  await run('drawFrame(frame)');
  assert.deepEqual(labels.map(entry => entry.label), ['PERSON 90%', 'FIRE · QR scenario 99%'], 'stale tracking never attaches to a different frame');
  labels.length = 0;
  run('frame.detections = [frame.detections[0]]');
  await run('drawFrame(frame)');
  assert.doesNotMatch(element('camera-label').innerHTML, /FIRE IN VIEW/);
});
