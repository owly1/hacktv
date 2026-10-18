'use strict';
/* BOSCO dashboard (Bushfire Observation, Simulation and Coordination Operations). Opens live against the backend that serves it:
   video, telemetry, detections and flight events from the ANAFI bridge;
   person-search observations from the backend; history from TigerData.
   Demo mode (historical fires from examples/ + flight-pattern replay) runs
   only when the Demo button is pressed. */
const $ = id => document.getElementById(id), M = EmberModel;
/** Escape untrusted text before inserting it into HTML templates. */
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Wait between asynchronous replay/Gemini retry attempts. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Format an evidence timestamp for display, retaining an unknown placeholder. */
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString() : '—';
const STALE_MS = 10_000;
const WIND_STALE_MS = 5_000, OUTDOOR_CONTOUR_PROFILE = 'outdoor-50m-live-wind';
const FLIGHT_STATES = {landed:'Landed', takingoff:'Taking off', hovering:'Hovering', flying:'Flying', landing:'Landing', emergency:'Emergency', usertakeoff:'Hand launch', motor_ramping:'Motors starting', emergency_landing:'Emergency landing'};
const SPREAD_BANDS = [[1.08,'#ffc459',.22],[1,'#ffb345',.24],[.79,'#ff8e43',.33],[.55,'#f54b31',.45],[.27,'#c7332c',.6]];

const state = {
  mode: 'live', liveDemo: false, token: '', connected: false, status: null,
  site: {name: 'UTSC · Sam Ibrahim Building', latitude: 43.7866, longitude: -79.1903},
  autonomy: null,
  telemetry: null, incident: null, episodeSeen: null, incidentModelKey: null, flight: {events: [], path: []},
  scenario: {...M.BASE}, detectedScenario: null, minute: 0, playing: false, speed: 1,
  // created_at of the analysis whose derived wind last set scenario.wind, the
  // analysis the user manually overrode, and the estimate shown in the UI
  windAuto: null, windManual: null, windDerived: null,
  // Per-drone FC wind samples -> BoscoFleet.windConsensus (one drone today)
  windSamples: {},
  video: {lastAt: 0, decoding: false, times: []},
  demo: {fires: [], selected: null, started: 0, videos: null},
  map: null, layers: {}, tiles: {}, basemap: 'osm', follow: false, droneMarker: null, tilesOk: false, tileErrors: 0, centredOnDrone: false,
  camera: null,
};
let toastTimer;

/** Show a short-lived status message, replacing the previous toast timer. */
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
/** Export browser-local content through a temporary Blob URL. */
function download(name, content, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], {type})); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
/** Open the requested native dashboard dialog. */
function openDialog(id) { $(id).showModal(); }

/** Make a token-authenticated API call with JSON encoding, timeout and visible error details. */
async function api(path, {method = 'GET', body, timeout = 12000} = {}) {
  const response = await fetch(path, {method, headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), Authorization: 'Bearer ' + state.token}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
  if (!response.ok) { let message; try { message = (await response.json()).error; } catch {} const err = new Error(message || `Backend returned ${response.status}`); err.status = response.status; throw err; }
  return response;
}
/** Decode a successful authenticated API response as JSON. */
const getJson = async (path, opts) => (await api(path, opts)).json();

let autonomousSession = null;
let autonomyRevision = 0, autonomyActionPending = false;
let autonomyConnectionError = false;
/** Treat aircraft emergency telemetry as authoritative over reported mission completion. */
function aircraftEmergency() {
  return ['emergency','emergency_landing'].includes(state.telemetry?.state);
}
/** Validate actual FC wind event evidence; nulls, stale cache values and unknown direction are not measurements. */
function freshWind(w, now=Date.now()) {
  if(!w||w.available===false||!Number.isFinite(w.speed_mps)||w.speed_mps<0||w.speed_mps>60) return null;
  const at=typeof w.observed_at==='string'?Date.parse(w.observed_at):NaN, age=now-at;
  if(!Number.isFinite(at)||age< -1000||age>WIND_STALE_MS||
    (w.age_s!=null&&(!Number.isFinite(w.age_s)||w.age_s<0||w.age_s*1000>WIND_STALE_MS))) return null;
  const direction=Number.isFinite(w.direction_deg)&&w.direction_deg>=0&&w.direction_deg<360?w.direction_deg:null;
  if(w.speed_mps>0&&direction===null) return null;
  return {speedMps:w.speed_mps,speedKmh:w.speed_mps*3.6,direction,observedAt:at,ageSeconds:Math.max(0,age/1000,w.age_s??0)};
}
/** Read real onboard wind independently of the editable fire-model and QR weather. */
function liveWindReading(now=Date.now()) {
  const t=state.telemetry, e=t?.extra;
  if(t?.provenance!=='live'||!e||e.fc_wind_available!==true) return null;
  return freshWind({speed_mps:e.fc_wind_speed_mps,direction_deg:e.fc_wind_direction_deg,
    observed_at:e.fc_wind_observed_at,age_s:e.fc_wind_age_s,available:e.fc_wind_available},now);
}
/** Describe the receiver's chosen model wind, retaining last measurements or an explicitly labeled assumption. */
function contourWindEvidence(plan, now=Date.now()) {
  const w=plan?.wind;
  if(!w||!Number.isFinite(w.speed_mps)||w.speed_mps<0||w.speed_mps>60) return null;
  const direction=Number.isFinite(w.direction_deg)&&w.direction_deg>=0&&w.direction_deg<360?w.direction_deg:null;
  if(w.speed_mps>0&&direction===null) return null;
  const speedKmh=w.speed_mps*3.6, toward=direction===null?'(calm)':`toward ${direction}°`;
  if(w.source==='qr-scenario-assumption') {
    if(Math.abs(speedKmh-.2)>1e-6||direction!==60||w.observed_at!=null) return null;
    return {status:'assumed',label:'Wind unavailable · using 0.2 km/h scenario assumption',speedKmh,direction};
  }
  const at=typeof w.observed_at==='string'?Date.parse(w.observed_at):NaN;
  if(w.source!=='flight-controller'||!Number.isFinite(at)) return null;
  const ageSeconds=Math.max(0,(now-at)/1000,Number.isFinite(w.age_s)?w.age_s:0);
  const current=plan.wind_status!=='stale'&&freshWind(w,now);
  return {status:current?'measured':'stale',speedKmh,direction,ageSeconds,
    label:current?`FC wind estimate ${Number(speedKmh.toFixed(1))} km/h ${toward}`:
      `Last measured wind · ${Math.round(ageSeconds)} s old · degraded · ${Number(speedKmh.toFixed(1))} km/h ${toward}`};
}
/** Keep live wind provenance visible while preserving the replay's scenario readout. */
function renderWindMetric(now=Date.now()) {
  if(state.mode==='demo') {
    $('wind-value').textContent=Math.round(state.windShown??state.scenario.wind);
    $('wind-context').textContent=`toward ${M.compass(state.scenario.direction)} · replay scenario`;
    return;
  }
  const w=liveWindReading(now);
  const modelWind=outdoorContourActive()?contourWindEvidence(state.autonomy?.receiver?.contour,now):null;
  $('wind-value').textContent=w?Number(w.speedKmh.toFixed(1)):'—';
  $('wind-context').textContent=w?`FC estimate · ${w.direction===null?'calm':`toward ${M.compass(w.direction)}`} · ${w.ageSeconds.toFixed(1)} s old`:
    modelWind?`Live wind unavailable · flight model: ${modelWind.label}`:'Unavailable · awaiting fresh onboard wind';
}
/** Identify the separately authorized outdoor profile without changing the circular response. */
function outdoorContourActive() {
  const a=state.autonomy;
  return state.mode==='live'&&a?.enabled&&a.mode==='contour'&&
    (a.mission?.contour?.profile===OUTDOOR_CONTOUR_PROFILE||a.receiver?.contour_profile===OUTDOOR_CONTOUR_PROFILE);
}
/** Describe the one aircraft's reported airborne-search stage without inventing a fire or flight. */
function contourFlightStatus(a) {
  const phase=a.receiver?.phase, search=a.receiver?.search_state;
  if(phase==='landing') return {state:'LANDING',summary:'1 drone landing',detail:a.receiver.reason||'Landing requested.'};
  if(phase==='takeoff'||phase==='climb') return {state:'TAKING OFF',summary:'1 drone taking off to search for fires',detail:'Climbing to 1 m above takeoff before moving through the QR search pattern.'};
  if(search==='acquiring') return {state:'READING MARKER',summary:'1 drone reading the QR fire scenario',detail:'Holding at 1 m to read Marker 2 and anchor the 50 m outdoor fire scenario with measured GPS. Onboard wind is used when available.'};
  if(search==='holding'||phase==='holding') return {state:'HOLDING',summary:'1 drone holding position',detail:a.receiver.reason||'Search is paused; use LAND to end the flight.'};
  if(a.mission&&(phase==='contour'||search==='tracking')) return {state:'GPS CONTOUR',summary:'1 drone following the fire contour',detail:`GPS contour response · ${a.receiver.reason||phase} · fixed initial fire area; continuing QR tracking is not required.`};
  if(a.mission) return {state:'READING MARKER',summary:'1 drone reading the QR fire scenario',detail:'Anchoring the 50 m outdoor scenario from the measured GPS fire location; wind gaps use the labeled model fallback.'};
  if(phase==='search'||search==='airborne-search') return {state:'SEARCHING',summary:'1 drone scanning for fires',detail:'Moving through the QR search pattern at 1 m above takeoff. Marker 2 identifies the outdoor fire area; onboard wind updates the forecast when available.'};
  return {state:'STARTING',summary:'1 drone preparing to search for fires',detail:a.search?'Airborne search claimed; checking takeoff readiness.':'Waiting for the receiver to claim the airborne search and take off to 1 m.'};
}
/** Show live receiver readiness, measured position and this page's available flight controls. */
function renderAutonomy() {
  const a=state.autonomy, enabled=!!a?.enabled;
  const search=a?.receiver?.search_state;
  const phase=a?.receiver?.phase, emergency=aircraftEmergency();
  const contour=a?.mode==='contour';
  const progress=state.mode==='live'&&enabled&&contour?contourFlightStatus(a):null;
  const adaptiveScale=a?.receiver?.qr_scale_mode==='adaptive';
  const currentMetricScale=a?.receiver?.position?.source==='measured-qr-3d';
  const acquiring=!contour&&!!a?.mission&&!['takeoff','climb','recover','circle','contour','return','landing'].includes(phase);
  $('autonomy-state').textContent=emergency?'EMERGENCY':autonomyConnectionError?'CONNECTION LOST':progress?progress.state:enabled?(acquiring?'ACQUIRING':phase==='recover'?'REACQUIRING':search==='scanning'?'SEARCHING':search==='acquiring'?'FIRE FOUND':a?.mission?'TRACKING':'ENABLED'):'OFF';
  $('autonomy-state').className='pill '+(enabled?'soft-orange':'muted');
  $('autonomy-enable').disabled=autonomyActionPending||autonomyConnectionError||emergency||state.mode!=='live'||enabled||!a?.receiver?.ready||!a?.receiver?.camera_ready||!a?.receiver?.camera_search_supported;
  $('autonomy-enable').textContent=enabled&&!contour?'BOSCO active':'Start BOSCO';
  $('autonomy-contour-enable').disabled=autonomyActionPending||autonomyConnectionError||emergency||state.mode!=='live'||enabled||!a?.receiver?.ready||!a?.receiver?.camera_ready||!a?.receiver?.camera_search_supported||!a?.receiver?.airborne_search_supported||!a?.receiver?.contour_supported||!a?.receiver?.contour_ready||a.receiver.contour_profile!==OUTDOOR_CONTOUR_PROFILE;
  $('autonomy-contour-enable').textContent=enabled&&contour?'Contour flight active':'Take off & search · 1 m';
  $('autonomy-limits').textContent=`1 m radius · about 1 m above launch · ${a?.lap_seconds===15?'15 s target per lap · ':''}${a?.flight_seconds===60?'SHORT TEST: 60 seconds':'up to 5 minutes'} · start ≥${a?.min_start_battery_pct??40}% battery, land below ${a?.min_flight_battery_pct??40}%. Keep this live page open.`;
  if(contour&&enabled) $('autonomy-limits').textContent=`1 m above takeoff · ${a?.flight_seconds===60?'SHORT TEST: 60 seconds':'flies until LAND; safety stops still apply'} · start ≥${a?.min_start_battery_pct??40}% battery, land below ${a?.min_flight_battery_pct??40}%. Keep this live page open; control, GPS and flight protections remain active. Wind gaps use the labeled fallback and do not end the flight.`;
  $('contour-readiness').textContent=state.mode!=='live'?'Contour flight is available in Live. The tiny-fire preview works in either mode.':
    enabled&&contour?'1 m QR search → +5-minute GPS contour around a 50 m initial fire. Received wind updates the forecast; wind gaps retain the last measured value or the labeled scenario assumption.':
    a?.receiver&&(!a.receiver.airborne_search_supported||a.receiver.contour_profile!==OUTDOOR_CONTOUR_PROFILE)?'Outdoor contour search requires an updated Pi receiver.':
    a?.receiver?.contour_ready?'Ready for outdoor takeoff and QR search at 1 m · Marker 2 · 50 m initial fire diameter · wind availability does not block flight.':
    a?.receiver?.contour_reason||'Outdoor contour awaits a compatible receiver and fresh measured GPS.';
  $('contour-progress').hidden=!progress;
  $('contour-mission-status').textContent=emergency?'1 drone · emergency reported':autonomyConnectionError?'1 drone · control connection interrupted':progress?.summary||'';
  $('pi-drone-status').textContent=progress?$('contour-mission-status').textContent:'One demo aircraft';
  const config=a?.mission?.contour, plan=a?.receiver?.contour, conditions=config?.details;
  const modelWind=contourWindEvidence(plan);
  $('contour-wind-status').hidden=!outdoorContourActive();
  $('contour-wind-status').textContent=modelWind?.label??'Wind provenance appears when the receiver creates the flight plan';
  $('contour-wind-status').className='pill '+(modelWind?.status==='measured'?'muted':'soft-orange');
  $('contour-conditions').textContent=outdoorContourActive()?`Outdoor scenario · 50 m initial diameter. ${conditions?`${conditions.temp_c}°C and ${conditions.rh_pct}% humidity are model assumptions; spread ${conditions.spread_m_per_min} m/min. `:''}Marker 2 identifies the fire area. ${modelWind?.status==='assumed'?'The encoded low-wind scenario is an assumption until an onboard estimate arrives.':modelWind?.status==='stale'?'The forecast continues with the last measured wind while the receiver waits for a new estimate.':'Onboard wind updates the forecast when available.'}`:
    progress&&conditions?`Encoded QR scenario · ${conditions.wind_kmh} km/h wind toward ${conditions.wind_dir_deg}° · ${conditions.temp_c}°C · ${conditions.rh_pct}% humidity · ${conditions.spread_m_per_min} m/min spread. These are marker inputs, not measured weather.`:'Marker 2 identification and forecast conditions appear after decoding; onboard wind is collected separately.';
  if (a?.receiver?.localization_sources) {
    const sources=a.receiver.localization_sources;
    if (adaptiveScale&&!currentMetricScale&&sources.includes('qr-test')) {
      $('autonomy-limits').textContent+=' QR location awaits automatic metric scale acquisition.';
      if (sources.includes('yolo')) $('autonomy-limits').textContent+=' RGB ground-plane geometry is verified.';
    } else $('autonomy-limits').textContent+=sources.length?` Location verified for ${sources.map(source=>source==='qr-test'?'QR markers':'RGB fire on the measured ground plane').join(' and ')}.`:' Fire localization is not verified.';
  }
  const calibration=a?.receiver?.calibration;
  $('autonomy-calibration').textContent=calibration?
    `${adaptiveScale?'QR size estimated automatically during vertical acquisition':`Configured QR black square: ${Number((calibration.qr_side_m*100).toFixed(1))} cm`} · camera offset (forward / right / down): ${calibration.offset_body_m.map(v=>Number((v*100).toFixed(1))).join(' / ')} cm · ${calibration.image_size.join(' × ')} pixels · calibration RMS ${calibration.rms_px.toFixed(3)} px. ${adaptiveScale?(currentMetricScale?'Metric target scale verified from current observations.':'Metric target scale is not yet verified; awaiting vertical acquisition.'):calibration.qr_verified?'Grounded QR location verified; flight performance remains unverified.':'QR position verification is missing.'} ${calibration.profile_verified===null?'Historical camera zoom/crop match is unknown.':calibration.profile_verified?'Camera profile matches calibration.':'Camera profile does not match calibration.'}`:
    'Measured camera configuration is unavailable from the receiver.';
  for(const id of ['camera-level','camera-shallow','camera-down','camera-steep'])
    $(id).disabled=autonomyActionPending||state.mode!=='live'||enabled||!a?.receiver?.camera_ready;
  const pitch=state.telemetry?.extra?.gimbal_pitch_deg;
  $('camera-pitch-status').textContent=Number.isFinite(pitch)&&a?.receiver?`Camera ${Math.round(pitch)}°`:'';
  const position=a?.receiver?.position;
  $('autonomy-detail').textContent=state.mode!=='live'?'Enable is available in Live mode only. LAND remains available.':
    emergency?'Aircraft reports an emergency. A completed landing has not been confirmed.':
    autonomyConnectionError?'Control connection interrupted; retrying. The receiver will land if its control watchdog expires.':
    !a?'Flight control unavailable.':
    !enabled&&a.reason&&a.reason!=='Autonomous response is off'?`${a.reason}${a.receiver?.ready?' · Ready to search when you start a new session.':a.receiver?.reason?' · '+a.receiver.reason:''}`:
    !a.receiver?'Waiting for the Pi/aircraft receiver. Connect and power both devices.':
    a.receiver.blocked_source?`${a.receiver.blocked_source==='yolo'?'RGB fire':'QR marker'} detected; automatic flight unavailable: ${a.receiver.reason}`:
    enabled&&phase==='recover'?`Holding position and reacquiring the fire · ${a.receiver.reason}`:
    progress?`${progress.summary} · ${progress.detail}`:
    enabled&&acquiring?`Fire response claimed; checking takeoff readiness · ${a.receiver.reason}`:
    enabled&&!a.mission?`${a.waiting_reason||a.reason}${position?` · Measured location: ${position.forward_m.toFixed(2)} m forward, ${position.right_m.toFixed(2)} m right`:''}`:
    enabled?(position?`Tracking fire: ${position.forward_m.toFixed(2)} m forward, ${position.right_m.toFixed(2)} m right${Number.isFinite(position.down_m)?`, ${position.down_m.toFixed(2)} m below drone`:''} · ${phase}`:
      a.mission?`Locating fire · ${a.receiver.reason}`:a.waiting_reason||a.reason):
      a.receiver.ready&&!a.receiver.camera_search_supported?'Waiting for automatic camera search capability.':a.receiver.reason||a.reason;
  document.querySelector?.('.autonomy-panel')?.setAttribute('data-enabled',String(enabled));
  renderContourRoute();
}
/** Renew only this live page's session; leaving live requests LAND and stops renewing it. */
async function pollAutonomy() {
  if (autonomyActionPending) return;
  const revision=autonomyRevision;
  try {
    let response;
    if (autonomousSession && state.mode==='live') {
      response=await getJson('/api/autonomy',{method:'POST',body:{action:'heartbeat',session_id:autonomousSession},timeout:1500});
    } else {
      if (autonomousSession) await api('/api/autonomy',{method:'POST',body:{action:'land'},timeout:1500});
      if (revision!==autonomyRevision) return;
      autonomousSession=null;
      response=await getJson('/api/autonomy',{timeout:1500});
    }
    if (revision!==autonomyRevision) return;
    state.autonomy=response;
    autonomyConnectionError=false;
    if (!state.autonomy.enabled) autonomousSession=null;
  } catch(error) {
    if (revision!==autonomyRevision) return;
    // A dropped HTTP reply must not abandon a still-authorized session. Keep
    // retrying its heartbeat; only the backend can confirm expiry. Its watchdog
    // still stops the mission if communication actually remains unavailable.
    if ([401,403,409].includes(error.status)) {
      autonomousSession=null; state.autonomy=null;
    }
    autonomyConnectionError=true;
  }
  renderAutonomy();
}
/** Send an explicit operator command; revisions prevent stale replies from restoring stopped ownership. */
async function setAutonomy(action,extra={}) {
  if (action==='enable' && (state.mode!=='live'||autonomyActionPending)) return;
  if (action==='camera' && (state.mode!=='live'||autonomyActionPending||state.autonomy?.enabled)) return;
  const revision=++autonomyRevision;
  // Stop refreshing permission immediately, including when LAND's HTTP request
  // cannot reach the backend. A failed stop must not leave heartbeats running.
  if (action==='land'||action==='disable') autonomousSession=null;
  autonomyActionPending=true; renderAutonomy();
  try {
    const response=await getJson('/api/autonomy',{method:'POST',body:{action,...extra},timeout:1500});
    if (revision!==autonomyRevision) return;
    state.autonomy=response;
    autonomyConnectionError=false;
    autonomousSession=action==='enable'?state.autonomy.session_id:null;
    toast(action==='camera'?'Camera tilt requested. Flight remains OFF.':action==='enable'?(extra.mode==='contour'?'Outdoor search requested: scan Marker 2 at 1 m and follow the 50 m fire forecast. Wind gaps use the labeled fallback.':'BOSCO active: camera search and automatic fire response enabled.'):'Landing requested; BOSCO stopped.');
  } catch(error) {toast(error.message);}
  finally {if(revision===autonomyRevision){autonomyActionPending=false;renderAutonomy();}}
}

