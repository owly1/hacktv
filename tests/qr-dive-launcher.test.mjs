import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkCombinedBackend} from '../scripts/qr-dive-demo.mjs';

test('combined startup may create a missing backend and reuse only an enabled person-search backend',async()=>{
  await checkCombinedBackend('http://localhost',async()=>{throw new Error('ECONNREFUSED');});
  const paths=[];
  await checkCombinedBackend('http://localhost',async(url,options)=>{
    paths.push(url);
    if(url.endsWith('/api/session'))return {ok:true,json:async()=>({token:'fake-dashboard-token'})};
    assert.equal(options.headers.authorization,'Bearer fake-dashboard-token');
    return {ok:true,json:async()=>({workflow:'qr-circle-dive-v1',person_detection:{model_status:'loading'}})};
  });
  assert.deepEqual(paths,['http://localhost/api/session','http://localhost/api/dive']);
});

test('combined startup refuses a normal disabled worker or incompatible backend instead of silently reusing it',async()=>{
  for(const result of [null,{workflow:'old'}, {workflow:'qr-circle-dive-v1',person_detection:{model_status:'disabled'}}]){
    await assert.rejects(checkCombinedBackend('http://localhost',async url=>url.endsWith('/api/session')
      ?{ok:true,json:async()=>({token:'fake'})}:{ok:result!==null,json:async()=>result}),/Stop the existing backend/);
  }
});
