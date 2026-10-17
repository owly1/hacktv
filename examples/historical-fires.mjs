#!/usr/bin/env node
/**
 * Emberwatch — historical fire map TEST CASE (isolated demo).
 *
 * Purpose: stand-in for the future real-map spread view (TEAM_AI_CONTEXT §6).
 * Until the live map + predictor exist, this file presents what that view will
 * look like: real recorded fires, their impact figures, and an ILLUSTRATIVE
 * "prediction zone" overlay showing the output shape our model will target.
 *
 * Honesty contract (same as the dashboard):
 *   - Perimeters/ellipses are APPROXIMATIONS drawn from reported area and a
 *     dominant spread direction — not surveyed fire boundaries.
 *   - The "model zone" is a drawing of intended output, NOT a prediction and
 *     NOT a validated model. No probabilities are calibrated.
 *   - Impact figures come from public incident records; "≈" means sources
 *     differ or the figure is rounded. Unknown values are null, never zeroed.
 *
 * Zero dependencies (Node >=18 built-in http only). Run:
 *
 *   node examples/historical-fires.mjs              # then open http://127.0.0.1:8790
 *   PORT=9000 node examples/historical-fires.mjs
 *   node examples/historical-fires.mjs --emit DIR   # write a static site (index.html + fires.json)
 *                                                   # for GitHub Pages / any static host
 *
 * Endpoints: GET / (dashboard), GET /fires.json (dataset), GET /healthz.
 * Map tiles need internet (Leaflet + Esri light-gray, key-free — see docs/KEYS.md);
 * without it the page falls back to a data-table view automatically.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || '127.0.0.1';

/* ------------------------------------------------------------------ *
 * Case file: recorded historical fires.
 * directionDeg = dominant observed spread direction (approximate).
 * drivers = the factors our predictor will take as input; null = unknown.
 * impacts: null = not reliably reported; figures marked approximate in UI.
 * ------------------------------------------------------------------ */