// ------------------------------------------------------------- banner/heading

/** Set the incident/connection banner and optionally expose false-alarm dismissal. */
function setBanner(kind, html, showDismiss = false) {
  const b = $('status-banner'); b.className = 'simulation-banner status-banner ' + kind;
  $('banner-text').innerHTML = html; $('dismiss-fire').hidden = !showDismiss;
}
/** Update the workspace mode badge and its visual state. */
function setModePill(kind, text) { const p = $('mode-pill'); p.className = 'pill ' + kind; p.innerHTML = `<span class="dot"></span> ${escapeHTML(text)}`; }

/** Return the current active live incident; replay never reuses live incident state. */
function activeFire() {
  if (state.mode === 'demo') return null;
  const inc = state.incident;
  return inc && inc.active ? inc : null;
}

// Demo anchoring changes only the projection, never the captured detection.
function fireLocation() {
  const d = activeFire()?.latest;
  if (!d) return null;
  if (d.fire.latitude != null) return {...d.fire, simulated: !!d.details?.position_simulated};
  if (state.liveDemo) return {...state.site, simulated: true, position_source: 'configured-demo-site-not-measured'};
  return null;
}

function setLiveDemo(on) {
  state.liveDemo = on;
  $('live-demo-toggle').setAttribute('aria-pressed', String(on));
  $('live-demo-toggle').classList.toggle('active', on);
  if (state.mode === 'demo') exitDemo();
  $('map-pill').textContent = on ? 'Live demo' : 'Live';
  const url = new URL(location.href);
  url.searchParams.delete('demo');
  url.searchParams.delete('case');
  if (on) url.searchParams.set('live-demo', ''); else url.searchParams.delete('live-demo');
  history.replaceState(null, '', url);
  state.incidentModelKey = null;
  renderIncident(); renderSpread(); fitToFire(); refreshFireTiming();
}

function renderDetectionDetails() {
  const inc = activeFire();
  $('detection-details').hidden = !inc;
  if (!inc) return;
  const d = inc.latest, det = d.details || {}, loc = fireLocation();
  $('detection-source').textContent = d.source === 'qr-test' ? 'QR FIRE SCENARIO' : `CAMERA · ${d.label.toUpperCase()}`;
  $('detection-conditions').textContent = [
    det.area_ha != null ? `${det.area_ha} ha${det.area_source ? ' (estimated)' : ''}` : 'Area estimated by model',
    det.intensity, det.fuel, det.spread_m_per_min != null ? `${det.spread_m_per_min} m/min` : null,
    `${Math.round(state.scenario.wind)} km/h toward ${M.compass(state.scenario.direction)} (${d.source==='qr-test'?'QR scenario':'model input'})`,
    `${state.scenario.temp} °C`, `${state.scenario.rh}% RH`,
  ].filter(Boolean).join(' · ');
  $('detection-location').textContent = loc?.simulated
    ? `Scenario location: ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} · configured demo site; fire position not measured`
    : loc ? `Estimated fire location: ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} · ${loc.position_source || 'camera estimate'}`
      : 'Fire location unavailable. Enable Live demo to explore spread at the configured site.';
  $('detection-model-note').textContent = d.source === 'qr-test'
    ? 'Spread starts from the QR payload. Timeline and conditions use this incident.'
    : 'Spread uses the camera area estimate when available and adjustable environmental assumptions.';
  if(outdoorContourActive()) $('detection-model-note').textContent='Marker 2 identifies the fire area. The flight map uses a 50 m initial fire and the receiver’s fresh FC wind estimate; QR weather and the explorer controls do not drive the aircraft.';
}

