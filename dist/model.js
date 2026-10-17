/* Deterministic visual illustration. No physical spread model or calibrated probabilities. */
(function(root) {
  const BASE = Object.freeze({wind:18, direction:45, dryness:65});
  function compass(deg) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg/45)%8]; }
  function footprint(minutes, scenario=BASE, scale=1) {
    const t=Math.max(0,Math.min(60,Number(minutes)||0))/60;
    const dry=Math.max(.1,Math.min(1,scenario.dryness/100));
    const wind=Math.max(0,Math.min(45,scenario.wind));
    const rad=scenario.direction*Math.PI/180;
    const drift=t*wind*2.3;
    const cx=410+Math.sin(rad)*drift, cy=290-Math.cos(rad)*drift;
    const radius=34+t*(57+dry*55);
    const points=[];
    for(let i=0;i<80;i++) {
      const a=i/80*Math.PI*2;
      const irregular=1+.075*Math.sin(a*5+.5)+.04*Math.cos(a*9);
      const along=radius*(1+wind/65)*Math.cos(a)*scale*irregular;
      const across=radius*.81*Math.sin(a)*scale*irregular;
      points.push([cx+along*Math.sin(rad)+across*Math.cos(rad),cy-along*Math.cos(rad)+across*Math.sin(rad)]);
    }
    return points;
  }
  function path(points) { return points.map((p,i)=>(i?'L':'M')+p.map(x=>x.toFixed(2)).join(' ')).join(' ')+'Z'; }
  function areaHa(points) { let a=0; for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2*16/10000; }
  function reviewDraft(objective,scenario,minutes,assumptions) {
    const names={situational:'Situational awareness briefing',community:'Community information needs',handoff:'Incident handoff briefing'};
    const questions={situational:['Which observations have a time, location and named source?','What independent observations could confirm a reported change?','Who is the authorized decision-maker for the next briefing?'],community:['Which community information requests are confirmed by the incident lead?','Who is authorized to publish verified public information?','Which accessibility and language needs should the liaison confirm?'],handoff:['Which records, timestamps and unresolved questions need handoff?','Who has accepted each review responsibility?','When will the incoming incident lead recheck stale information?']};
    return {id:'draft-'+Date.now(),createdAt:new Date().toISOString(),title:names[objective]||names.situational,provenance:'simulation',status:'draft',scenario:{...scenario},minute:Number(minutes.toFixed(1)),assumptions:assumptions.trim(),observations:[`Illustration at T + ${Math.round(minutes)} min: ${areaHa(footprint(minutes,scenario)).toFixed(1)} ha on a fictional schematic.`,`Assumed wind ${scenario.wind} km/h toward ${compass(scenario.direction)}; dryness input ${scenario.dryness}%.`],questions:questions[objective]||questions.situational,unknowns:['Actual fire perimeter and ground conditions are unknown.','Access, occupied locations, resources and airspace status are unverified.','Illustrative spread has no validated accuracy or confidence interval.'],checks:[false,false,false],reviewer:'',reviewedAt:null,limits:'Briefing support only. No crew dispatch, suppression tactics, safe-route claim or evacuation order. Human review does not validate the spread model.'};
  }
  const api={BASE,compass,footprint,path,areaHa,reviewDraft};root.EmberModel=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
