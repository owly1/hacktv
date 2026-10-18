// Normal app startup. A provisioned Mac also starts the disarmed response
// receiver; only the visible, expiring dashboard session authorizes flight.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const children=new Set(); let stopping=false;
function start(program,args) {
  const child=spawn(program,args,{cwd:root,stdio:'inherit'}); children.add(child);
  child.on('error',error=>console.error(error.message));
  child.on('exit',()=>children.delete(child)); return child;
}
function stop() { if(stopping)return; stopping=true; for(const child of children)child.kill('SIGINT'); }
process.on('SIGINT',stop); process.on('SIGTERM',stop);
const backend=start(process.execPath,['--env-file=.env','backend/server.mjs']);
backend.on('exit',code=>{stop();process.exitCode=code??1;});
const python=path.join(root,'.venv/bin/python');
if(process.platform==='darwin' && existsSync(path.join(root,'.pi.local')) && existsSync(python)
   && process.env.EMBERWATCH_RECEIVER!=='off') {
  // Copy this checkout's source, preserving calibration and credentials. No
  // startup path enables a flight session or sends a takeoff command.
  const install=start(python,['scripts/mac.py','install-pi']);
  install.on('exit',code=>{
    if(code!==0||stopping)return;
    const observer=start(python,['scripts/mac.py','stop-observer']);
    observer.on('exit',code=>{
      if(code===0&&!stopping)start(python,['scripts/mac.py','pi','--mode','fire-response','--headless',
        ...(process.env.EMBERWATCH_FIRE_TEST==='1'?['--short-test']:[])]);
    });
  });
}
