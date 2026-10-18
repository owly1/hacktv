import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp,MemoryStorage} from '../backend/server.mjs';
import {FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS} from '../backend/validation.mjs';

test('QR claim, actual frame inference, D ownership, progress, sightings and X work together over authenticated HTTP',async()=>{
  let clock=2_000_000;
  const storage=new MemoryStorage();
  const server=http.createServer(createApp({ingestToken:'test-ingest',dashboardToken:'test-dashboard',
    allowedOrigins:[],storage,now:()=>clock,divePersonDetector:async()=>[{score:.9,bbox:[.2,.2,.4,.9]}]}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  /** Send only to this isolated, ephemeral test server with fake credentials. */
  const request=async(route,body,ingest=false)=>{
    const response=await fetch(base+route,{method:body?'POST':'GET',
      headers:{authorization:`Bearer test-${ingest?'ingest':'dashboard'}`,'content-type':'application/json'},
      body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  };
  const receiver={receiver_id:'combined-receiver',ready:true,reason:'Ready',phase:'waiting',until_stop:true};
  const diveReceiver={receiver_id:'combined-search',ready:true,reason:'Circle ready',phase:'circling'};
  const hit={source:'qr-test',label:'fire',confidence:1,bbox:[.3,.3,.5,.5],qr_text:FIRE_MARKER_PAYLOAD};
  const command={type:'dive-surveillance',request_id:'combined-request',target_altitude_m:.4,sweep_deg:360};
  /** Feed a real HTTP camera frame; the detector itself is explicitly injected/fake. */
  const frame=async()=>{
    const response=await fetch(base+'/api/ingest/frame',{method:'POST',headers:{authorization:'Bearer test-ingest',
      'content-type':'image/jpeg','x-captured-at':new Date(clock).toISOString()},body:Buffer.from([255,216,255,224,0,0,255,217])});
    assert.equal(response.status,204);await new Promise(resolve=>setImmediate(resolve));
  };
  try {
    assert.equal((await fetch(base+'/api/dive')).status,401);
    await request('/api/ingest/autonomy/status',receiver,true);
    await request('/api/ingest/dive/status',diveReceiver,true);
    assert.equal((await request('/api/commands',command)).status,409,'D cannot independently authorize takeoff');
    const session=(await request('/api/autonomy',{action:'enable'})).body;
    await request('/api/autonomy',{action:'heartbeat',session_id:session.session_id});
    for(let i=0;i<6;i++){
      clock+=200;await request('/api/ingest/autonomy/status',receiver,true);
      await request('/api/ingest/autonomy/target',{captured_at:new Date(clock).toISOString(),width:1280,height:720,episode_id:'combined-fire',hit},true);
    }
    assert.equal((await request('/api/ingest/detection',{detected_at:new Date(clock).toISOString(),episode_id:'combined-fire',
      ...hit,details:FIRE_MARKER_DETAILS},true)).status,200);
    const claim=await request('/api/ingest/autonomy/claim',{receiver_id:receiver.receiver_id,session_id:session.session_id,episode_id:'combined-fire'},true);
    assert.equal(claim.status,200);assert.ok(claim.body.mission);
    await storage.insertTelemetry({observed_at:new Date(clock).toISOString(),provenance:'live',altitude_m:1,battery_pct:80});
    await frame();await request('/api/ingest/dive/status',diveReceiver,true);
    const readiness=(await request('/api/dive')).body;
    assert.equal(readiness.workflow,'qr-circle-dive-v1');assert.equal(readiness.ready,true);assert.equal(readiness.person_detection.fresh,true);
    const queued=await request('/api/commands',command);assert.equal(queued.status,200);
    const {id,session_id}=queued.body;
    assert.equal((await request('/api/commands/next?receiver_id=combined-search',undefined,true)).body.command,null);
    await request(`/api/commands/${id}/heartbeat`,{session_id});
    assert.equal((await request('/api/commands/next?receiver_id=combined-search',undefined,true)).body.command.id,id);
    assert.equal((await request(`/api/commands/${id}/ack`,{receiver_id:'combined-search',status:'in_progress'},true)).status,200);
    const control=(await request('/api/ingest/dive/status',{...diveReceiver,ready:false,phase:'searching',command_id:id},true)).body;
    assert.equal(control.authorized,true);
    clock+=1600;await frame();
    const progress=(await request('/api/dive')).body;
    assert.equal(progress.commands.at(-1).person_observations,1);assert.equal(progress.receiver.phase,'searching');
    assert.equal((await request('/api/dive/land',{})).status,200);
    assert.equal((await request('/api/autonomy')).body.enabled,false);
    const stopped=(await request('/api/ingest/dive/status',{...diveReceiver,phase:'landing',command_id:id},true)).body;
    assert.equal(stopped.authorized,false);assert.ok(stopped.stop_id);
    assert.equal((await request(`/api/commands/${id}/ack`,{receiver_id:'combined-search',status:'done'},true)).status,409);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
