'use strict';
/* BOSCO dashboard (Bushfire Observation, Simulation and Coordination Operations). Opens live against the backend that serves it:
   video, telemetry, detections and flight events from the ANAFI bridge;
   Gemini analysis and plans from the backend; history from TigerData.
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
const FLIGHT_STATES = {landed:'Landed', takingoff:'Taking off', hovering:'Hovering', flying:'Flying', landing:'Landing', emergency:'Emergency', usertakeoff:'Hand launch', motor_ramping:'Motors starting', emergency_landing:'Emergency landing'};
const SPREAD_BANDS = [[1.08,'#ffc459',.22],[1,'#ffb345',.24],[.79,'#ff8e43',.33],[.55,'#f54b31',.45],[.27,'#c7332c',.6]];

const state = {
  mode: 'live', token: '', connected: false, status: null,
  site: {name: 'UTSC · Sam Ibrahim Building', latitude: 43.7866, longitude: -79.1903},
  telemetry: null, incident: null, episodeSeen: null, flight: {events: [], path: []},
  analysis: null, analysisMeta: null, plan: null, planDirty: false,
  scenario: {...M.BASE}, detectedScenario: null, minute: 0, playing: false, speed: 1,
  // created_at of the analysis whose derived wind last set scenario.wind, the
  // analysis the user manually overrode, and the estimate shown in the UI
  windAuto: null, windManual: null, windDerived: null,
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

/** Show live monitoring, fire or disconnected status from current evidence freshness. */
function renderHeading() {
  if (state.mode === 'demo') return;
  const inc = activeFire(), t = state.telemetry;
  const telemetryAge = t ? Date.now() - Date.parse(t.observed_at) : Infinity;
  if (inc) {
    const d = inc.latest, det = d.details || {};
    $('incident-eyebrow').textContent = 'ACTIVE FIRE · ANAFI-01'; $('incident-dot').classList.add('alert');
    $('incident-title').textContent = det.name ? `${det.name} fire` : 'Fire detected'; $('incident-tag').hidden = false;
    const location = d.details?.position_simulated ? 'Scenario location · configured site, not measured GPS' : d.fire.latitude != null ? `${d.fire.latitude.toFixed(5)}, ${d.fire.longitude.toFixed(5)}` : 'Fire location unavailable';
    $('incident-sub').textContent = `First sighted ${fmtTime(inc.first_detected_at)} · ${inc.sightings} sighting${inc.sightings === 1 ? '' : 's'} · ${location}`;
    const how = d.source === 'qr-test' ? 'test marker' : `fire model (${d.label})`;
    setBanner('alert', `<strong>Fire detected at ${escapeHTML(fmtTime(d.detected_at))}</strong> by ANAFI-01 · ${escapeHTML(how)}, ${Math.round(d.confidence * 100)}%. ${d.details?.position_simulated ? 'Spread uses the configured test location.' : d.fire.latitude == null ? 'Location unavailable; map projection is waiting.' : 'Fire location is available for the spread projection.'} Analysis and response tools are below.`, true);
    setModePill('alert-badge', 'Fire detected');
  } else {
    $('incident-eyebrow').textContent = 'LIVE MONITORING · ANAFI-01'; $('incident-dot').classList.remove('alert');
    $('incident-title').textContent = 'Monitoring for fire'; $('incident-tag').hidden = true;
    $('incident-sub').textContent = state.site.name;
    if (!state.connected) { setBanner('warn', '<strong>Backend offline</strong> · run <code>npm start</code>'); setModePill('demo', 'Offline'); }
    else if (telemetryAge > STALE_MS) { setBanner('info', '<strong>Waiting for the drone</strong> · keep the receiver running'); setModePill('demo', 'Waiting for drone'); }
    else {
      const v = state.status?.vision;
      const vision = !v?.fresh ? 'fire detector offline' : v.error ? 'fire detector error' : v.camera_state !== 'live' ? 'waiting for camera frames' : v.model_status === 'ready' ? 'fire detection on' : 'QR fire test only';
      setBanner('info', `<strong>Live</strong> · ${vision}`); setModePill('live-badge', 'Live · monitoring');
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
  for (const name of ['spread', 'wind', 'fire', 'drone', 'demo', 'ask']) state.layers[name] = L.layerGroup().addTo(map);
  state.layers.path = L.polyline([], {color: '#3A372E', weight: 2, dashArray: '4 5', opacity: .75}).addTo(state.layers.drone);
  state.droneMarker = droneMarker([state.site.latitude, state.site.longitude]).setOpacity(0).addTo(state.layers.drone);
  L.control.scale({imperial: false, position: 'bottomright'}).addTo(map);
  map.on('dragstart', () => setFollow(false));
  state.layers.trail = L.layerGroup().addTo(state.layers.drone); // drone trail, coloured by what it was doing about the fire
  peopleInitMap();
  window.addEventListener('resize', () => map.invalidateSize());
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map-viewport'));
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
const droneMarker = ll => L.marker(ll, {icon: L.divIcon({className: 'drone-icon-wrap', html: DRONE_HTML, iconSize: [120, 120], iconAnchor: [60, 60]}), keyboard: false, interactive: false});
/** Update map-icon heading in degrees, height label and grounded appearance. */
function setDronePose(marker, heading, alt, landed = false) {
  const el = marker.getElement()?.querySelector('.drone-icon'); if (!el) return;
  el.querySelector('.drone-rot').setAttribute('transform', `rotate(${heading || 0})`);
  el.querySelector('.drone-alt').textContent = alt == null ? 'ANAFI-01' : `ANAFI-01 · ${alt < 10 ? alt.toFixed(1) : Math.round(alt)} m`;
  const lift = Math.min(12, 2 + (alt ?? 0) / 10); // higher -> the shadow falls further away
  el.style.setProperty('--shadow-x', (lift * .6).toFixed(1) + 'px'); el.style.setProperty('--shadow-y', lift.toFixed(1) + 'px');
  el.classList.toggle('landed', landed);
}

/** Return the current live or simulated drone's geographic position when known. */
function dronePosition() {
  if (state.mode === 'demo') return state.demo.pos ?? null;
  const t = state.telemetry; return t?.latitude != null ? [t.latitude, t.longitude] : null;
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
  $('map-empty').hidden = !title; $('map-empty-title').textContent = title; $('map-empty-text').textContent = text;
}

/** Update the live aircraft marker, activity-colored trail and optional follow view. */
function renderDrone() {
  const t = state.telemetry;
  if (!t || t.latitude == null || state.mode === 'demo') { state.droneMarker.setOpacity(0); return; }
  const ll = [t.latitude, t.longitude];
  state.droneMarker.setLatLng(ll).setOpacity(1);
  setDronePose(state.droneMarker, t.extra?.heading_deg, t.altitude_m, t.state === 'landed');
  drawTrail(state.layers.trail, liveTrail(state.flight.path));
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
  const inc = activeFire(); return inc?.latest.fire.latitude != null ? [inc.latest.fire.latitude, inc.latest.fire.longitude] : null;
}

/* Projected spread at the selected minute, drawn as layered intensity bands. */
function renderSpread() {
  const sc = state.scenario, t = state.minute;
  $('time-label').textContent = `T + ${Math.round(t)} min`; $('timeline').value = t;
  document.querySelectorAll('[data-minute]').forEach(b => b.classList.toggle('selected', Math.abs(+b.dataset.minute - t) < .5));
  $('wind-value').textContent = Math.round(sc.wind); $('wind-context').textContent = `toward ${M.compass(sc.direction)} ${['↑','↗','→','↘','↓','↙','←','↖'][Math.round(sc.direction/45)%8]}` + (state.windDerived ? windSourceLabel(state.windDerived) : '');
  state.layers.spread.clearLayers(); state.layers.wind.clearLayers();
  const o = origin();
  if (!o) { $('area-value').textContent = '—'; $('area-context').textContent = state.mode === 'demo' ? (demoCase() ? 'confirming detection…' : 'select a fire') : activeFire() ? 'fire detected · location unavailable' : 'no fire detected'; return; }
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
    L.polygon(M.footprint(o, 0, sc, details), {color: '#9e3026', weight: 1.4, dashArray: '4 4', fill: false}).addTo(state.layers.spread).bindTooltip('Fire now');
  }
  for (const [scale, color, opacity] of SPREAD_BANDS) {
    const poly = L.polygon(ring(scale), {stroke: scale === 1, color: '#ec9d33', weight: 1.2, dashArray: '5 4', fillColor: color, fillOpacity: opacity}).addTo(state.layers.spread);
    if (scale === 1 && modelledFire()) poly.bindTooltip(`Projected head ≈${M.spreadRate(sc, fireDetails()).toFixed(0)} m/min toward ${M.compass(sc.direction)} — illustrative`);
  }
  const area = M.areaHa(outline);
  $('area-value').textContent = area >= 100 ? Math.round(area).toLocaleString() : area.toFixed(area < 1 ? 3 : 1);
  $('area-context').textContent = t < .5 ? 'now' : `projected at +${Math.round(t)} min`;
  const reach = !modelledFire() ? Math.sqrt(area * 10000 / Math.PI) * 1.3 : M.headDistance(t, sc, fireDetails());
  const windHead = M.destPoint(o[0], o[1], sc.direction, reach);
  L.polyline([M.destPoint(o[0], o[1], sc.direction + 180, reach * .25), windHead], {color: '#8C8679', weight: 1.6, dashArray: '2 6'}).addTo(state.layers.wind).bindTooltip(`Wind ${Math.round(sc.wind)} km/h toward ${M.compass(sc.direction)}`);
  L.marker(windHead, {icon: L.divIcon({className: 'wind-arrow', html: `<div style="transform:rotate(${Math.round(sc.direction)}deg)">▲</div>`, iconSize: [14, 14], iconAnchor: [7, 7]}), interactive: false}).addTo(state.layers.wind);
}

/** Draw only the positioned live fire, with its detection context. */
function renderFirePin() {
  state.layers.fire.clearLayers();
  const inc = activeFire(); if (!inc || !origin()) return;
  const d = inc.latest, det = d.details || {};
  L.marker([d.fire.latitude, d.fire.longitude], {icon: L.divIcon({className: 'fire-pin-wrap', html: '<div class="fire-pin">🔥</div>', iconSize: [34, 34], iconAnchor: [17, 17]})})
    .addTo(state.layers.fire)
    .bindPopup(`<b>${escapeHTML(det.name || 'Detected fire')}</b><br>${escapeHTML(d.label)} · ${Math.round(d.confidence * 100)}% · ${escapeHTML(d.source)}<br>${d.fire.latitude.toFixed(6)}, ${d.fire.longitude.toFixed(6)}<br>${d.fire.distance_m} m from drone · bearing ${d.fire.bearing_deg}°${det.area_ha != null ? `<br>Reported area ${det.area_ha} ha` : ''}${det.fuel ? `<br>Fuel: ${escapeHTML(det.fuel)}` : ''}`);
  if (d.drone?.latitude != null) L.polyline([[d.drone.latitude, d.drone.longitude], [d.fire.latitude, d.fire.longitude]], {color: '#E8562A', weight: 1.5, dashArray: '3 4'}).addTo(state.layers.fire);
}

/** Frame the relevant search sector, fire footprint or drone fallback on the map. */
function fitToFire() {
  if (peopleDemoActive() && fitPeople()) return;
  const o = origin();
  if (!o && demoCase()) { const f = demoCase(); state.map.fitBounds(L.latLng(f.lat, f.lon).toBounds(1100)); return; } // drone and fire, before geolocation
  if (!o) { const t = state.telemetry; if (t?.latitude != null) state.map.setView([t.latitude, t.longitude], 19); else state.map.setView([state.site.latitude, state.site.longitude], 17); return; }
  state.map.invalidateSize();
  const pts = state.mode === 'demo' && !peopleDemoActive() ? [...demoOutline(demoCase(), state.minute), state.demo.pos] : M.footprint(o, 30, state.scenario, fireDetails());
  state.map.fitBounds(L.latLngBounds(pts).pad(.15), {maxZoom: 20});
}

// ------------------------------------------------------------- telemetry

/** Display measured drone values and mark missing or stale live telemetry clearly. */
function renderTelemetry() {
  if (state.mode === 'demo') return;
  const t = state.telemetry;
  if (!t) { for (const id of ['altitude', 'ground-speed', 'power']) $(id).innerHTML = `— <small>${id === 'power' ? '%' : id === 'altitude' ? 'm' : 'm/s'}</small>`; $('flight-state').textContent = '—'; return; }
  const age = Math.max(0, (Date.now() - Date.parse(t.observed_at)) / 1000), stale = age * 1000 > STALE_MS;
  $('altitude').innerHTML = `${escapeHTML(t.altitude_m ?? '—')} <small>m</small>`;
  $('ground-speed').innerHTML = `${escapeHTML(t.ground_speed_mps ?? '—')} <small>m/s</small>`;
  $('power').innerHTML = `${escapeHTML(t.battery_pct ?? '—')} <small>%</small>`;
  $('flight-state').textContent = FLIGHT_STATES[t.state] || t.state || '—';
  $('battery-value').innerHTML = `${escapeHTML(t.battery_pct ?? '—')}<span class="small-unit">%</span>`;
  $('battery-context').textContent = stale ? `last seen ${Math.round(age)} s ago` : 'ANAFI-01 battery';
  $('telemetry-tag').textContent = stale ? 'STALE' : 'LIVE';
  $('drone-source').textContent = stale ? 'Telemetry stale' : 'Live telemetry';
  const where = t.extra?.position_source === 'gps' ? 'GPS' : 'indoor position (home + flight moves)';
  $('telemetry-note').textContent = `${stale ? 'STALE · ' : ''}${t.drone_id || 'ANAFI-01'} · ${where} · heading ${t.extra?.heading_deg ?? '—'}° · camera ${t.extra?.gimbal_pitch_deg != null ? Math.round(t.extra.gimbal_pitch_deg) + '°' : '—'} · ${Math.round(age)} s ago`;
  $('telemetry-note').classList.toggle('error-text', stale);
}

/** Render live flight-phase progress and recent event messages. */
function renderFlight() {
  if (state.mode === 'demo') return;
  const e = state.flight.events.at(-1);
  const recent = e && Date.now() - Date.parse(e.at) < (e.phase === 'landed' || e.phase === 'aborted' || e.phase === 'error' ? 10_000 : 120_000);
  $('flight-progress').hidden = !recent; if (!recent) return;
  const frac = {preflight: 0, takeoff: .1, climb: .2, circle: .2 + .6 * ((e.step || 0) / (e.steps || 8)), return: .85, landing: .93, landed: 1, aborted: 1, error: 1}[e.phase] ?? 0;
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
    const canvas = $('camera'), ctx = canvas.getContext('2d');
    if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height; }
    ctx.drawImage(bmp, 0, 0); bmp.close();
    for (const d of f.detections) {
      const [x1, y1, x2, y2] = d.bbox, w = canvas.width, h = canvas.height;
      ctx.strokeStyle = '#E8562A'; ctx.lineWidth = Math.max(3, w / 240); ctx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
      ctx.fillStyle = '#E8562A'; ctx.font = `600 ${Math.round(w / 40)}px 'IBM Plex Mono', ui-monospace, monospace`; ctx.fillText(`${d.source === 'qr-test' ? 'FIRE · test marker' : d.label.toUpperCase()} ${Math.round(d.confidence * 100)}%`, x1 * w, Math.max(h / 20, y1 * h - 8));
    }
    const now = Date.now(); state.video.lastAt = now; state.video.times.push(now); state.video.times = state.video.times.filter(t => now - t < 2000);
    $('camera-label').innerHTML = f.detections.length ? '<i class="hot"></i> FIRE IN VIEW' : '<i></i> LIVE · ANAFI-01';
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
  if (inc && inc.episode_id !== state.episodeSeen) {
    state.episodeSeen = inc.episode_id;
    state.detectedScenario = M.scenarioFrom(inc.latest.details);
    state.scenario = {...state.detectedScenario}; state.minute = 0;
    state.windAuto = state.windManual = state.windDerived = null;
    markPlanDirty(); renderFirePin(); renderSpread(); fitToFire();
    toast(`Fire detected — ${inc.latest.details?.name || inc.latest.label}. See analysis and response below.`);
  } else renderFirePin();
  if (!inc && state.episodeSeen) { state.episodeSeen = null; renderSpread(); }
  if (inc) {
    $('detect-value').textContent = Math.round(inc.max_confidence * 100); $('detect-unit').textContent = '%';
    $('detect-context').textContent = `${inc.latest.source === 'qr-test' ? 'test marker' : 'fire model · ' + inc.latest.label} · ${inc.sightings} sightings`;
  } else { $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'watching the camera feed'; }
  renderHeading();
}

// -------------------------------------------------------------- analysis

/** Present the current structured scene assessment, uncertainty and derived-wind context. */
function renderAnalysis() {
  const meta = state.analysisMeta, a = state.analysis;
  $('analysis-panel').classList.toggle('has-analysis', !!a);
  let offline = null;
  if (meta && !meta.configured) offline = 'GEMINI_API_KEY is not set on the backend.';
  else if (meta?.error && (!a || meta.error.at > a.created_at)) offline = meta.error.message;
  $('analysis-offline').hidden = !offline; $('analysis-offline-text').textContent = offline || '';
  if (meta?.pending) $('analysis-source').textContent = 'ANALYZING…';
  if (!a) { if (!meta?.pending) $('analysis-source').textContent = offline ? 'UNAVAILABLE' : 'WAITING'; return; }
  if (!meta?.pending) $('analysis-source').textContent = `GEMINI · ${a.trigger === 'auto-detection' ? 'AUTO' : 'MANUAL'} · ${fmtTime(a.created_at)}`;
  $('analysis-severity').hidden = !a.severity; $('analysis-severity').textContent = a.severity || ''; $('analysis-severity').className = 'severity ' + (a.severity || '');
  $('analysis-summary').textContent = a.summary;
  $('analysis-title').textContent = 'Spread outlook';
  $('analysis-detail').textContent = a.spread_outlook || (a.unknowns || []).join(' ');
  const obs = (a.observations || []).slice(0, 3);
  $('analysis-observations').innerHTML = obs.map(o => `<li>${escapeHTML(o)}</li>`).join('');
  $('analysis-more').hidden = !obs.length && !a.limitations && !(a.unknowns || []).length;
  const w = a.wind_estimate;
  const windLine = w ? `Wind est. ${w.speed_mps != null ? `≈${w.speed_mps} m/s` : 'unknown speed'}${w.direction_deg != null ? ` toward ${Math.round(w.direction_deg)}° ${M.compass(w.direction_deg)}` : ''} — ${w.method} (${w.confidence})` : null;
  $('analysis-limit').textContent = [windLine, (a.unknowns || [])[0], a.limitations].filter(Boolean).join(' · ');
  applyWindEstimate(a);
}

/* Which estimator a wind_estimate came from — the label follows the method,
   so a flight-controller value and a tilt-derived value are not conflated. */
function windSourceLabel(w) {
  return /flight-controller|flight controller/i.test(w?.method ?? '') ? ' · FC est.' : ' · derived est.';
}

/* When the latest analysis carries a wind estimate — the flight controller's
   own onboard estimate when the drone streams one, else a value derived from
   stabilization telemetry — adopt it as the scenario's wind so the projected
   spread follows live evidence instead of the marker's fixed value. Each
   analysis applies at most once; a manual Apply in the conditions dialog
   overrides it until the next analysis arrives. */
function applyWindEstimate(a) {
  const w = a?.wind_estimate;
  if (!w || state.mode === 'demo') return;
  if (a.created_at === state.windAuto || a.created_at === state.windManual) return;
  const kmh = w.speed_mps != null ? Math.round(w.speed_mps * 3.6) : null;
  const deg = w.direction_deg != null ? ((Math.round(w.direction_deg) % 360) + 360) % 360 : null;
  if (kmh === null && deg === null) return;
  const changed = (kmh !== null && kmh !== state.scenario.wind) || (deg !== null && deg !== state.scenario.direction);
  if (kmh !== null) state.scenario.wind = kmh;
  if (deg !== null) state.scenario.direction = deg;
  state.windAuto = a.created_at; state.windDerived = w;
  if (changed) {
    markPlanDirty(); renderSpread(); refreshFireTiming();
    toast(`Wind updated ${/flight-controller|flight controller/i.test(w.method ?? '') ? 'from the flight-controller estimate' : 'from drone stabilization'} — estimate, not a sensor reading.`);
  }
}

// ------------------------------------------------------------------ plan

/** Describe the selected fire's modeled spread for live or isolated replay planning. */
function projection() {
  const o = origin(); if (!o) return null;
  if (demoCase()) return demoProjection();
  const details = fireDetails();
  return {minutes_ahead: Math.round(state.minute), area_ha: +M.areaHa(M.footprint(o, state.minute, state.scenario, details)).toFixed(3), head_distance_m: Math.round(M.headDistance(state.minute, state.scenario, details)), spread_rate_m_per_min: +M.spreadRate(state.scenario, details).toFixed(1), toward_deg: state.scenario.direction, toward: M.compass(state.scenario.direction), origin: {latitude: o[0], longitude: o[1]}};
}
/** Invalidate an existing plan and its scenario cache after relevant conditions change. */
function markPlanDirty() { if (state.plan && !state.planDirty) { state.planDirty = true; const r = demoResults(); if (r) r.planDirty = true; renderPlan(); } }

/** Render a reviewed/draft plan, wording flags, named approval and export controls. */
function renderPlan(offline) {
  const p = state.plan;
  const offlineHtml = offline ? `<div class="gemini-offline"><strong>Cannot connect to Gemini</strong><p>${escapeHTML(offline)}</p></div>` : '';
  if (!p) { if (offline) $('draft-area').innerHTML = `<div class="review-draft">${offlineHtml}</div>`; return; }
  /** Render a titled escaped plan list only when entries exist. */
  const list = (title, items) => items?.length ? `<h4>${title}</h4><ul>${items.map(i => `<li>${escapeHTML(i)}</li>`).join('')}</ul>` : '';
  const approved = p.approvedBy && !state.planDirty;
  // The drone cannot certify ground as safe: point out any wording that claims it.
  const wording = p.wording_flags?.length ? `<div class="gemini-offline"><strong>Check the wording before approving</strong><p>This plan describes ground as safe or cleared (${p.wording_flags.map(w => `“${escapeHTML(w)}”`).join(', ')}). BOSCO cannot verify that. Restate it as observed hazards and when they were seen.</p></div>` : '';
  $('draft-area').innerHTML = `<div class="review-draft">${offlineHtml}${wording}<div class="draft-heading"><h3>${escapeHTML(p.title)}</h3><span class="pill ${approved ? 'live-badge' : 'soft-orange'}">${approved ? 'Approved' : 'Draft'}</span></div><p class="draft-meta">GEMINI · ${escapeHTML(p.objective)} · ${escapeHTML(new Date(p.created_at).toLocaleTimeString())}${p.projection ? ` · spread at +${p.projection.minutes_ahead} min` : ''}</p>${state.planDirty ? '<div class="notice plan-dirty">Conditions changed since this plan. Regenerate to use the latest picture.</div>' : ''}<div class="advantage"><strong>Operational advantage</strong><p>${escapeHTML(p.advantage)}</p></div><h4>Situation</h4><p class="plan-text">${escapeHTML(p.situation)}</p>${list('Objectives', p.objectives)}<h4>Actions</h4><table class="plan-actions"><thead><tr><th>#</th><th>Action</th><th>Owner</th><th>Timing</th></tr></thead><tbody>${p.actions.map(a => `<tr><td>${a.priority}</td><td>${escapeHTML(a.action)}${a.rationale ? `<small>${escapeHTML(a.rationale)}</small>` : ''}</td><td>${escapeHTML(a.owner || '—')}</td><td>${escapeHTML(a.timing || '—')}</td></tr>`).join('')}</tbody></table>${list('Resources & staging', p.resources)}${list('Re-planning triggers', p.triggers)}${list('Risks', p.risks)}${p.next_update ? `<h4>Next update</h4><p class="plan-text">${escapeHTML(p.next_update)}</p>` : ''}<div class="reviewer-row"><input id="reviewer-name" aria-label="Approver name" maxlength="80" placeholder="Incident commander" value="${escapeHTML(p.approvedBy || '')}" ${approved ? 'disabled' : ''}><button class="button primary" id="approve-plan" ${approved || state.planDirty ? 'disabled' : ''}>Approve plan</button></div>${approved ? `<p class="microcopy">Approved by ${escapeHTML(p.approvedBy)} at ${escapeHTML(new Date(p.approvedAt).toLocaleString())}.</p>` : ''}<div class="draft-buttons"><span class="microcopy">${p.provenance === 'gemini-demo' ? 'Incident replay — kept in this session.' : 'Stored in TigerData with the detection it was built on.'}</span><button class="button" id="export-plan">Export plan ↓</button></div></div>`;
  $('approve-plan').onclick = () => { const name = $('reviewer-name').value.trim(); if (!name) { toast('Enter the approving incident commander.'); return; } p.approvedBy = name; p.approvedAt = new Date().toISOString(); renderPlan(); toast('Plan approved.'); };
  $('export-plan').onclick = () => download(`bosco-plan-${p.id.slice(0, 8)}.json`, JSON.stringify(p, null, 2), 'application/json');
}

/** Render the ask-the-incident answer plus highlight markers for the places it cites. */
function renderAsk(r) {
  const box = $('ask-answer');
  box.hidden = false;
  const consulted = r.tool_trace?.length
    ? `<p class="microcopy">Gemini consulted: ${r.tool_trace.map((t) => escapeHTML(t.tool)).join(', ')}</p>` : '';
  const noFire = r.context && !r.context.fire_projected
    ? '<p class="microcopy">No fire projected — distances measured from the site anchor.</p>' : '';
  box.innerHTML = `<div class="ask-response"><p class="ask-q">${escapeHTML(r.question)}</p><p class="ask-a">${escapeHTML(r.answer)}</p>${r.confidence_note ? `<p class="ask-note">${escapeHTML(r.confidence_note)}</p>` : ''}${consulted}${noFire}</div>`;
  state.layers.ask?.clearLayers();
  for (const lm of r.landmarks ?? []) {
    const sub = lm.inside_fire_now ? 'inside now'
      : lm.projected_arrival_min != null ? `~${Math.round(lm.projected_arrival_min)} min`
      : `${Math.round(lm.distance_m)} m`;
    L.marker([lm.latitude, lm.longitude], {
      icon: L.divIcon({ className: 'ask-place', html: `<span>${escapeHTML(lm.name)}<b>${escapeHTML(sub)}</b></span>`, iconAnchor: [8, 8] }),
    }).addTo(state.layers.ask).bindTooltip(
      `${escapeHTML(lm.name)} — ${Math.round(lm.distance_m)} m` +
      (lm.bearing_compass ? ` ${lm.bearing_compass} of the fire` : '') +
      (lm.projected_arrival_min != null ? ` · projected arrival ~${Math.round(lm.projected_arrival_min)} min`
        : lm.inside_fire_now ? ' · inside the fire now'
        : lm.bearing_compass ? ' · not projected within the horizon' : ''));
  }
}

/** Send the map-grounded question; live incidents resolve server-side, replay passes its own fire. */
async function askIncident() {
  const q = $('ask-input').value.trim();
  if (q.length < 3) { toast('Type a question about the incident.'); return; }
  $('ask-send').disabled = true;
  try {
    const body = { question: q, scenario: state.scenario };
    if (state.mode === 'demo' && modelledFire()) {
      const o = origin();
      if (o) body.fire = { latitude: o[0], longitude: o[1] };
      if (fireDetails()) body.details = fireDetails();
    }
    const r = await getJson('/api/ask', { method: 'POST', body, timeout: 100000 });
    renderAsk(r);
  } catch (e) {
    const box = $('ask-answer');
    box.hidden = false;
    box.innerHTML = `<div class="ask-response"><p class="ask-a">${escapeHTML(e.status === 503 ? 'Gemini is not configured on the backend.' : e.message)}</p></div>`;
  } finally { $('ask-send').disabled = false; }
}

/* Fictional wind variation for a live-feel demo: only reachable with
   ?demo-wind in the URL, toggled from the conditions dialog, and labelled
   fictional wherever it appears. Nothing about it is real wind. */
const DEMO_WIND_FLAG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo-wind');
let demoWindTimer = null, demoWindBase = null, demoWindT0 = 0;
function setDemoWind(on) {
  if (on) {
    demoWindBase = { ...state.scenario };
    demoWindT0 = performance.now();
    toast('Fictional wind variation on — wind values are not real.');
    demoWindTimer = setInterval(() => {
      const t = (performance.now() - demoWindT0) / 1000;
      state.scenario = {
        ...state.scenario,
        wind: Math.round(Math.max(0, Math.min(120, demoWindBase.wind + 18 * Math.sin(t / 7) + 6 * Math.sin(t / 2.3)))),
        direction: Math.round((demoWindBase.direction + 28 * Math.sin(t / 11) + 360) % 360),
      };
      renderSpread(); refreshFireTiming(); markPlanDirty();
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

/** Request a live or scenario-specific replay plan and preserve visible service errors. */
async function generatePlan() {
  $('generate-plan').disabled = true; $('generate-plan').innerHTML = '<svg><use href="#i-spark"/></svg>Gemini is planning…';
  try {
    const r = demoResults();
    if (state.mode === 'demo') { const plan = await demoGemini('plan'); if (!plan) return; r.plan = plan; r.planDirty = false; if (demoResults() !== r) return; state.plan = plan; }
    else state.plan = await getJson('/api/plan', {method: 'POST', body: {objective: $('objective').value, notes: $('notes').value, scenario: state.scenario, projection: projection()}, timeout: 100000});
    state.planDirty = false; renderPlan(); toast('Operational plan ready.');
  } catch (e) {
    if (e.status === 429) toast(e.message);
    else renderPlan(e.status === 503 ? 'GEMINI_API_KEY is not set on the backend.' : e.message);
  } finally { $('generate-plan').disabled = false; $('generate-plan').innerHTML = '<svg><use href="#i-spark"/></svg>Generate operational plan'; }
}

// ------------------------------------------------------------------ demo

const DEMO_FLIGHT_S = 26;
const PANEL_DEFAULTS = {};
/** Cache original analysis/plan placeholders before switching scenarios. */
function savePanelDefaults() { for (const id of ['analysis-summary', 'analysis-detail', 'analysis-observations', 'analysis-limit', 'draft-area']) PANEL_DEFAULTS[id] = $(id).innerHTML; }
/** Restore empty analysis markup and clear prior severity/error indicators. */
function resetAnalysisPanel() { for (const id of ['analysis-summary', 'analysis-detail', 'analysis-observations', 'analysis-limit']) $(id).innerHTML = PANEL_DEFAULTS[id]; $('analysis-severity').hidden = true; $('analysis-offline').hidden = true; }
/** Restore the empty plan placeholder when changing evidence context. */
function resetPlanPanel() { $('draft-area').innerHTML = PANEL_DEFAULTS['draft-area']; }
/** Return only a historical camera case, excluding flight-pattern and person-search replay. */
const demoCase = () => state.mode === 'demo' && state.demo.selected && state.demo.selected !== 'flight' && state.demo.selected.id !== 'people' ? state.demo.selected : null;
/** Return an isolated analysis/plan cache for the currently selected replay scenario. */
const demoResults = () => {
  const f = state.mode === 'demo' && state.demo.selected;
  if (!f || f === 'flight') return null;
  const key = f.id === 'people' ? `people:${f.scenario}` : f.id;
  return (state.demo.results[key] ??= {analysis: null, plan: null, planDirty: false});
};

/* Show the selected case's own Gemini results, or empty panels until Gemini is asked. */
function showDemoResults() {
  const r = demoResults();
  state.analysis = r?.analysis ?? null; state.plan = r?.plan ?? null; state.planDirty = r?.planDirty ?? false;
  state.analysisMeta = {configured: state.status?.gemini?.configured ?? true, pending: false, error: null};
  resetAnalysisPanel(); resetPlanPanel();
  if (!r) { $('analysis-summary').textContent = 'Select an incident; Gemini analyzes it once ANAFI-01 geolocates the fire.'; $('analysis-source').textContent = 'WAITING'; return; }
  if (!state.analysis) {
    $('analysis-summary').textContent = peopleDemoActive() ? 'Analyze current view to review the simulated fire and rescue leads.' : `Gemini analyzes ${demoCase().name} automatically once ANAFI-01 geolocates it.`;
    $('analysis-detail').textContent = peopleDemoActive() ? 'Gemini receives simulated observations; results stay in this replay session.' : 'Gemini receives the drone camera frame, telemetry and observed conditions.';
  }
  renderAnalysis(); if (state.plan) renderPlan();
}

/* Simulated ANAFI-01 for a demo case, t seconds after its camera first saw
   the fire: it was patrolling low (35 m) about 280 m upwind, hovers while the
   detection is confirmed, then climbs at up to 4 m/s (ANAFI max) to its
   recorded 120 m while widening to a 450 m survey orbit at 8 m/s, camera
   locked on the fire's head. Information reaches the workspace in the order
   a real sighting would: detection confirmed, fire geolocated, Gemini. */
const SIM = {r0: 280, alt0: 35, climbS: 32, orbitR: 450, orbitV: 8};
const SIM_DELAY = {confirm: 2.5, locate: 4, analyze: 5};
/** Smoothly interpolate a bounded zero-to-one simulation transition. */
const ease = k => { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); };
/* The burning front the camera sees; the map's T + 0 outline is the same ellipse. */
function simFire(f, t) { const a = Math.min(300, 90 + t * .8); return {a, b: a / 2.4, shift: a * .45}; }
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
  const p = scout && BoscoScout.pose(scout, t, surveyPose(f, BoscoScout.START));
  return p ? {...p, fire: simFire(f, t)} : surveyPose(f, t);
}

/** Refresh historical-case leads without touching live person-search storage. */
function updateDemoScout(t = demoT()) {
  const f = demoCase(), scout = state.demo.scout;
  if (!f || !scout) return;
  const snapshot = BoscoScout.snapshot(scout, t, surveyPose(f, BoscoScout.START));
  renderPeople(snapshot);
  $('people-source').textContent = 'Simulated · case';
  if (t >= BoscoScout.START) setBanner('demo', `<strong>Simulated rescue scout · ${escapeHTML(f.name)}.</strong> ${escapeHTML(simPose(f, t).phase)} · ${snapshot.leads.length} fictional people spotted. Map, camera and telemetry follow the same simulation.`);
}
/* The detector locks on over the first seconds, then firms up as the view opens out. */
function simConfidence(f, t) {
  const c = f.drone.detection.confidence * (.55 + .45 * ease(t / SIM_DELAY.confirm)) + .03 * ease((t - 2) / SIM.climbS);
  return Math.max(.3, Math.min(.99, c + .012 * Math.sin(t * 5.3) + .008 * Math.sin(t * 11.1)));
}
/** Return elapsed time in the current historical replay, in seconds. */
const demoT = () => Math.max(0, (performance.now() - state.demo.started) / 1000);
/* Spread outline at `minute`: the live fire at T + 0, growing geometrically to
   the recorded final burn area at T + 60, in the recorded burn's shape. */
function demoOutline(f, minute, scale = 1) {
  const live = simFire(f, demoT()), a0 = Math.PI * live.a * live.b, af = f.areaHa * 10000;
  const k = Math.sqrt(a0 * Math.pow(af / a0, minute / 60) / af) * scale;
  return M.recordedPerimeter(f).map(p => [f.lat + (p[0] - f.lat) * k, f.lon + (p[1] - f.lon) * k]);
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
  setBanner('demo', `<strong>Fire geolocated · ${escapeHTML(f.name)}.</strong> ANAFI-01 is climbing to survey it. Conditions on scene: ${f.drivers.tempC ?? '—'} °C, wind ${f.drivers.windKmh ?? '—'} km/h toward ${M.compass(f.directionDeg)}, RH ${f.drivers.rhPct ?? '—'}%. Gemini is analyzing it automatically.`);
  toast(`Fire detected — ${f.name}. Gemini is analyzing it.`);
  renderSpread();
}

/* Gemini analyzes each demo fire on its own once it is geolocated, as it does
   for live detections. Retries rate limits (one request per 10 s) and Gemini
   timeouts; gives up only when Gemini is not configured or keeps failing. */
async function autoAnalyze(f) {
  const ATTEMPTS = 4;
  for (let attempt = 1; attempt <= ATTEMPTS && demoCase() === f; attempt++) {
    const r = demoResults(); if (r.analysis) return;
    state.analysisMeta = {...state.analysisMeta, pending: true, error: null}; renderAnalysis();
    if (!state.analysis) $('analysis-summary').textContent = attempt === 1 ? `Gemini is analyzing the ${f.name} detection…` : `Gemini is analyzing the ${f.name} detection… (retry ${attempt - 1})`;
    try {
      const a = await demoGemini('analyze', 'auto-detection'); r.analysis = a;
      if (demoCase() === f) { state.analysis = a; state.analysisMeta = {...state.analysisMeta, pending: false}; renderAnalysis(); toast('Gemini analysis ready.'); }
      return;
    } catch (e) {
      if (demoCase() !== f) return;
      if (e.status === 503 || attempt === ATTEMPTS) {
        state.analysisMeta = {...state.analysisMeta, pending: false, configured: e.status !== 503, error: {message: e.message, at: new Date().toISOString()}}; renderAnalysis();
        if (!state.analysis) $('analysis-summary').textContent = 'Gemini could not analyze this fire. Press "Analyze current view" to try again.';
        return;
      }
      await sleep(10500);
    }
  }
}
/* The incident as Gemini sees it for a live detection: where the fire is, the
   observed conditions, and the drone's telemetry and detection right now. */
function simCase(f) {
  const t = demoT(), p = simPose(f, t), tel = f.drone.telemetry, det = f.drone.detection;
  return {
    id: f.id, name: f.name, region: f.region, latitude: f.lat, longitude: f.lon,
    observed: {temp_c: f.drivers.tempC, wind_kmh: f.drivers.windKmh, wind_toward_deg: f.directionDeg, rh_pct: f.drivers.rhPct, fuel: f.drivers.fuel},
    estimated_area_ha: +M.areaHa(demoOutline(f, 0)).toFixed(1),
    provenance: 'demo-simulated', rescue_leads: peopleState.snap?.historical_scout ? peopleState.snap.leads : [],
    drone: {
      telemetry: {provenance: 'demo-simulated', drone_id: tel.drone_id, latitude: +p.lat.toFixed(6), longitude: +p.lon.toFixed(6), altitude_m: +p.alt.toFixed(1), ground_speed_mps: +p.speed.toFixed(1), battery_pct: Math.round(p.battery), state: 'flying', extra: {heading_deg: Math.round(p.heading), gimbal_pitch_deg: -Math.round(p.pitch), position_source: 'simulated', flight_phase: p.phase.toLowerCase()}},
      detection: {source: det.source, label: det.label, confidence: +simConfidence(f, t).toFixed(2), seconds_since_first_sighting: Math.round(t), fire: {...det.fire, distance_m: Math.round(p.range), bearing_deg: Math.round(p.heading)}},
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
/** Advance only the selected historical camera case, detection timing and automatic analysis. */
function animateDemoCase(now) {
  const f = demoCase(); if (!f || !state.demo.marker) return;
  const t = Math.max(0, (now - state.demo.started) / 1000), p = simPose(f, t), conf = simConfidence(f, t), confirmed = t >= SIM_DELAY.confirm;
  if (state.demo.scout && now - (state.demo.lastScout ?? -2000) > 1000) { state.demo.lastScout = now; updateDemoScout(t); }
  if (t >= BoscoScout.START && state.demo.video) setDemoVideo(null);
  state.demo.pos = [p.lat, p.lon];
  state.demo.marker.setLatLng(state.demo.pos); setDronePose(state.demo.marker, p.heading, p.alt);
  if (!state.demo.located && t >= SIM_DELAY.locate) locateDemoFire(f);
  state.demo.sight?.setLatLngs([state.demo.pos, [f.lat, f.lon]]);
  if (state.demo.located && !state.playing && now - (state.demo.lastSpread ?? 0) > 1000) { state.demo.lastSpread = now; renderSpread(); } // the live fire keeps growing
  if (!state.demo.autoAsked && t >= SIM_DELAY.analyze) { state.demo.autoAsked = true; autoAnalyze(f); }
  if (t - (state.demo.lastTrail ?? -9) >= 1) { state.demo.lastTrail = t; state.demo.trail.addLatLng(state.demo.pos); }
  if (state.follow && now - (state.demo.lastPan ?? 0) > 250) { state.demo.lastPan = now; state.map.panTo(state.demo.pos, {animate: false}); }
  const cam = camera(), video = !!state.demo.video && state.demo.video.readyState >= 2;
  if (cam && now - (state.demo.lastCam ?? 0) > 33) {
    state.demo.lastCam = now;
    const seen = EmberCamera.render($('camera').getContext('2d'), cam, p, {t, fire: p.fire, confidence: conf, label: confirmed ? 'FIRE' : 'POSSIBLE FIRE', people: state.demo.scout?.targets, speed: p.speed, battery: p.battery, range: p.range, footer: video ? 'REFERENCE FOOTAGE · NOT RECORDED BY ANAFI-01' : `SIMULATED · ${p.phase.toUpperCase()} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`});
    state.demo.inView = !!seen;
  }
  if (now - lastPanel < 250) return; lastPanel = now;
  $('altitude').innerHTML = `${p.alt.toFixed(1)} <small>m</small>`; $('ground-speed').innerHTML = `${p.speed.toFixed(1)} <small>m/s</small>`;
  $('power').innerHTML = `${Math.round(p.battery)} <small>%</small>`; $('flight-state').textContent = `${p.climbRate > .3 ? `Climbing ${p.climbRate.toFixed(1)} m/s` : 'Flying'} · ${p.phase.toLowerCase()}`;
  $('battery-value').innerHTML = `${Math.round(p.battery)}<span class="small-unit">%</span>`; $('battery-context').textContent = 'ANAFI-01 battery';
  $('telemetry-note').textContent = `ANAFI-01 · SIMULATED POSITION · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · heading ${Math.round(p.heading)}° · camera ${-Math.round(p.pitch)}° · ${Math.round(p.range)} m from ignition`;
  $('detect-value').textContent = confirmed ? Math.round(conf * 100) : '…'; $('detect-unit').textContent = confirmed ? '%' : '';
  $('detect-context').textContent = confirmed ? `fire model · ${Math.round(p.range)} m · ${Math.floor(t * 4) + 1} sightings` : 'fire model · confirming possible fire…';
  $('camera-label').innerHTML = t >= BoscoScout.START ? '<i class="hot"></i> SIMULATED · PEOPLE SCOUT' : video ? '<i class="hot"></i> REFERENCE FOOTAGE · NOT ANAFI-01' : state.demo.inView && confirmed ? '<i class="hot"></i> FIRE IN VIEW' : '<i></i> POSSIBLE FIRE';
  $('camera-clock').textContent = `${f.startDate} · T+${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  $('video-fps').textContent = cam?.ok ? '30 fps' : '—';
  $('video-status').textContent = video ? `Reference clip · ${state.demo.videoCredit}` : cam?.ok ? 'ANAFI-01 camera · replay' : 'Camera view needs WebGL';
}

/** Describe the historical burn projection at the selected replay minute. */
function demoProjection() {
  const f = demoCase(); if (!f) return null;
  return {minutes_ahead: Math.round(state.minute), area_ha: +M.areaHa(demoOutline(f, state.minute)).toFixed(1), toward_deg: state.scenario.direction, toward: M.compass(state.scenario.direction), origin: {latitude: f.lat, longitude: f.lon}, basis: 'detected fire front growing to the recorded final burn area over a 60-minute replay'};
}

/* The drone camera frame as base64 JPEG, as the bridge sends it for live detections. */
function cameraFrame() {
  if (!camera()?.ok) return undefined;
  try { return $('camera').toDataURL('image/jpeg', .85).split(',')[1]; } catch { return undefined; }
}

/** Submit the selected simulated incident/leads through the replay-only Gemini endpoint. */
async function demoGemini(kind, trigger = 'manual') {
  const f = demoCase(), snap = peopleDemoActive() ? peopleState.snap : null;
  if (!f && !snap?.simulated) { toast('Select an incident and wait for its observations first.'); return null; }
  const incident = f ? simCase(f) : {
    id: `people:${state.demo.selected.scenario}`, name: state.demo.selected.name,
    provenance: 'simulated', fire: snap.fire, drone: snap.drone, rescue_leads: snap.leads,
  };
  const a = state.analysis;
  return getJson(`/api/demo/${kind}`, {method: 'POST', timeout: 100000, body: {case: incident, scenario: state.scenario, ...(kind === 'analyze' ? {...(f ? {image: cameraFrame()} : {}), trigger} : {}), ...(kind === 'plan' ? {objective: $('objective').value, notes: $('notes').value, projection: projection(), analysis: a && {summary: a.summary, severity: a.severity, spread_outlook: a.spread_outlook}} : {})}});
}

/** Enter explicit replay with per-scenario state, or restore live monitoring. */
async function toggleDemo() {
  if (state.mode === 'demo') { exitDemo(); return; }
  state.demo.fires = window.EMBER_DEMO?.cases ?? [];
  if (!state.demo.fires.length) { toast('Incident replays failed to load (demo-cases.js).'); return; }
  state.demo.results ??= {};
  state.live = {analysis: state.analysis, analysisMeta: state.analysisMeta, plan: state.plan, planDirty: state.planDirty};
  state.mode = 'demo'; state.playing = false; setPlayButton();
  state.basemapBeforeDemo = state.basemap; setBasemap('sat'); await loadDemoVideos();
  $('demo-toggle').innerHTML = 'Exit replay <svg><use href="#i-close"/></svg>';
  setModePill('demo', 'Replay'); setBanner('demo', '<strong>Replay</strong> · historical fires, not live data');
  $('map-pill').textContent = 'Replay';
  $('incident-eyebrow').textContent = 'INCIDENT REPLAY'; $('incident-title').textContent = 'Incident replay'; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
  $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'replay — live detection paused';
  const sel = $('demo-fire'); sel.hidden = false;
  /** Format the recorded fire's year for the replay selector. */
  const yr = f => escapeHTML(f.startDate.slice(0, 4));
  sel.innerHTML = '<optgroup label="Person search · fire first (simulated)"><option value="people">UTSC · Highland Creek ravine</option>'
    + state.demo.fires.map(f => `<option value="people:${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${yr(f)}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Historical fire scouting (simulated)"><option value="flight">ANAFI demo flight pattern · UTSC</option>'
    + state.demo.fires.map(f => `<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${yr(f)}</option>`).join('') + '</optgroup>';
  state.layers.fire.clearLayers(); state.droneMarker.setOpacity(0); state.layers.trail.clearLayers();
  state.layers.path.setLatLngs([]);
  for (const f of state.demo.fires) L.circleMarker([f.lat, f.lon], {radius: 6, color: '#d9480f', weight: 2, fillColor: '#d9480f', fillOpacity: .85}).addTo(state.layers.demo).bindTooltip(f.name).on('click', () => { sel.value = f.id; selectDemo(f.id); });
  selectDemo(state.demo.fires[0].id); sel.value = state.demo.fires[0].id;
}

/** Reset incompatible replay state before starting a search, historical case or flight pattern. */
function selectDemo(id) {
  if (state.demo.scout) state.demo.scout.elapsed = demoT();
  state.demo.scout = null;
  state.demo.layer?.remove();
  state.demo.layer = L.layerGroup().addTo(state.map);
  state.layers.ask?.clearLayers(); $('ask-answer').hidden = true;
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
    setBanner('demo', `<strong>Simulated search</strong> · ${fire ? escapeHTML(fire.name) : 'UTSC'} · not live data`);
    $('incident-eyebrow').textContent = 'DEMO · SIMULATED SEARCH'; $('incident-title').textContent = fire ? `Person search · ${fire.name}` : 'Person search replay';
    $('incident-sub').textContent = fire ? `${fire.region} · ${fire.startDate.slice(0, 4)} ignition point` : 'UTSC · Highland Creek ravine';
    $('map-location').textContent = fire ? fire.name : 'UTSC · Highland Creek ravine';
    showDemoResults();
    startPeopleDemo();
    if (fire) state.map.setView([fire.lat, fire.lon], 16); else state.map.setView([state.site.latitude - .0012, state.site.longitude + .0018], 17);
    renderSpread(); return;
  }
  setBanner('demo', '<strong>Demo</strong> · recorded burns, not live data');
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
    const f = state.demo.selected = state.demo.fires.find(x => x.id === id);
    state.scenario = {wind: f.drivers.windKmh ?? M.BASE.wind, direction: f.directionDeg, dryness: f.drivers.rhPct != null ? 100 - f.drivers.rhPct : M.BASE.dryness, temp: f.drivers.tempC ?? M.BASE.temp, rh: f.drivers.rhPct ?? M.BASE.rh};
    state.detectedScenario = {...state.scenario};
    L.polygon(M.recordedPerimeter(f), {color: '#c2410c', weight: 1.2, fill: false, dashArray: '2 4'}).addTo(state.demo.layer).bindTooltip('Recorded final burn area (approx.)');
    // A fresh sighting: the fire pin, spread and Gemini follow as the simulated detection firms up.
    state.demo.scoutSessions ??= {};
    state.demo.scout = state.demo.scoutSessions[f.id] ??= BoscoScout.create(f);
    state.demo.started = performance.now() - state.demo.scout.elapsed * 1000; state.demo.lastTrail = null; state.demo.inView = false;
    state.demo.lastScout = -2000;
    state.demo.located = false; state.demo.autoAsked = false; state.demo.sight = null; state.demo.lastSpread = 0;
    const start = simPose(f, state.demo.scout.elapsed); state.demo.pos = [start.lat, start.lon];
    state.demo.trail = L.polyline([], {color: '#3A372E', weight: 2.5, opacity: .85}).addTo(state.demo.layer);
    state.demo.marker = droneMarker(state.demo.pos).addTo(state.demo.layer);
    const cam = camera(); if (cam) EmberCamera.setScene(cam, {kind: 'fire', lat: f.lat, lon: f.lon, windDeg: f.directionDeg, windKmh: f.drivers.windKmh});
    setDemoVideo(f);
    $('incident-eyebrow').textContent = 'INCIDENT · ANAFI-01'; $('incident-title').textContent = f.name; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
    $('incident-sub').textContent = `${f.region} · ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)} · ${f.drivers.fuel}`;
    setBanner('demo', `<strong>Possible fire · ${escapeHTML(f.name)}.</strong> ANAFI-01, patrolling at ${SIM.alt0} m, has spotted smoke about ${SIM.r0} m ahead and is confirming the detection.`);
    $('telemetry-tag').textContent = 'SIMULATED'; $('drone-source').textContent = 'Simulated scout'; $('telemetry-note').classList.remove('error-text'); $('flight-progress').hidden = true;
    if ($('map-subtitle')) $('map-subtitle').textContent = 'Simulated drone scouting inside the fire · fictional rescue leads';
    setBanner('demo', `<strong>Historical fire + simulated rescue scout.</strong> ${escapeHTML(f.name)} · the drone enters the rendered fire area and looks for fictional people. Map, camera and telemetry follow the same simulation.`);
    updateDemoScout(state.demo.scout.elapsed);
    $('map-location').textContent = `${f.name} · ${f.region}`;
    state.minute = 0; state.playing = false; setPlayButton();
    fitToFire();
  }
  showDemoResults();
  renderSpread();
}

/** Stop simulations and restore saved live evidence, plan, basemap and polling state. */
function exitDemo() {
  if (state.demo.scout) state.demo.scout.elapsed = demoT();
  state.demo.scout = null;
  stopPeopleDemo();
  state.mode = 'live'; state.demo.layer?.remove(); state.demo.layer = null; state.demo.marker = null; state.demo.pos = null; state.layers.demo.clearLayers(); state.layers.ask?.clearLayers(); $('ask-answer').hidden = true; state.map.closePopup();
  setDemoVideo(null); setBasemap(state.basemapBeforeDemo ?? 'osm'); setFollow(false);
  $('demo-toggle').innerHTML = 'Replay <svg><use href="#i-play"/></svg>'; $('demo-fire').hidden = true;
  $('map-pill').textContent = 'Live';
  $('map-location').textContent = state.site.name; state.detectedScenario = null; state.scenario = {...M.BASE}; state.minute = 0; state.episodeSeen = null; state.centredOnDrone = false;
  $('telemetry-tag').textContent = 'LIVE'; $('telemetry-note').textContent = 'No telemetry yet'; $('camera-clock').textContent = '—'; $('video-status').textContent = 'No video'; state.video.lastAt = 0;
  $('battery-value').innerHTML = '—<span class="small-unit">%</span>'; $('battery-context').textContent = 'no telemetry yet'; $('drone-source').textContent = 'Waiting for drone';
  Object.assign(state, state.live ?? {}); resetAnalysisPanel(); resetPlanPanel(); renderAnalysis(); if (state.plan) renderPlan();
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
/** Refresh valid live analysis while preventing a late response from replacing replay state. */
async function pollAnalysis() { if (state.mode === 'demo') return; const m = await getJson('/api/analysis/latest'); if (state.mode === 'demo') return; state.analysisMeta = m; if (typeof m.analysis?.summary === 'string') state.analysis = m.analysis; renderAnalysis(); }
/** Refresh connection/service health and current site without overwriting replay labels. */
async function pollStatus() {
  try { state.status = await getJson('/api/status'); state.connected = true; } catch (e) { state.connected = false; renderHeading(); throw e; }
  const s = state.status; state.site = s.site || state.site; if (state.mode !== 'demo') $('map-location').textContent = state.site.name;
  const videoFresh = s.video?.fresh ?? (s.video?.available && s.video.age_ms < 3000);
  const telemetryFresh = s.telemetry?.fresh ?? (s.telemetry?.available && s.telemetry.age_ms < STALE_MS);
  $('parrot-status').textContent = videoFresh ? `Live · ${Math.round(s.video.fps)} fps` : telemetryFresh ? 'Telemetry only' : 'Disconnected · waiting for drone';
  $('tiger-status').textContent = s.storage?.status === 'postgres' ? 'Connected' : s.storage?.status === 'postgres-unavailable' ? 'Unavailable' : 'Memory only';
  $('gemini-status').textContent = !s.gemini?.configured ? 'Not configured' : s.gemini.last_error && (!s.gemini.last_ok_at || s.gemini.last_error_at > s.gemini.last_ok_at) ? 'Cannot connect' : s.gemini.last_ok_at ? 'Connected' : `Ready · ${s.gemini.model}`;
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
  $('scenario-open').onclick = () => { pending = {...state.scenario}; scenarioControls(pending); $('scenario-intro').textContent = state.detectedScenario ? 'From the detected fire.' : ''; openDialog('scenario-dialog'); };
  for (const [id, key] of [['wind-input', 'wind'], ['direction-input', 'direction'], ['dry-input', 'dryness'], ['temp-input', 'temp'], ['rh-input', 'rh']]) $(id).oninput = () => { pending[key] = +$(id).value; scenarioControls(pending); };
  $('reset-scenario').onclick = () => { pending = {...(state.detectedScenario || M.BASE)}; scenarioControls(pending); };
  $('apply-scenario').onclick = () => { state.scenario = {...pending}; state.windManual = state.analysis?.created_at ?? 'manual'; state.windDerived = null; markPlanDirty(); renderSpread(); refreshFireTiming(); $('scenario-dialog').close(); };
  $('play').onclick = () => { state.playing = !state.playing; setPlayButton(); };
  $('speed').onclick = () => { state.speed = state.speed === 4 ? 1 : state.speed * 2; $('speed').textContent = state.speed + '×'; };
  $('timeline').oninput = () => { state.playing = false; setPlayButton(); state.minute = +$('timeline').value; renderSpread(); };
  for (const b of document.querySelectorAll('[data-minute]')) b.onclick = () => { state.playing = false; setPlayButton(); state.minute = +b.dataset.minute; renderSpread(); };
  $('layers-open').onclick = () => { $('layer-menu').hidden = !$('layer-menu').hidden; $('layers-open').setAttribute('aria-expanded', String(!$('layer-menu').hidden)); };
  for (const [box, layer] of [['layer-spread', 'spread'], ['layer-fire', 'fire'], ['layer-drone', 'drone'], ['layer-wind', 'wind']]) $(box).onchange = () => $(box).checked ? state.map.addLayer(state.layers[layer]) : state.map.removeLayer(state.layers[layer]);
  $('zoom-in').onclick = () => state.map.zoomIn(); $('zoom-out').onclick = () => state.map.zoomOut(); $('zoom-reset').onclick = () => { setFollow(false); fitToFire(); };
  $('zoom-drone').onclick = () => setFollow(!state.follow); $('layer-sat').onchange = () => setBasemap($('layer-sat').checked ? 'sat' : 'osm');
  $('dismiss-fire').onclick = async () => { const inc = state.incident; if (!inc) return; try { await api('/api/incident/dismiss', {method: 'POST', body: {episode_id: inc.episode_id}}); toast('Marked as a false alarm.'); await pollIncident(); } catch (e) { toast(e.message); } };
  $('analysis-summary').onclick = () => $('analysis-summary').classList.toggle('expanded');
  $('analyze').onclick = async () => {
    $('analyze').disabled = true; $('analysis-source').textContent = 'ANALYZING…';
    try {
      if (state.mode === 'demo') { const r = demoResults(), a = await demoGemini('analyze'); if (!a) return; r.analysis = a; if (demoResults() !== r) return; state.analysis = a; }
      else state.analysis = await getJson('/api/analyze', {method: 'POST', body: {}, timeout: 90000});
      state.analysisMeta = {...state.analysisMeta, error: null, pending: false}; toast('Gemini analysis updated.');
    }
    catch (e) { if (e.status === 409 || e.status === 429) toast(e.message); else state.analysisMeta = {...state.analysisMeta, configured: e.status !== 503, error: {message: e.message, at: new Date().toISOString()}}; }
    finally { $('analyze').disabled = false; renderAnalysis(); }
  };
  $('generate-plan').onclick = generatePlan;
  $('ask-send').onclick = askIncident;
  $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askIncident(); });
  if (DEMO_WIND_FLAG) $('demo-wind-row').hidden = false;
  $('demo-wind').onchange = (e) => setDemoWind(e.target.checked);
  $('objective').onchange = markPlanDirty; $('notes').oninput = markPlanDirty;
  $('demo-toggle').onclick = toggleDemo; $('demo-fire').onchange = () => selectDemo($('demo-fire').value);
  for (const id of ['open-integrations', 'top-integrations']) $(id).onclick = () => { openDialog('integrations-dialog'); pollStatus().catch(() => {}); renderHistory().catch(() => { $('history-source').textContent = 'unavailable'; }); };
  $('connect-api').onclick = async () => { const t = $('api-token').value.trim(); if (t) state.token = t; await connect(); };
  $('export-brief').onclick = exportBrief;
}

/** Export the current evidence, lead review, projection and plan with source labels. */
function exportBrief() {
  const inc = activeFire(), a = state.analysis, p = state.plan, proj = projection();
  const simulatedCase = demoCase() ? simCase(demoCase()) : null;
  const telemetry = simulatedCase?.drone.telemetry ?? (peopleDemoActive() ? peopleState.snap?.drone : state.telemetry);
  const lines = ['# BOSCO incident brief', '', `Generated: ${new Date().toISOString()}`, `Site: ${state.site.name} (${state.site.latitude}, ${state.site.longitude})`, `Mode: ${state.mode === 'demo' ? 'incident replay' : state.mode}`, '',
    '## People · rescue leads', peopleBrief(), '',
    '## Fire', simulatedCase ? `SIMULATED SCOUT: ${simulatedCase.name} at ${simulatedCase.latitude}, ${simulatedCase.longitude}; historical context with fictional people and flight.` : inc ? [`Detected ${inc.first_detected_at} by ANAFI-01 (${inc.latest.source}, ${inc.latest.label}, max confidence ${Math.round(inc.max_confidence * 100)}%), ${inc.sightings} sightings.`, `Position: ${inc.latest.fire.latitude}, ${inc.latest.fire.longitude} — ${inc.latest.fire.distance_m} m from the drone, bearing ${inc.latest.fire.bearing_deg}° (${inc.latest.fire.position_source}).`, `Details: ${JSON.stringify(inc.latest.details)}`].join('\n') : 'No active fire.', '',
    '## Projected spread', proj ? `At +${proj.minutes_ahead} min: ${proj.area_ha} ha, head ${proj.head_distance_m} m toward ${proj.toward} at ${proj.spread_rate_m_per_min} m/min.\nConditions: ${JSON.stringify(state.scenario)}` : '—', '',
    '## Drone telemetry', telemetry ? '```json\n' + JSON.stringify(telemetry, null, 2) + '\n```' : 'No telemetry.', '',
    '## Gemini analysis', a ? `${a.summary}\n\nSeverity: ${a.severity ?? '—'}\nSpread outlook: ${a.spread_outlook ?? '—'}\nUnknowns: ${(a.unknowns || []).join('; ') || '—'}\nLimitations: ${a.limitations ?? '—'}\n(${a.model}, ${a.created_at})` : 'None yet.', '',
    '## Operational plan', p ? `${p.title}\n\n${p.situation}\n\nAdvantage: ${p.advantage}\n\n${p.actions.map(x => `${x.priority}. ${x.action} — ${x.owner || ''} (${x.timing || ''})`).join('\n')}\n\n${p.approvedBy ? `Approved by ${p.approvedBy} at ${p.approvedAt}` : 'Not yet approved.'}${state.planDirty ? '\n(Conditions changed after this plan was generated.)' : ''}` : 'None yet.'];
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
  every(2000, 'people', pollPeople); every(2000, 'analysis', pollAnalysis); every(5000, 'status', pollStatus); setInterval(videoWatchdog, 1000);
  try { const {plan} = await getJson('/api/plan/latest'); if (plan) { state.plan = plan; renderPlan(); } } catch {}
  streamVideo();
}

let lastFrame = 0, lastSpread = 0;
/** Advance active spread/replay animations and schedule the next browser frame. */
function animate(now) {
  const delta = Math.min(now - (lastFrame || now), 100); lastFrame = now;
  if (state.playing) { state.minute = (state.minute + delta * .002 * state.speed) % 60; if (now - lastSpread > 66) { lastSpread = now; renderSpread(); } }
  animateDemoFlight(now); animateDemoCase(now);
  tickPeopleDemo(now);
  requestAnimationFrame(animate);
}

/** Initialize the dashboard, bootstrap local access and enter explicit replay only when requested. */
async function boot() {
  savePanelDefaults(); initMap(); bindUi(); drawWaiting('No video', ''); renderSpread(); renderMapChip();
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