function renderHeading() {
  if (state.mode === 'demo') return;
  const inc = activeFire(), t = state.telemetry;
  const telemetryAge = t ? Date.now() - Date.parse(t.observed_at) : Infinity;
  if (inc) {
    const d = inc.latest, det = d.details || {};
    $('incident-eyebrow').textContent = 'ACTIVE FIRE · ANAFI-01'; $('incident-dot').classList.add('alert');
    $('incident-title').textContent = det.name ? `${det.name} fire` : 'Fire detected'; $('incident-tag').hidden = false;
    const loc = fireLocation();
    const location = loc?.simulated ? 'Scenario location · configured site, not measured GPS' : loc ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}` : 'Fire location unavailable';
    $('incident-sub').textContent = `First sighted ${fmtTime(inc.first_detected_at)} · ${inc.sightings} sighting${inc.sightings === 1 ? '' : 's'} · ${location}`;
    const how = d.source === 'qr-test' ? 'test marker' : `fire model (${d.label})`;
    setBanner('alert', `<strong>${escapeHTML(d.label === 'smoke' ? 'Smoke' : 'Fire')} detected at ${escapeHTML(fmtTime(d.detected_at))}</strong> by ANAFI-01 · ${escapeHTML(how)}, ${Math.round(d.confidence * 100)}%. ${loc?.simulated ? 'Spread uses the configured demo location, not measured fire GPS.' : !loc ? 'Location unavailable; map projection is waiting.' : 'Fire location is available for the spread projection.'} Forecast and rescue leads are below.`, true);
    setModePill('alert-badge', state.liveDemo ? 'Live demo · detected' : 'Fire detected');
  } else {
    $('incident-eyebrow').textContent = 'LIVE MONITORING · ANAFI-01'; $('incident-dot').classList.remove('alert');
    $('incident-title').textContent = 'Monitoring for fire'; $('incident-tag').hidden = true;
    $('incident-sub').textContent = state.site.name;
    if (!state.connected) { setBanner('warn', '<strong>Backend offline</strong> · run <code>npm start</code>'); setModePill('demo', 'Offline'); }
    else if (telemetryAge > STALE_MS) { setBanner('info', '<strong>Waiting for the drone</strong> · keep the receiver running'); setModePill('demo', 'Waiting for drone'); }
    else {
      const v = state.status?.vision;
      const vision = !v?.fresh ? 'Fire detector is offline; video reception is active.' : v.error ? 'Fire detector reported an error; check its terminal.' : v.camera_state !== 'live' ? 'Fire detector is waiting for fresh camera frames.' : v.model_status === 'ready' ? 'RGB fire/smoke classification and QR fire testing are active.' : 'QR fire testing is active; RGB fire model is unavailable.';
      const peopleVision = v?.people_model_status === 'ready' ? 'Person recognition is active.' : 'Person recognition is unavailable.';
      setBanner('info', `<strong>${state.liveDemo ? 'Live demo' : 'Live'} · monitoring.</strong> ${vision} ${peopleVision}`); setModePill('live-badge', state.liveDemo ? 'Live demo · monitoring' : 'Live · monitoring');
    }
  }
}

// ------------------------------------------------------------------- map

/** Create base/overlay layers, shared drone rendering and person-search map controls. */
function initMap() {
  const map = state.map = L.map('map', {zoomControl: false, attributionControl: false, maxZoom: 22}).setView([state.site.latitude, state.site.longitude], 17);
  state.tiles = {osm: L.tileLayer('/tiles/osm/{z}/{x}/{y}.png', {maxNativeZoom: 19, maxZoom: 22}), sat: L.tileLayer('/tiles/sat/{z}/{x}/{y}.png', {maxNativeZoom: 18, maxZoom: 22})};
  for (const tiles of Object.values(state.tiles)) {
    tiles.on('tileload', () => { state.tilesOk = true; $('map-viewport').classList.remove('tiles-offline'); renderMapChip(); });
    tiles.on('tileerror', () => { state.tileErrors++; if (!state.tilesOk && state.tileErrors >= 4) { $('map-viewport').classList.add('tiles-offline'); renderMapChip(); } });
  }
  state.tiles.osm.addTo(map);
  for (const name of ['fuel', 'spread', 'wind', 'fire', 'drone', 'demo', 'orbit']) state.layers[name] = L.layerGroup().addTo(map);
  state.layers.contour = L.layerGroup().addTo(state.layers.drone);
  renderFuels();
  state.layers.path = L.polyline([], {color: '#3A372E', weight: 2, dashArray: '4 5', opacity: .75}).addTo(state.layers.drone);
  state.droneMarker = droneMarker([state.site.latitude, state.site.longitude]).setOpacity(0).addTo(state.layers.drone);
  L.control.scale({imperial: false, position: 'bottomright'}).addTo(map);
  map.on('dragstart', () => setFollow(false));
  state.layers.trail = L.layerGroup().addTo(state.layers.drone); // drone trail, coloured by what it was doing about the fire
  peopleInitMap();
  window.addEventListener('resize', () => map.invalidateSize());
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map-viewport'));
}

/** Draw the approximate site land-cover map once: brakes (buildings, pavement)
   in grey and faster fuel (ravine, woodlot) in green, both faint underlays
   that explain why the projected zone pinches and widens. */
function renderFuels() {
  const zones = globalThis.BoscoFuels?.zones || [];
  for (const z of zones) {
    const brake = z.factor < 1;
    L.polygon(z.polygon, {color: brake ? '#8C8679' : '#3f7d4f', weight: .8, dashArray: '3 4',
      fillColor: brake ? '#8C8679' : '#3f7d4f', fillOpacity: brake ? .07 : .09})
      .addTo(state.layers.fuel)
      .bindTooltip(`${escapeHTML(z.name)} — ${brake ? 'slows' : 'accelerates'} projected spread · approximate site cover`);
  }
}

/** Switch OSM/satellite layers and keep the control and attribution in sync. */
function setBasemap(kind) {
  state.map.removeLayer(state.tiles[kind === 'sat' ? 'osm' : 'sat']);
  state.tiles[kind].addTo(state.map).bringToBack();
  state.basemap = kind; $('layer-sat').checked = kind === 'sat';
  $('map-disclaimer').textContent = kind === 'sat' ? 'Imagery © Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap contributors';
}

/* Top-down ANAFI with spinning rotors, an altitude tag and the camera's
   69° field of view. Pixel-sized, so it reads at any zoom. */
const ROTORS = [[-14, -12, ''], [14, -12, ' ccw'], [-14, 13, ' ccw'], [14, 13, '']];
const DRONE_HTML = `<div class="drone-icon"><svg class="drone-svg" viewBox="-60 -60 120 120"><g class="drone-rot">
<path class="drone-cone" d="M0 -4 L-37.4 -54.4 A66 66 0 0 1 37.4 -54.4 Z"/>
<circle class="halo" r="25"/>
${ROTORS.map(([x, y]) => `<line class="arm${y < 0 ? ' front' : ''}" x1="0" y1="0" x2="${x}" y2="${y}"/>`).join('')}
${ROTORS.map(([x, y, d]) => `<circle class="disc" cx="${x}" cy="${y}" r="9"/><line class="blade${d}" x1="${x - 8}" y1="${y}" x2="${x + 8}" y2="${y}"/>`).join('')}
<rect class="body" x="-5.5" y="-10" width="11" height="22" rx="4"/><circle class="gimbal" cx="0" cy="-10" r="3"/><circle class="led rear" cx="-3" cy="10" r="1.2"/><circle class="led rear" cx="3" cy="10" r="1.2"/>
</g></svg><span class="drone-alt"></span></div>`;
/** Create the shared ANAFI map icon with camera cone, rotors and altitude label. */
const droneMarker = (ll, interactive = false) => L.marker(ll, {icon: L.divIcon({className: 'drone-icon-wrap', html: DRONE_HTML, iconSize: [120, 120], iconAnchor: [60, 60]}), keyboard: interactive, interactive});
/** Update map-icon heading in degrees, height label and grounded appearance. */
function setDronePose(marker, heading, alt, landed = false, id = 'ANAFI-01', color = '', selected = false) {
  const el = marker.getElement()?.querySelector('.drone-icon'); if (!el) return;
  el.querySelector('.drone-rot').setAttribute('transform', `rotate(${heading || 0})`);
  el.querySelector('.drone-alt').textContent = alt == null ? id : `${id} · ${alt < 10 ? alt.toFixed(1) : Math.round(alt)} m`;
  if (color) el.style.setProperty('--fleet-color', color);
  el.classList.toggle('fleet-selected', selected);
  const lift = Math.min(12, 2 + (alt ?? 0) / 10); // higher -> the shadow falls further away
  el.style.setProperty('--shadow-x', (lift * .6).toFixed(1) + 'px'); el.style.setProperty('--shadow-y', lift.toFixed(1) + 'px');
  el.classList.toggle('landed', landed);
}

/** Read only measured GPS coordinates, retaining the sensor event time instead of a refreshed cache time. */
function measuredGps(sample, now=Date.now(), requireFresh=true) {
  const source=sample?.extra?.position_source??sample?.position_source;
  const fixed=sample?.gps_fix;
  if(sample?.provenance!=='live'||source!=='gps'||fixed===false||fixed==='no fix'||
    !Number.isFinite(sample.latitude)||Math.abs(sample.latitude)>90||!Number.isFinite(sample.longitude)||Math.abs(sample.longitude)>180) return null;
  const eventAt=sample.extra?.gps_observed_at??sample.gps_observed_at;
  if(outdoorContourActive()&&!eventAt) return null;
  const at=Date.parse(eventAt??sample.observed_at??sample.t), age=now-at;
  if(!Number.isFinite(at)||age< -1000) return null;
  if(requireFresh&&(age>(eventAt?1500:STALE_MS)||(sample.extra?.gps_age_s??0)>1.5)) return null;
  return {point:[sample.latitude,sample.longitude],at,ageSeconds:Math.max(0,age/1000),droneId:sample.drone_id??'ANAFI-01'};
}
/** Return the current live GPS or explicitly simulated replay position when known. */
function dronePosition() {
  if (state.mode === 'demo') return state.demo.pos ?? null;
  return measuredGps(state.telemetry)?.point??null;
}
/** Toggle map following and centre on the selected drone position. */
function setFollow(on) {
  state.follow = on; $('zoom-drone').classList.toggle('active', on);
  const p = on && dronePosition(); if (p) state.map.setView(p, Math.max(state.map.getZoom(), demoCase() ? 15 : 19));
}

/** Explain missing position or unavailable map tiles over the map. */
function renderMapChip() {
  let title = '', text = '';
  if ($('map-viewport').classList.contains('tiles-offline')) { title = 'Map tiles offline'; text = ''; }
  else if (state.mode === 'live' && !state.telemetry) { title = 'No drone position yet'; text = ''; }
  else if(state.mode==='live'&&!measuredGps(state.telemetry)) {title='Fresh GPS position unavailable';text='The drone marker waits for measured GPS.';}
  $('map-empty').hidden = !title; $('map-empty-title').textContent = title; $('map-empty-text').textContent = text;
}

/** Build chronological received-GPS trail segments, breaking at gaps or unverified positions. */
function measuredGpsTrail(path=state.flight.path, now=Date.now()) {
  const rows=[...(path??[])], latest=state.telemetry;
  if(latest&&(!rows.length||Date.parse(latest.observed_at)>Date.parse(rows.at(-1).t??rows.at(-1).observed_at))) rows.push(latest);
  const segments=[];let current=[],previous=null;
  const started=outdoorContourActive()?(state.autonomy.search?.claimed_at??state.autonomy.enabled_at??0):0;
  /** Retain completed line segments without bridging missing evidence. */
  const flush=()=>{if(current.length>1) segments.push(current);current=[];previous=null;};
  for(const row of rows) {
    const fix=measuredGps(row,now,false);
    if(!fix||fix.droneId!==(latest?.drone_id??'ANAFI-01')) {flush();continue;}
    if(fix.at<started) continue;
    if(previous&&(fix.at<previous.at||fix.at-previous.at>5000)) flush();
    if(previous&&fix.at===previous.at) continue;
    current.push(fix.point);previous=fix;
  }
  flush();return segments;
}
/** Update the live aircraft directly from received GPS; forecast animation never advances this marker. */
function renderDrone() {
  if(state.mode==='demo') {$('live-position-status').hidden=true;return;}
  const t = state.telemetry;
  const fix=measuredGps(t), last=measuredGps(t,Date.now(),false), layer=state.layers.trail;
  $('live-position-status').hidden=false;
  $('live-position-status').textContent=fix?`ANAFI-01 · received GPS ${fix.point[0].toFixed(6)}, ${fix.point[1].toFixed(6)} · ${fix.ageSeconds.toFixed(1)} s old · blue trail is recorded GPS; forecast is a model.`:
    last?`GPS stale · last fix ${last.ageSeconds.toFixed(1)} s ago. Current drone marker hidden; recorded GPS trail remains.`:'Waiting for actual GPS · current drone marker unavailable; configured site coordinates are not flight evidence.';
  if(layer) {layer.clearLayers();for(const points of measuredGpsTrail()) L.polyline(points,{color:'#4a80df',weight:3,opacity:.9}).addTo(layer).bindTooltip('Recorded aircraft GPS · received positions only');}
  $('trail-legend').hidden=true;
  if(!fix) {state.droneMarker?.setOpacity(0);return;}
  const ll = fix.point;
  state.droneMarker.setLatLng(ll).setOpacity(1);
  setDronePose(state.droneMarker, t.extra?.heading_deg, t.altitude_m, t.state === 'landed');
  if (state.follow) state.map.panTo(ll);
  if (!state.centredOnDrone) { state.centredOnDrone = true; if (!activeFire()) state.map.setView(ll, 19); }
}

/* Detection details driving the spread model: the live detection, or the simulated search's fire. */
function fireDetails() {
  if (state.mode === 'demo') return state.demo.selected?.id === 'people' ? state.demo.selected.details ?? null : null;
  return activeFire()?.latest.details ?? null;
}
/** Distinguish a modeled live/search fire from the separate historical burn replay. */
const modelledFire = () => state.mode === 'live' ? !!activeFire() : !!(state.demo.selected?.id === 'people' && state.demo.selected.details);

/** Return the usable fire coordinates without inventing GPS or prematurely locating replay fire. */
function origin() {
  if (peopleDemoActive()) { const f = state.demo.selected; return f.lat != null ? [f.lat, f.lon] : null; }
  if (state.mode === 'demo') { const f = demoCase(); return f && state.demo.located ? [f.lat, f.lon] : null; }
  const loc = fireLocation(); return loc ? [loc.latitude, loc.longitude] : null;
}

/* Minutes the live fire has already burned since first detection — the
   contour is a continuous function of real elapsed time, not a frozen
   snapshot of the first sighting. Size, wind, direction and fuels all feed
   the same rings, so any change morphs the whole stack. */
function fireAgeMin() {
  const inc = state.mode === 'live' ? activeFire() : null;
  const t0 = inc?.first_detected_at || inc?.latest?.detected_at;
  const ms = t0 ? Date.now() - new Date(t0).getTime() : 0;
  return Math.min(60, Math.max(0, ms / 60000));
}
/** Model minutes for the rendered rings: fire age + the timeline lookahead. */
const spreadMinutes = () => fireAgeMin() + state.minute;
/** Incident identity for forecast-trail scoping; empty string when no fire. */
const incIdentity = () => activeFire()?.episode_id || '';

/** Read only a receiver-confirmed fixed GPS anchor, never an explorer/demo pin. */
function contourMissionGeometry(now=Date.now()) {
  const a=state.autonomy, c=a?.receiver?.contour, anchor=c?.anchor;
  if(state.mode!=='live'||!a?.enabled||a.mode!=='contour'||!globalThis.BoscoContour||
     anchor?.position_source!=='gps'||!Number.isFinite(anchor.latitude)||!Number.isFinite(anchor.longitude)) return null;
  const config=a.mission?.contour, started=c.started_at??config?.started_at, details=c.details??config?.details;
  if(!Number.isFinite(started)||!details) return null;
  const outdoor=(c.profile??config?.profile)===OUTDOOR_CONTOUR_PROFILE, sc=c.effective_scenario;
  const wind=outdoor?contourWindEvidence(c,now):null;
  if(outdoor&&(!sc||!['wind','direction','temp','rh','dryness'].every(k=>Number.isFinite(sc[k]))||!wind)) return null;
  const geometry=BoscoContour.forecast([anchor.latitude,anchor.longitude], details, Math.max(0,now-started)/60000,outdoor?sc:null);
  if(outdoor&&Number.isFinite(c.speed_mps)) geometry.speedMps=c.speed_mps;
  return {...geometry,anchor,outdoor,wind};
}

/** Draw the exact flight forecast independently of mutable explorer conditions. */
function renderContourRoute() {
  const layer=state.layers.contour;
  if(!layer) return;
  layer.clearLayers();
  if(state.mode==='live'&&state.autonomy?.enabled&&state.autonomy.mode==='contour') state.layers.orbit?.clearLayers();
  const geometry=contourMissionGeometry();
  if(outdoorContourActive()) {
    state.layers.spread?.clearLayers();state.layers.wind?.clearLayers();state.layers.fire?.clearLayers();
    $('area-value').textContent=geometry?M.areaHa(geometry.current).toFixed(3):'—';
    $('area-context').textContent=geometry?`50 m initial fire · ${geometry.wind?.status==='measured'?'measured wind':geometry.wind?.status==='stale'?'last measured wind · degraded':'assumed wind'}`:'waiting for Marker 2 and receiver flight plan';
    $('time-label').textContent='Flight forecast · +5 min';
  }
  if(!geometry) return;
  if(geometry.outdoor&&state.layers.fire) L.marker([geometry.anchor.latitude,geometry.anchor.longitude],
    {icon:L.divIcon({className:'fire-pin-wrap',html:'<div class="fire-pin">🔥</div>',iconSize:[34,34],iconAnchor:[17,17]})})
    .addTo(state.layers.fire).bindTooltip('Outdoor fire area · measured GPS anchor from Marker 2 · 50 m initial scenario');
  L.polygon(geometry.current,{color:'#d9480f',weight:1.5,fillColor:'#d9480f',fillOpacity:.28})
    .addTo(layer).bindTooltip(geometry.outdoor?'Outdoor scenario · fire now · 50 m initial diameter · measured GPS anchor':'Contour mission · fire now · fixed initial QR area');
  L.polygon(geometry.route,{color:'#249bc5',weight:3,fill:false})
    .addTo(layer).bindTooltip(`GPS flight route · +5-minute contour · ${geometry.outdoor?`50 m initial fire · ${geometry.wind.label} · `:''}patrol ${geometry.speedMps.toFixed(3)} m/s · real-time growth`);
  const mission=state.autonomy.mission?.id;
  if(mission&&state.contourFittedMission!==mission) {state.contourFittedMission=mission;fitToFire();}
}

let contourPreviewStarted=0, contourPreviewOffset=0, contourPreviewLast=0;
/** Reset the aircraft-free preview clock; its minutes never reach the flight API. */
function resetContourPreview(minutes=0) {
  contourPreviewStarted=Date.now(); contourPreviewOffset=minutes;
  renderTinyContourPreview();
}

/** Render one hypothetical aircraft on the same uniform-fuel +5-minute model. */
function renderTinyContourPreview(now=Date.now()) {
  const C=globalThis.BoscoContour; if(!C) return;
  const age=Math.min(5,Math.max(0,contourPreviewOffset+(now-contourPreviewStarted)/60000));
  const geometry=C.forecast([0,0],C.TINY,age), final=C.forecast([0,0],C.TINY,5).route;
  // Local metre coordinates deliberately have no geographic/site provenance.
  const xs=final.map(p=>p[1]*111320), ys=final.map(p=>-p[0]*111320);
  const centreX=(Math.min(...xs)+Math.max(...xs))/2, centreY=(Math.min(...ys)+Math.max(...ys))/2;
  const scale=Math.min(530/(Math.max(...xs)-Math.min(...xs)),285/(Math.max(...ys)-Math.min(...ys)));
  /** Project model coordinates into a fixed viewport so growth remains visible. */
  const point=p=>[320+(p[1]*111320-centreX)*scale,185+(-p[0]*111320-centreY)*scale];
  /** Serialize a numeric model ring for SVG without exposing markup input. */
  const path=ring=>ring.map((p,i)=>`${i?'L':'M'}${point(p).map(n=>n.toFixed(2)).join(' ')}`).join(' ')+' Z';
  const drone=point(C.alongRing(geometry.route,age*60*geometry.speedMps));
  const marker=point([0,0]);
  $('contour-preview-plot').innerHTML=`<path class="preview-current" d="${path(geometry.current)}"/><path class="preview-forecast" d="${path(geometry.route)}"/><circle class="preview-origin" cx="${marker[0]}" cy="${marker[1]}" r="4"/><g class="preview-aircraft" transform="translate(${drone[0]-12} ${drone[1]-12})"><use href="#i-drone" width="24" height="24"/></g><path class="preview-scale" d="M35 340h${scale.toFixed(2)}m-${scale.toFixed(2)} -4v8m${scale.toFixed(2)} -8v8"/><text x="35" y="365">1 metre · local coordinates</text>`;
  $('contour-preview-time').value=age.toFixed(2);
  $('contour-preview-age').textContent=`${age.toFixed(1)} min elapsed`;
  $('contour-preview-speed').textContent=`${geometry.speedMps.toFixed(3)} m/s patrol · ${C.TINY.wind_kmh} km/h wind · 1 cm/min head spread · real-time growth`;
}

/* Projected spread at the selected minute, drawn as layered intensity bands. */
function renderSpread() {
  const sc = state.scenario, t = spreadMinutes(), age = fireAgeMin();
  renderDetectionDetails();
  $('time-label').textContent = `T + ${Math.round(state.minute)} min`; $('timeline').value = state.minute;
  document.querySelectorAll('[data-minute]').forEach(b => b.classList.toggle('selected', Math.abs(+b.dataset.minute - state.minute) < .5));
  renderWindMetric();
  state.layers.spread.clearLayers(); state.layers.wind.clearLayers(); state.layers.orbit?.clearLayers();
  if(outdoorContourActive()) {
    const geometry=contourMissionGeometry();
    $('time-label').textContent='Flight forecast · +5 min';
    $('area-value').textContent=geometry?M.areaHa(geometry.current).toFixed(3):'—';
    $('area-context').textContent=geometry?`50 m initial fire · ${geometry.wind?.status==='measured'?'measured wind':geometry.wind?.status==='stale'?'last measured wind · degraded':'assumed wind'}`:'waiting for Marker 2 and receiver flight plan';
    renderContourRoute();return;
  }
  const o = origin();
  if (!o) { $('area-value').textContent = '—'; $('area-context').textContent = forestWaiting() ? 'no fire detected' : state.mode === 'demo' ? (demoCase() ? 'confirming detection…' : 'select a fire') : activeFire() ? 'fire detected · location unavailable' : 'no fire detected'; return; }
  /** Supply scaled fire-outline bands for the active spread-rendering branch. */
  let outline, ring = scale => [];
  if (state.mode === 'demo' && !peopleDemoActive()) {
    // Demo: the fire ANAFI-01 sees now, growing to the recorded burn over the timeline.
    const f = demoCase();
    ring = scale => demoOutline(f, t, scale);
    outline = ring(1);
  } else {
    const details = fireDetails();
    ring = scale => M.footprint(o, t, sc, details, scale);
    outline = ring(1);
    L.polygon(M.footprint(o, age, sc, details), {color: '#9e3026', weight: 1.4, dashArray: '4 4', fill: false}).addTo(state.layers.spread).bindTooltip(age > .1 ? `Fire now — burning for ~${Math.round(age)} min` : 'Fire now');
  }
  /* Forecast trail: a projection is only the forecast under the conditions
     measured at that moment. When wind/direction shifts, the earlier outer
     ring survives as a fading ghost — so the judge sees the +60 forecast from
     15 min ago differ from the +45 computed under the veered wind. Buckets
     keep the ticker-lerp from spamming ghosts on every tiny step. */
  if (incIdentity() !== state.ghostEpisode) { state.ghosts = []; state.ghostEpisode = incIdentity(); state.prevSig = null; state.prevForecast = null; }
  const sig = modelledFire() ? `${incIdentity()}|${Math.round(sc.wind / 4)}|${Math.round(sc.direction / 12)}` : null;
  if (sig && state.prevForecast && sig !== state.prevSig) {
    const ghosts = (state.ghosts || []).concat({pts: state.prevForecast, sig: state.prevSig});
    state.ghosts = ghosts.slice(-4);
  }
  state.prevSig = sig; state.prevForecast = sig ? outline : null;
  if (sig) (state.ghosts || []).forEach((g, i) => {
    L.polygon(g.pts, {color: '#a8764a', weight: 1, dashArray: '2 6', fill: false, opacity: .18 + .1 * i})
      .addTo(state.layers.spread).bindTooltip('Earlier forecast — superseded when conditions changed');
  });
  // Contours morph between states: a fire's outline is (roughly) an ellipse,
  // so vertex-lerping the 72-point rings glides the zone instead of jumping.
  const targets = SPREAD_BANDS.map(([scale, color, opacity]) => ({
    scale, color, opacity, pts: ring(scale),
    tooltip: scale === 1 && modelledFire() ? `Projected head ≈${M.spreadRate(sc, fireDetails()).toFixed(0)} m/min toward ${M.compass(sc.direction)}` : null,
  }));
  morphSpread(targets);
  /* Standoff orbit track: the drone's contour follows the fire's perimeter,
     sliding outward at the fire's own advance speed. Circumference scales
     with fire size — a soccer-ball fire means tight orbits, a block-wide
     fire means a long spaced-out track. */
  const fleet = globalThis.BoscoFleet;
  if (fleet && modelledFire() && !(state.mode==='live'&&state.autonomy?.enabled&&state.autonomy.mode==='contour')) {
    const margin = 40;
    const retreat = fleet.orbitSpeedMps(o, t, sc, fireDetails(), sc.direction, margin, M);
    const orbitPts = fleet.offsetContour(outline, margin);
    const poly = L.polyline(state.orbitCur || orbitPts, {color: '#2f7fd1', weight: 1.5, dashArray: '6 5', opacity: .85})
      .addTo(state.layers.orbit)
      .bindTooltip(`Drone orbit — ${margin} m standoff · retreats ≈${retreat ? retreat.toFixed(1) : '—'} m/s as the fire advances`);
    morphTarget({poly, pts: orbitPts, key: 'orbitCur'});
  }
  if (demoCase()) L.polygon(demoOutline(demoCase(), 0), {color: '#a82f1d', weight: 2, fillColor: '#d9480f', fillOpacity: .3}).addTo(state.layers.spread).bindTooltip('Fire now · outer rings are predictions');
  const area = M.areaHa(outline);
  $('area-value').textContent = area >= 100 ? Math.round(area).toLocaleString() : area.toFixed(area < 1 ? 3 : 1);
  $('area-context').textContent = state.minute < .5 ? (age > .1 ? `now · burning ~${Math.round(age)} min` : 'now') : `projected at +${Math.round(state.minute)} min`;
  const reach = !modelledFire() ? Math.sqrt(area * 10000 / Math.PI) * 1.3 : M.headDistance(t, sc, fireDetails());
  const windHead = M.destPoint(o[0], o[1], sc.direction, reach);
  L.polyline([M.destPoint(o[0], o[1], sc.direction + 180, reach * .25), windHead], {color: '#8C8679', weight: 1.6, dashArray: '2 6'}).addTo(state.layers.wind).bindTooltip(`${state.mode==='live'?'Model input':'Replay scenario'} wind ${Math.round(sc.wind)} km/h toward ${M.compass(sc.direction)}`);
  L.marker(windHead, {icon: L.divIcon({className: 'wind-arrow', html: `<div style="transform:rotate(${Math.round(sc.direction)}deg)">▲</div>`, iconSize: [14, 14], iconAnchor: [7, 7]}), interactive: false}).addTo(state.layers.wind);
}

/** Draw only the positioned live fire, with its detection context. */
function renderFirePin() {
  state.layers.fire.clearLayers();
  if(outdoorContourActive()) {renderContourRoute();return;}
  const inc = activeFire(); if (!inc || !origin()) return;
  const d = inc.latest, det = d.details || {}, loc = fireLocation();
  L.marker([loc.latitude, loc.longitude], {icon: L.divIcon({className: 'fire-pin-wrap', html: '<div class="fire-pin">🔥</div>', iconSize: [34, 34], iconAnchor: [17, 17]})})
    .addTo(state.layers.fire)
    .bindPopup(`<b>${escapeHTML(det.name || 'Detected fire')}</b><br>${escapeHTML(d.label)} · ${Math.round(d.confidence * 100)}% · ${escapeHTML(d.source)}<br>${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}<br>${loc.simulated ? 'Configured scenario location · not measured' : escapeHTML(loc.position_source || 'camera estimate')}${det.area_ha != null ? `<br>Reported area ${escapeHTML(det.area_ha)} ha` : ''}${det.fuel ? `<br>Fuel: ${escapeHTML(det.fuel)}` : ''}`);
  if (!loc.simulated && d.drone?.latitude != null) L.polyline([[d.drone.latitude, d.drone.longitude], [loc.latitude, loc.longitude]], {color: '#E8562A', weight: 1.5, dashArray: '3 4'}).addTo(state.layers.fire);
}

/** Frame the relevant search sector, fire footprint or drone fallback on the map. */
function fitToFire() {
  const contour=contourMissionGeometry();
  if(contour) {
    const drone=dronePosition(), points=drone?[...contour.route,drone]:contour.route;
    state.map.invalidateSize();
    state.map.fitBounds(L.latLngBounds(points).pad(.35),{maxZoom:22});
    return;
  }
  if (peopleDemoActive() && fitPeople()) return;
  if (demoCase() && state.demo.scout) {
    state.map.invalidateSize();
    const scout = state.demo.scout, t = demoT();
    const fleet = scout.drones.map(d => { const p = BoscoScout.pose(scout, t, d.id); return [p.lat, p.lon]; });
    const f = demoCase(), fire = state.demo.located ? demoOutline(f, state.minute) : [[f.lat, f.lon]];
    state.map.fitBounds(L.latLngBounds([...fleet, ...fire]).pad(.3), {maxZoom: 18});
    return;
  }
  const o = origin();
  if (!o && demoCase()) { const f = demoCase(); state.map.fitBounds(L.latLng(f.lat, f.lon).toBounds(1100)); return; } // drone and fire, before geolocation
  if (!o) { const gps=dronePosition(); if(gps) state.map.setView(gps,19); else state.map.setView([state.site.latitude,state.site.longitude],17); return; }
  state.map.invalidateSize();
  const pts = state.mode === 'demo' && !peopleDemoActive() ? [...demoOutline(demoCase(), state.minute), state.demo.pos] : M.footprint(o, 30, state.scenario, fireDetails());
  state.map.fitBounds(L.latLngBounds(pts).pad(.15), {maxZoom: 20});
}

// ------------------------------------------------------------- telemetry

/** Display measured drone values and mark missing or stale live telemetry clearly. */
/* Collect each drone's FC wind vector (NED m/s) into the fleet sample set. */
function updateWindSamples() {
  const t=state.telemetry, w=liveWindReading(), id=t?.drone_id||'ANAFI-01';
  if(!w) {delete state.windSamples[id];return;}
  const d=(w.direction??0)*Math.PI/180;
  state.windSamples[id]={drone_id:id,north:w.speedMps*Math.cos(d),east:w.speedMps*Math.sin(d),
    alt_m:Number.isFinite(t.altitude_m)?t.altitude_m:null,captured_at:w.observedAt,flight_state:t.state};
}

/* Air readings riding the same telemetry stream: humidity and temperature
   drift feeds the scenario exactly like wind does, so a moist lull or a
   hot dry gust reshapes the contour on the very next render. */
function applyEnvSamples() {
  const extra = state.telemetry?.extra || {};
  const rh = extra.rh_pct, temp = extra.temp_c;
  let changed = false;
  if (Number.isFinite(rh)) { const v = Math.round(Math.min(100, Math.max(0, rh))); if (v !== state.scenario.rh) { state.scenario.rh = v; changed = true; } }
  if (Number.isFinite(temp)) { const v = Math.round(temp * 10) / 10; if (v !== state.scenario.temp) { state.scenario.temp = v; changed = true; } }
  if (changed && state.mode === 'live') { renderSpread(); refreshFireTiming(); }
}

function renderTelemetry() {
  if (state.mode === 'demo') return;
  updateWindSamples();
  applyEnvSamples();
  renderWindMetric();
  const t = state.telemetry;
  if (!t) { for (const id of ['altitude', 'ground-speed', 'power']) $(id).innerHTML = `— <small>${id === 'power' ? '%' : id === 'altitude' ? 'm' : 'm/s'}</small>`; $('flight-state').textContent = '—'; return; }
  // FC wind arrives on every telemetry packet — feed it straight into the
  // scenario (eased, altitude-normalized) instead of waiting on an analysis.
  const w=liveWindReading();
  if(w) {
    applyWindEstimate({created_at:new Date(w.observedAt).toISOString(),episode_id:null,
      wind_estimate:{speed_mps:w.speedMps,direction_deg:w.direction,method:'flight-controller'}});
  }
  const age = Math.max(0, (Date.now() - Date.parse(t.observed_at)) / 1000), stale = age * 1000 > STALE_MS;
  $('altitude').innerHTML = `${escapeHTML(t.altitude_m ?? '—')} <small>m</small>`;
  $('ground-speed').innerHTML = `${escapeHTML(t.ground_speed_mps ?? '—')} <small>m/s</small>`;
  $('power').innerHTML = `${escapeHTML(t.battery_pct ?? '—')} <small>%</small>`;
  $('flight-state').textContent = FLIGHT_STATES[t.state] || t.state || '—';
  $('battery-value').innerHTML = `${escapeHTML(t.battery_pct ?? '—')}<span class="small-unit">%</span>`;
  $('battery-context').textContent = stale ? `last seen ${Math.round(age)} s ago` : 'ANAFI-01 battery';
  $('telemetry-tag').textContent = stale ? 'STALE' : 'LIVE';
  $('drone-source').textContent = stale ? 'Telemetry stale' : 'Live telemetry';
  const where = measuredGps(t)?'measured GPS':t.extra?.position_source==='gps'?'GPS stale or unavailable':'GPS unavailable';
  $('telemetry-note').textContent = `${stale ? 'STALE · ' : ''}${t.drone_id || 'ANAFI-01'} · ${where} · heading ${t.extra?.heading_deg ?? '—'}° · camera ${t.extra?.gimbal_pitch_deg != null ? Math.round(t.extra.gimbal_pitch_deg) + '°' : '—'} · ${Math.round(age)} s ago`;
  $('telemetry-note').classList.toggle('error-text', stale);
}

/** Render live flight-phase progress and recent event messages. */
function renderFlight() {
  if (state.mode === 'demo') return;
  const e = state.flight.events.at(-1);
  if (aircraftEmergency()) {
    $('flight-progress').hidden=false;
    $('flight-phase').textContent=`Aircraft ${FLIGHT_STATES[state.telemetry.state].toLowerCase()} · landing not confirmed`;
    $('flight-bar').style.width='0%';
    $('flight-progress').classList.toggle('error',true);
    return;
  }
  const recent = e && Date.now() - Date.parse(e.at) < (e.phase === 'landed' || e.phase === 'aborted' || e.phase === 'error' ? 10_000 : 120_000);
  $('flight-progress').hidden = !recent; if (!recent) return;
  if (e.phase==='landed' && state.telemetry?.state && state.telemetry.state!=='landed'
      && Date.parse(state.telemetry.observed_at)>=Date.parse(e.at)-2000) {
    $('flight-phase').textContent=`Landing unconfirmed · aircraft reports ${FLIGHT_STATES[state.telemetry.state]||state.telemetry.state}`;
    $('flight-bar').style.width='0%';
    $('flight-progress').classList.toggle('error',true);
    return;
  }
  const frac = {preflight: 0, takeoff: .1, climb: .2, recover: .2, circle: .2 + .6 * ((e.step || 0) / (e.steps || 8)), return: .85, landing: .93, landed: 1, aborted: 1, error: 1}[e.phase] ?? 0;
  $('flight-phase').textContent = `Flight pattern · ${e.phase}${e.step ? ` ${e.step}/${e.steps}` : ''}${e.message ? ' · ' + e.message : ''}`;
  $('flight-bar').style.width = Math.round(frac * 100) + '%';
  $('flight-progress').classList.toggle('error', e.phase === 'error' || e.phase === 'aborted');
}

// ---------------------------------------------------------------- video

const CRLF2 = [13, 10, 13, 10];
/** Join two byte arrays used by the incremental MJPEG parser. */
function concat(a, b) { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
/** Find a byte sequence inside buffered multipart data, or return minus one. */
function findSeq(buf, seq) { outer: for (let i = 0; i <= buf.length - seq.length; i++) { for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer; return i; } return -1; }
/* One part of the backend's multipart MJPEG stream, or null if incomplete. */
function takeFrame(buf) {
  const end = findSeq(buf.subarray(0, Math.min(buf.length, 4096)), CRLF2);
  if (end < 0) return buf.length > 4096 ? {rest: buf.subarray(buf.length)} : null;
  const head = new TextDecoder().decode(buf.subarray(0, end));
  const len = Number((/Content-Length:\s*(\d+)/i.exec(head) || [])[1]);
  const start = end + 4;
  if (!len) return {rest: buf.subarray(start)};
  if (buf.length < start + len) return null;
  let detections = []; try { detections = JSON.parse((/X-Detections:\s*(.*)/i.exec(head) || [])[1] || '[]'); } catch {}
  return {jpeg: buf.slice(start, start + len), captured: (/X-Captured-At:\s*(\S+)/i.exec(head) || [])[1], detections, rest: buf.subarray(Math.min(buf.length, start + len + 2))};
}

/** Maintain the authenticated MJPEG subscription and reconnect after stream failures. */
async function streamVideo() {
  for (;;) {
    try {
      const res = await fetch('/api/video', {headers: {Authorization: 'Bearer ' + state.token}});
      if (!res.ok) throw new Error('video ' + res.status);
      const reader = res.body.getReader(); let buf = new Uint8Array(0);
      for (;;) {
        const {value, done} = await reader.read(); if (done) break;
        buf = concat(buf, value);
        for (let f = takeFrame(buf); f; f = takeFrame(buf)) { buf = f.rest; if (f.jpeg) drawFrame(f); }
      }
    } catch {}
    await sleep(2000);
  }
}

/** Decode a received JPEG, preserve capture freshness and draw its detection overlays. */
async function drawFrame(f) {
  if (state.video.decoding || state.mode === 'demo') return; // decoder busy: skip, the next frame is newer anyway
  state.video.decoding = true;
  try {
    const bmp = await createImageBitmap(new Blob([f.jpeg], {type: 'image/jpeg'}));
    if (state.mode === 'demo') { bmp.close(); return; }
    const canvas = $('camera'), ctx = canvas.getContext('2d');
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
    ctx.drawImage(bmp, 0, 0); bmp.close();
    const tracked = state.autonomy?.observed_target;
    const located = tracked && state.autonomy?.receiver?.position?.episode_id === tracked.episode_id;
    const freshTracked = tracked && Math.abs(Date.parse(f.captured) - tracked.at) < 600;
    const boxes = Array.isArray(f.detections) ? f.detections : [];
    // Replace only matching fire evidence; live people and other sources keep their own boxes.
    const overlays = freshTracked ? [...boxes.filter(d => d?.source !== tracked.source || !['fire', 'smoke'].includes(d.label)),
      {...tracked, label: tracked.label || 'fire', trackingLabel: located ? 'FIRE · LOCATED'
        : tracked.hits >= 5 && tracked.at - tracked.first >= 800 ? 'FIRE · CONFIRMED' : 'FIRE · CONFIRMING'}] : boxes;
    const detections = overlays.filter(d => d && Array.isArray(d.bbox)
      && d.bbox.length === 4 && d.bbox.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      && d.bbox[2] > d.bbox[0] && d.bbox[3] > d.bbox[1] && Number.isFinite(d.confidence));
    for (const d of detections) {
      const [x1, y1, x2, y2] = d.bbox, w = canvas.width, h = canvas.height;
      const color = d.label === 'person' ? '#5CC8C0' : '#E8562A';
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, w / 240); ctx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
      ctx.fillStyle = color; ctx.font = `600 ${Math.round(w / 40)}px 'IBM Plex Mono', ui-monospace, monospace`; ctx.fillText(`${d.trackingLabel || (d.source === 'qr-test' ? 'FIRE · QR scenario' : String(d.label || 'DETECTION').toUpperCase())} ${Math.round(d.confidence * 100)}%`, x1 * w, Math.max(h / 20, y1 * h - 8));
    }
    const now = Date.now(), captured = Date.parse(f.captured);
    // A late overlay can redraw an image; that is not a new camera frame.
    if (Number.isFinite(captured)) state.video.lastAt = captured;
    if (state.video.lastCapture !== f.captured) state.video.times.push(now);
    state.video.lastCapture = f.captured; state.video.times = state.video.times.filter(t => now - t < 2000);
    const fire = detections.find(d => d.label === 'fire' || d.label === 'smoke');
    $('camera-label').innerHTML = fire ? `<i class="hot"></i> ${fire.label === 'smoke' ? 'SMOKE' : 'FIRE'} IN VIEW` : '<i></i> LIVE · ANAFI-01';
    $('camera-clock').textContent = f.captured ? new Date(f.captured).toLocaleTimeString() : '—';
    $('video-fps').textContent = `${(state.video.times.length / 2).toFixed(1)} fps`;
    $('video-status').textContent = 'Live camera frames via backend relay';
  } catch {} finally { state.video.decoding = false; }
}

/** Render a clear placeholder when camera evidence is unavailable or simulated differently. */
function drawWaiting(title, sub) {
  const canvas = $('camera'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#2A2822'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#F3EFE6'; ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(w / 22)}px 'Instrument Sans', system-ui, sans-serif`; ctx.fillText(title, w / 2, h * .24);
  ctx.font = `${Math.round(w / 34)}px 'Instrument Sans', system-ui, sans-serif`; ctx.fillStyle = '#B9B3A6'; ctx.fillText(sub, w / 2, h * .24 + w / 18); ctx.textAlign = 'start';
}

