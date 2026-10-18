import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousResponse} from '../backend/autonomy.mjs';
import {OUTDOOR_CONTOUR_PROFILE,OUTDOOR_CONTOUR_DETAILS} from '../backend/contour-profile.mjs';
import {FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS,TINY_FIRE_MARKER_PAYLOAD,
  TINY_FIRE_MARKER_DETAILS} from '../backend/validation.mjs';

/** Drive an isolated authorization clock and exact marker evidence without aircraft. */
function harness() {
  let now=1_000_000;
  const a=new AutonomousResponse(()=>now);
  const status={receiver_id:'contour-receiver',ready:true,reason:'Ready',phase:'waiting',
    contour_supported:true,contour_ready:true,airborne_search_supported:true,contour_reason:'GPS ready',
    contour_profile:OUTDOOR_CONTOUR_PROFILE};
  const receiver=(extra={})=>a.status({...status,...extra});
  receiver();
  const advance=ms=>{now+=ms;receiver();};
  const frame=(payload=TINY_FIRE_MARKER_PAYLOAD,episode='tiny-episode',extra={})=>a.observe({
    captured_at:new Date(now).toISOString(),width:1280,height:720,episode_id:episode,
    hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:payload,...extra}});
  const confirm=(payload=TINY_FIRE_MARKER_PAYLOAD,details=TINY_FIRE_MARKER_DETAILS)=>{
    a.control({action:'heartbeat',session_id:a.snapshot().session_id});
    if (a.snapshot().mode==='contour' && !a.snapshot().search) search();
    for (let i=0;i<6;i++) {advance(200);frame(payload);}
    a.incident({episode_id:'tiny-episode',source:'qr-test',label:'fire',id:'tiny-incident',details});
  };
  const claim=()=>a.claim({receiver_id:status.receiver_id,session_id:a.snapshot().session_id,episode_id:'tiny-episode'});
  const search=(extra={})=>a.claim({stage:'search',receiver_id:status.receiver_id,session_id:a.snapshot().session_id,...extra});
  return {a,receiver,advance,frame,confirm,claim,search};
}

test('legacy enable remains circle; contour requires explicit ready capability and rejects unknown modes',()=>{
  const {a,receiver}=harness();
  receiver({contour_supported:false,contour_ready:false,contour_reason:'GPS accuracy unavailable'});
  assert.equal(a.control({action:'enable'}).mode,'circle');
  a.control({action:'land'});
  assert.throws(()=>a.control({action:'enable',mode:'contour'}),/GPS accuracy/);
  assert.throws(()=>a.control({action:'enable',mode:'fleet'}),/circle or contour/);
  receiver();
  const session=a.control({action:'enable',mode:'contour'});
  assert.equal(session.mode,'contour');
  assert.equal(a.control({action:'heartbeat',session_id:session.session_id,mode:'circle'}).mode,'contour');
  assert.throws(()=>a.control({action:'enable',mode:'circle'}),/already enabled/);
});

