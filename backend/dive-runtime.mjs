import {Worker} from 'node:worker_threads';
import {DiveControl} from './dive-control.mjs';

/** Own detector health and commands without blocking the HTTP flight-control event loop. */
export class DiveRuntime {
  constructor({now=Date.now,detector=null}={}) {
    this.now=now;this.detector=detector;this.control=new DiveControl(now);
    this.pending=false;this.lastFrame=-Infinity;this.completed=-Infinity;this.inferred=-Infinity;
    this.lastAttempt=-Infinity;this.count=0;this.error=null;this.modelStatus=detector?'loading':'disabled';
    this.worker=null;
  }
  /** Report actual successful inference, separately from a loaded or failed model. */
  health() {
    const at=this.now();
    return {model_status:this.modelStatus,fresh:this.modelStatus==='ready'&&at>=this.inferred&&at-this.inferred<5000
      &&at>=this.completed&&at-this.completed<8000,error:this.error,
      captured_at:Number.isFinite(this.completed)?new Date(this.completed).toISOString():null,people_in_last_frame:this.count};
  }
  /** Run one frame in a separate worker; a failed/stalled worker grants no readiness. */
  detect(jpeg) {
    if(typeof this.detector==='function')return this.detector(jpeg);
    if(!this.worker) {
      this.worker=new Worker(new URL('./person-worker.mjs',import.meta.url));
      this.worker.on('error',()=>{});this.worker.unref();
    }
    const worker=this.worker;
    return new Promise((resolve,reject)=>{
      /** Remove listeners after exactly one inference result or failure. */
      const cleanup=()=>{clearTimeout(timer);worker.off('message',message);worker.off('error',failed);worker.off('exit',exited);worker.unref();};
      /** Reject the active inference and discard its untrustworthy worker. */
      const failed=error=>{cleanup();this.worker=null;void worker.terminate();reject(error);};
      /** Treat an unexpected worker exit as loss of detection, never an empty result. */
      const exited=code=>failed(new Error(`Person detector worker exited (${code})`));
      /** Resolve validated model output or propagate its reported error. */
      const message=result=>{if(result.error){failed(new Error(result.error));return;}cleanup();resolve(result.persons);};
      const timer=setTimeout(()=>failed(new Error('Person inference timed out')),15000);timer.unref();
      worker.on('message',message);worker.once('error',failed);worker.once('exit',exited);worker.unref();
      worker.postMessage(jpeg);
    });
  }
  /** Sample relayed live frames, bound concurrency and attribute real observations to the search. */
  async frame(jpeg,capturedAtMs) {
    if(!this.detector||this.pending||capturedAtMs<=this.lastFrame||capturedAtMs-this.lastFrame<1500
      ||(this.modelStatus==='error'&&this.now()-this.lastAttempt<30000))return;
    this.pending=true;this.lastFrame=capturedAtMs;this.lastAttempt=this.now();
    try {
      const result=await this.detect(jpeg);
      if(!Array.isArray(result))throw new Error('Person detector returned invalid results');
      const persons=result.filter(p=>Number.isFinite(p.score)&&p.score>=.5&&p.score<=1
        &&Array.isArray(p.bbox)&&p.bbox.length===4&&p.bbox.every(v=>Number.isFinite(v)&&v>=0&&v<=1)
        &&p.bbox[2]>p.bbox[0]&&p.bbox[3]>p.bbox[1]).slice(0,10);
      this.modelStatus='ready';this.error=null;this.completed=capturedAtMs;this.inferred=this.now();this.count=persons.length;
      this.control.observePersons(capturedAtMs,persons);
    }catch(error){this.modelStatus='error';this.error=`Person detection unavailable: ${error.message}`.slice(0,250);}
    finally{this.pending=false;}
  }
}
