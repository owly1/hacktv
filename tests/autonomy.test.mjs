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
    for(let i=0;i<6;i++){advance(200);frame({hit:{...hit,source,qr_text:FIRE_MARKER_PAYLOAD}});}
    a.incident({episode_id:'fire-episode',source,label:'fire',id:'accepted-incident'});
  };
  return {a,receiver,frame,advance,confirm,now:()=>clock};
}

test('starts disabled; enable needs a ready receiver and never restores authorization',()=>{
  const {a}=harness();assert.equal(a.snapshot().enabled,false);
  a.status({receiver_id:'receiver-123',ready:false,reason:'Calibration missing'});
  assert.throws(()=>a.control({action:'enable'}),/Calibration/);
  assert.equal(new AutonomousResponse().snapshot().enabled,false);
});
test('fresh confirmed RGB and exact QR fires can each claim once, after enable and incident acceptance',()=>{
  for(const source of ['yolo','qr-test']){
    const {a,confirm}=harness(); const session=a.control({action:'enable'});
    confirm(source);assert.ok(a.snapshot().target);
    const claim={receiver_id:'receiver-123',session_id:session.session_id,episode_id:'fire-episode'};
    assert.ok(a.claim(claim).mission);assert.throws(()=>a.claim(claim),/unconsumed/);
    a.control({action:'land'}); assert.equal(a.snapshot().enabled,false);
  }
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