test('contour claims use exact Tiny model, matching accepted incident, and retained mission identity',()=>{
  const {a,confirm,claim}=harness();
  a.control({action:'enable',mode:'contour'});
  confirm(TINY_FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  assert.equal(a.snapshot().target,null);
  assert.match(a.snapshot().waiting_reason,/matching Tiny/);
  confirm();
  const mission=claim().mission;
  assert.equal(mission.mode,'contour');
  assert.equal(mission.qr_text,TINY_FIRE_MARKER_PAYLOAD);
  assert.deepEqual(mission.contour.details,OUTDOOR_CONTOUR_DETAILS);
  assert.deepEqual(mission.contour.marker_details,TINY_FIRE_MARKER_DETAILS);
  assert.equal(mission.contour.profile,OUTDOOR_CONTOUR_PROFILE);
  assert.ok(Math.abs(Math.sqrt(mission.contour.details.area_ha*10000/Math.PI)*2-50)<1e-10);
  assert.equal(mission.contour.forecast_minutes,5);
  assert.equal(mission.contour.started_at,mission.claimed_at);
  assert.equal(claim().mission.id,mission.id);
});

test('large Alpha scenario stays circular and cannot claim a contour flight',()=>{
  const {a,confirm,claim}=harness();
  a.control({action:'enable',mode:'contour'});
  confirm(FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  assert.equal(a.snapshot().target,null);
  assert.match(a.snapshot().waiting_reason,/Marker 2/);
  assert.throws(claim,/authorized/);
  a.control({action:'land'});
  a.control({action:'enable'});
  confirm(FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  assert.equal(claim().mission.mode,'circle');
  assert.equal(a.snapshot().radius_m,1);
});

test('GPS readiness is rechecked before search; airborne permission still expires on lost heartbeat',()=>{
  const {a,confirm,claim,receiver,advance,search}=harness();
  const s=a.control({action:'enable',mode:'contour'});
  a.control({action:'heartbeat',session_id:s.session_id});
  receiver({contour_ready:false,contour_reason:'GPS accuracy unavailable'});
  assert.throws(search,/GPS accuracy/);
  receiver();confirm();claim();
  for(let i=0;i<5;i++) advance(1000);
  assert.equal(a.snapshot().enabled,false);
  assert.equal(a.snapshot().mission,null);
});

test('contour takeoff requires new capability, acknowledged enable and exact receiver ownership',()=>{
  const {a,receiver,search}=harness();
  receiver({airborne_search_supported:false});
  assert.throws(()=>a.control({action:'enable',mode:'contour'}),/airborne contour search/);
  receiver();
  const s=a.control({action:'enable',mode:'contour'});
  assert.equal(s.mission,null);
  assert.equal(s.flight_seconds,null,'contour has no normal automatic landing timer');
  assert.throws(search,/authorized/,'a lost enable reply cannot launch an aircraft');
  a.control({action:'heartbeat',session_id:s.session_id});
  assert.throws(()=>search({receiver_id:'other-receiver'}),/authorized/);
  const first=search();
  assert.equal(first.search.height_m,1);
  assert.equal(first.mission,null,'search does not invent a fire');
  const inAir=receiver({ready:false,contour_ready:false,phase:'search',search_state:'airborne-search'});
  assert.equal(inAir.enabled,true);
  assert.equal(inAir.receiver.search_state,'airborne-search');
  assert.equal(search().search.id,first.search.id,'lost claim replies never authorize a second takeoff');
  a.control({action:'land'});
  assert.equal(a.snapshot().search,null);
  assert.throws(search,/authorized/);
});

test('only contour search can hand off to an in-flight exact-marker mission',()=>{
  const {a,receiver,confirm,claim,search}=harness();
  a.control({action:'enable'});
  a.control({action:'heartbeat',session_id:a.snapshot().session_id});
  assert.throws(search,/authorized/,'circle keeps its fire-triggered takeoff');
  assert.equal(a.snapshot().flight_seconds,300);
  a.control({action:'land'});
  a.control({action:'enable',mode:'contour'});confirm();
  receiver({ready:false,contour_ready:false,phase:'holding',search_state:'acquiring'});
  assert.equal(claim().mission.mode,'contour');
  receiver({ready:false,phase:'landed'});
  assert.equal(a.snapshot().enabled,false);
});

test('search authorization retains short-test deadline and expires without receiver or dashboard',()=>{
  const {a,receiver,search,advance}=harness();
  receiver({short_test:true});
  const s=a.control({action:'enable',mode:'contour'});
  assert.equal(s.flight_seconds,60);
  a.control({action:'heartbeat',session_id:s.session_id});search();
  advance(3000);
  assert.equal(a.snapshot().enabled,false);
  assert.throws(search,/authorized/);
});

test('marker switching resets confirmation and cannot renew an existing marker mission',()=>{
  const {a,confirm,claim,advance,frame}=harness();
  a.control({action:'enable'});confirm(FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  const mission=claim().mission,lastSeen=mission.last_visual_at;
  advance(200);frame(TINY_FIRE_MARKER_PAYLOAD);
  assert.equal(a.snapshot().observed_target.hits,1);
  assert.equal(a.snapshot().target,null);
  assert.equal(a.snapshot().mission.last_visual_at,lastSeen);
  advance(200);
  assert.throws(()=>frame(TINY_FIRE_MARKER_PAYLOAD,'tiny-episode',{
    qr_tracking:'visual-template',qr_corners:[[300,200],[400,200],[400,300],[300,300]],
    qr_decoded_at:mission.qr_seed_at,qr_template_score:.95,qr_template_data_score:.9,
    qr_template_module_error:.01,qr_template_module_coverage:.9}),/matching fire/);
});

test('receiver contour telemetry is mission-bound, immutable and discarded after LAND',()=>{
  const {a,confirm,claim,receiver}=harness();
  a.control({action:'enable',mode:'contour'});confirm();const mission=claim().mission;
  const contour={...mission.contour,details:{...mission.contour.details},
    anchor:{latitude:43.78,longitude:-79.18,position_source:'gps'},speed_mps:.5,
    wind_status:'measured',wind:{source:'flight-controller',speed_mps:2,direction_deg:90,observed_at:new Date(mission.claimed_at).toISOString(),age_s:0},
    effective_scenario:{wind:7.2,direction:90,dryness:55,temp:22,rh:45}};
  assert.equal(receiver({contour}).receiver.contour.anchor.latitude,43.78);
  contour.anchor.latitude=44;
  assert.equal(a.snapshot().receiver.contour.anchor.latitude,43.78);
  for(const invalid of [
    {...contour,anchor:{...contour.anchor,position_source:'simulated'}},
    {...contour,started_at:contour.started_at-1},
    {...contour,details:FIRE_MARKER_DETAILS},
    {...contour,speed_mps:5},
  ]) assert.throws(()=>receiver({contour:invalid}),/GPS contour status/);
  a.control({action:'land'});
  assert.equal(receiver({contour}).receiver.contour,null);
});


test('outdoor mode rejects old receivers and forecast weather that is not the actual FC input',()=>{
  const {a,confirm,claim,receiver}=harness();
  receiver({contour_profile:null});
  assert.throws(()=>a.control({action:'enable',mode:'contour'}),/outdoor 50 m/);
  receiver();a.control({action:'enable',mode:'contour'});confirm();const mission=claim().mission;
  const contour={...mission.contour,anchor:{latitude:43.78,longitude:-79.18,position_source:'gps'},speed_mps:.5,
    wind_status:'measured',wind:{source:'flight-controller',speed_mps:0,direction_deg:null,observed_at:new Date(mission.claimed_at).toISOString(),age_s:0},
    effective_scenario:{wind:0,direction:0,dryness:55,temp:22,rh:45}};
  assert.equal(receiver({contour}).receiver.contour.wind.direction_deg,null);
  assert.equal(receiver({contour:{...contour,wind:{...contour.wind,speed_mps:60/3.6,direction_deg:90},
    effective_scenario:{...contour.effective_scenario,wind:60,direction:90}}}).receiver.contour.effective_scenario.wind,60);
  const stale={...contour,wind_status:'stale',wind:{...contour.wind,age_s:120}};
  assert.equal(receiver({contour:stale}).receiver.contour.wind.age_s,120);
  const assumed={...contour,wind_status:'assumed',wind:{source:'qr-scenario-assumption',speed_mps:.2/3.6,direction_deg:60,observed_at:null,age_s:null},
    effective_scenario:{wind:.2,direction:60,dryness:55,temp:22,rh:45}};
  assert.equal(receiver({contour:assumed}).receiver.contour.wind.source,'qr-scenario-assumption');
  for(const invalid of [
    {...contour,wind:{...contour.wind,source:'qr-scenario'}},
    {...contour,wind:{...contour.wind,speed_mps:null}},
    {...contour,wind:{...contour.wind,speed_mps:2}},
    {...contour,effective_scenario:{...contour.effective_scenario,wind:18}},
    {...contour,effective_scenario:{...contour.effective_scenario,temp:30}},
  ]) assert.throws(()=>receiver({contour:invalid}),/GPS contour status/);
});