/** Mark stale live video without replacing it with replay imagery. */
function videoWatchdog() {
  if (state.mode === 'demo' || Date.now() - state.video.lastAt < 3000) return;
  drawWaiting(state.video.lastAt ? 'Reconnecting…' : 'No video', '');
  $('camera-label').innerHTML = '<i></i> NO VIDEO'; $('video-fps').textContent = '—';
  $('video-status').textContent = state.video.lastAt ? `Last frame ${Math.round((Date.now() - state.video.lastAt) / 1000)} s ago` : 'Waiting for the bridge';
}

// -------------------------------------------------------------- incident

/** Apply a newly detected live fire's scenario and refresh incident-dependent panels. */
function renderIncident() {
  if (state.mode === 'demo') return;
  const inc = activeFire();
  const modelKey = inc ? JSON.stringify([inc.episode_id, fireLocation(), inc.latest.details, state.liveDemo]) : null;
  const modelChanged = modelKey !== state.incidentModelKey;
  state.incidentModelKey = modelKey;
  if (inc && inc.episode_id !== state.episodeSeen) {
    state.episodeSeen = inc.episode_id;
    state.detectedScenario = M.scenarioFrom(inc.latest.details);
    state.scenario = {...state.detectedScenario}; state.minute = 0;
    state.windAuto = state.windManual = state.windDerived = null;
    state.playing = false; setPlayButton();
    renderFirePin(); renderSpread(); fitToFire();
    toast(`Fire detected — ${inc.latest.details?.name || inc.latest.label}. See the forecast and rescue leads below.`);
  } else {
    renderFirePin();
    if (inc && modelChanged) {
      // Keep operator changes, but adopt updated reported conditions when
      // the previous detection's defaults are still selected.
      const following = JSON.stringify(state.scenario) === JSON.stringify(state.detectedScenario);
      state.detectedScenario = M.scenarioFrom(inc.latest.details);
      if (following) state.scenario = {...state.detectedScenario};
      renderSpread(); refreshFireTiming();
    }
  }
  if (!inc && state.episodeSeen) { state.episodeSeen = null; renderSpread(); }
  if (inc) {
    $('detect-value').textContent = Math.round(inc.max_confidence * 100); $('detect-unit').textContent = '%';
    $('detect-context').textContent = `${inc.latest.source === 'qr-test' ? 'test marker' : 'fire model · ' + inc.latest.label} · ${inc.sightings} sightings`;
  } else { $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'watching the camera feed'; }
  renderDetectionDetails(); renderHeading();
}

