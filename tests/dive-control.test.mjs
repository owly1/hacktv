import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DiveControl} from '../backend/dive-control.mjs';

/** Supply fresh fake evidence without loading a model or contacting an aircraft. */
function harness() {
  let time=10000;const d=new DiveControl(()=>time);
  const context={video_fresh:true,telemetry_fresh:true,person_detection:{fresh:true,model_status:'ready'}};
  const receiver=()=>d.status({receiver_id:'receiver-one',ready:true,reason:'Ready',phase:'idle'});
  receiver();
  const enqueue=(over={})=>d.enqueue({type:'dive-surveillance',request_id:'request-one',...over},context);
  return {d,context,receiver,enqueue,advance:ms=>{time+=ms;}};
}

test('movement requires explicit ownership confirmation, exact receiver and a valid transition',()=>{
  const {d,context,enqueue}=harness();const c=enqueue();
  assert.equal(d.next('receiver-one'),null,'lost enqueue reply cannot authorize flight');
  assert.throws(()=>d.heartbeat(c.id,'wrong-session'),/expired/);
  d.heartbeat(c.id,c.session_id);
  assert.throws(()=>d.next('other-receiver'),/registered/);
  const next=d.next('receiver-one');assert.equal(next.id,c.id);
  assert.equal(d.next('receiver-one').id,c.id,'dropped delivery remains retryable');
  assert.throws(()=>d.ack(c.id,{receiver_id:'receiver-one',status:'done'}),/transition/);
  d.ack(c.id,{receiver_id:'receiver-one',status:'in_progress'});
  assert.equal(d.next('receiver-one'),null);
  assert.equal(d.control('receiver-one',c.id,context).authorized,true);
  d.observePersons(10001,[{score:.9},{score:.8}]);
  d.ack(c.id,{receiver_id:'receiver-one',status:'done',note:'Measured return confirmed'});
  const status=d.snapshot(context);assert.equal(status.commands.at(-1).person_observations,2);
  assert.equal(status.commands.at(-1).status,'done');assert.equal(status.commands[0].session_id,undefined);
  assert.equal(d.control('receiver-one',c.id,context).authorized,false);
});

test('duplicate start is idempotent and concurrent searches are rejected',()=>{
  const {d,enqueue}=harness();const c=enqueue();assert.deepEqual(enqueue(),c);
  assert.throws(()=>enqueue({request_id:'request-two'}),/already active/);
  assert.equal(d.commands.length,1);
});

test('receiver, video, telemetry and person inference are all required before starting',()=>{
  for(const fault of ['receiver','video_fresh','telemetry_fresh','person_detection']){
    const {d,context,enqueue,advance}=harness();
    if(fault==='receiver')advance(3100);else if(fault==='person_detection')context.person_detection={fresh:false,error:'Model failed'};else context[fault]=false;
    assert.throws(()=>enqueue(),error=>error.status===409);
    assert.equal(d.snapshot(context).ready,false);
  }
});

test('stale dashboard, changed receiver, lost detector and LAND never resume an old search',()=>{
  for(const fault of ['heartbeat','receiver','detector','land']){
    const {d,context,enqueue,advance,receiver}=harness();const c=enqueue();d.heartbeat(c.id,c.session_id);
    d.next('receiver-one');d.ack(c.id,{receiver_id:'receiver-one',status:'in_progress'});
    if(fault==='heartbeat'){advance(5100);receiver();}
    if(fault==='receiver')d.status({receiver_id:'receiver-new',ready:true,reason:'Ready',phase:'idle'});
    if(fault==='detector')context.person_detection.fresh=false;
    if(fault==='land')d.land();
    assert.equal(d.control('receiver-one',c.id,context).authorized,false);
    if(fault!=='detector')assert.throws(()=>d.ack(c.id,{receiver_id:'receiver-one',status:'done'}),/transition/);
  }
});

test('old pending commands expire instead of executing after reconnect, and params reject invalid numbers',()=>{
  const {d,context,enqueue,advance,receiver}=harness();enqueue();advance(5100);receiver();
  assert.equal(d.next('receiver-one'),null);assert.equal(d.snapshot(context).commands[0].status,'aborted');
  for(const params of [{target_altitude_m:null,sweep_deg:NaN},{target_altitude_m:.1},{target_altitude_m:'0.4'},{sweep_deg:720}])
    assert.throws(()=>enqueue({request_id:crypto.randomUUID(),...params}));
});

test('a lost delivery followed by expiry does not strand the receiver in a busy queue',()=>{
  const {d,context,enqueue,advance,receiver}=harness();const c=enqueue();d.heartbeat(c.id,c.session_id);
  d.next('receiver-one');advance(5100);receiver();
  assert.equal(d.snapshot(context).commands[0].status,'aborted');
  assert.equal(d.snapshot(context).ready,true);
  assert.equal(enqueue({request_id:'new-request'}).status,'pending');
});
