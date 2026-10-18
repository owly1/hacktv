import {parentPort} from 'node:worker_threads';
import {getPersonModel,detectPersons} from './personcv.mjs';

/** Execute real CPU inference off the HTTP/control thread; preserve errors as errors. */
parentPort.on('message',async jpeg=>{
  try{const model=await getPersonModel();parentPort.postMessage({persons:await detectPersons(model,Buffer.from(jpeg))});}
  catch(error){parentPort.postMessage({error:String(error.message).slice(0,200)});}
});
