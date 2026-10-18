import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {AutonomousResponse} from '../backend/autonomy.mjs';
import {createApp,MemoryStorage} from '../backend/server.mjs';
import {FIRE_MARKER_PAYLOAD} from '../backend/validation.mjs';

function harness() {
  let clock=1_000_000;
  const a=new AutonomousResponse(()=>clock);
  const receiver=()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready',phase:'waiting'});
  receiver();
  const hit={source:'yolo',label:'fire',confidence:.9,bbox:[.3,.3,.5,.5]};
  const frame=(over={})=>a.observe({captured_at:new Date(clock).toISOString(),width:1280,height:720,episode_id:'fire-episode',hit,...over});
  const advance=ms=>{clock+=ms;receiver();};
  const confirm=(source='yolo')=>{
    const session=a.snapshot();
    if(session.enabled)a.control({action:'heartbeat',session_id:session.session_id});
    for(let i=0;i<6;i++){advance(200);frame({hit:{...hit,source,qr_text:FIRE_MARKER_PAYLOAD}});}
    a.incident({episode_id:'fire-episode',source,label:'fire',id:'accepted-incident'});
  };
  return {a,receiver,frame,advance,confirm,now:()=>clock};
}

test('claimed fire persists through misses for exactly 15 seconds and one matching sighting renews it',()=>{
  const {a,confirm,advance,frame,now}=harness();const s=a.control({action:'enable'});confirm('qr-test');
  a.claim({session_id:s.session_id,receiver_id:'receiver-123',episode_id:'fire-episode'});
  const keep=ms=>{for(let elapsed=0;elapsed<ms;elapsed+=500){a.control({action:'heartbeat',session_id:s.session_id});advance(500);}};
  advance(100);frame({hit:null});assert.equal(a.snapshot().target,null);
  assert.equal(a.snapshot().fire_presence.present,true);
  keep(14000);assert.equal(a.snapshot().fire_presence.present,true);
  frame({hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.4,.4,.6,.6],qr_text:FIRE_MARKER_PAYLOAD}});
  const seen=now();assert.equal(a.snapshot().fire_presence.last_seen_at,seen);
  keep(14500);frame({hit:null});assert.equal(a.snapshot().fire_presence.present,true);
  keep(500);assert.equal(a.snapshot().fire_presence.present,false);
  assert.equal(a.snapshot().fire_presence.last_seen_at,seen);
});

test('starts disabled; enable needs a ready receiver and never restores authorization',()=>{
  const {a}=harness();assert.equal(a.snapshot().enabled,false);
  a.status({receiver_id:'receiver-123',ready:false,reason:'Calibration missing'});
  assert.throws(()=>a.control({action:'enable'}),/Calibration/);
  assert.equal(new AutonomousResponse().snapshot().enabled,false);
});

test('a lost enable response cannot authorize flight without a confirmed owning heartbeat',()=>{
  const {a,frame,advance}=harness();const s=a.control({action:'enable'});
  for(let i=0;i<6;i++){advance(200);frame();}
  a.incident({episode_id:'fire-episode',source:'yolo',label:'fire',id:'accepted'});
  assert.equal(a.snapshot().target,null);
  assert.throws(()=>a.claim({session_id:s.session_id,receiver_id:'receiver-123',episode_id:'fire-episode'}),/authorized/);
  a.control({action:'heartbeat',session_id:s.session_id});
  assert.ok(a.snapshot().target);
});

