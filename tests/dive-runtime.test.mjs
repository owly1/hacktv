import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DiveRuntime} from '../backend/dive-runtime.mjs';

test('inference completion and camera capture both expire; missing/failed models never authorize a search',async()=>{
  let now=10000;const runtime=new DiveRuntime({now:()=>now,detector:async()=>[{score:.91,bbox:[.1,.2,.3,.8]}]});
  assert.equal(runtime.health().fresh,false);await runtime.frame(Buffer.alloc(0),now);
  assert.equal(runtime.health().fresh,true);assert.equal(runtime.health().people_in_last_frame,1);
  now+=5100;assert.equal(runtime.health().fresh,false);
  runtime.detector=async()=>{throw new Error('model unavailable');};await runtime.frame(Buffer.alloc(0),now);
  assert.equal(runtime.health().fresh,false);assert.match(runtime.health().error,/model unavailable/);
  assert.equal(new DiveRuntime().health().model_status,'disabled');
});

test('single inference cannot block control polling and cannot overlap another inference',async()=>{
  let resolve,calls=0;const runtime=new DiveRuntime({detector:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const at=Date.now(),pending=runtime.frame(Buffer.alloc(0),at);
  await runtime.frame(Buffer.alloc(0),at+2000);assert.equal(calls,1);
  assert.equal(runtime.control.snapshot({flight_authorized:false}).ready,false);
  resolve([]);await pending;assert.equal(runtime.health().fresh,true);
});

test('combined search requires original QR flight ownership in addition to the D lease',()=>{
  const runtime=new DiveRuntime();runtime.control.status({receiver_id:'receiver-one',ready:true,reason:'ready',phase:'circling'});
  const context={flight_authorized:false,video_fresh:true,telemetry_fresh:true,person_detection:{fresh:true}};
  assert.throws(()=>runtime.control.enqueue({type:'dive-surveillance',request_id:'request-one'},context),/Start BOSCO/);
  context.flight_authorized=true;const c=runtime.control.enqueue({type:'dive-surveillance',request_id:'request-one'},context);
  runtime.control.heartbeat(c.id,c.session_id);runtime.control.next('receiver-one');
  runtime.control.ack(c.id,{receiver_id:'receiver-one',status:'in_progress'});
  context.flight_authorized=false;assert.equal(runtime.control.control('receiver-one',c.id,context).authorized,false);
});