// -------------------------------------------------------------- analysis

/* Which estimator a wind_estimate came from — the label follows the method,
   so a flight-controller value and a tilt-derived value are not conflated. */
function windSourceLabel(w) {
  return /flight-controller|flight controller/i.test(w?.method ?? '') ? ' · FC est.' : ' · derived est.';
}

/* When a telemetry packet carries a wind estimate — the flight controller's
   own onboard estimate when the drone streams one, else a value derived from
   stabilization telemetry — adopt it as the scenario's wind so the projected
   spread follows live evidence instead of the marker's fixed value. Each
   packet applies at most once; a manual Apply in the conditions dialog
   overrides it until the next packet arrives. */
function applyWindEstimate(a) {
  const w = a?.wind_estimate;
  if (!w || state.mode === 'demo') return;
  // The QR carries explicit scenario weather. Keep it reproducible even
  // when Gemini derives a different wind estimate from a grounded drone.
  if (activeFire()?.latest.source === 'qr-test') return;
  if (a.episode_id && a.episode_id !== activeFire()?.episode_id) return;
  if (a.created_at === state.windAuto || a.created_at === state.windManual) return;
  // The flight-controller estimate is measured at flight altitude; wind grows
  // with height, so scale it down to the 10 m reference the scenario uses.
  const altScale = /flight.controller/i.test(w.method ?? '') ? M.altitudeWindScale(state.telemetry?.altitude_m ?? 10) : 1;
  const kmh = w.speed_mps != null ? Math.round(w.speed_mps / altScale * 3.6) : null;
  const deg = w.direction_deg != null ? ((Math.round(w.direction_deg) % 360) + 360) % 360 : null;
  if (kmh === null && deg === null) return;
  const changed = (kmh !== null && kmh !== state.scenario.wind) || (deg !== null && deg !== state.scenario.direction);
  /* The scenario eases toward the new evidence instead of snapping: a real
     wind shift develops over seconds, and the ellipse should merge onto its
     new path, not teleport there. */
  if (kmh !== null || deg !== null) state.windEase = {wind: kmh ?? state.scenario.wind, direction: deg ?? state.scenario.direction};
  state.windAuto = a.created_at; state.windDerived = w;
  if (changed) {
    renderSpread(); refreshFireTiming();
    toast(`Wind updated ${/flight-controller|flight controller/i.test(w.method ?? '') ? 'from the flight-controller estimate' : 'from drone stabilization'} — estimate, not a sensor reading.`);
  }
}

// ------------------------------------------------------------------ plan

/** Describe the selected fire's modeled spread for live or isolated replay planning. */
function projection() {
  const o = origin(); if (!o) return null;
  if (demoCase()) return demoProjection();
  const details = fireDetails();
  const loc = fireLocation();
  return {minutes_ahead: Math.round(spreadMinutes()), area_ha: +M.areaHa(M.footprint(o, spreadMinutes(), state.scenario, details)).toFixed(3), head_distance_m: Math.round(M.headDistance(spreadMinutes(), state.scenario, details)), spread_rate_m_per_min: +M.spreadRate(state.scenario, details).toFixed(1), toward_deg: state.scenario.direction, toward: M.compass(state.scenario.direction), origin: {latitude: o[0], longitude: o[1], position_source: loc?.position_source ?? null, simulated: loc?.simulated ?? state.mode === 'demo'}};
}
/* Fictional wind variation for a live-feel demo: only reachable with
   ?demo-wind in the URL, toggled from the conditions dialog, and labelled
   isolated from live wind estimates and retained in demo metadata. */
const DEMO_WIND_FLAG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo-wind');
let demoWindTimer = null, demoWindBase = null, demoWindT0 = 0;
function setDemoWind(on) {
  if (on) {
    demoWindBase = { ...state.scenario };
    demoWindT0 = performance.now();
    toast('Wind variation on.');
    demoWindTimer = setInterval(() => {
      const t = (performance.now() - demoWindT0) / 1000;
      state.scenario = {
        ...state.scenario,
        wind: Math.round(Math.max(0, Math.min(120, demoWindBase.wind + 18 * Math.sin(t / 7) + 6 * Math.sin(t / 2.3)))),
        direction: Math.round((demoWindBase.direction + 28 * Math.sin(t / 11) + 360) % 360),
      };
      renderSpread(); refreshFireTiming();
    }, 800);
  } else {
    clearInterval(demoWindTimer);
    demoWindTimer = null;
    if (demoWindBase) {
      state.scenario = { ...demoWindBase };
      demoWindBase = null;
      renderSpread(); refreshFireTiming();
    }
  }
}

// ------------------------------------------------------------------ demo

const DEMO_FLIGHT_S = 26;
/** Return only a historical camera case, excluding flight-pattern and person-search replay. */
const demoCase = () => state.mode === 'demo' && state.demo.selected && state.demo.selected !== 'flight' && state.demo.selected.id !== 'people' ? state.demo.selected : null;
/** The fictional forest contains no incident until the presenter explicitly triggers one. */
const forestWaiting = () => !!(demoCase()?.manualDetection && state.demo.scout?.detectedAt == null);
/** Trigger only this browser-owned scenario; aircraft commands and live ingest are never called. */
function detectForestFire() {
  const scout = state.demo.scout, f = demoCase();
  if (!f?.manualDetection || !BoscoScout.detect(scout, demoT())) return;
  state.demo.responseClock = {t: scout.detectedAt, now: performance.now()};
  state.minute = 30; state.playing = false; setPlayButton();
  $('demo-detected').disabled = true; $('demo-detected').textContent = 'Detected · fleet responding';
  $('map-subtitle').textContent = 'Fire detected near ANAFI-01 · fleet approaching the exterior perimeter';
  state.demo.lastScout = -2000;
  locateDemoFire(f); fitToFire(); updateDemoScout();
}
/* Simulated ANAFI-01 for a demo case, t seconds after its camera first saw
   the fire: it was patrolling low (35 m) about 280 m upwind, hovers while the
   detection is confirmed, then climbs at up to 4 m/s (ANAFI max) to its
   recorded 120 m while widening to a 450 m survey orbit at 8 m/s, camera
   locked on the fire's head. Information reaches the workspace in the order
   a real sighting would: detection confirmed, then fire geolocated. */
const SIM = {r0: 280, alt0: 35, climbS: 32, orbitR: 450, orbitV: 8};
const SIM_DELAY = {confirm: 2.5, locate: 4};
/** Smoothly interpolate a bounded zero-to-one simulation transition. */
const ease = k => { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); };
/* The burning front the camera sees; the map's T + 0 outline is the same ellipse. */
function simFire(f, t) { const a = Math.min(300, 90 + BoscoScout.fireTime(state.demo.scout, t) * .8); return {a, b: a / 2.4, shift: a * .45}; }
/** Compute the historical replay drone's widening orbit about the incident. */
function simTrack(f, t) {
  /** Interpolate the replay's initial patrol radius toward its survey orbit. Interpolate the replay drone's speed as it enters the survey. */
  const radius = u => SIM.r0 + (SIM.orbitR - SIM.r0) * ease((u - 2) / SIM.climbS), speed = u => SIM.orbitV * ease((u - 2) / 6);
  const end = 2 + SIM.climbS; let ang = 0;
  for (let u = 0; u < Math.min(t, end); u += .5) ang += speed(u) * Math.min(.5, Math.min(t, end) - u) / radius(u);
  if (t > end) ang += (t - end) * SIM.orbitV / SIM.orbitR;
  const bearing = (f.drone.detection.fire.bearing_deg + 180) % 360 + ang * 180 / Math.PI, b = bearing * Math.PI / 180, R = radius(t);
  return {bearing, R, e: R * Math.sin(b), n: R * Math.cos(b), alt: SIM.alt0 + (f.drone.telemetry.altitude_m - SIM.alt0) * ease((t - 2) / SIM.climbS)};
}
/** Compute replay camera/drone pose and display measurements at the elapsed simulation time. */
function surveyPose(f, t) {
  const tel = f.drone.telemetry, {bearing, R, e, n, alt: climb} = simTrack(f, t), next = simTrack(f, t + .2);
  const phase = t < 2 ? 'Detection hover' : t < 2 + SIM.climbS ? 'Climb to survey' : 'Survey orbit';
  const alt = climb + .3 * Math.sin(t * .7), fire = simFire(f, t), wd = f.directionDeg * Math.PI / 180;
  const te = fire.shift * .6 * Math.sin(wd) - e, tn = fire.shift * .6 * Math.cos(wd) - n, [lat, lon] = M.destPoint(f.lat, f.lon, bearing, R);
  return {e, n, alt, lat, lon, phase, fire, range: R, battery: tel.battery_pct - t / 40,
    speed: Math.hypot(next.e - e, next.n - n) / .2, climbRate: (next.alt - climb) / .2,
    heading: (Math.atan2(te, tn) * 180 / Math.PI + 360) % 360, pitch: Math.atan2(alt, Math.hypot(te, tn)) * 180 / Math.PI};
}
/** Use one simulated scouting pose for the map, video, telemetry and observations. */
function simPose(f, t) {
  const scout = state.demo.scout;
  const p = scout && BoscoScout.pose(scout, t);
  return p ? {...p, fire: simFire(f, t)} : surveyPose(f, t);
}

/** Refresh historical-case leads without touching live person-search storage. */
function updateDemoScout(t = demoT()) {
  const f = demoCase(), scout = state.demo.scout;
  if (!f || !scout) return;
  const snapshot = BoscoScout.snapshot(scout, t);
  renderPeople(snapshot);
  $('people-source').textContent = 'Fleet';
  const active = snapshot.fleet.find(p => p.depth > 0);
  if (state.demo.autoPOV && active) selectFleetDrone(active.drone_id, false);
  const mission = forestWaiting() ? '4 drones holding high above the forest · no fire detected · press Detected to begin' : snapshot.fleet.some(p => p.phase === 'Responding to fire') ? 'Fire detected near ANAFI-01 · 4 drones flying toward the incident' : active ? `${active.drone_id} ${active.phase.toLowerCase()}; 3 drones maintain observation` : '4 drones observing the perimeter';
  setBanner('demo', `<strong>Fleet · ${escapeHTML(f.name)}.</strong> ${mission} · ${snapshot.leads.length} unique people spotted.`);
}
/** Focus one simulated aircraft without restarting the shared replay or its evidence. */
function selectFleetDrone(id, manual = true) {
  const scout = state.demo.scout;
  if (!scout?.drones.some(d => d.id === id)) return;
  scout.selectedId = id;
  if (manual) scout.autoPOV = state.demo.autoPOV = false;
  state.demo.marker = state.demo.fleetLayers[id].marker;
  state.demo.trail = state.demo.fleetLayers[id].trail;
  const p = BoscoScout.pose(scout, demoT(), id);
  state.demo.pos = [p.lat, p.lon];
  $('drone-heading').textContent = `${id} · Fleet POV`;
  $('camera').setAttribute('aria-label', `${id} camera`);
  $('fleet-auto').setAttribute('aria-pressed', String(state.demo.autoPOV));
  for (const d of scout.drones) {
    $(`fleet-${d.id}`).setAttribute('aria-pressed', String(d.id === id));
    $(`fleet-${d.id}`).classList.toggle('selected', d.id === id);
  }
}
/** Build a scrollable roster with an independent rendered preview for each aircraft. */
function initDemoFleet() {
  const scout = state.demo.scout;
  state.demo.fleetLayers = {};
  state.demo.autoPOV = scout.autoPOV ?? true;
  $('fleet-controls').hidden = false;
  $('fleet-rate').value = String(state.demo.playbackRate ?? 8);
  $('fleet-roster').innerHTML = scout.drones.map(d => `<button type="button" class="fleet-card" id="fleet-${d.id}" aria-label="View ${d.id} camera and telemetry" aria-pressed="false" style="--fleet-color:${d.color}"><span class="fleet-card-head"><b>${d.id}</b><small>ANAFI</small></span><canvas id="fleet-camera-${d.id}" width="320" height="180" aria-label="${d.id} preview"></canvas><span class="fleet-phase" id="fleet-phase-${d.id}">Observing</span><span class="fleet-readout" id="fleet-tel-${d.id}"></span><span class="fleet-readout" id="fleet-people-${d.id}">0 people spotted</span></button>`).join('');
  for (const d of scout.drones) {
    const p = BoscoScout.pose(scout, scout.elapsed, d.id);
    const marker = droneMarker([p.lat, p.lon], true).addTo(state.demo.layer)
      .bindTooltip(`${d.id} · click to view camera`).on('click', () => selectFleetDrone(d.id));
    const trail = L.polyline([], {color: d.color, weight: 2, opacity: .7}).addTo(state.demo.layer);
    state.demo.fleetLayers[d.id] = {marker, trail, points: []};
    $(`fleet-${d.id}`).onclick = () => selectFleetDrone(d.id);
  }
  $('fleet-auto').onclick = () => { scout.autoPOV = state.demo.autoPOV = !state.demo.autoPOV; $('fleet-auto').setAttribute('aria-pressed', String(state.demo.autoPOV)); updateDemoScout(); };
  $('fleet-rate').onchange = () => {
    const t = demoT(); state.demo.playbackRate = Number($('fleet-rate').value);
    state.demo.started = performance.now() - t * 1000 / state.demo.playbackRate;
    if (state.demo.responseClock) state.demo.responseClock = {t, now: performance.now()};
  };
  selectFleetDrone(scout.selectedId, false);
}
/* The detector locks on over the first seconds, then firms up as the view opens out. */
function simConfidence(f, t) {
  const c = f.drone.detection.confidence * (.55 + .45 * ease(t / SIM_DELAY.confirm)) + .03 * ease((t - 2) / SIM.climbS);
  return Math.max(.3, Math.min(.99, c + .012 * Math.sin(t * 5.3) + .008 * Math.sin(t * 11.1)));
}
/** Return elapsed time in the current historical replay, in seconds. */
const demoT = () => {
  const rate = state.demo.scout ? state.demo.playbackRate ?? 8 : 1, anchor = state.demo.responseClock;
  return anchor ? BoscoScout.advanceClock(state.demo.scout, anchor.t, Math.max(0, performance.now() - anchor.now) / 1000 * rate)
    : Math.max(0, (performance.now() - state.demo.started) / 1000 * rate);
};
/* Spread outline at `minute`: the live fire at T + 0, growing geometrically to
   the recorded final burn area at T + 60, in the recorded burn's shape. */
