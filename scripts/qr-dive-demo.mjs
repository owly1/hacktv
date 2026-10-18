// Start only the laptop dashboard and separate person inference worker. No aircraft commands.
import {main} from './demo.mjs';
process.env.BOSCO_DIVE_PERSON_CV='1';
if(!process.argv.includes('--live'))process.argv.push('--live');
main().catch(error=>{console.error(error.message);process.exitCode=1;});
