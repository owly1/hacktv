import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousResponse} from '../backend/autonomy.mjs';
import {FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS,TINY_FIRE_MARKER_PAYLOAD,
  TINY_FIRE_MARKER_DETAILS} from '../backend/validation.mjs';

/** Drive an isolated authorization clock and exact marker evidence without aircraft. */
function harness() {
  let now=1_000_000;
  const a=new AutonomousResponse(()=>now);
  const status={receiver_id:'contour-receiver',ready:true,reason:'Ready',phase:'waiting',
    contour_supported:true,contour_ready:true,contour_reason:'GPS ready'};
  const receiver=(extra={})=>a.status({...status,...extra});
  receiver();
  const advance=ms=>{now+=ms;receiver();};
  const frame=(payload=TINY_FIRE_MARKER_PAYLOAD,episode='tiny-episode',extra={})=>a.observe({
    captured_at:new Date(now).toISOString(),width:1280,height:720,episode_id:episode,
    hit:{source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:payload,...extra}});
  const confirm=(payload=TINY_FIRE_MARKER_PAYLOAD,details=TINY_FIRE_MARKER_DETAILS)=>{
    a.control({action:'heartbeat',session_id:a.snapshot().session_id});
    for (let i=0;i<6;i++) {advance(200);frame(payload);}
    a.incident({episode_id:'tiny-episode',source:'qr-test',label:'fire',id:'tiny-incident',details});
  };
  const claim=()=>a.claim({receiver_id:status.receiver_id,session_id:a.snapshot().session_id,episode_id:'tiny-episode'});
  return {a,receiver,advance,frame,confirm,claim};
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
  assert.deepEqual(mission.contour.details,TINY_FIRE_MARKER_DETAILS);
  assert.equal(mission.contour.forecast_minutes,5);
  assert.equal(mission.contour.started_at,mission.claimed_at);
  assert.equal(claim().mission.id,mission.id);
});

test('large Alpha scenario stays circular and cannot claim a contour flight',()=>{
  const {a,confirm,claim}=harness();
  a.control({action:'enable',mode:'contour'});
  confirm(FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  assert.equal(a.snapshot().target,null);
  assert.match(a.snapshot().waiting_reason,/Tiny 1 m²/);
  assert.throws(claim,/authorized/);
  a.control({action:'land'});
  a.control({action:'enable'});
  confirm(FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS);
  assert.equal(claim().mission.mode,'circle');
  assert.equal(a.snapshot().radius_m,1);
});

test('GPS readiness is rechecked at claim; airborne permission still expires on lost heartbeat',()=>{
  const {a,confirm,claim,receiver,advance}=harness();
  a.control({action:'enable',mode:'contour'});confirm();
  receiver({contour_ready:false,contour_reason:'GPS accuracy unavailable'});
  assert.throws(claim,/GPS accuracy/);
  receiver();claim();
  for(let i=0;i<5;i++) advance(1000);
  assert.equal(a.snapshot().enabled,false);
  assert.equal(a.snapshot().mission,null);
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
    anchor:{latitude:43.78,longitude:-79.18,position_source:'gps'},speed_mps:.06};
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
