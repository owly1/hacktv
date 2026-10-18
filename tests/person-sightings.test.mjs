import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp, MemoryStorage} from '../backend/server.mjs';

/** Build isolated camera-only evidence for contract tests. */
const sighting = () => ({obs_id:'obs-1',track_id:'person-1',observed_at:new Date().toISOString(),
  provenance:'live',sensor:'visible',label:'person',detector:'fake-model',detector_score:.8,
  bbox:[.4,.4,.6,.8],location_reason:'pose-unavailable'});

test('camera sightings require real provenance, deduplicate, support review and persist without invented coordinates', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bosco-camera-person-'));
  const servers = [];
  /** Start an injectable backend sharing this test's temporary persistence directory. */
  const start = async () => {
    const server = http.createServer(createApp({ingestToken:'ingest',dashboardToken:'dash',storage:new MemoryStorage(),dataDir}));
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); servers.push(server);
    return async (route,body,token=body?'ingest':'dash') => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  };
  try {
    const request = await start(), sample = sighting();
    assert.equal((await request('/api/ingest/person/sighting',sample,'dash')).status,401);
    for (const invalid of [{...sample,provenance:'demo'}, {...sample,bbox:[0,0,2,1]},
      {...sample,track_id:'../bad'}, {...sample,location_reason:'unknown'}]) {
      assert.equal((await request('/api/ingest/person/sighting',invalid)).status,400);
    }
    assert.equal((await request('/api/ingest/person/sighting',sample)).status,200);
    const duplicate = await request('/api/ingest/person/sighting',sample).then(r=>r.json());
    assert.equal(duplicate.accepted,false);
    let snapshot = await request('/api/people').then(r=>r.json());
    assert.equal(snapshot.leads.length,0); assert.equal(snapshot.unlocated_sightings.length,1);
    assert.equal(snapshot.unlocated_sightings[0].latitude,undefined);
    assert.equal(snapshot.unlocated_sightings[0].sightings,1);
    assert.equal((await request('/api/people/sighting/ack',{track_id:sample.track_id,by:''},'dash')).status,400);
    assert.equal((await request('/api/people/sighting/ack',{track_id:sample.track_id,by:'Observer'},'dash')).status,200);
    assert.equal((await request('/api/people/sighting/close',{track_id:sample.track_id,by:'Observer',outcome:'handed-off'},'dash')).status,200);
    // Wait for the debounce save, then verify through a new backend instance.
    const until = Date.now()+3000;
    for (;;) {
      try { const saved=JSON.parse(await readFile(path.join(dataDir,'people/state.json'),'utf8')); if(saved.unlocated_sightings[0]?.closed) break; } catch {}
      if(Date.now()>until) throw new Error('camera sighting was not persisted');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const restored = await start();
    snapshot=await restored('/api/people').then(r=>r.json());
    assert.equal(snapshot.unlocated_sightings[0].acknowledged.by,'Observer');
    assert.equal(snapshot.unlocated_sightings[0].closed.outcome,'handed-off');
  } finally {
    for (const server of servers) {server.close();server.closeAllConnections?.();}
    await rm(dataDir,{recursive:true,force:true});
  }
});