test('fresh same-episode observations resume a claimed mission during bounded recovery without reauthorizing',()=>{
  const {a,frame,confirm,advance}=harness();const s=a.control({action:'enable'});confirm('qr-test');
  const claimed=a.claim({session_id:s.session_id,receiver_id:'receiver-123',episode_id:'fire-episode'});
  advance(200);frame({hit:null});
  const waiting=a.status({receiver_id:'receiver-123',ready:false,aircraft_connected:true,
    phase:'recover',reason:'Holding position; reacquiring measured fire'});
  assert.equal(waiting.enabled,true);assert.equal(waiting.target,null);
  advance(200);frame({hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.4,.4,.6,.6],qr_text:FIRE_MARKER_PAYLOAD}});
  assert.equal(a.snapshot().mission.id,claimed.mission.id);
  assert.equal(a.snapshot().target.hits,1);
});
test('fresh confirmed RGB and exact QR fires can each claim once, after enable and incident acceptance',()=>{
  for(const source of ['yolo','qr-test']){
    const {a,confirm}=harness(); const session=a.control({action:'enable'});
    confirm(source);assert.ok(a.snapshot().target);
    const claim={receiver_id:'receiver-123',session_id:session.session_id,episode_id:'fire-episode'};
    const claimed=a.claim(claim);
    assert.ok(claimed.mission);assert.equal(claimed.height_m,1);
    assert.equal(claimed.radius_m,1);
    assert.equal(a.claim(claim).mission.id,claimed.mission.id,'retry returns the existing mission, never another flight');
    a.control({action:'land'}); assert.equal(a.snapshot().enabled,false);
  }
});

test('a lost claim response is retryable only by the same current receiver with a fresh matching target',()=>{
  const {a,confirm,advance,frame}=harness();const session=a.control({action:'enable'});confirm('qr-test');
  const request={receiver_id:'receiver-123',session_id:session.session_id,episode_id:'fire-episode'};
  const original=a.claim(request).mission;
  assert.deepEqual(a.claim(request).mission,original);
  assert.throws(()=>a.claim({...request,receiver_id:'different-123'}),/authorized/);
  assert.throws(()=>a.claim({...request,episode_id:'other-fire'}),/authorized/);
  advance(200);frame({hit:null});assert.throws(()=>a.claim(request),/authorized/);
  confirm('qr-test');assert.equal(a.claim(request).mission.id,original.id);
  a.control({action:'land'});assert.throws(()=>a.claim(request),/authorized/);
  a.status({receiver_id:'replacement-123',ready:true,reason:'Ready'});
  assert.throws(()=>a.claim({...request,receiver_id:'replacement-123'}),/authorized/);
});

test('explicit rearming permits one new response to the same QR after landing and receiver restart',()=>{
  const {a,confirm}=harness();const first=a.control({action:'enable'});confirm('qr-test');
  const original=a.claim({receiver_id:'receiver-123',session_id:first.session_id,episode_id:'fire-episode'}).mission;
  a.status({receiver_id:'receiver-123',ready:false,reason:'Landed',phase:'landed'});
  assert.equal(a.snapshot().enabled,false);
  a.status({receiver_id:'replacement-123',ready:true,reason:'Ready'});
  assert.equal(a.snapshot().enabled,false,'receiver restart is not authorization');
  const second=a.control({action:'enable'});
  a.control({action:'heartbeat',session_id:second.session_id});
  assert.equal(a.snapshot().target,null,'pre-enable observations cannot be reused');
  const enabledAt=a.session.enabled_at;
  // The harness receiver helper has the old ID; publish directly to retain the new owner.
  for(let i=1;i<=5;i++){
    a.now=()=>enabledAt+i*200;
    a.status({receiver_id:'replacement-123',ready:true,reason:'Ready'});
    a.observe({captured_at:new Date(a.now()).toISOString(),width:1280,height:720,episode_id:'fire-episode',
      hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:FIRE_MARKER_PAYLOAD}});
  }
  const next=a.claim({receiver_id:'replacement-123',session_id:second.session_id,episode_id:'fire-episode'}).mission;
  assert.notEqual(next.id,original.id);assert.equal(next.episode_id,original.episode_id);
  assert.equal(a.claim({receiver_id:'replacement-123',session_id:second.session_id,episode_id:'fire-episode'}).mission.id,next.id);
});

