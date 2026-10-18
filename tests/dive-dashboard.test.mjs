import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

/** Exercise the actual browser controller with a fake DOM and authenticated API transport. */
async function dashboard() {
  const elements=new Map(),bindings=new Map(),calls=[];let mode='live';
  const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,value:'0.4'});return elements.get(id);};
  const context=vm.createContext({window:{},console});
  vm.runInContext(await readFile(new URL('../dist/dive.js',import.meta.url),'utf8'),context);
  const status={ready:true,reason:'Ready',receiver:{phase:'idle'},commands:[],person_detection:{fresh:true,people_in_last_frame:0}};
  const client=new context.window.BoscoDive({document:{getElementById:element},window:{addEventListener:(name,handler)=>bindings.set(name,handler)},
    mode:()=>mode,toast:()=>{},uuid:()=> 'request-fixed',getJson:async(path,options)=>{
      calls.push({path,...options});if(path==='/api/dive')return status;
      if(path==='/api/commands')return {id:'command-one',session_id:'owned-session',status:'pending'};
      return {};
    }});
  client.bind();await client.refresh();calls.length=0;
  return {client,calls,status,bindings,element,setMode:value=>{mode=value;}};
}

test('visible button and D use the same owned search; measured results and people are shown',async()=>{
  const {client,calls,status,bindings,element}=await dashboard();
  assert.equal(element('dive-start').disabled,false);
  await bindings.get('keydown')({key:'D',preventDefault(){}});
  assert.equal(calls.filter(c=>c.path==='/api/commands').length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.path==='/api/commands').body)),
    {type:'dive-surveillance',target_altitude_m:.4,sweep_deg:360,request_id:'request-fixed'});
  assert.ok(calls.some(c=>c.path.endsWith('/heartbeat')));
  assert.equal(element('dive-start').disabled,true);
  status.commands=[{id:'command-one',status:'done',note:'Returned to measured starting altitude',person_observations:3,
    sightings:[{captured_at:new Date().toISOString(),count:1,confidence:.9}]}];
  await client.refresh();assert.equal(client.owner,null);
  assert.match(element('dive-progress').textContent,/Returned to measured/);
  assert.match(element('dive-people').textContent,/3 camera observations/);
  assert.match(element('dive-sightings').textContent,/90%/);
});

test('Replay, unavailable CV, input fields, modifiers and repeats never start an aircraft maneuver',async()=>{
  const {client,calls,status,bindings,element,setMode}=await dashboard();
  for(const over of [{repeat:true},{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},
                    {target:{isContentEditable:true}},{target:{closest:()=>({})}}])
    await bindings.get('keydown')({key:'d',...over});
  setMode('demo');await element('dive-start').onclick();await bindings.get('keydown')({key:'d'});
  setMode('live');status.ready=false;await client.refresh();await element('dive-start').onclick();
  assert.equal(calls.filter(c=>c.path==='/api/commands').length,0);
});

test('lost start reply retries the same request; X and leaving Live stop renewal even if LAND fails',async()=>{
  const {client,calls,bindings,setMode}=await dashboard();const original=client.getJson;let lost=false;
  client.getJson=async(path,options)=>{if(path==='/api/commands'&&!lost){lost=true;calls.push({path,...options});throw new Error('reply lost');}return original(path,options);};
  await client.start();const starts=calls.filter(c=>c.path==='/api/commands');
  assert.equal(starts.length,2);assert.equal(starts[0].body.request_id,starts[1].body.request_id);
  await bindings.get('keydown')({key:'x',preventDefault(){}});assert.equal(client.owner,null);
  client.owner={id:'command-one',session_id:'owned-session'};
  client.getJson=async(path,options)=>{if(path==='/api/dive/land')throw new Error('link lost');return original(path,options);};
  setMode('demo');await client.land();assert.equal(client.owner,null);
  calls.length=0;await client.refresh();assert.ok(!calls.some(c=>c.path.endsWith('/heartbeat')));
});

test('dashboard loads its dive controller before app boot and exposes both controls',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('src="dive.js"')<html.indexOf('src="app.js"'));
  for(const id of ['dive-start','dive-land','dive-height','dive-detector','dive-progress','dive-people'])assert.match(html,new RegExp(`id="${id}"`));
});