function demoOutline(f, minute, scale = 1) {
  return BoscoScout.outline(f, BoscoScout.fireTime(state.demo.scout, demoT()), minute, scale);
}

/* Once ANAFI-01 has placed the fire on the map. */
function locateDemoFire(f) {
  /** Format an available historical impact count without inventing missing values. */
  const i = f.impacts, n = v => v == null ? '—' : '≈' + v.toLocaleString();
  state.demo.located = true;
  L.marker([f.lat, f.lon], {icon: L.divIcon({className: 'fire-pin-wrap', html: '<div class="fire-pin">🔥</div>', iconSize: [34, 34], iconAnchor: [17, 17]})}).addTo(state.demo.layer)
    .bindPopup(`<b>${escapeHTML(f.name)}</b><br>${escapeHTML(f.region)} · ${escapeHTML(f.startDate)}<br>Cause: ${escapeHTML(f.cause)}<br>≈${f.areaHa.toLocaleString()} ha · structures ${n(i.structures)} · evacuated ${n(i.evacuated)} · deaths ${i.deaths ?? '—'}<br><small>${escapeHTML(f.notes)}</small><br><small>Source: ${escapeHTML(f.source)}</small>`);
  state.demo.sight = L.polyline([state.demo.pos, [f.lat, f.lon]], {color: '#e66c43', weight: 1.5, dashArray: '3 4'}).addTo(state.demo.layer);
  $('incident-tag').hidden = false; $('incident-dot').classList.add('alert');
  setBanner('demo', `<strong>Fire geolocated · ${escapeHTML(f.name)}.</strong> The fleet is observing the fire. Conditions on scene: ${f.drivers.tempC ?? '—'} °C, wind ${f.drivers.windKmh ?? '—'} km/h toward ${M.compass(f.directionDeg)}, RH ${f.drivers.rhPct ?? '—'}%.`);
  toast(`Fire detected — ${f.name}. The forecast is ready.`);
  renderSpread();
}

/* The incident as Gemini sees it for a live detection: where the fire is, the
   observed conditions, and the drone's telemetry and detection right now. */
function simCase(f) {
  const t = demoT(), p = simPose(f, t), tel = f.drone.telemetry, det = f.drone.detection;
  const snapshot = state.demo.scout ? BoscoScout.snapshot(state.demo.scout, t) : null;
  return {
    id: f.id, name: f.name, region: f.region, latitude: f.lat, longitude: f.lon,
    observed: {temp_c: f.drivers.tempC, wind_kmh: f.drivers.windKmh, wind_toward_deg: f.directionDeg, rh_pct: f.drivers.rhPct, fuel: f.drivers.fuel},
    estimated_area_ha: forestWaiting() ? null : +M.areaHa(demoOutline(f, 0)).toFixed(1),
    provenance: 'demo-simulated', rescue_leads: snapshot?.leads ?? [],
    fleet: snapshot?.fleet ?? [],
    drone: {
      telemetry: {provenance: 'demo-simulated', drone_id: p.drone_id ?? tel.drone_id, observed_at: new Date((state.demo.scout?.startedAt ?? Date.now()) + t * 1000).toISOString(), latitude: +p.lat.toFixed(6), longitude: +p.lon.toFixed(6), altitude_m: +p.alt.toFixed(1), ground_speed_mps: +p.speed.toFixed(1), battery_pct: Math.round(p.battery), state: 'flying', extra: {heading_deg: Math.round(p.heading), gimbal_pitch_deg: -Math.round(p.pitch), position_source: 'simulated', flight_phase: p.phase.toLowerCase()}},
      detection: forestWaiting() ? null : {source: det.source, label: det.label, confidence: +simConfidence(f, BoscoScout.fireTime(state.demo.scout, t)).toFixed(2), seconds_since_first_sighting: Math.round(f.manualDetection ? t - state.demo.scout.detectedAt : t), fire: {...det.fire, latitude: f.lat, longitude: f.lon, position_source: 'demo-simulated', distance_m: Math.round(p.range), bearing_deg: Math.round(p.heading)}},
    },
  };
}

/** Lazily create the shared simulated camera renderer when WebGL support exists. */
function camera() {
  if (!state.camera && window.EmberCamera) { const c = $('camera'); state.camera = EmberCamera.create(c.width, c.height); }
  return state.camera;
}

/* Optional reference clips for demo cases, listed in dist/demo-video/videos.json
   as {"<case id>": {"file": "clip.mp4", "credit": "…"}}. Labeled on screen as
   not recorded by ANAFI-01. */
async function loadDemoVideos() {
  if (state.demo.videos) return;
  state.demo.videos = {};
  try { const r = await fetch('demo-video/videos.json'); if (r.ok) state.demo.videos = await r.json(); } catch {}
}
/** Select an optional credited reference clip or return to rendered replay imagery. */
function setDemoVideo(f) {
  const cam = camera(), entry = f && state.demo.videos?.[f.id];
  state.demo.video?.pause(); state.demo.video = null; state.demo.videoCredit = null;
  if (entry?.file) {
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.src = 'demo-video/' + entry.file; v.play().catch(() => {});
    state.demo.video = v; state.demo.videoCredit = entry.credit || 'credit not listed';
  }
  if (cam) EmberCamera.setVideo(cam, state.demo.video);
}

