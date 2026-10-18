// Start only the laptop dashboard and separate person inference worker. No aircraft commands.
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {main,options} from './demo.mjs';

/** Reject reuse of an older/normal backend that cannot run the requested person worker. */
export async function checkCombinedBackend(base,fetchImpl=fetch) {
  let response;
  try{response=await fetchImpl(base+'/api/session',{signal:AbortSignal.timeout(1500)});}
  catch{return;}
  const message='Stop the existing backend in its owner terminal, then rerun npm run qr-dive. Its person-search runtime is not enabled.';
  if(!response.ok)throw new Error(message);
  const session=await response.json();
  const status=await fetchImpl(base+'/api/dive',{headers:{authorization:'Bearer '+session.token},signal:AbortSignal.timeout(1500)});
  if(!status.ok)throw new Error(message);
  const dive=await status.json();
  if(dive.workflow!=='qr-circle-dive-v1'||!dive.person_detection||dive.person_detection.model_status==='disabled')throw new Error(message);
}

/** Start only the explicitly selected laptop workflow, preserving the existing aircraft-off startup. */
async function launch() {
  const root=fileURLToPath(new URL('../',import.meta.url));
  if(existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
  process.env.BOSCO_DIVE_PERSON_CV='1';
  if(!process.argv.includes('--live'))process.argv.push('--live');
  const {port}=options(process.argv.slice(2));
  await checkCombinedBackend(`http://127.0.0.1:${port}`);
  await main();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  launch().catch(error=>{console.error(error.message);process.exitCode=1;});
}
