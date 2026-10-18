import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function dashboard() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false,
      classList: {add() {}, remove() {}, toggle() {}},
      style: {setProperty() {}},
      setAttribute() {},
    });
    return elements.get(id);
  };
  const layer = () => ({
    addTo() {return this;}, remove() {}, clearLayers() {}, bindTooltip() {return this;},
    setLatLng() {return this;}, setOpacity() {return this;},
  });
  const context = vm.createContext({
    console, performance, URLSearchParams, AbortSignal,
    document: {getElementById: element, querySelectorAll: () => []},
    L: {layerGroup: layer, polyline: layer, polygon: layer, marker: layer, divIcon: value => value},
    window: {}, setTimeout: () => 0, clearTimeout() {},
  });
  for (const name of ['model.js', 'demo-cases.js', 'people.js', 'app.js']) {
    let source = await readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8');
    if (name === 'app.js') source = source.replace(/\nboot\(\);\s*$/, '\n');
    vm.runInContext(source, context, {filename: name});
  }
  vm.runInContext(`
    state.mode = 'demo'; state.demo.results = {}; state.demo.fires = window.EMBER_DEMO.cases;
    state.map = {setView() {}, closePopup() {}};
    for (const name of ['fire', 'people', 'coverage', 'mission']) state.layers[name] = L.layerGroup();
    renderSpread = fitToFire = renderAnalysis = renderPlan = renderPeople = toast = setDemoVideo = () => {};
    camera = () => null;
  `, context);
  return {context, run: source => vm.runInContext(source, context), element};
}

test('person search and historical replay switch without reusing a historical drone or analysis', async () => {
  const {run} = await dashboard();
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('demoCase().id'), run('state.demo.fires[0].id'));
  assert.ok(run('state.demo.marker'));
  run("demoResults().analysis = {summary: 'Historical analysis'}; selectDemo('people')");
  assert.equal(run('demoCase()'), null, 'person search is not a historical camera case');
  assert.equal(run('state.demo.marker'), null, 'the removed historical marker cannot keep animating');
  assert.equal(run('state.analysis'), null);
  run('animateDemoCase(performance.now())');
  run("demoResults().analysis = {summary: 'UTSC search'}; selectDemo('people:' + state.demo.fires[0].id)");
  assert.equal(run('state.analysis'), null, 'each search scenario owns its results');
  run("selectDemo('people')");
  assert.equal(run('state.analysis.summary'), 'UTSC search');
  run('selectDemo(state.demo.fires[0].id)');
  assert.equal(run('state.analysis.summary'), 'Historical analysis');
  assert.equal(run('peopleDemoActive()'), false);
});

test('simulated rescue plans use the demo endpoint and include that scenario\'s leads', async () => {
  const {context, run, element} = await dashboard();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({url, options: {...options, body: JSON.parse(options.body)}});
    return {ok: true, json: async () => ({id: 'demo-plan'})};
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
  finish({ok: true, json: async () => ({leads: [{id: 'live-lead'}]})});
  await pending;
  assert.equal(run('rendered'), 0);
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