let lastPanel = 0;
/** Advance only the selected historical camera case, detection timing and shared fleet cameras. */
function animateDemoCase(now) {
  const f = demoCase(); if (!f || !state.demo.marker) return;
  const t = demoT(), waiting = forestWaiting(), conf = waiting ? 0 : simConfidence(f, BoscoScout.fireTime(state.demo.scout, t)), confirmed = !waiting && (f.manualDetection || t >= SIM_DELAY.confirm);
  if (state.demo.scout && now - (state.demo.lastScout ?? -2000) > 1000) { state.demo.lastScout = now; updateDemoScout(t); }
  const p = simPose(f, t), poses = state.demo.scout.drones.map(d => BoscoScout.pose(state.demo.scout, t, d.id));
  state.demo.pos = [p.lat, p.lon];
  for (const q of poses) {
    const layer = state.demo.fleetLayers[q.drone_id];
    layer.marker.setLatLng([q.lat, q.lon]);
    setDronePose(layer.marker, q.heading, q.alt, false, q.drone_id, q.color, q.drone_id === p.drone_id);
    if (t - (state.demo.lastTrail ?? -9) >= 1) {
      layer.points.push([q.lat, q.lon]); if (layer.points.length > 180) layer.points.shift();
      layer.trail.setLatLngs(layer.points);
    }
  }
  if (f.manualDetection && !waiting && !state.demo.approachFramed && poses.every(q => q.phase !== 'Responding to fire')) {
    state.demo.approachFramed = true;
    $('map-subtitle').textContent = 'Fleet orbiting the predicted perimeter · trails show flown paths';
    fitToFire();
  }
  if (!state.demo.located && !waiting && (f.manualDetection || t >= SIM_DELAY.locate)) locateDemoFire(f);
  state.demo.sight?.setLatLngs([state.demo.pos, [f.lat, f.lon]]);
  if (state.demo.located && !state.playing && now - (state.demo.lastSpread ?? 0) > 1000) { state.demo.lastSpread = now; renderSpread(); } // the live fire keeps growing
  if (t - (state.demo.lastTrail ?? -9) >= 1) {
    state.demo.lastTrail = t;
  }
  if (state.follow && now - (state.demo.lastPan ?? 0) > 250) { state.demo.lastPan = now; state.map.panTo(state.demo.pos, {animate: false}); }
  const cam = camera();
  if (cam && now - (state.demo.lastCam ?? 0) > 33) {
    state.demo.lastCam = now;
    const seen = renderFleetCamera($('camera'), cam, p, poses, f, t, conf);
    state.demo.inView = !!seen;
    if (now - (state.demo.lastPreviews ?? -1000) > 300) {
      state.demo.lastPreviews = now;
      for (const q of poses) renderFleetCamera($(`fleet-camera-${q.drone_id}`), cam, q, poses, f, t, conf);
    }
  }
  if (now - lastPanel < 250) return; lastPanel = now;
  $('altitude').innerHTML = `${p.alt.toFixed(1)} <small>m</small>`; $('ground-speed').innerHTML = `${p.speed.toFixed(1)} <small>m/s</small>`;
  $('power').innerHTML = `${Math.round(p.battery)} <small>%</small>`; $('flight-state').textContent = `${p.phase} · ${p.climbRate >= 0 ? '+' : ''}${p.climbRate.toFixed(1)} m/s vertical`;
  $('battery-value').innerHTML = `${Math.round(p.battery)}<span class="small-unit">%</span>`; $('battery-context').textContent = `${p.drone_id} battery`;
  $('telemetry-note').textContent = `${p.drone_id} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · heading ${Math.round(p.heading)}° · camera ${-Math.round(p.pitch)}° · ${waiting ? 'high-altitude hold · no fire' : Math.round(BoscoScout.clearance(state.demo.scout, t, p)) + ' m from fire edge'}`;
  for (const q of poses) {
    $(`fleet-phase-${q.drone_id}`).textContent = q.phase;
    $(`fleet-tel-${q.drone_id}`).textContent = `${q.alt.toFixed(0)} m high · ${q.speed.toFixed(1)} m/s · ${Math.round(q.battery)}%`;
    const count = state.demo.scout.targets.filter(x => x.seenBy.includes(q.drone_id)).length;
    $(`fleet-people-${q.drone_id}`).textContent = `${count} people spotted · ${waiting ? 'high-altitude hold · no fire' : Math.round(BoscoScout.clearance(state.demo.scout, t, q)) + ' m from fire'} · ${q.sector}`;
  }
  const active = poses.find(q => q.phase !== 'Observing');
  const replaySpeed = p.phase === 'Responding to fire' ? `${(state.demo.playbackRate ?? 8) * BoscoScout.APPROACH_RATE}× approach · ${state.demo.playbackRate ?? 8}× patrol` : `${state.demo.playbackRate ?? 8}× replay`;
  $('fleet-summary').textContent = `${waiting ? 'High-altitude forest hold · press Detected to begin' : p.phase === 'Responding to fire' ? 'Fleet responding to detected fire' : 'Exterior perimeter patrol'} · ${peopleState.snap?.leads.length ?? 0} unique people · ${active ? `${active.drone_id} ${active.phase.toLowerCase()}` : '4 drones observing'} · ${replaySpeed}`;
  $('detect-value').textContent = waiting ? '—' : confirmed ? Math.round(conf * 100) : '…'; $('detect-unit').textContent = confirmed ? '%' : '';
  $('detect-context').textContent = waiting ? 'no fire · awaiting Detected button' : confirmed ? `fire model · ${Math.round(p.range)} m · ${Math.floor(t * 4) + 1} sightings` : 'fire model · confirming possible fire…';
  if (f.manualDetection && !waiting) $('demo-detected').textContent = poses.some(q => q.phase === 'Responding to fire') ? 'Detected · fleet responding' : 'Detected · incident active';
  $('camera-label').innerHTML = `<i class="hot"></i> ${p.drone_id}`;
  $('camera-clock').textContent = `${f.startDate} · T+${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  $('video-fps').textContent = cam?.ok ? '30 fps' : '—';
  $('video-status').textContent = cam?.ok ? `${p.drone_id} · ${p.phase.toLowerCase()}` : 'Camera view needs WebGL';
}

/** Render the same world from a particular drone, scaling previews without extra GL contexts. */
function renderFleetCamera(canvas, cam, p, poses, f, t, confidence) {
  const ctx = canvas.getContext('2d');
  ctx.save(); ctx.scale(canvas.width / cam.w, canvas.height / cam.h);
  const found = EmberCamera.render(ctx, cam, p, {t, shake: 0, fire: forestWaiting() ? null : simFire(f, t), confidence, forest: !!f.manualDetection,
    people: state.demo.scout.targets.filter(target => BoscoScout.visible(p, target, state.demo.scout)), fleet: poses,
    speed: p.speed, battery: p.battery, range: forestWaiting() ? null : p.range, clearance: forestWaiting() ? null : BoscoScout.clearance(state.demo.scout, t, p),
    footer: `${p.drone_id} · ${p.phase.toUpperCase()}`});
  ctx.restore(); return found;
}

/** Describe the historical burn projection at the selected replay minute. */
function demoProjection() {
  const f = demoCase(); if (!f || forestWaiting()) return null;
  return {minutes_ahead: Math.round(state.minute), area_ha: +M.areaHa(demoOutline(f, state.minute)).toFixed(1), toward_deg: state.scenario.direction, toward: M.compass(state.scenario.direction), origin: {latitude: f.lat, longitude: f.lon}, basis: f.manualDetection ? 'illustrative forest-fire forecast from the simulated detected front' : 'detected fire front growing to the recorded final burn area over a 60-minute replay'};
}

/** Enter explicit replay with per-scenario state, or restore live monitoring. */
async function toggleDemo() {
  if (state.mode === 'demo') { exitDemo(); return; }
  state.demo.fires = window.EMBER_DEMO?.cases ?? [];
  if (!state.demo.fires.length) { toast('Incident replays failed to load (demo-cases.js).'); return; }
  state.mode = 'demo'; state.playing = false; setPlayButton();
  $('detection-details').hidden = true;
  state.basemapBeforeDemo = state.basemap; setBasemap('sat'); await loadDemoVideos();
  $('demo-toggle').innerHTML = 'Exit replay <svg><use href="#i-close"/></svg>';
  setModePill('demo', 'Replay'); setBanner('demo', '<strong>Historical incidents</strong>');
  $('map-pill').textContent = 'Replay';
  $('incident-eyebrow').textContent = 'INCIDENT REPLAY'; $('incident-title').textContent = 'Incident replay'; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
  $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'replay — live detection paused';
  const sel = $('demo-fire'); sel.hidden = false;
  /** Format the recorded fire's year for the replay selector. */
  const yr = f => escapeHTML(f.startDate.slice(0, 4));
  sel.innerHTML = '<optgroup label="Person search · fire first"><option value="people">UTSC · Highland Creek ravine</option>'
    + state.demo.fires.map(f => `<option value="people:${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${yr(f)}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Historical fleet perimeter search"><option value="flight">ANAFI demo flight pattern · UTSC</option>'
    + state.demo.fires.map(f => `<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${yr(f)}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Forest patrol"><option value="forest-detection">Forest patrol · press Detected</option></optgroup>';
  state.layers.fire.clearLayers(); state.droneMarker.setOpacity(0); state.layers.trail.clearLayers();
  state.layers.path.setLatLngs([]);
  for (const f of state.demo.fires) L.circleMarker([f.lat, f.lon], {radius: 6, color: '#d9480f', weight: 2, fillColor: '#d9480f', fillOpacity: .85}).addTo(state.layers.demo).bindTooltip(f.name).on('click', () => { sel.value = f.id; selectDemo(f.id); });
  const requested = new URLSearchParams(location.search).get('case');
  const initial = [...sel.options].some(option => option.value === requested) ? requested : state.demo.fires[0].id;
  selectDemo(initial); sel.value = initial;
}

/** Keep reloads and shared links on the selected mode/case without starting a new page. */
function syncWorkspaceUrl(caseId = null) {
  const url = new URL(location.href);
  for (const key of ['demo', 'case', 'live-demo']) url.searchParams.delete(key);
  if (state.mode === 'demo') {
    url.searchParams.set('demo', '');
    if (caseId) url.searchParams.set('case', caseId);
  } else if (state.liveDemo) url.searchParams.set('live-demo', '');
  history.replaceState(null, '', url);
}

/** Reset incompatible replay state before starting a search, historical case or flight pattern. */
function selectDemo(id) {
  syncWorkspaceUrl(id);
  $('demo-detected').hidden = true;
  if ($('map-subtitle')) $('map-subtitle').textContent = 'Drone position, detected fire and projected spread';
  if (state.demo.scout) state.demo.scout.elapsed = demoT();
  state.demo.responseClock = null; state.demo.approachFramed = false;
  state.demo.scout = null;
  $('fleet-controls').hidden = true; $('drone-heading').textContent = 'ANAFI-01'; $('camera').setAttribute('aria-label', 'ANAFI camera');
  state.demo.layer?.remove();
  state.demo.layer = L.layerGroup().addTo(state.map);

  stopPeopleDemo();
  peopleState.listKey = ''; renderPeople({leads: [], counts: {}, coverage: {cells: []}});
  state.demo.marker = null; state.demo.pos = null; state.demo.located = false;
  setDemoVideo(null);
  state.layers.fire.clearLayers();
  if (id === 'people' || id.startsWith('people:')) {
    // Simulated search: at UTSC, or at one of the historical fires' ignition points.
    // The fire's position and conditions arrive with the first snapshot; spread grows from it.
    const scenarioId = id === 'people' ? 'utsc' : id.slice(7);
    const fire = state.demo.fires.find(f => f.id === scenarioId);
    state.demo.selected = {id: 'people', scenario: scenarioId, name: fire?.name ?? 'UTSC · Highland Creek ravine', lat: null, lon: null, areaHa: 3, directionDeg: fire?.directionDeg ?? 225};
    state.scenario = {...M.BASE, wind: fire?.drivers?.windKmh ?? 24, direction: fire?.directionDeg ?? 225}; state.minute = 20;
    setBanner('demo', `<strong>Person search</strong> · ${fire ? escapeHTML(fire.name) : 'UTSC'}`);
    $('incident-eyebrow').textContent = 'PERSON SEARCH'; $('incident-title').textContent = fire ? `Person search · ${fire.name}` : 'Person search replay';
    $('incident-sub').textContent = fire ? `${fire.region} · ${fire.startDate.slice(0, 4)} ignition point` : 'UTSC · Highland Creek ravine';
    $('map-location').textContent = fire ? fire.name : 'UTSC · Highland Creek ravine';
    if ($('map-subtitle')) $('map-subtitle').textContent = 'Perimeter person search';
    startPeopleDemo();
    if (fire) state.map.setView([fire.lat, fire.lon], 16); else state.map.setView([state.site.latitude - .0012, state.site.longitude + .0018], 17);
    renderSpread(); return;
  }
  setBanner('demo', '<strong>Historical incidents</strong> · recorded burns');
  $('incident-eyebrow').textContent = 'DEMO · HISTORICAL CASES'; $('incident-title').textContent = 'Demo replay';
  if (id === 'flight') {
    state.demo.selected = 'flight'; state.demo.started = performance.now();
    const s = [state.site.latitude, state.site.longitude], side = 2 * Math.sin(Math.PI / 8);
    // Same 8-segment polygon the bridge flies: start heading north, turn 45° after each 1 m-radius side.
    const pts = [s], local = [[0, 0]]; let p = s;
    for (let i = 0; i < 8; i++) {
      p = M.destPoint(p[0], p[1], i * 45, side); pts.push(p);
      const [e, n] = local.at(-1); local.push([e + side * Math.sin(i * Math.PI / 4), n + side * Math.cos(i * Math.PI / 4)]);
    }
    state.demo.flightPts = pts; state.demo.flightLocal = local;
    L.polyline(pts, {color: '#3A372E', weight: 2, dashArray: '4 5'}).addTo(state.demo.layer);
    state.demo.marker = droneMarker(s).addTo(state.demo.layer);
    // The printed test marker 2 m ahead of take-off, where the -45° camera centres it at the 2 m hover.
    const cam = camera(); if (cam) EmberCamera.setScene(cam, {kind: 'pad', lat: s[0], lon: s[1], windDeg: 0, marker: {e: 0, n: 2, size: .18, src: 'test-marker.png'}});
    setDemoVideo(null);
    state.map.setView(M.destPoint(s[0], s[1], 112.5, 1.2), 21);
    state.scenario = {...M.BASE}; $('map-location').textContent = state.site.name; $('incident-sub').textContent = `Take off · climb 1 m · 1 m-radius circle · return · land — ${state.site.name}`;
    $('incident-eyebrow').textContent = 'ANAFI-01 · FLIGHT PATTERN'; $('incident-title').textContent = 'ANAFI-01 flight pattern'; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
    $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'flight-pattern replay — no fire';
    $('telemetry-tag').textContent = 'REPLAY'; $('drone-source').textContent = 'Replay'; $('telemetry-note').textContent = 'ANAFI-01 · flight pattern: take off, climb, circle, return, land';
    $('flight-progress').hidden = false;
    $('battery-value').innerHTML = '76<span class="small-unit">%</span>'; $('battery-context').textContent = 'ANAFI-01 battery';
    setBanner('demo', '<strong>ANAFI-01 flight pattern.</strong> Take off, climb to 2 m, fly a 1 m-radius circle and land at UTSC; the fire test marker sits 2 m ahead of take-off.');
  } else {
    const f = state.demo.selected = id === 'forest-detection' ? BoscoScout.forestCase(state.demo.fires[0]) : state.demo.fires.find(x => x.id === id);
    state.scenario = {wind: f.drivers.windKmh ?? M.BASE.wind, direction: f.directionDeg, dryness: f.drivers.rhPct != null ? 100 - f.drivers.rhPct : M.BASE.dryness, temp: f.drivers.tempC ?? M.BASE.temp, rh: f.drivers.rhPct ?? M.BASE.rh};
    state.detectedScenario = {...state.scenario};
    if (!f.manualDetection) L.polygon(M.recordedPerimeter(f), {color: '#c2410c', weight: 1.2, fill: false, dashArray: '2 4'}).addTo(state.demo.layer).bindTooltip('Recorded final burn area (approx.)');
    // A fresh sighting: the fire pin and spread follow as the simulated detection firms up.
    state.demo.scoutSessions ??= {};
    if (f.manualDetection) delete state.demo.scoutSessions[f.id]; // Selecting the exercise always rearms the presenter button.
    state.demo.scout = state.demo.scoutSessions[f.id] ??= BoscoScout.create(f);
    state.demo.playbackRate ??= 8;
    state.demo.started = performance.now() - state.demo.scout.elapsed * 1000 / state.demo.playbackRate; state.demo.lastTrail = null; state.demo.inView = false;
    state.demo.lastScout = -2000;
    state.demo.located = false; state.demo.sight = null; state.demo.lastSpread = 0;
    const start = simPose(f, state.demo.scout.elapsed); state.demo.pos = [start.lat, start.lon];
    initDemoFleet();
    const cam = camera(); if (cam) EmberCamera.setScene(cam, {kind: 'fire', lat: f.lat, lon: f.lon, windDeg: f.directionDeg, windKmh: f.drivers.windKmh});
    setDemoVideo(null);
    $('incident-eyebrow').textContent = 'HISTORICAL INCIDENT · FLEET'; $('incident-title').textContent = f.name; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
    $('incident-sub').textContent = `${f.region} · ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)} · ${f.drivers.fuel}`;
    $('telemetry-tag').textContent = 'FLEET'; $('drone-source').textContent = '4-drone fleet'; $('telemetry-note').classList.remove('error-text'); $('flight-progress').hidden = true;
    if ($('map-subtitle')) $('map-subtitle').textContent = 'Fleet perimeter patrol · red outline: fire now';
    updateDemoScout(state.demo.scout.elapsed);
    if (f.manualDetection) {
      $('demo-detected').hidden = false; $('demo-detected').disabled = false; $('demo-detected').textContent = 'Detected';
      $('incident-eyebrow').textContent = 'FOREST PATROL · FLEET';
      $('map-subtitle').textContent = 'Four widely spaced drones holding high · press Detected to reveal a fire near ANAFI-01';
      $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'no fire detected';
    }
    $('map-location').textContent = `${f.name} · ${f.region}`;
    state.minute = 0; state.playing = false; setPlayButton();
    fitToFire();
  }
  renderSpread();
}

/** Stop simulations and restore saved live evidence, plan, basemap and polling state. */
function exitDemo() {
  $('demo-detected').hidden = true;
  if (state.demo.scout) state.demo.scout.elapsed = demoT();
  state.demo.responseClock = null; state.demo.approachFramed = false;
  state.demo.scout = null;
  $('fleet-controls').hidden = true; $('drone-heading').textContent = 'ANAFI-01'; $('camera').setAttribute('aria-label', 'Live ANAFI camera');
  stopPeopleDemo();
  state.mode = 'live'; state.demo.layer?.remove(); state.demo.layer = null; state.demo.marker = null; state.demo.pos = null; state.layers.demo.clearLayers(); state.map.closePopup();
  syncWorkspaceUrl();
  setDemoVideo(null); setBasemap(state.basemapBeforeDemo ?? 'osm'); setFollow(false);
  $('demo-toggle').innerHTML = 'Replay <svg><use href="#i-play"/></svg>'; $('demo-fire').hidden = true;
  $('map-pill').textContent = state.liveDemo ? 'Live demo' : 'Live'; if ($('map-subtitle')) $('map-subtitle').textContent = 'Drone position, detected fire and projected spread';
  $('map-location').textContent = state.site.name; state.detectedScenario = null; state.scenario = {...M.BASE}; state.minute = 0; state.episodeSeen = null; state.centredOnDrone = false;
  $('telemetry-tag').textContent = 'LIVE'; $('telemetry-note').textContent = 'No telemetry yet'; $('camera-clock').textContent = '—'; $('video-status').textContent = 'No video'; state.video.lastAt = 0;
  $('battery-value').innerHTML = '—<span class="small-unit">%</span>'; $('battery-context').textContent = 'no telemetry yet'; $('drone-source').textContent = 'Waiting for drone';
  state.windAuto = state.windManual = state.windDerived = null;
  renderIncident(); renderDrone(); renderSpread(); renderTelemetry(); renderFlight(); fitToFire();
  pollPeople().catch(() => {});
}

/** Animate the labeled fixed flight-pattern preview without aircraft commands. */
function animateDemoFlight(now) {
  if (state.mode !== 'demo' || state.demo.selected !== 'flight') return;
  const pts = state.demo.flightPts, t = ((now - state.demo.started) / 1000) % DEMO_FLIGHT_S, side = 2 * Math.sin(Math.PI / 8);
  // 0-3 s take-off, 3-5 s climb, 5-21 s circle, 21-23 s return, 23-26 s landing
  let phase, pos = pts[0], alt = 0, heading = 0;
  if (t < 3) { phase = 'take-off'; alt = t / 3; }
  else if (t < 5) { phase = 'climb +1 m'; alt = 1 + (t - 3) / 2; }
  else if (t < 21) { const k = (t - 5) / 16 * 8, i = Math.min(7, Math.floor(k)), f = k - i; phase = `circle ${i + 1}/8`; alt = 2; heading = i * 45; pos = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; }
  else if (t < 23) { phase = 'return'; alt = 2; heading = 360; }
  else { phase = 'landing'; alt = 2 * (1 - (t - 23) / 3); }
  state.demo.marker.setLatLng(pos); state.demo.pos = pos; setDronePose(state.demo.marker, heading, alt, t >= 25.5);
  if (state.follow) state.map.panTo(pos, {animate: false});
  $('flight-phase').textContent = `Flight pattern · ${phase}`; $('flight-bar').style.width = Math.round(t / DEMO_FLIGHT_S * 100) + '%';
  $('altitude').innerHTML = `${alt.toFixed(1)} <small>m</small>`; $('flight-state').textContent = phase.split(' ')[0];
  const cam = camera();
  if (!cam?.ok) { drawWaiting('Flight pattern', `${phase} · altitude ${alt.toFixed(1)} m`); $('camera-label').innerHTML = '<i></i> LIVE · ANAFI-01'; return; }
  if (now - (state.demo.lastCam ?? 0) < 33) return; state.demo.lastCam = now;
  // The same pose in metres from take-off, for the simulated camera.
  const local = state.demo.flightLocal, circling = t >= 5 && t < 21, k = circling ? (t - 5) / 16 * 8 : 0, i = Math.min(7, Math.floor(k)), fr = k - i;
  const [e, n] = circling ? [local[i][0] + (local[i + 1][0] - local[i][0]) * fr, local[i][1] + (local[i + 1][1] - local[i][1]) * fr] : [0, 0];
  const pose = {e, n, alt: alt + .02 * Math.sin(t * 2.1), heading: heading % 360, pitch: 45};
  const seen = EmberCamera.render($('camera').getContext('2d'), cam, pose, {t, confidence: .97, speed: circling ? side / 2 : 0, battery: 76 - t / 30, range: Math.hypot(e, n - 2), shake: alt > .2 ? .6 : 0, zoom: `MARKER ${Math.hypot(e, n - 2).toFixed(1)} m`, footer: `FLIGHT PATTERN · ${phase.toUpperCase()}`});
  $('camera-label').innerHTML = seen ? '<i class="hot"></i> TEST MARKER IN VIEW' : '<i></i> LIVE · ANAFI-01';
  $('ground-speed').innerHTML = `${(circling ? side / 2 : 0).toFixed(1)} <small>m/s</small>`; $('power').innerHTML = `${Math.round(76 - t / 30)} <small>%</small>`;
  $('camera-clock').textContent = `T+0:${String(Math.floor(t)).padStart(2, '0')}`;
  $('video-fps').textContent = '30 fps'; $('video-status').textContent = 'ANAFI-01 camera · flight pattern';
}

// --------------------------------------------------------------- polling

const busy = {};
/** Poll a named resource without overlapping requests for that resource. */
function every(ms, name, fn) { /* Execute one guarded poll and release its busy flag even when the request fails. */ const run = async () => { if (busy[name]) return; busy[name] = true; try { await fn(); } catch {} finally { busy[name] = false; } }; run(); setInterval(run, ms); }

/** Read current telemetry and update freshness, measurements and the live drone marker. */
async function pollTelemetry() {
  const data = await getJson('/api/telemetry/latest');
  state.telemetry = data.sample && data.sample.provenance === 'live' ? data.sample : null;
  state.connected = true; renderTelemetry(); renderDrone(); renderMapChip();
}
/** Read the latest live incident and update detection-dependent panels. */
async function pollIncident() { state.incident = (await getJson('/api/incident')).incident; renderIncident(); }
/** Refresh flight-event/path data and redraw its live map representation. */
async function pollFlight() { state.flight = await getJson('/api/flight'); renderFlight(); renderDrone(); }
async function pollStatus() {
  try { state.status = await getJson('/api/status'); state.connected = true; } catch (e) { state.connected = false; renderHeading(); throw e; }
  const s = state.status; state.site = s.site || state.site; if (state.mode !== 'demo') $('map-location').textContent = state.site.name;
  const videoFresh = s.video?.fresh ?? (s.video?.available && s.video.age_ms < 3000);
  const telemetryFresh = s.telemetry?.fresh ?? (s.telemetry?.available && s.telemetry.age_ms < STALE_MS);
  $('parrot-status').textContent = videoFresh ? `Live · ${Math.round(s.video.fps)} fps` : telemetryFresh ? 'Telemetry only' : 'Disconnected · waiting for drone';
  $('tiger-status').textContent = s.storage?.status === 'postgres' ? 'Connected' : s.storage?.status === 'postgres-unavailable' ? 'Unavailable' : 'Memory only';
  renderHeading();
}

/** Load and draw the stored per-minute telemetry history in integrations. */
async function renderHistory() {
  const data = await getJson('/api/telemetry/summary?minutes=60');
  const pts = data.buckets.filter(b => b.avg_altitude_m != null);
  $('history-source').textContent = `${data.source} · ${data.buckets.length} min`;
  // The chart stretches to the dialog width, so labels live in HTML, not in the SVG.
  if (!pts.length) { $('history-svg').innerHTML = '<line x1="0" y1="66" x2="300" y2="66" stroke="#CFC8B8" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>'; $('history-source').textContent += ' · no flight data in the last hour'; return; }
  const max = Math.max(1, ...pts.map(p => p.max_altitude_m ?? p.avg_altitude_m));
  const xy = pts.map((p, i) => `${pts.length === 1 ? 150 : i / (pts.length - 1) * 300},${66 - p.avg_altitude_m / max * 60}`);
  $('history-svg').innerHTML = `<polyline points="${xy.join(' ')}" fill="none" stroke="#E8562A" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  $('history-source').textContent += ` · peak ${max.toFixed(1)} m`;
}