test('waiting reasons distinguish dashboard acknowledgment, confirmation and incident acceptance',()=>{
  const {a,advance,frame}=harness();const s=a.control({action:'enable'});
  assert.match(a.snapshot().waiting_reason,/dashboard.*acknowledge/);
  a.control({action:'heartbeat',session_id:s.session_id});
  assert.match(a.snapshot().waiting_reason,/Searching/);
  advance(200);frame();assert.match(a.snapshot().waiting_reason,/1\/5/);
  for(let i=0;i<4;i++){advance(200);frame();}
  assert.match(a.snapshot().waiting_reason,/incident record/);
  a.incident({episode_id:'fire-episode',source:'yolo',label:'fire',id:'accepted'});
  assert.match(a.snapshot().waiting_reason,/measured position and takeoff readiness/);
});

test('receiver calibration metadata is bounded and cannot mutate after ingestion',()=>{
  const {a}=harness();
  const calibration={qr_side_m:.12,offset_body_m:[.08,0,0],image_size:[1280,720],rms_px:.344,
    qr_verified:true,profile_verified:null};
  const status=()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready',calibration});
  assert.deepEqual(status().receiver.calibration,calibration);
  calibration.offset_body_m[0]=.1;
  assert.equal(a.snapshot().receiver.calibration.offset_body_m[0],.08);
  for(const invalid of [{qr_side_m:1},{offset_body_m:[0,0]},{image_size:[1280,NaN]},
    {rms_px:-1},{qr_verified:'yes'},{profile_verified:'unknown'}])
    assert.throws(()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready',calibration:{...calibration,...invalid}}),/calibration summary/);
});

test('adaptive QR scale mode accepts unknown physical width without asserting metric position',()=>{
  const {a}=harness();
  const body={receiver_id:'receiver-123',ready:true,reason:'Ready',qr_scale_mode:'adaptive',
    calibration:{qr_side_m:null,offset_body_m:[.08,0,0],image_size:[1280,720],rms_px:.344,
      qr_verified:false,profile_verified:null}};
  const status=a.status(body);
  assert.equal(status.receiver.qr_scale_mode,'adaptive');
  assert.equal(status.receiver.calibration.qr_side_m,null);
  assert.equal(status.receiver.position,null);
  assert.throws(()=>a.status({...body,qr_scale_mode:'guessed'}),/scale mode/);
  assert.throws(()=>a.status({...body,qr_scale_mode:'measured'}),/calibration summary/);
});
test('cached, wrong, smoke, low-confidence and old-session detections cannot authorize flight',()=>{
  const {a,frame,confirm,advance}=harness();confirm();a.control({action:'enable'});advance(200);
  assert.equal(a.snapshot().target,null);
  for(const hit of [{source:'yolo',label:'smoke',confidence:.9,bbox:[.3,.3,.5,.5]},
    {source:'qr-test',label:'fire',confidence:1,qr_text:'EW1:Other',bbox:[.3,.3,.5,.5]},
    {source:'yolo',label:'fire',confidence:.2,bbox:[.3,.3,.5,.5]}]) assert.throws(()=>frame({hit}),/Invalid fire target/);
  for(let i=0;i<10;i++)frame();assert.equal(a.snapshot().target,null);
});
test('old frames cannot restore a cleared rectangle and a new episode must reconfirm',()=>{
  const {a,frame,confirm,advance,now}=harness();a.control({action:'enable'});confirm();
  const old=new Date(now()).toISOString();advance(200);frame({hit:null});
  frame({captured_at:old});assert.equal(a.snapshot().observed_target,null);
  advance(200);frame({episode_id:'new-episode'});
  assert.equal(a.snapshot().observed_target.hits,1);
  assert.equal(a.snapshot().target,null);
});
test('target loss, identity switches, expiry, receiver restart and LAND invalidate authorization',()=>{
  const {a,confirm,advance,frame}=harness(); const session=a.control({action:'enable'});confirm();
  advance(200);frame({hit:null});assert.equal(a.snapshot().target,null);
  confirm();advance(200);frame({episode_id:'different-fire'});assert.equal(a.snapshot().target,null);
  advance(6000);assert.equal(a.snapshot().enabled,false);
  a.control({action:'enable'});a.status({receiver_id:'replacement-123',ready:true,reason:'Ready'});
  assert.equal(a.snapshot().enabled,false);
  assert.throws(()=>a.control({action:'heartbeat',session_id:session.session_id}),/expired/);
});

test('two one-second receiver timeouts can recover within the three-second control grace',()=>{
  let clock=1_000_000;const a=new AutonomousResponse(()=>clock);
  const receiver=()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready',aircraft_connected:true});
  receiver();const s=a.control({action:'enable'});
  a.control({action:'heartbeat',session_id:s.session_id});
  // An open dashboard continues its own heartbeat while Pi requests time out.
  for(const elapsed of [1150,2300]){
    clock=1_000_000+elapsed;
    assert.equal(a.control({action:'heartbeat',session_id:s.session_id}).enabled,true);
    assert.ok(a.snapshot().receiver);
  }
  clock=1_002_450;assert.equal(receiver().enabled,true);
  assert.equal(a.snapshot().session_id,s.session_id);
  clock+=2999;a.control({action:'heartbeat',session_id:s.session_id});
  assert.equal(a.snapshot().enabled,true);
  clock+=1;
  assert.equal(a.snapshot().enabled,false,'permission expires at exactly three seconds without the receiver');
  assert.equal(a.snapshot().receiver,null);
  assert.equal(receiver().enabled,false,'a reconnect never restores expired flight permission');
});

test('receiver contact cannot prolong a missing dashboard heartbeat beyond five seconds',()=>{
  let clock=1_000_000;const a=new AutonomousResponse(()=>clock);
  const receiver=()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready'});
  receiver();const s=a.control({action:'enable'});a.control({action:'heartbeat',session_id:s.session_id});
  for(const elapsed of [2000,4000,4999]){clock=1_000_000+elapsed;assert.equal(receiver().enabled,true);}
  clock=1_005_000;assert.equal(receiver().enabled,false);
});
test('control and receiver endpoints enforce separate tokens',async()=>{
  const app=createApp({ingestToken:'ingest',dashboardToken:'dashboard',allowedOrigins:[],storage:new MemoryStorage()});
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const [path,token,status] of [['/api/autonomy','ingest',401],['/api/ingest/autonomy','dashboard',401],['/api/autonomy','dashboard',200],['/api/ingest/autonomy','ingest',200]]) {
      const res=await fetch(base+path,{headers:{authorization:'Bearer '+token}});assert.equal(res.status,status);
    }
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('main person and overlay APIs coexist with incident-backed autonomous claims',async()=>{
  let clock=2_000_000;
  const server=http.createServer(createApp({ingestToken:'ingest',dashboardToken:'dashboard',
    allowedOrigins:[],storage:new MemoryStorage(),now:()=>clock}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  /** Exercise only this test's ephemeral backend with distinct test credentials. */
  const request=(route,body,token=body?'ingest':'dashboard')=>fetch(base+route,{
    method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:body?JSON.stringify(body):undefined});
  const receiver={receiver_id:'merged-receiver',ready:true,reason:'Ready',phase:'waiting'};
  const hit={source:'yolo',label:'fire',confidence:.9,bbox:[.3,.3,.5,.5]};
  try {
    assert.equal((await request('/api/ingest/autonomy/status',receiver)).status,200);
    const session=await request('/api/autonomy',{action:'enable'},'dashboard').then(r=>r.json());
    assert.equal((await request('/api/autonomy',{action:'heartbeat',session_id:session.session_id},'dashboard')).status,200);
    assert.equal((await request('/api/ingest/person/sighting',{
      obs_id:'merged-observation',track_id:'merged-person',observed_at:new Date(clock).toISOString(),
      provenance:'live',sensor:'visible',label:'person',detector:'fixture-model',detector_score:.8,
      bbox:[.4,.4,.6,.8],location_reason:'pose-unavailable'})).status,200);
    assert.equal((await request('/api/ingest/overlays',{
      captured_at:new Date(clock).toISOString(),detections:[hit]})).status,200);
    assert.equal((await request('/api/ingest/vision',{
      observed_at:new Date(clock).toISOString(),model_status:'ready',people_model_status:'ready',
      camera_state:'live',last_person_at:new Date(clock).toISOString()})).status,200);
    for(let i=0;i<6;i++){
      clock+=200;
      assert.equal((await request('/api/ingest/autonomy/status',receiver)).status,200);
      assert.equal((await request('/api/ingest/autonomy/target',{
        captured_at:new Date(clock).toISOString(),width:1280,height:720,episode_id:'merged-fire',hit})).status,200);
    }
    const claim={receiver_id:receiver.receiver_id,session_id:session.session_id,episode_id:'merged-fire'};
    assert.equal((await request('/api/ingest/autonomy/claim',claim)).status,409,
      'Person/overlay evidence must not replace an accepted fire incident');
    const detection=await request('/api/ingest/detection',{
      detected_at:new Date(clock).toISOString(),episode_id:'merged-fire',...hit}).then(r=>r.json());
    assert.equal(detection.accepted,true);
    const claimed=await request('/api/ingest/autonomy/claim',claim).then(r=>r.json());
    assert.equal(claimed.mission.incident_id,detection.id);
    const people=await request('/api/people').then(r=>r.json());
    assert.equal(people.unlocated_sightings[0].track_id,'merged-person');
    assert.equal(people.leads.length,0);
    const status=await request('/api/status').then(r=>r.json());
    assert.equal(status.vision.people_model_status,'ready');
    assert.equal(status.gemini.automatic_analysis,false);
    const stopped=await request('/api/autonomy',{action:'land'},'dashboard').then(r=>r.json());
    assert.equal(stopped.enabled,false);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('camera-only requests work without flight calibration and expire without enabling flight',()=>{
  const {a,advance}=harness();
  a.status({receiver_id:'receiver-123',ready:false,camera_ready:true,reason:'Calibration missing'});
  const s=a.control({action:'camera',pitch_deg:-45});
  assert.equal(s.enabled,false);assert.equal(s.camera.pitch_deg,-45);
  assert.equal(s.camera.receiver_id,'receiver-123');assert.equal(s.mission,null);
  assert.equal(a.control({action:'camera',pitch_deg:-30}).camera.pitch_deg,-30);
  assert.equal(a.control({action:'camera',pitch_deg:-55}).camera.pitch_deg,-55);
  assert.throws(()=>a.control({action:'camera',pitch_deg:80}),/Select/);
  advance(6000);assert.equal(a.snapshot().camera,null);
  a.status({receiver_id:'receiver-123',ready:true,camera_ready:true,reason:'Ready'});
  a.control({action:'enable'});
  assert.throws(()=>a.control({action:'camera',pitch_deg:-45}),/OFF/);
});

test('metric QR corners stay attached to their exact captured frame and malformed geometry is rejected',()=>{
  const {a,frame,advance}=harness();
  const corners=[[400,200],[500,200],[500,300],[400,300]];
  const hit={source:'qr-test',label:'fire',confidence:1,bbox:[.3,.2,.5,.5],qr_text:FIRE_MARKER_PAYLOAD,qr_corners:corners};
  frame({hit});assert.deepEqual(a.snapshot().observed_target.qr_corners,corners);
  corners[0][0]=99;assert.equal(a.snapshot().observed_target.qr_corners[0][0],400);
  advance(200);
  assert.throws(()=>frame({hit:{...hit,qr_corners:[[0,0],[2000,0],[2,2],[0,2]]}}),/corners/);
  frame({hit});assert.deepEqual(a.snapshot().observed_target.qr_corners,corners);
});

test('short-test receiver exposes bounded limits while normal mode keeps 40 percent',()=>{
  const {a}=harness();assert.equal(a.snapshot().min_start_battery_pct,40);
  a.status({receiver_id:'receiver-123',ready:false,reason:'Calibration missing',short_test:true});
  const s=a.snapshot();assert.equal(s.flight_seconds,60);assert.equal(s.min_start_battery_pct,30);
  assert.equal(s.min_flight_battery_pct,25);assert.equal(s.enabled,false);
});

test('receiver communicates source-specific localization without pretending RGB has measured distance',()=>{
  const {a}=harness();a.control({action:'enable'});
  const status=a.status({receiver_id:'receiver-123',ready:true,reason:'RGB ground plane is not verified',
    localization_sources:['qr-test'],blocked_source:'yolo'});
  assert.equal(status.enabled,true);
  assert.deepEqual(status.receiver.localization_sources,['qr-test']);
  assert.equal(status.receiver.blocked_source,'yolo');
  assert.throws(()=>a.status({receiver_id:'receiver-123',ready:true,reason:'Ready',localization_sources:['guessed']}),/localization sources/);
});

test('BOSCO explicitly enables search and response together and never survives stop or receiver replacement',()=>{
  const {a,confirm}=harness();
  assert.throws(()=>a.control({action:'enable',camera_search:true}),/search is not ready/);
  a.status({receiver_id:'receiver-123',ready:true,camera_ready:true,camera_search_supported:true,reason:'Ready'});
  assert.throws(()=>a.control({action:'enable',camera_search:'true'}),/boolean/);
  const s=a.control({action:'enable',camera_search:true});
  assert.equal(s.camera_search,true);assert.equal(s.enabled,true);
  a.control({action:'heartbeat',session_id:s.session_id});confirm('qr-test');
  assert.equal(a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'}).camera_search,true);
  assert.equal(a.control({action:'land'}).camera_search,false);
  a.status({receiver_id:'receiver-123',ready:true,camera_ready:true,camera_search_supported:true,reason:'Ready'});
  a.control({action:'enable',camera_search:true});
  a.status({receiver_id:'replacement-123',ready:true,reason:'Ready'});
  assert.equal(a.snapshot().camera_search,false);assert.equal(a.snapshot().enabled,false);
});

test('a search failure ends authorization even before a flight is claimed',()=>{
  const {a}=harness();a.control({action:'enable'});
  a.status({receiver_id:'receiver-123',ready:false,reason:'Camera rejected command',phase:'error',search_state:'error'});
  assert.equal(a.snapshot().enabled,false);assert.equal(a.snapshot().receiver.search_state,'error');
});

test('aircraft power-off ends a session even while the receiver heartbeat remains alive',()=>{
  const {a,confirm}=harness();const s=a.control({action:'enable'});confirm();
  a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'});
  a.status({receiver_id:'receiver-123',ready:false,aircraft_connected:false,reason:'Disconnected',phase:'climb'});
  assert.equal(a.snapshot().enabled,false);
  a.status({receiver_id:'receiver-123',ready:true,aircraft_connected:true,reason:'Ready'});
  assert.equal(a.snapshot().enabled,false);
});

test('claimed fire tracks fresh same-episode frames without repeating initial five-hit confirmation',()=>{
  const {a,confirm,frame,advance}=harness();const s=a.control({action:'enable'});confirm('qr-test');
  a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'});
  advance(200);frame({hit:null});assert.equal(a.snapshot().target,null);
  advance(200);frame({hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:FIRE_MARKER_PAYLOAD}});
  assert.equal(a.snapshot().target.hits,1);
  advance(200);frame({episode_id:'other-fire'});assert.equal(a.snapshot().target,null);
  advance(200);frame();assert.equal(a.snapshot().target,null,'RGB cannot replace the claimed QR');
});

test('claim preserves the accepted target across real capture-to-request latency',()=>{
  const {a,confirm,advance}=harness();const s=a.control({action:'enable'});confirm('qr-test');
  const captured=a.snapshot().target.at;
  advance(150);
  const claimed=a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'});
  assert.equal(claimed.target.at,captured);
  assert.equal(claimed.target.incident_id,claimed.mission.incident_id);
  assert.ok(claimed.mission.claimed_at>captured);
});

test('an in-flight camera frame from before enable cannot poison subsequent fresh confirmation',()=>{
  const {a,frame,confirm,advance,now}=harness();
  const captured=new Date(now()).toISOString();advance(200);a.control({action:'enable'});
  frame({captured_at:captured});assert.equal(a.snapshot().target,null);
  confirm();assert.ok(a.snapshot().target);
  assert.ok(a.snapshot().target.first> Date.parse(captured));
});

test('bounded optical tracking needs initial decoded authorization and cannot outlive its decode',()=>{
  const {a,confirm,frame,advance,now}=harness();const s=a.control({action:'enable'});
  const hit={source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:FIRE_MARKER_PAYLOAD,
    qr_corners:[[400,200],[500,200],[500,300],[400,300]],qr_tracking:'optical-flow',qr_decoded_at:now()};
  for(let i=0;i<6;i++){advance(200);frame({hit});}
  a.incident({episode_id:'fire-episode',source:'qr-test',label:'fire',id:'incident'});
  assert.equal(a.snapshot().target,null,'tracked payload cannot authorize takeoff');
  confirm('qr-test');a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'});
  hit.qr_decoded_at=now();advance(200);frame({hit});
  assert.equal(a.snapshot().target.qr_tracking,'optical-flow');
  a.control({action:'heartbeat',session_id:s.session_id});
  for(let i=0;i<3;i++){advance(800);a.control({action:'heartbeat',session_id:s.session_id});}
  assert.throws(()=>frame({hit}),/recent decode/);
  assert.equal(a.snapshot().target,null);
});

test('verified template corners continue only their already claimed QR mission',()=>{
  const {a,confirm,frame,advance,now}=harness();const s=a.control({action:'enable'});
  const hit={source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:FIRE_MARKER_PAYLOAD,
    qr_corners:[[400,200],[500,200],[500,300],[400,300]],qr_tracking:'visual-template',
    qr_decoded_at:now(),qr_template_score:.92,qr_template_data_score:.8,
    qr_template_module_error:.02,qr_template_module_coverage:.8};
  assert.throws(()=>frame({hit}),/claimed matching fire/);
  confirm('qr-test');hit.qr_decoded_at=now();
  a.claim({receiver_id:'receiver-123',session_id:s.session_id,episode_id:'fire-episode'});
  for(let i=0;i<20;i++){
    advance(200);a.control({action:'heartbeat',session_id:s.session_id});frame({hit});
    assert.equal(a.snapshot().target.qr_tracking,'visual-template');
  }
  assert.ok(now()-hit.qr_decoded_at>2500,'independent fresh shape validation can continue beyond optical-flow grace');
  advance(200);
  for(const invalid of [{...hit,qr_template_score:.84},{...hit,qr_template_data_score:.64},
    {...hit,qr_template_module_error:.056},{...hit,qr_template_module_error:undefined},
    {...hit,qr_template_module_coverage:.54},
    {...hit,qr_template_score:NaN},{...hit,qr_decoded_at:hit.qr_decoded_at-2000}])
    assert.throws(()=>frame({hit:invalid}),/verified visual evidence/);
  assert.throws(()=>frame({hit,episode_id:'other-fire'}),/verified visual evidence/);
  for(let i=0;i<9;i++){advance(1800);a.control({action:'heartbeat',session_id:s.session_id});}
  assert.throws(()=>frame({hit}),/verified visual evidence/,'a long visual absence needs a fresh exact decode');
});