const FIRES = [
  {
    id: 'horse-river-2016',
    name: 'Horse River (Fort McMurray)',
    region: 'Alberta, Canada',
    startDate: '2016-05-01',
    cause: 'Human-caused (under investigation; official cause undetermined)',
    lat: 56.618, lon: -111.197,
    areaHa: 589552,
    directionDeg: 60,
    drivers: { tempC: 32.8, windKmh: 40, rhPct: 12, fuel: 'Extreme drought; cured boreal fuels (FFMC >90)' },
    impacts: { structures: 2400, evacuated: 88000, deaths: 0, costCad: 3580000000 },
    notes: '≈2,400 homes/buildings destroyed; largest evacuation in Alberta history. ~$3.58 B insured — costliest disaster in Canadian history. 2 indirect deaths during evacuation.',
    source: 'Alberta Wildfire / Insurance Bureau of Canada records',
  },
  {
    id: 'lytton-2021',
    name: 'Lytton Creek',
    region: 'British Columbia, Canada',
    startDate: '2021-06-30',
    cause: 'Within rail corridor; cause disputed (not officially attributed)',
    lat: 50.231, lon: -121.581,
    areaHa: 83800,
    directionDeg: 10,
    drivers: { tempC: 49.6, windKmh: 30, rhPct: 10, fuel: 'Heat-dome-dried forest/grass interface' },
    impacts: { structures: null, evacuated: null, deaths: 2, costCad: null },
    notes: '≈90% of the Village of Lytton destroyed; reached it in minutes along the canyon. Burned the day after Lytton set Canada\'s all-time temperature record (49.6 °C).',
    source: 'BC Wildfire Service / coroner records',
  },
  {
    id: 'jasper-2024',
    name: 'Jasper townsite complex',
    region: 'Alberta, Canada',
    startDate: '2024-07-22',
    cause: 'Lightning',
    lat: 52.874, lon: -118.081,
    areaHa: 32700,
    directionDeg: 350,
    drivers: { tempC: 30, windKmh: 50, rhPct: null, fuel: 'Fire-smarted but drought-stressed parkland forest' },
    impacts: { structures: 358, evacuated: 25000, deaths: 0, costCad: 880000000 },
    notes: '≈358 structures (~30% of the townsite) lost when north and south fires converged on Jasper overnight; ≈$880 M insured damage.',
    source: 'Parks Canada / Insurance Bureau of Canada',
  },
  {
    id: 'elephant-hill-2017',
    name: 'Elephant Hill',
    region: 'British Columbia, Canada',
    startDate: '2017-07-06',
    cause: 'Suspected human-caused (smoking materials suspected, unproven)',
    lat: 51.166, lon: -121.077,
    areaHa: 191865,
    directionDeg: 60,
    drivers: { tempC: 35, windKmh: 40, rhPct: 15, fuel: 'Drought-cured interior forest and grass' },
    impacts: { structures: 100, evacuated: null, deaths: 0, costCad: null },
    notes: '≈100 structures destroyed across Cache Creek / Loon Lake area; burned for over two months in the record 2017 BC season.',
    source: 'BC Wildfire Service records',
  },
  {
    id: 'mcdougall-2023',
    name: 'McDougall Creek (West Kelowna)',
    region: 'British Columbia, Canada',
    startDate: '2023-08-15',
    cause: 'Undetermined (human-caused suspected)',
    lat: 49.865, lon: -119.578,
    areaHa: 13970,
    directionDeg: 75,
    drivers: { tempC: 30, windKmh: 50, rhPct: 15, fuel: 'Extreme drought; embers spotted across Okanagan Lake' },
    impacts: { structures: 189, evacuated: 10700, deaths: 0, costCad: null },
    notes: '≈189 structures lost; ≈10,700 under evacuation order and ~35,000 under order or alert across the Central Okanagan. Part of Canada\'s record 2023 season (≈18.5 M ha nationally).',
    source: 'BC Wildfire Service / Central Okanagan EOC records',
  },
  {
    id: 'camp-fire-2018',
    name: 'Camp Fire (Paradise)',
    region: 'California, USA',
    startDate: '2018-11-08',
    cause: 'Electrical transmission equipment failure',
    lat: 39.813, lon: -121.435,
    areaHa: 62053,
    directionDeg: 245,
    drivers: { tempC: 10, windKmh: 80, rhPct: 23, fuel: 'Critically dry fuels after drought; Jarbo gap winds' },
    impacts: { structures: 18804, evacuated: 52000, deaths: 85, costUsd: 16500000000 },
    notes: 'Deadliest and most destructive fire in California history; reached Paradise within hours driven by downslope winds.',
    source: 'CAL FIRE incident records',
  },
  {
    id: 'dixie-2021',
    name: 'Dixie Fire',
    region: 'California, USA',
    startDate: '2021-07-13',
    cause: 'Electrical line contact with tree',
    lat: 39.794, lon: -121.406,
    areaHa: 389837,
    directionDeg: 120,
    drivers: { tempC: 35, windKmh: 45, rhPct: 12, fuel: 'Record-dry fuels; first fire to burn from west to east Sierra crest' },
    impacts: { structures: 1329, evacuated: 16000, deaths: 1, costUsd: null },
    notes: 'Second-largest single fire in California history; destroyed most of Greenville.',
    source: 'CAL FIRE incident records',
  },
  {
    id: 'marshall-2021',
    name: 'Marshall Fire',
    region: 'Colorado, USA',
    startDate: '2021-12-30',
    cause: 'Power line ignition in extreme wind (plus a second ignition point)',
    lat: 39.956, lon: -105.212,
    areaHa: 2461,
    directionDeg: 100,
    drivers: { tempC: 8, windKmh: 160, rhPct: 15, fuel: 'Drought-cured grassland-urban interface' },
    impacts: { structures: 1084, evacuated: 30000, deaths: 2, costUsd: 2000000000 },
    notes: 'Colorado\'s most destructive fire by structure count; hurricane-force downslope winds drove it through Superior and Louisville in hours. Area is small because fuels were grass, not forest.',
    source: 'Boulder County / NIST investigation records',
  },
  {
    id: 'eaton-2025',
    name: 'Eaton Fire (Altadena)',
    region: 'California, USA',
    startDate: '2025-01-07',
    cause: 'Suspected electrical transmission ignition (under investigation)',
    lat: 34.190, lon: -118.088,
    areaHa: 5674,
    directionDeg: 240,
    drivers: { tempC: 16, windKmh: 150, rhPct: 9, fuel: '8+ months without significant rain; chaparral-urban interface' },
    impacts: { structures: 9400, evacuated: 100000, deaths: 17, costUsd: null },
    notes: '≈9,400 structures damaged or destroyed; extreme Santa Ana downslope event drove it into Altadena overnight alongside the Palisades fire.',
    source: 'CAL FIRE / Los Angeles County records',
  },
];