// --------------------------------------------------------------- controls

/** Keep the spread play/pause icon and accessible label consistent with playback state. */
function setPlayButton() { $('play').innerHTML = `<svg aria-hidden="true"><use href="#${state.playing ? 'i-pause' : 'i-play'}"/></svg>`; $('play').setAttribute('aria-label', state.playing ? 'Pause spread projection' : 'Play spread projection'); }
/** Populate the condition dialog from the supplied spread inputs. */
function scenarioControls(sc) {
  for (const [id, key, out] of [['wind-input', 'wind', 'wind-output'], ['dry-input', 'dryness', 'dry-output'], ['temp-input', 'temp', 'temp-output'], ['rh-input', 'rh', 'rh-output']]) { $(id).value = sc[key]; $(out).textContent = Math.round(sc[key]); }
  $('direction-input').value = sc.direction; $('direction-output').textContent = `${Math.round(sc.direction)}° · ${M.compass(sc.direction)}`;
}
let pending = {...M.BASE};

/** Connect dashboard controls to planning, replay, map and local review actions. */
function bindUi() {
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => { const r = d.getBoundingClientRect(); if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close(); });
  $('scenario-open').onclick = () => { pending = {...state.scenario}; scenarioControls(pending); $('scenario-intro').textContent = outdoorContourActive()?'Outdoor flight uses onboard wind when available, the last measurement during gaps, or its labeled initial assumption. These explorer values do not change the aircraft route.':state.detectedScenario?'Scenario model inputs from the detected fire; these are not measured weather.':'Editable model assumptions. Missing live wind is shown as unavailable.'; openDialog('scenario-dialog'); };
  $('contour-preview-open').onclick=()=>{resetContourPreview();openDialog('contour-preview-dialog');};
  $('contour-preview-reset').onclick=()=>resetContourPreview();
  $('contour-preview-time').oninput=()=>resetContourPreview(Number($('contour-preview-time').value));
  for (const [id, key] of [['wind-input', 'wind'], ['direction-input', 'direction'], ['dry-input', 'dryness'], ['temp-input', 'temp'], ['rh-input', 'rh']]) $(id).oninput = () => { pending[key] = +$(id).value; scenarioControls(pending); };
  $('reset-scenario').onclick = () => { pending = {...(state.detectedScenario || M.BASE)}; scenarioControls(pending); };
  $('apply-scenario').onclick = () => { state.scenario = {...pending}; state.windManual = 'manual'; state.windDerived = null; renderSpread(); refreshFireTiming(); $('scenario-dialog').close(); };
  $('play').onclick = () => { state.playing = !state.playing; setPlayButton(); };
  $('speed').onclick = () => { state.speed = state.speed === 4 ? 1 : state.speed * 2; $('speed').textContent = state.speed + '×'; };
  $('timeline').oninput = () => { state.playing = false; setPlayButton(); state.minute = +$('timeline').value; renderSpread(); };
  for (const b of document.querySelectorAll('[data-minute]')) b.onclick = () => { state.playing = false; setPlayButton(); state.minute = +b.dataset.minute; renderSpread(); };
  $('layers-open').onclick = () => { $('layer-menu').hidden = !$('layer-menu').hidden; $('layers-open').setAttribute('aria-expanded', String(!$('layer-menu').hidden)); };
  for (const [box, layer] of [['layer-spread', 'spread'], ['layer-fire', 'fire'], ['layer-drone', 'drone'], ['layer-wind', 'wind']]) $(box).onchange = () => $(box).checked ? state.map.addLayer(state.layers[layer]) : state.map.removeLayer(state.layers[layer]);
  $('zoom-in').onclick = () => state.map.zoomIn(); $('zoom-out').onclick = () => state.map.zoomOut(); $('zoom-reset').onclick = () => { setFollow(false); fitToFire(); };
  $('zoom-drone').onclick = () => setFollow(!state.follow); $('layer-sat').onchange = () => setBasemap($('layer-sat').checked ? 'sat' : 'osm');
  $('dismiss-fire').onclick = async () => { const inc = state.incident; if (!inc) return; try { await api('/api/incident/dismiss', {method: 'POST', body: {episode_id: inc.episode_id}}); toast('Marked as a false alarm.'); await pollIncident(); } catch (e) { toast(e.message); } };
  if (DEMO_WIND_FLAG) $('demo-wind-row').hidden = false;
  $('demo-wind').onchange = (e) => setDemoWind(e.target.checked);
  $('demo-toggle').onclick = toggleDemo; $('demo-fire').onchange = () => selectDemo($('demo-fire').value);
  $('demo-detected').onclick = detectForestFire;
  $('live-demo-toggle').onclick = () => setLiveDemo(state.mode === 'demo' || !state.liveDemo);
  for (const id of ['open-integrations', 'top-integrations']) $(id).onclick = () => { openDialog('integrations-dialog'); pollStatus().catch(() => {}); renderHistory().catch(() => { $('history-source').textContent = 'unavailable'; }); };
  $('connect-api').onclick = async () => { const t = $('api-token').value.trim(); if (t) state.token = t; await connect(); };
  $('export-brief').onclick = exportBrief;
}

/** Export the current evidence, lead review, projection with source labels. */
function exportBrief() {
  const inc = activeFire(), proj = projection();
  const simulatedCase = demoCase() ? simCase(demoCase()) : null;
  const telemetry = simulatedCase?.drone.telemetry ?? (peopleDemoActive() ? peopleState.snap?.drone : state.telemetry);
  const lines = ['# BOSCO incident brief', '', `Generated: ${new Date().toISOString()}`, `Site: ${state.site.name} (${state.site.latitude}, ${state.site.longitude})`, `Mode: ${state.mode === 'demo' ? 'incident replay' : state.mode}`, '',
    '## People · rescue leads', peopleBrief(), '',
    '## Fire', forestWaiting() ? 'No fire detected. Forest patrol exercise awaiting the presenter button.' : simulatedCase ? `SIMULATED SCOUT: ${simulatedCase.name} at ${simulatedCase.latitude}, ${simulatedCase.longitude}; replay context with fictional people and flight.` : inc ? [`Detected ${inc.first_detected_at} by ANAFI-01 (${inc.latest.source}, ${inc.latest.label}, max confidence ${Math.round(inc.max_confidence * 100)}%), ${inc.sightings} sightings.`, `Position: ${inc.latest.fire.latitude}, ${inc.latest.fire.longitude} — ${inc.latest.fire.distance_m} m from the drone, bearing ${inc.latest.fire.bearing_deg}° (${inc.latest.fire.position_source}).`, `Details: ${JSON.stringify(inc.latest.details)}`].join('\n') : 'No active fire.', '',
    '## Projected spread', proj ? `At +${proj.minutes_ahead} min: ${proj.area_ha} ha, head ${proj.head_distance_m} m toward ${proj.toward} at ${proj.spread_rate_m_per_min} m/min.\nProjection origin: ${JSON.stringify(proj.origin)}\nConditions: ${JSON.stringify(state.scenario)}` : '—', '',
    '## Drone telemetry', telemetry ? '```json\n' + JSON.stringify(telemetry, null, 2) + '\n```' : 'No telemetry.', '',
    ...(simulatedCase?.fleet.length ? ['## Simulated fleet', '```json\n' + JSON.stringify(simulatedCase.fleet, null, 2) + '\n```', ''] : []),
  ];
  download('bosco-incident-brief.md', lines.join('\n'), 'text/markdown'); toast('Incident brief exported.');
}

// ------------------------------------------------------------------ boot

let started = false;
/** Verify the serving backend contract and start one set of authenticated polling/video tasks. */
async function connect() {
  try {
    state.status = await getJson('/api/status');
    if (state.status.contract !== 'emberwatch.v1') throw new Error('unsupported API contract');
    state.connected = true; $('connection-result').textContent = 'Connected to the BOSCO backend.';
  } catch (e) { state.connected = false; $('connection-result').textContent = 'Connection failed: ' + e.message; renderHeading(); return; }
  if (started) return; started = true;
  if (state.status.site) { state.site = state.status.site; if (!state.telemetry) state.map.setView([state.site.latitude, state.site.longitude], 17); }
  every(1000, 'telemetry', pollTelemetry); every(1000, 'incident', pollIncident); every(2000, 'flight', pollFlight);
  $('autonomy-enable').onclick=()=>setAutonomy('enable',{camera_search:true});
  $('autonomy-contour-enable').onclick=()=>setAutonomy('enable',{camera_search:true,mode:'contour'});
  $('autonomy-land').onclick=()=>setAutonomy('land');
  $('camera-level').onclick=()=>setAutonomy('camera',{pitch_deg:0});
  $('camera-shallow').onclick=()=>setAutonomy('camera',{pitch_deg:-30});
  $('camera-down').onclick=()=>setAutonomy('camera',{pitch_deg:-45});
  $('camera-steep').onclick=()=>setAutonomy('camera',{pitch_deg:-70});
  every(250,'autonomy',pollAutonomy);
  every(2000, 'people', pollPeople); every(5000, 'status', pollStatus); setInterval(videoWatchdog, 1000);
  // Explorer refresh: recompute the zone from the latest conditions every 30 s.
  setInterval(renderSpread, 30000);
  streamVideo();
}

let lastFrame = 0, lastSpread = 0, lastWind = 0, lastEaseSpread = 0, lastPositionEvidence = 0;
/** Animate the band rings/orbit from their last rendered positions to `targets`.
   Vertex counts are fixed (72), so index-wise lat/lon lerp glides the shape. */
const raf = globalThis.requestAnimationFrame ?? (cb => setTimeout(() => cb(performance.now()), 16));
const caf = globalThis.cancelAnimationFrame ?? clearTimeout;
let morphAnims = [];
function morphTarget(t) {
  const prev = state[t.key] || t.pts;
  const t0 = performance.now(), DUR = 1400;
  caf(t.raf);
  const step = now => {
    const k = Math.min(1, (now - t0) / DUR), e = k * k * (3 - 2 * k);
    t.poly.setLatLngs(t.pts.map((p, j) => { const f = prev[j] || p; return [f[0] + (p[0] - f[0]) * e, f[1] + (p[1] - f[1]) * e]; }));
    const lls = t.poly.getLatLngs(), flat = Array.isArray(lls[0]) ? lls[0] : lls; // polygon nests rings; polyline is flat
    state[t.key] = flat.map(ll => [ll.lat, ll.lng]);
    if (k < 1) t.raf = raf(step);
  };
  t.raf = raf(step);
}
function morphSpread(targets) {
  caf(state.spreadRaf);
  morphAnims = targets.map((t, i) => {
    const poly = L.polygon(state.spreadCur?.[i] || t.pts, {stroke: t.scale === 1, color: '#ec9d33', weight: 1.2, dashArray: '5 4', fillColor: t.color, fillOpacity: t.opacity}).addTo(state.layers.spread);
    if (t.tooltip) poly.bindTooltip(t.tooltip);
    return {poly, pts: t.pts};
  });
  const from = state.spreadCur || targets.map(t => t.pts);
  const t0 = performance.now(), DUR = 1400;
  const step = now => {
    const k = Math.min(1, (now - t0) / DUR), e = k * k * (3 - 2 * k);
    morphAnims.forEach((t, i) => {
      const f = from[i] || t.pts;
      t.poly.setLatLngs(t.pts.map((p, j) => { const g = f[j] || p; return [g[0] + (p[0] - g[0]) * e, g[1] + (p[1] - g[1]) * e]; }));
    });
    state.spreadCur = morphAnims.map(t => t.poly.getLatLngs()[0].map(ll => [ll.lat, ll.lng]));
    if (k < 1) state.spreadRaf = raf(step);
  };
  state.spreadRaf = raf(step);
}

/** Advance active spread/replay animations and schedule the next browser frame. */
function animate(now) {
  const delta = Math.min(now - (lastFrame || now), 100); lastFrame = now;
  if($('contour-preview-dialog').open&&now-contourPreviewLast>100) {contourPreviewLast=now;renderTinyContourPreview();}
  // Only Replay interpolates fictional wind. Live always shows received event
  // evidence and expires it even if telemetry stops arriving.
  if (now - lastWind >= 100) {
    lastWind = now;
    if(state.mode==='demo') {
      if(state.windShown==null) state.windShown=state.scenario.wind;
      state.windShown+=(state.scenario.wind-state.windShown)*.2;
      if(Math.abs(state.windShown-state.scenario.wind)<.05) state.windShown=state.scenario.wind;
    }
    renderWindMetric();
  }
  if(now-lastPositionEvidence>=1000) {
    lastPositionEvidence=now;
    if(state.mode==='live') {renderDrone();renderMapChip();}
    else $('live-position-status').hidden=true;
  }
  /* Scenario wind easing: new evidence sets a target; the wind and bearing
     glide toward it over ~3 s (shortest arc for direction), re-rendering the
     spread every ~250 ms so the old projected path merges into the new one. */
  if (state.windEase) {
    const k = Math.min(1, delta / 3000), sc = state.scenario, tgt = state.windEase;
    sc.wind += (tgt.wind - sc.wind) * k;
    const dd = ((tgt.direction - sc.direction + 540) % 360) - 180;
    sc.direction = ((sc.direction + dd * k) % 360 + 360) % 360;
    if (Math.abs(tgt.wind - sc.wind) < .2 && Math.abs(dd) < .5) {
      sc.wind = tgt.wind; sc.direction = tgt.direction; state.windEase = null;
    }
    if (now - lastEaseSpread > 250) { lastEaseSpread = now; renderSpread(); }
  }
  if (state.playing) { state.minute = (state.minute + delta * .002 * state.speed) % 60; if (now - lastSpread > 66) { lastSpread = now; renderSpread(); } }
  animateDemoFlight(now); animateDemoCase(now);
  tickPeopleDemo(now); renderPeopleCamera(now);
  requestAnimationFrame(animate);
}

/** Initialize the dashboard, bootstrap local access and enter explicit replay only when requested. */
async function boot() {
  state.liveDemo = new URLSearchParams(location.search).has('live-demo');
  $('live-demo-toggle').setAttribute('aria-pressed', String(state.liveDemo));
  $('live-demo-toggle').classList.toggle('active', state.liveDemo);
  $('map-pill').textContent = state.liveDemo ? 'Live demo' : 'Live';
  initMap(); bindUi(); drawWaiting('Waiting for live video', 'The bridge relays the ANAFI camera through the backend'); renderSpread(); renderMapChip();
  // Opened straight from disk there is no backend to talk to: say so instead of asking for a token.
  if (location.protocol === 'file:') {
    setBanner('warn', '<strong>Opened from a file</strong> · run <code>npm start</code>, then open <code>127.0.0.1:8787</code>');
    setModePill('demo', 'Not connected'); $('connection-result').textContent = 'Not connected: this page was opened from a file, not from the BOSCO backend.';
    requestAnimationFrame(animate); return;
  }
  try { const s = await (await fetch('/api/session')).json(); state.token = s.token || ''; } catch {}
  if (!state.token) { setBanner('warn', '<strong>Dashboard token needed</strong> · open Integrations'); setModePill('demo', 'Not connected'); openDialog('integrations-dialog'); }
  else await connect();
  if (new URLSearchParams(location.search).has('demo')) toggleDemo();
  requestAnimationFrame(animate);
}
boot();
