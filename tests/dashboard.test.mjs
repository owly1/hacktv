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
  run('state.autonomy.receiver.ready=true;renderAutonomy()');
  assert.equal(element('autonomy-enable').disabled,false);
  await run("setAutonomy('enable')");
  assert.equal(run('autonomousSession'),'test-session');
  run("state.mode='demo'");await run('pollAutonomy()');
  assert.ok(calls.some(body=>body?.action==='land'));
  assert.equal(run('autonomousSession'),null);
  const before=calls.length;await run("setAutonomy('enable')");assert.equal(calls.length,before);
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
  await run("setAutonomy('camera',{pitch_deg:-45})");
  assert.equal(calls[0].action,'camera');assert.equal(calls[0].pitch_deg,-45);
  assert.equal(run('autonomousSession'),null);
  run('state.autonomy.enabled=true;renderAutonomy()');assert.equal(element('camera-down').disabled,true);
  await run("setAutonomy('camera',{pitch_deg:-45})");assert.equal(calls.length,1);
});