const CONTEXT_NOTE =
  'Context: Canada\'s 2023 season burned ≈18.5 M ha nationally (CIFFC) — more than double the previous national record.';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Emberwatch test case · Historical fire map</title>
<meta name="description" content="Isolated test case for the Emberwatch predicted-fire map: recorded historical fires, impacts, and illustrative prediction zones.">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#1b2430; --muted:#5b6673;
  --line:#e2e6ec; --ember:#d9480f; --ember-soft:rgba(224,90,43,.28);
  --model:#5a4fc7; --model-soft:rgba(90,79,199,.10); --warn-bg:#fff4e8;
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:center;gap:12px;padding:10px 18px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:650}
.badge{font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;background:var(--warn-bg);color:var(--ember);border:1px solid #f3d2b8;text-transform:uppercase}
.hint{color:var(--muted);font-size:12px;margin-left:auto}
main{display:grid;grid-template-columns:1fr 360px;gap:0;height:calc(100vh - 49px)}
#map{min-height:300px}
#fallback{display:none;padding:24px;overflow:auto}
aside{border-left:1px solid var(--line);background:var(--panel);overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px}
section h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
.card{padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fbfcfd;margin-bottom:8px;cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit}
.card:hover{border-color:var(--ember)}
.card.active{border-color:var(--ember);background:var(--warn-bg)}
.card .nm{font-weight:650}
.card .meta{color:var(--muted);font-size:12px}
.detail h3{margin:0 0 2px;font-size:15px}
.detail .sub{color:var(--muted);font-size:12px;margin-bottom:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin:10px 0}
.kv{font-size:12px}
.kv .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.kv .v{font-weight:600;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chip{font-size:11.5px;background:#eef1f5;border:1px solid var(--line);border-radius:999px;padding:3px 9px}
.note{font-size:12.5px;color:var(--muted);border-left:3px solid var(--ember);padding-left:10px;margin-top:8px}
.src{font-size:11px;color:var(--muted);margin-top:6px}
label.tgl{display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0;cursor:pointer}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.leg{font-size:12px;color:var(--muted)}
.leg div{margin:3px 0}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{background:#fbfcfd;border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.stat .v{font-size:17px;font-weight:700}
.stat .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.about{font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}
footer{font-size:11.5px;color:var(--muted);padding:6px 18px;border-top:1px solid var(--line);background:var(--panel)}
.dir-pad{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:6px 0 2px}
.dir-pad button{font:inherit;font-size:11px;padding:3px 0;border:1px solid var(--line);border-radius:6px;background:#fbfcfd;cursor:pointer}
.dir-pad button.on{background:var(--model);color:#fff;border-color:var(--model)}
.sc-row{display:flex;align-items:center;gap:8px;margin:8px 0}
.sc-k{width:120px;font-size:11.5px;color:var(--muted);flex:none}
.sc-row input[type=range]{flex:1;min-width:0}
.sc-v{width:66px;text-align:right;font-size:12px;font-weight:600;flex:none}
.badge-mod{font-size:10px;background:var(--model-soft);color:var(--model);border-radius:999px;padding:2px 7px;font-weight:700;text-transform:none;letter-spacing:.02em}
table.fires{width:100%;border-collapse:collapse;font-size:13px}
table.fires th,table.fires td{border:1px solid var(--line);padding:6px 8px;text-align:left}
table.fires th{background:#fbfcfd}
.offline-note{background:var(--warn-bg);border:1px solid #f3d2b8;border-radius:10px;padding:10px 12px;margin-bottom:16px}
@media (max-width:900px){main{grid-template-columns:1fr;height:auto}aside{border-left:none;border-top:1px solid var(--line)}#map{height:55vh}}
</style>
</head>
<body>
<header>
  <h1>Emberwatch · historical fire map</h1>
  <span class="badge">Test case — recorded events, illustrative zones</span>
  <span class="hint">Isolated demo for the future spread-prediction map · not connected to live telemetry</span>
</header>
<main>
  <div id="map" role="application" aria-label="Historical fire map"></div>
  <div id="fallback"></div>
  <aside>
    <section><h2>Case files</h2><div id="list"></div></section>
    <section><h2>Layers</h2>
      <label class="tgl"><input type="checkbox" id="tgl-actual" checked>Recorded burn area <span class="leg">(approx.)</span></label>
      <label class="tgl"><input type="checkbox" id="tgl-model" checked>Illustrative prediction zone</label>
      <label class="tgl"><input type="checkbox" id="tgl-ignition" checked>Ignition markers</label>
      <div class="leg" style="margin-top:8px">
        <div><span class="swatch" style="background:rgba(224,90,43,.45)"></span>Recorded burn area (ellipse approx.)</div>
        <div><span class="swatch" style="background:#fff;border:2px dashed #5a4fc7"></span>Illustrative prediction zone + wind arrow</div>
        <div><span class="swatch" style="background:#d9480f;border-radius:50%"></span>Ignition point</div>
      </div>
    </section>
    <section><h2>Scenario inputs <span class="badge-mod" id="mod-badge" style="display:none">modified</span></h2>
      <div class="sc-row" style="display:block">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="sc-k">Wind direction</span><span class="sc-v" id="dir-v"></span>
        </div>
        <div class="dir-pad" id="dir-pad"></div>
      </div>
      <div class="sc-row"><span class="sc-k">Wind speed</span><input type="range" id="sc-wind" min="0" max="160" step="5"><span class="sc-v" id="wind-v"></span></div>
      <div class="sc-row"><span class="sc-k">Fuel dryness</span><input type="range" id="sc-dry" min="0" max="100" step="1"><span class="sc-v" id="dry-v"></span></div>
      <div class="sc-row"><span class="sc-k">Temperature</span><input type="range" id="sc-temp" min="-10" max="50" step="1"><span class="sc-v" id="temp-v"></span></div>
      <div class="sc-row"><span class="sc-k">Rel. humidity</span><input type="range" id="sc-rh" min="0" max="100" step="1"><span class="sc-v" id="rh-v"></span></div>
      <div class="sc-row"><span class="sc-k">Minutes from ignition</span><input type="range" id="sc-min" min="0" max="60" step="1"><span class="sc-v" id="min-v"></span></div>
      <button class="card" id="sc-reset">Reset to recorded conditions</button>
      <div class="leg" style="margin-top:8px">These inputs control an illustrative zone drawing. They do not describe real weather or fire behavior — no terrain, spotting, suppression or probabilistic physics. Direction is <b>toward</b>, clockwise from north.</div>
    </section>
    <section class="detail"><h2>Selected case</h2><div id="detail"></div></section>
    <section><h2>Dataset</h2><div class="stats" id="stats"></div></section>
    <section class="about"><h2>About this test case</h2>
      <div>This is an isolated presentation file for Emberwatch's planned map view — a fire-spread
      <b>prediction zone</b> driven by temperature, wind, dryness and fuel. Until live data/tool access
      exists, it replays <b>recorded</b> fires with their documented conditions and impacts.</div>
      <div style="margin-top:8px">Burned areas are ellipses fitted to reported area and dominant
      direction — <b>approximations, not surveyed perimeters</b>. The dashed zone is a drawing of the
      output shape our future model will produce — <b>not a prediction and not validated</b>.
      Impact figures come from public incident records; ≈ marks rounded or source-varying values.</div>
    </section>
  </aside>
</main>
<footer id="ctx"></footer>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var FIRES = __FIRES_JSON__;
var CONTEXT_NOTE = __CONTEXT_JSON__;

var fmt = {
  int: function(n){ return n == null ? '—' : n.toLocaleString('en-CA'); },
  ha: function(n){ return n == null ? '—' : n.toLocaleString('en-CA') + ' ha'; },
  money: function(f){
    var parts = [];
    if (f.impacts.costCad != null) parts.push('≈$' + (f.impacts.costCad/1e9).toFixed(2).replace(/\\.?0+$/,'') + ' B CAD');
    if (f.impacts.costUsd != null) parts.push('≈$' + (f.impacts.costUsd/1e9).toFixed(2).replace(/\\.?0+$/,'') + ' B USD');
    return parts.length ? parts.join(' · ') : '—';
  },
  compass: function(deg){ return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg/45)%8]; }
};

function kv(k, v){ return '<div class="kv"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>'; }

/* ---------- sidebar ---------- */
function renderList(){
  var el = document.getElementById('list');
  el.innerHTML = FIRES.map(function(f){
    return '<button class="card" data-id="'+f.id+'">' +
      '<div class="nm">'+f.name+'</div>' +
      '<div class="meta">'+f.region+' · '+f.startDate.slice(0,4)+' · '+fmt.ha(f.areaHa)+'</div></button>';
  }).join('');
  el.querySelectorAll('.card').forEach(function(c){
    c.addEventListener('click', function(){ selectFire(c.dataset.id, true); });
  });
}

function renderDetail(f){
  var d = f.drivers, i = f.impacts;
  var conds = [
    d.tempC != null ? d.tempC+' °C' : null,
    d.windKmh != null ? 'wind ≈'+d.windKmh+' km/h' : null,
    d.rhPct != null ? 'RH ≈'+d.rhPct+'%' : null,
    'spread → '+fmt.compass(f.directionDeg),
    d.fuel
  ].filter(Boolean).map(function(c){ return '<span class="chip">'+c+'</span>'; }).join('');
  document.getElementById('detail').innerHTML =
    '<h3>'+f.name+'</h3>' +
    '<div class="sub">'+f.region+' · ignited '+f.startDate+' · cause: '+f.cause+'</div>' +
    '<div class="grid">' +
      kv('Burned area', '≈'+fmt.ha(f.areaHa)) +
      kv('Structures destroyed', i.structures != null ? '≈'+fmt.int(i.structures) : '—') +
      kv('Evacuated', i.evacuated != null ? '≈'+fmt.int(i.evacuated) : '—') +
      kv('Deaths', i.deaths != null ? fmt.int(i.deaths) : '—') +
      kv('Recorded cost', fmt.money(f)) +
      kv('Dominant direction', fmt.compass(f.directionDeg)) +
    '</div>' +
    '<div class="chips">'+conds+'</div>' +
    '<div class="note">'+f.notes+'</div>' +
    '<div class="src">Source: '+f.source+'</div>';
}

function renderStats(){
  var t = {ha:0, st:0, ev:0, n:FIRES.length};
  FIRES.forEach(function(f){ t.ha += f.areaHa||0; t.st += f.impacts.structures||0; t.ev += f.impacts.evacuated||0; });
  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="v">'+t.n+'</div><div class="k">Recorded fires</div></div>' +
    '<div class="stat"><div class="v">≈'+(t.ha/1e6).toFixed(2)+' M ha</div><div class="k">Combined burn</div></div>' +
    '<div class="stat"><div class="v">≈'+fmt.int(t.st)+'</div><div class="k">Structures lost</div></div>' +
    '<div class="stat"><div class="v">≈'+fmt.int(t.ev)+'</div><div class="k">People evacuated</div></div>';
  document.getElementById('ctx').textContent = CONTEXT_NOTE;
}

/* ---------- geometry: degrees → meters-ish, all approximate ---------- */
function destPoint(lat, lon, bearingDeg, distM){
  var b = bearingDeg*Math.PI/180, dLat = distM*Math.cos(b)/111320;
  var dLon = distM*Math.sin(b)/(111320*Math.cos(lat*Math.PI/180));
  return [lat+dLat, lon+dLon];
}
/* Ellipse fitted to reported area, elongated along the recorded direction. */
function semiMajor(f){
  var areaM2 = f.areaHa*10000, ratio = 2.4;
  return Math.sqrt(areaM2*ratio/Math.PI);    // semi-major axis, metres
}
function perimeter(f){
  var areaM2 = f.areaHa*10000;
  var a = semiMajor(f);                      // semi-major (along spread)
  var b = areaM2/(Math.PI*a);                // semi-minor
  var centre = destPoint(f.lat, f.lon, f.directionDeg, a*0.45);
  var pts = [];
  for(var i=0;i<64;i++){
    var ang = i/64*Math.PI*2;
    var wob = 1 + 0.08*Math.sin(ang*5 + f.directionDeg) + 0.05*Math.cos(ang*7);
    var u = a*Math.cos(ang)*wob, v = b*Math.sin(ang)*wob;
    var dist = Math.hypot(u, v);
    var brg = f.directionDeg + Math.atan2(v, u)*180/Math.PI;
    pts.push(destPoint(centre[0], centre[1], brg, dist));
  }
  return pts;
}
/* ---- live scenario inputs (artistic zone drawing; not fire physics) ---- */
var BASE = {wind:18, direction:45, dryness:65, temp:20, rh:50, minutes:60};
var scenario = Object.assign({}, BASE);

function scenarioFor(f){
  var d = f.drivers||{};
  return {
    wind: d.windKmh != null ? d.windKmh : BASE.wind,
    direction: f.directionDeg != null ? f.directionDeg : BASE.direction,
    dryness: d.rhPct != null ? Math.max(0, 100-d.rhPct) : BASE.dryness,
    temp: d.tempC != null ? d.tempC : BASE.temp,
    rh: d.rhPct != null ? d.rhPct : BASE.rh,
    minutes: BASE.minutes
  };
}
/* Environment factor: hotter/drier/lower-RH enlarges the zone. */
function envFactor(sc){
  var e = 1 + (sc.dryness-50)/200 + (sc.temp-20)/200 - (sc.rh-50)/300;
  return Math.max(0.6, Math.min(1.6, e));
}
/* Dashed wedge from ignition toward sc.direction — the SHAPE the future model emits. */
function modelZone(f, sc, innerScale){
  var t = Math.max(0.08, Math.min(1, sc.minutes/60));
  var windStretch = 1 + sc.wind/65;      // dashboard footprint() parity
  var halfAngle = Math.max(15, 45 - sc.wind*0.4);
  var r = semiMajor(f)*1.25*t*windStretch*envFactor(sc)*(innerScale||1);
  var pts = [[f.lat, f.lon]];
  for(var tt=-1; tt<=1; tt+=0.125){
    var brg = sc.direction + tt*halfAngle;
    pts.push(destPoint(f.lat, f.lon, brg, r*(1-Math.abs(tt)*0.35)));
  }
  return pts;
}
function windArrow(f, sc){
  var a = semiMajor(f);
  var from = destPoint(f.lat, f.lon, sc.direction+180, a*0.25);
  var to   = destPoint(f.lat, f.lon, sc.direction, a*0.75);
  return [from, to];
}

/* ---------- map ---------- */
var map, layers = {actual:null, model:null, ignition:null};
var selected = null;
var modelGroups = {};

function initMap(){
  map = L.map('map').setView([50.5, -110], 4);
  // Key-free light road tiles. CARTO Voyager was the documented choice
  // (docs/KEYS.md) but began returning watermarked 'API KEY REQUIRED' tiles
  // on 2026-10-17 — a 200 response, so undetectable via tileerror. Primary
  // is now Esri's key-free light-gray canvas (same light road-style look);
  // OSM standard tiles are the error fallback. Attribution per provider.
  var tileProviders = [
    {url:'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
     attribution:'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ', name:'Esri Light Gray'},
    {url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
     attribution:'&copy; OpenStreetMap contributors', name:'OpenStreetMap'}
  ];
  var tileIndex = 0;
  function addTiles(){
    var p = tileProviders[tileIndex];
    var layer = L.tileLayer(p.url, {attribution:p.attribution, maxZoom:19});
    layer.on('tileerror', function(){
      if(tileIndex < tileProviders.length-1){
        tileIndex++;
        map.removeLayer(layer);
        addTiles();
        console.warn('Map tiles: '+p.name+' failed — fell back to '+tileProviders[tileIndex].name);
      }
    });
    layer.addTo(map);
  }
  addTiles();
  layers.actual = L.layerGroup().addTo(map);
  layers.model = L.layerGroup().addTo(map);
  layers.ignition = L.layerGroup().addTo(map);

  FIRES.forEach(function(f){
    L.circleMarker([f.lat, f.lon], {radius:6, color:'#d9480f', weight:2, fillColor:'#d9480f', fillOpacity:.85})
      .addTo(layers.ignition)
      .bindTooltip(f.name, {direction:'top'});
    L.polygon(perimeter(f), {color:'#c2410c', weight:1.5, fillColor:'#e05a2b', fillOpacity:.28})
      .addTo(layers.actual)
      .bindTooltip('Recorded burn area (approx.) — '+f.name);
    modelGroups[f.id] = buildModelGroup(f, scenarioFor(f));
  });
  var bounds = L.latLngBounds(FIRES.map(function(f){ return [f.lat,f.lon]; }));
  map.fitBounds(bounds.pad(0.15));
}

function buildModelGroup(f, sc){
  var g = L.layerGroup();
  L.polygon(modelZone(f, sc, 0.55), {color:'#5a4fc7', weight:0, fillColor:'#5a4fc7', fillOpacity:.14})
    .addTo(g).bindTooltip('Higher-intensity illustrative core — '+f.name);
  L.polygon(modelZone(f, sc, 1), {color:'#5a4fc7', weight:2, dashArray:'7 6', fillColor:'#5a4fc7', fillOpacity:.07})
    .addTo(g).bindTooltip('Illustrative prediction zone — '+f.name);
  L.polyline(windArrow(f, sc), {color:'#5a4fc7', weight:1.4, dashArray:'2 6', opacity:.8}).addTo(g);
  if(map) g.addTo(layers.model);
  return g;
}

function redrawScenario(){
  if(!map || !selected) return;
  var old = modelGroups[selected.id];
  if(old) layers.model.removeLayer(old);
  modelGroups[selected.id] = buildModelGroup(selected, scenario);
  markModified();
}

function markModified(){
  var rec = scenarioFor(selected);
  var mod = ['wind','direction','dryness','temp','rh','minutes'].some(function(k){ return scenario[k] !== rec[k]; });
  document.getElementById('mod-badge').style.display = mod ? 'inline-block' : 'none';
  if(map && selected){
    var arr = windArrow(selected, scenario);
    L.popup({closeButton:false, className:'dir-pop'})
      .setLatLng(arr[1])
      .setContent('<b>Wind → '+scenario.direction+'° '+fmt.compass(scenario.direction)+' at '+scenario.wind+' km/h</b><br><span style="font-size:11px">'+(mod?'scenario input — illustrative':'recorded dominant direction')+'</span>')
      .openOn(map);
  }
}

function selectFire(id, zoom){
  selected = FIRES.find(function(f){ return f.id === id; }) || selected;
  if(!selected) return;
  document.querySelectorAll('#list .card').forEach(function(c){
    c.classList.toggle('active', c.dataset.id === selected.id);
  });
  renderDetail(selected);
  scenario = scenarioFor(selected);
  syncInputs(); markModified();
  if(map){
    var old = modelGroups[selected.id];
    if(old){ layers.model.removeLayer(old); modelGroups[selected.id] = buildModelGroup(selected, scenario); }
    if(zoom !== false){
      var b = L.latLngBounds(perimeter(selected).concat(modelZone(selected, scenario, 1)));
      map.flyToBounds(b.pad(0.2), {duration:.8});
    }
    var arr = windArrow(selected, scenario);
    L.popup({closeButton:false, className:'dir-pop'})
      .setLatLng(arr[1])
      .setContent('<b>Spread → '+scenario.direction+'° '+fmt.compass(scenario.direction)+' at '+scenario.wind+' km/h</b><br><span style="font-size:11px">recorded dominant direction</span>')
      .openOn(map);
  }
  if(history.replaceState) history.replaceState(null,'','?fire='+selected.id);
}

/* ---------- offline fallback ---------- */
function renderFallback(){
  document.getElementById('map').style.display = 'none';
  var el = document.getElementById('fallback');
  el.style.display = 'block';
  el.innerHTML =
    '<div class="offline-note"><b>Map tiles unavailable offline.</b> ' +
    'Leaflet + CARTO Voyager tiles need internet (no key required). ' +
    'Below is the same dataset as a table — perimeters and model zones are illustrative approximations.</div>' +
    '<table class="fires"><tr><th>Fire</th><th>Region</th><th>Ignited</th><th>Area</th><th>Spread</th><th>Structures</th><th>Evacuated</th><th>Deaths</th></tr>' +
    FIRES.map(function(f){
      return '<tr><td>'+f.name+'</td><td>'+f.region+'</td><td>'+f.startDate+'</td><td>≈'+fmt.ha(f.areaHa)+'</td><td>'+fmt.compass(f.directionDeg)+'</td><td>'+(f.impacts.structures!=null?'≈'+fmt.int(f.impacts.structures):'—')+'</td><td>'+(f.impacts.evacuated!=null?'≈'+fmt.int(f.impacts.evacuated):'—')+'</td><td>'+(f.impacts.deaths!=null?fmt.int(f.impacts.deaths):'—')+'</td></tr>';
    }).join('') + '</table>';
}

/* ---------- scenario controls ---------- */
var DIRS = [['N',0],['NE',45],['E',90],['SE',135],['S',180],['SW',225],['W',270],['NW',315]];
function syncInputs(){
  document.getElementById('sc-wind').value = scenario.wind;
  document.getElementById('sc-dry').value = scenario.dryness;
  document.getElementById('sc-temp').value = scenario.temp;
  document.getElementById('sc-rh').value = scenario.rh;
  document.getElementById('sc-min').value = scenario.minutes;
  paintInputs();
}
function paintInputs(){
  document.getElementById('wind-v').textContent = scenario.wind+' km/h';
  document.getElementById('dry-v').textContent = scenario.dryness+'%';
  document.getElementById('temp-v').textContent = scenario.temp+' °C';
  document.getElementById('rh-v').textContent = scenario.rh+'%';
  document.getElementById('min-v').textContent = 'T+'+scenario.minutes+' min';
  document.getElementById('dir-v').textContent = scenario.direction+'° → '+fmt.compass(scenario.direction);
  document.querySelectorAll('#dir-pad button').forEach(function(b){
    b.classList.toggle('on', Number(b.dataset.deg) === scenario.direction);
  });
}
function bindScenarioControls(){
  var pad = document.getElementById('dir-pad');
  DIRS.forEach(function(d){
    var b = document.createElement('button');
    b.type='button'; b.textContent=d[0]; b.dataset.deg=d[1];
    b.addEventListener('click', function(){ scenario.direction=d[1]; paintInputs(); redrawScenario(); });
    pad.appendChild(b);
  });
  [['sc-wind','wind'],['sc-dry','dryness'],['sc-temp','temp'],['sc-rh','rh'],['sc-min','minutes']]
    .forEach(function(pair){
      document.getElementById(pair[0]).addEventListener('input', function(e){
        scenario[pair[1]] = Number(e.target.value); paintInputs(); redrawScenario();
      });
    });
  document.getElementById('sc-reset').addEventListener('click', function(){
    if(!selected) return;
    scenario = scenarioFor(selected); syncInputs(); redrawScenario();
  });
}

/* ---------- boot ---------- */
renderList(); renderStats(); bindScenarioControls();
['actual','model','ignition'].forEach(function(k){
  document.getElementById('tgl-'+k).addEventListener('change', function(e){
    if(!map) return;
    if(e.target.checked) map.addLayer(layers[k]); else map.removeLayer(layers[k]);
  });
});
if(window.L){ initMap(); selectFire(new URLSearchParams(location.search).get('fire') || FIRES[0].id, true); }
else { renderFallback(); selectFire(FIRES[0].id, false); }
</script>
</body>
</html>`;

function renderPage(){
  return PAGE
    .replace('__FIRES_JSON__', JSON.stringify(FIRES))
    .replace('__CONTEXT_JSON__', JSON.stringify(CONTEXT_NOTE));
}

/* --emit <dir>: write a fully static copy (no Node needed to view). */
if (process.argv.includes('--emit')) {
  const dir = process.argv[process.argv.indexOf('--emit') + 1] || 'site-dist';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), renderPage());
  fs.writeFileSync(path.join(dir, 'fires.json'),
    JSON.stringify({ contract: 'emberwatch-testcase.v1', note: 'recorded events; illustrative zones; not a prediction', fires: FIRES }, null, 2));
  console.log(`Static site written to ${dir}/ (index.html + fires.json)`);
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/fires.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ contract: 'emberwatch-testcase.v1', note: 'recorded events; illustrative zones; not a prediction', fires: FIRES }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(renderPage());
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, HOST, () => {
  console.log(`Emberwatch historical-fire test case`);
  console.log(`  → http://${HOST}:${PORT}        (dashboard)`);
  console.log(`  → http://${HOST}:${PORT}/fires.json  (dataset)`);
  console.log(`Recorded events; ellipses and prediction zones are illustrative — not a model output.`);
});
