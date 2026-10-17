'use strict';
/* BOSCO dashboard (Bushfire Observation, Simulation and Coordination Operations). Opens live against the backend that serves it:
   video, telemetry, detections and flight events from the ANAFI bridge;
   Gemini analysis and plans from the backend; history from TigerData.
   Demo mode (historical fires from examples/ + flight-pattern replay) runs
   only when the Demo button is pressed. */
const $ = id => document.getElementById(id), M = EmberModel;
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  video: {lastAt: 0, decoding: false, times: []},
  demo: {fires: [], selected: null, started: 0},
  map: null, layers: {}, droneMarker: null, tilesOk: false, tileErrors: 0, centredOnDrone: false,
};
let toastTimer;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function download(name, content, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], {type})); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
function openDialog(id) { $(id).showModal(); }

async function api(path, {method = 'GET', body, timeout = 12000} = {}) {
  const response = await fetch(path, {method, headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), Authorization: 'Bearer ' + state.token}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
  if (!response.ok) { let message; try { message = (await response.json()).error; } catch {} const err = new Error(message || `Backend returned ${response.status}`); err.status = response.status; throw err; }
  return response;
}
const getJson = async (path, opts) => (await api(path, opts)).json();

// ------------------------------------------------------------- banner/heading

function setBanner(kind, html, showDismiss = false) {
  const b = $('status-banner'); b.className = 'simulation-banner status-banner ' + kind;
  $('banner-text').innerHTML = html; $('dismiss-fire').hidden = !showDismiss;
}
function setModePill(kind, text) { const p = $('mode-pill'); p.className = 'pill ' + kind; p.innerHTML = `<span class="dot"></span> ${escapeHTML(text)}`; }

function activeFire() {
  if (state.mode === 'demo') return null;
  const inc = state.incident;
  return inc && inc.active && inc.latest.fire.latitude != null ? inc : null;
}

function renderHeading() {
  if (state.mode === 'demo') return;
  const inc = activeFire(), t = state.telemetry;
  const telemetryAge = t ? Date.now() - Date.parse(t.observed_at) : Infinity;
  if (inc) {
    const d = inc.latest, det = d.details || {};
    $('incident-eyebrow').textContent = 'ACTIVE FIRE · ANAFI-01'; $('incident-dot').classList.add('alert');
    $('incident-title').textContent = det.name ? `${det.name} fire` : 'Fire detected'; $('incident-tag').hidden = false;
    $('incident-sub').textContent = `First sighted ${fmtTime(inc.first_detected_at)} · ${inc.sightings} sighting${inc.sightings === 1 ? '' : 's'} · ${d.fire.latitude.toFixed(5)}, ${d.fire.longitude.toFixed(5)} · ${state.site.name}`;
    const how = d.source === 'qr-test' ? 'test marker' : `fire model (${d.label})`;
    setBanner('alert', `<strong>Fire detected at ${escapeHTML(fmtTime(d.detected_at))}</strong> by ANAFI-01 · ${escapeHTML(how)}, ${Math.round(d.confidence * 100)}% · ${d.fire.distance_m ?? '—'} m from the drone, bearing ${d.fire.bearing_deg ?? '—'}°. Spread projection, Gemini analysis and planning are active.`, true);
    setModePill('alert-badge', 'Fire detected');
  } else {
    $('incident-eyebrow').textContent = 'LIVE MONITORING · ANAFI-01'; $('incident-dot').classList.remove('alert');
    $('incident-title').textContent = 'Monitoring for fire'; $('incident-tag').hidden = true;
    $('incident-sub').textContent = state.site.name;
    if (!state.connected) { setBanner('warn', '<strong>Backend unreachable.</strong> Start it with <code>npm start</code>, then reload.'); setModePill('demo', 'Offline'); }
    else if (telemetryAge > STALE_MS) { setBanner('info', '<strong>Waiting for the drone.</strong> Start <code>bridge/anafi_bridge.py --backend http://127.0.0.1:8787</code> on the drone\'s Wi-Fi.'); setModePill('demo', 'Waiting for drone'); }
    else { setBanner('info', '<strong>Live · monitoring.</strong> ANAFI-01 is streaming; the camera feed is checked for fire several times a second.'); setModePill('live-badge', 'Live · monitoring'); }
  }
}

// ------------------------------------------------------------------- map

function initMap() {
  const map = state.map = L.map('map', {zoomControl: false, attributionControl: false, maxZoom: 22}).setView([state.site.latitude, state.site.longitude], 17);
  const tiles = L.tileLayer('/tiles/osm/{z}/{x}/{y}.png', {maxNativeZoom: 19, maxZoom: 22});
  tiles.on('tileload', () => { state.tilesOk = true; $('map-viewport').classList.remove('tiles-offline'); renderMapChip(); });
  tiles.on('tileerror', () => { state.tileErrors++; if (!state.tilesOk && state.tileErrors >= 4) { $('map-viewport').classList.add('tiles-offline'); renderMapChip(); } });
  tiles.addTo(map);
  for (const name of ['spread', 'wind', 'fire', 'drone', 'demo']) state.layers[name] = L.layerGroup().addTo(map);
  state.layers.trail = L.layerGroup().addTo(state.layers.drone); // drone trail, coloured by what it was doing about the fire
  state.droneMarker = L.marker([state.site.latitude, state.site.longitude], {icon: L.divIcon({className: 'drone-icon-wrap', html: '<div class="drone-icon"><span>▲</span></div>', iconSize: [30, 30], iconAnchor: [15, 15]}), keyboard: false, opacity: 0}).addTo(state.layers.drone).bindTooltip('ANAFI-01');
  L.control.scale({imperial: false, position: 'bottomright'}).addTo(map);
  peopleInitMap();
  window.addEventListener('resize', () => map.invalidateSize());
}

function renderMapChip() {
  let title = '', text = '';
  if ($('map-viewport').classList.contains('tiles-offline')) { title = 'Map tiles offline.'; text = 'Showing a grid. Areas viewed once while online stay cached.'; }
  else if (state.mode === 'live' && !state.telemetry) { title = 'No drone position yet.'; text = 'The map follows ANAFI-01 once telemetry arrives.'; }
  $('map-empty').hidden = !title; $('map-empty-title').textContent = title; $('map-empty-text').textContent = text;
}

function renderDrone() {
  const t = state.telemetry;
  if (!t || t.latitude == null || state.mode === 'demo') { state.droneMarker.setOpacity(0); return; }
  const ll = [t.latitude, t.longitude];
  state.droneMarker.setLatLng(ll).setOpacity(1);
  const el = state.droneMarker.getElement()?.querySelector('.drone-icon');
  if (el) el.style.transform = `rotate(${t.extra?.heading_deg ?? 0}deg)`;
  drawTrail(state.layers.trail, liveTrail(state.flight.path));
  if (!state.centredOnDrone) { state.centredOnDrone = true; if (!activeFire()) state.map.setView(ll, 19); }
}

/* Detection details driving the spread model: the live detection, or the simulated search's fire. */
function fireDetails() {
  if (state.mode === 'demo') return state.demo.selected?.id === 'people' ? state.demo.selected.details ?? null : null;
  return activeFire()?.latest.details ?? null;
}
const modelledFire = () => state.mode === 'live' ? !!activeFire() : !!(state.demo.selected?.id === 'people' && state.demo.selected.details);

function origin() {
  if (state.mode === 'demo') { const f = state.demo.selected; return f && f !== 'flight' && f.lat != null ? [f.lat, f.lon] : null; }
  const inc = activeFire(); return inc ? [inc.latest.fire.latitude, inc.latest.fire.longitude] : null;
}

/* Projected spread at the selected minute, drawn as layered intensity bands. */
function renderSpread() {
  const sc = state.scenario, t = state.minute;
  $('time-label').textContent = `T + ${Math.round(t)} min`; $('timeline').value = t;
  document.querySelectorAll('[data-minute]').forEach(b => b.classList.toggle('selected', Math.abs(+b.dataset.minute - t) < .5));
  $('wind-value').textContent = Math.round(sc.wind); $('wind-context').textContent = `toward ${M.compass(sc.direction)} ${['↑','↗','→','↘','↓','↙','←','↖'][Math.round(sc.direction/45)%8]}`;
  state.layers.spread.clearLayers(); state.layers.wind.clearLayers();
  const o = origin();
  if (!o) { $('area-value').textContent = '—'; $('area-context').textContent = state.mode === 'demo' ? 'select a fire' : 'no fire detected'; return; }
  let outline, ring = scale => [];
  if (state.mode === 'demo' && !modelledFire()) {
    // Demo: replay the recorded burn growing from its ignition point over the timeline.
    const f = state.demo.selected, k = Math.sqrt(.03 + .97 * t / 60), rec = M.recordedPerimeter(f);
    ring = scale => rec.map(p => [o[0] + (p[0] - o[0]) * k * scale, o[1] + (p[1] - o[1]) * k * scale]);
    outline = ring(1);
  } else {
    const details = fireDetails();
    ring = scale => M.footprint(o, t, sc, details, scale);
    outline = ring(1);
    L.polygon(M.footprint(o, 0, sc, details), {color: '#9e3026', weight: 1.4, dashArray: '4 4', fill: false}).addTo(state.layers.spread).bindTooltip('Fire now');
  }
  for (const [scale, color, opacity] of SPREAD_BANDS) L.polygon(ring(scale), {stroke: scale === 1, color: '#ec9d33', weight: 1.2, dashArray: '5 4', fillColor: color, fillOpacity: opacity}).addTo(state.layers.spread);
  const area = M.areaHa(outline);
  $('area-value').textContent = area >= 100 ? Math.round(area).toLocaleString() : area.toFixed(area < 1 ? 3 : 1);
  $('area-context').textContent = t < .5 ? 'now' : `projected at +${Math.round(t)} min`;
  const reach = !modelledFire() ? Math.sqrt(area * 10000 / Math.PI) * 1.3 : M.headDistance(t, sc, fireDetails());
  L.polyline([M.destPoint(o[0], o[1], sc.direction + 180, reach * .25), M.destPoint(o[0], o[1], sc.direction, reach)], {color: '#4E6A70', weight: 1.6, dashArray: '2 6'}).addTo(state.layers.wind).bindTooltip(`Wind ${Math.round(sc.wind)} km/h toward ${M.compass(sc.direction)}`);
}

function renderFirePin() {
  state.layers.fire.clearLayers();
  const inc = activeFire(); if (!inc) return;
  const d = inc.latest, det = d.details || {};
  L.marker([d.fire.latitude, d.fire.longitude], {icon: L.divIcon({className: 'fire-pin-wrap', html: '<div class="fire-pin">🔥</div>', iconSize: [34, 34], iconAnchor: [17, 17]})})
    .addTo(state.layers.fire)
    .bindPopup(`<b>${escapeHTML(det.name || 'Detected fire')}</b><br>${escapeHTML(d.label)} · ${Math.round(d.confidence * 100)}% · ${escapeHTML(d.source)}<br>${d.fire.latitude.toFixed(6)}, ${d.fire.longitude.toFixed(6)}<br>${d.fire.distance_m} m from drone · bearing ${d.fire.bearing_deg}°${det.area_ha != null ? `<br>Reported area ${det.area_ha} ha` : ''}${det.fuel ? `<br>Fuel: ${escapeHTML(det.fuel)}` : ''}`);
  if (d.drone?.latitude != null) L.polyline([[d.drone.latitude, d.drone.longitude], [d.fire.latitude, d.fire.longitude]], {color: '#E8562A', weight: 1.5, dashArray: '3 4'}).addTo(state.layers.fire);
}

function fitToFire() {
  if (peopleDemoActive() && fitPeople()) return;
  const o = origin(); if (!o) { const t = state.telemetry; if (t?.latitude != null) state.map.setView([t.latitude, t.longitude], 19); else state.map.setView([state.site.latitude, state.site.longitude], 17); return; }
  state.map.invalidateSize();
  const pts = !modelledFire() ? M.recordedPerimeter(state.demo.selected) : M.footprint(o, 30, state.scenario, fireDetails());
  state.map.fitBounds(L.latLngBounds(pts).pad(.15), {maxZoom: 20});
}

// ------------------------------------------------------------- telemetry

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

function renderFlight() {
  if (state.mode === 'demo') return;
  const e = state.flight.events.at(-1);
  const recent = e && Date.now() - Date.parse(e.at) < (e.phase === 'landed' || e.phase === 'aborted' || e.phase === 'error' ? 10_000 : 120_000);
  $('flight-progress').hidden = !recent; if (!recent) return;
  const frac = {preflight: 0, takeoff: .1, climb: .2, circle: .2 + .6 * ((e.step || 0) / (e.steps || 8)), return: .85, landing: .93, landed: 1, aborted: 1, error: 1}[e.phase] ?? 0;
  $('flight-phase').textContent = `Demo flight · ${e.phase}${e.step ? ` ${e.step}/${e.steps}` : ''}${e.message ? ' · ' + e.message : ''}`;
  $('flight-bar').style.width = Math.round(frac * 100) + '%';
  $('flight-progress').classList.toggle('error', e.phase === 'error' || e.phase === 'aborted');
}

// ---------------------------------------------------------------- video

const CRLF2 = [13, 10, 13, 10];
function concat(a, b) { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
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

function drawWaiting(title, sub) {
  const canvas = $('camera'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#2A2822'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#F3EFE6'; ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(w / 22)}px 'Instrument Sans', system-ui, sans-serif`; ctx.fillText(title, w / 2, h * .24);
  ctx.font = `${Math.round(w / 34)}px 'Instrument Sans', system-ui, sans-serif`; ctx.fillStyle = '#B9B3A6'; ctx.fillText(sub, w / 2, h * .24 + w / 18); ctx.textAlign = 'start';
}

function videoWatchdog() {
  if (state.mode === 'demo' || Date.now() - state.video.lastAt < 3000) return;
  drawWaiting(state.video.lastAt ? 'Video paused — reconnecting' : 'Waiting for live video', 'The bridge relays the ANAFI camera through the backend');
  $('camera-label').innerHTML = '<i></i> NO VIDEO'; $('video-fps').textContent = '—';
  $('video-status').textContent = state.video.lastAt ? `Last frame ${Math.round((Date.now() - state.video.lastAt) / 1000)} s ago` : 'Waiting for the bridge';
}

// -------------------------------------------------------------- incident

function renderIncident() {
  if (state.mode === 'demo') return;
  const inc = activeFire();
  if (inc && inc.episode_id !== state.episodeSeen) {
    state.episodeSeen = inc.episode_id;
    state.detectedScenario = M.scenarioFrom(inc.latest.details);
    state.scenario = {...state.detectedScenario}; state.minute = 0;
    markPlanDirty(); renderFirePin(); renderSpread(); fitToFire();
    toast(`Fire detected — ${inc.latest.details?.name || inc.latest.label}. Gemini is analyzing it.`);
  } else renderFirePin();
  if (!inc && state.episodeSeen) { state.episodeSeen = null; renderSpread(); }
  if (inc) {
    $('detect-value').textContent = Math.round(inc.max_confidence * 100); $('detect-unit').textContent = '%';
    $('detect-context').textContent = `${inc.latest.source === 'qr-test' ? 'test marker' : 'fire model · ' + inc.latest.label} · ${inc.sightings} sightings`;
  } else { $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'watching the camera feed'; }
  renderHeading();
}

// -------------------------------------------------------------- analysis

function renderAnalysis() {
  const meta = state.analysisMeta, a = state.analysis;
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
  $('analysis-observations').innerHTML = (a.observations || []).slice(0, 4).map(o => `<li>${escapeHTML(o)}</li>`).join('');
  $('analysis-limit').textContent = [(a.unknowns || [])[0], a.limitations].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ plan

function projection() {
  const o = origin(); if (!o || state.mode === 'demo') return null;
  const details = activeFire().latest.details;
  return {minutes_ahead: Math.round(state.minute), area_ha: +M.areaHa(M.footprint(o, state.minute, state.scenario, details)).toFixed(3), head_distance_m: Math.round(M.headDistance(state.minute, state.scenario, details)), spread_rate_m_per_min: +M.spreadRate(state.scenario, details).toFixed(1), toward_deg: state.scenario.direction, toward: M.compass(state.scenario.direction), origin: {latitude: o[0], longitude: o[1]}};
}
function markPlanDirty() { if (state.plan && !state.planDirty) { state.planDirty = true; renderPlan(); } }

function renderPlan(offline) {
  const p = state.plan;
  const offlineHtml = offline ? `<div class="gemini-offline"><strong>Cannot connect to Gemini</strong><p>${escapeHTML(offline)}</p></div>` : '';
  if (!p) { if (offline) $('draft-area').innerHTML = `<div class="review-draft">${offlineHtml}</div>`; return; }
  const list = (title, items) => items?.length ? `<h4>${title}</h4><ul>${items.map(i => `<li>${escapeHTML(i)}</li>`).join('')}</ul>` : '';
  const approved = p.approvedBy && !state.planDirty;
  // The drone cannot certify ground as safe: point out any wording that claims it.
  const wording = p.wording_flags?.length ? `<div class="gemini-offline"><strong>Check the wording before approving</strong><p>This plan describes ground as safe or cleared (${p.wording_flags.map(w => `“${escapeHTML(w)}”`).join(', ')}). BOSCO cannot verify that. Restate it as observed hazards and when they were seen.</p></div>` : '';
  $('draft-area').innerHTML = `<div class="review-draft">${offlineHtml}${wording}<div class="draft-heading"><h3>${escapeHTML(p.title)}</h3><span class="pill ${approved ? 'live-badge' : 'soft-orange'}">${approved ? 'Approved' : 'Draft'}</span></div><p class="draft-meta">GEMINI · ${escapeHTML(p.objective)} · ${escapeHTML(new Date(p.created_at).toLocaleTimeString())}${p.projection ? ` · spread at +${p.projection.minutes_ahead} min` : ''}</p>${state.planDirty ? '<div class="notice plan-dirty">Conditions changed since this plan. Regenerate to use the latest picture.</div>' : ''}<div class="advantage"><strong>Operational advantage</strong><p>${escapeHTML(p.advantage)}</p></div><h4>Situation</h4><p class="plan-text">${escapeHTML(p.situation)}</p>${list('Objectives', p.objectives)}<h4>Actions</h4><table class="plan-actions"><thead><tr><th>#</th><th>Action</th><th>Owner</th><th>Timing</th></tr></thead><tbody>${p.actions.map(a => `<tr><td>${a.priority}</td><td>${escapeHTML(a.action)}${a.rationale ? `<small>${escapeHTML(a.rationale)}</small>` : ''}</td><td>${escapeHTML(a.owner || '—')}</td><td>${escapeHTML(a.timing || '—')}</td></tr>`).join('')}</tbody></table>${list('Resources & staging', p.resources)}${list('Re-planning triggers', p.triggers)}${list('Risks', p.risks)}${p.next_update ? `<h4>Next update</h4><p class="plan-text">${escapeHTML(p.next_update)}</p>` : ''}<div class="reviewer-row"><input id="reviewer-name" aria-label="Approver name" maxlength="80" placeholder="Incident commander" value="${escapeHTML(p.approvedBy || '')}" ${approved ? 'disabled' : ''}><button class="button primary" id="approve-plan" ${approved || state.planDirty ? 'disabled' : ''}>Approve plan</button></div>${approved ? `<p class="microcopy">Approved by ${escapeHTML(p.approvedBy)} at ${escapeHTML(new Date(p.approvedAt).toLocaleString())}.</p>` : ''}<div class="draft-buttons"><span class="microcopy">Stored in TigerData with the detection it was built on.</span><button class="button" id="export-plan">Export plan ↓</button></div></div>`;
  $('approve-plan').onclick = () => { const name = $('reviewer-name').value.trim(); if (!name) { toast('Enter the approving incident commander.'); return; } p.approvedBy = name; p.approvedAt = new Date().toISOString(); renderPlan(); toast('Plan approved.'); };
  $('export-plan').onclick = () => download(`bosco-plan-${p.id.slice(0, 8)}.json`, JSON.stringify(p, null, 2), 'application/json');
}

async function generatePlan() {
  $('generate-plan').disabled = true; $('generate-plan').innerHTML = '<svg><use href="#i-spark"/></svg>Gemini is planning…';
  try {
    state.plan = await getJson('/api/plan', {method: 'POST', body: {objective: $('objective').value, notes: $('notes').value, scenario: state.scenario, projection: projection()}, timeout: 100000});
    state.planDirty = false; renderPlan(); toast('Operational plan ready.');
  } catch (e) {
    if (e.status === 429) toast(e.message);
    else renderPlan(e.status === 503 ? 'GEMINI_API_KEY is not set on the backend.' : e.message);
  } finally { $('generate-plan').disabled = false; $('generate-plan').innerHTML = '<svg><use href="#i-spark"/></svg>Generate operational plan'; }
}

// ------------------------------------------------------------------ demo

const DEMO_FLIGHT_S = 26;
async function toggleDemo() {
  if (state.mode === 'demo') { exitDemo(); return; }
  try { state.demo.fires = (await getJson('/api/demo/fires')).fires; } catch (e) { toast('Demo data unavailable: ' + e.message); return; }
  state.mode = 'demo'; state.playing = false; setPlayButton();
  $('demo-toggle').innerHTML = 'Exit demo <svg><use href="#i-close"/></svg>';
  setModePill('demo', 'Demo'); setBanner('demo', '<strong>Demo mode.</strong> Recorded historical fires from <code>examples/</code> and a replay of the ANAFI demo flight pattern. Live data resumes when you exit.');
  $('map-pill').textContent = 'Demo'; $('map-subtitle').textContent = 'Recorded fires replayed from ignition, plus the drone flight pattern';
  $('incident-eyebrow').textContent = 'DEMO · HISTORICAL CASES'; $('incident-title').textContent = 'Demo replay'; $('incident-tag').hidden = true; $('incident-dot').classList.remove('alert');
  $('detect-value').textContent = '—'; $('detect-unit').textContent = ''; $('detect-context').textContent = 'demo — live detection paused';
  const sel = $('demo-fire'); sel.hidden = false;
  sel.innerHTML = '<option value="people">Person search · simulated multi-view</option><option value="flight">ANAFI demo flight pattern · UTSC</option>' + state.demo.fires.map(f => `<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${escapeHTML(f.startDate.slice(0, 4))}</option>`).join('');
  state.layers.fire.clearLayers(); state.droneMarker.setOpacity(0); state.layers.trail.clearLayers();
  for (const f of state.demo.fires) L.circleMarker([f.lat, f.lon], {radius: 6, color: '#d9480f', weight: 2, fillColor: '#d9480f', fillOpacity: .85}).addTo(state.layers.demo).bindTooltip(f.name).on('click', () => { sel.value = f.id; selectDemo(f.id); });
  selectDemo('people'); sel.value = 'people';
}

function selectDemo(id) {
  state.demo.layer?.remove();
  state.demo.layer = L.layerGroup().addTo(state.map);
  stopPeopleDemo();
  if (id === 'people') {
    // Simulated search: a fire whose position arrives with the first snapshot; spread grows from it.
    state.demo.selected = {id: 'people', lat: null, lon: null, areaHa: 3, directionDeg: 225};
    state.scenario = {...M.BASE, wind: 24, direction: 225}; state.minute = 20;
    setBanner('demo', '<strong>Demo mode · simulated person search.</strong> A seeded simulation runs through the real lead pipeline: survey, multi-angle revisits, a hot rock that never confirms, and a radio outage with delayed alerts. Nothing here is live.');
    $('incident-eyebrow').textContent = 'DEMO · SIMULATED SEARCH'; $('incident-title').textContent = 'Person search replay';
    $('incident-sub').textContent = 'Simulated wildfire person search · 70 m survey, multi-view revisits, a radio outage · seeded, the same every run';
    $('map-subtitle').textContent = 'Simulated search: rescue leads, observed ground, next looks and the fire';
    startPeopleDemo();
    state.map.setView([state.site.latitude - .0012, state.site.longitude + .0018], 17);
    setTimeout(() => { if (peopleDemoActive()) fitToFire(); }, 1500);
    renderSpread(); return;
  }
  setBanner('demo', '<strong>Demo mode.</strong> Recorded historical fires from <code>examples/</code> and a replay of the ANAFI demo flight pattern. Live data resumes when you exit.');
  $('incident-eyebrow').textContent = 'DEMO · HISTORICAL CASES'; $('incident-title').textContent = 'Demo replay';
  $('map-subtitle').textContent = 'Recorded fires replayed from ignition, plus the drone flight pattern';
  if (id === 'flight') {
    state.demo.selected = 'flight'; state.demo.started = performance.now();
    const s = [state.site.latitude, state.site.longitude], side = 2 * Math.sin(Math.PI / 8);
    // Same 8-segment polygon the bridge flies: start heading north, turn 45° after each 1 m-radius side.
    const pts = [s]; let p = s;
    for (let i = 0; i < 8; i++) { p = M.destPoint(p[0], p[1], i * 45, side); pts.push(p); }
    state.demo.flightPts = pts;
    L.polyline(pts, {color: '#2F8F8A', weight: 2, dashArray: '4 5'}).addTo(state.demo.layer);
    state.demo.marker = L.marker(s, {icon: L.divIcon({className: 'drone-icon-wrap', html: '<div class="drone-icon"><span>▲</span></div>', iconSize: [30, 30], iconAnchor: [15, 15]})}).addTo(state.demo.layer);
    state.map.setView(M.destPoint(s[0], s[1], 112.5, 1.2), 21);
    state.scenario = {...M.BASE}; $('incident-sub').textContent = `Take off · climb 1 m · 1 m-radius circle · return · land — ${state.site.name}`;
    $('flight-progress').hidden = false;
  } else {
    const f = state.demo.selected = state.demo.fires.find(x => x.id === id);
    state.scenario = {wind: f.drivers.windKmh ?? M.BASE.wind, direction: f.directionDeg, dryness: f.drivers.rhPct != null ? 100 - f.drivers.rhPct : M.BASE.dryness, temp: f.drivers.tempC ?? M.BASE.temp, rh: f.drivers.rhPct ?? M.BASE.rh};
    L.polygon(M.recordedPerimeter(f), {color: '#c2410c', weight: 1.2, fill: false, dashArray: '2 4'}).addTo(state.demo.layer).bindTooltip('Recorded final burn area (approx.)');
    const i = f.impacts, n = v => v == null ? '—' : '≈' + v.toLocaleString();
    L.popup({closeButton: false, autoPan: false}).setLatLng([f.lat, f.lon]).setContent(`<b>${escapeHTML(f.name)}</b><br>${escapeHTML(f.region)} · ${escapeHTML(f.startDate)}<br>≈${f.areaHa.toLocaleString()} ha · structures ${n(i.structures)} · evacuated ${n(i.evacuated)}<br><small>${escapeHTML(f.notes)}</small>`).openOn(state.map);
    $('incident-sub').textContent = `${f.name} · ${f.region} · ${f.startDate} · ${f.cause}`;
    $('flight-progress').hidden = true; state.minute = 60;
    fitToFire();
  }
  renderSpread();
}

function exitDemo() {
  stopPeopleDemo();
  state.mode = 'live'; state.demo.layer?.remove(); state.demo.layer = null; state.layers.demo.clearLayers(); state.map.closePopup();
  $('demo-toggle').innerHTML = 'Demo <svg><use href="#i-play"/></svg>'; $('demo-fire').hidden = true;
  $('map-pill').textContent = 'Live'; $('map-subtitle').textContent = 'Drone position, detected fire and projected spread';
  state.scenario = state.detectedScenario ? {...state.detectedScenario} : {...M.BASE}; state.minute = 0; state.episodeSeen = null; state.centredOnDrone = false;
  renderIncident(); renderDrone(); renderSpread(); renderTelemetry(); renderFlight(); fitToFire();
  pollPeople().catch(() => {});
}

function animateDemoFlight(now) {
  if (state.mode !== 'demo' || state.demo.selected !== 'flight') return;
  const pts = state.demo.flightPts, t = ((now - state.demo.started) / 1000) % DEMO_FLIGHT_S;
  // 0-3 s take-off, 3-5 s climb, 5-21 s circle, 21-23 s return, 23-26 s landing
  let phase, pos = pts[0], alt = 0, heading = 0;
  if (t < 3) { phase = 'take-off'; alt = t / 3; }
  else if (t < 5) { phase = 'climb +1 m'; alt = 1 + (t - 3) / 2; }
  else if (t < 21) { const k = (t - 5) / 16 * 8, i = Math.min(7, Math.floor(k)), f = k - i; phase = `circle ${i + 1}/8`; alt = 2; heading = i * 45; pos = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; }
  else if (t < 23) { phase = 'return'; alt = 2; heading = 360; }
  else { phase = 'landing'; alt = 2 * (1 - (t - 23) / 3); }
  state.demo.marker.setLatLng(pos);
  const el = state.demo.marker.getElement()?.querySelector('.drone-icon'); if (el) el.style.transform = `rotate(${heading}deg)`;
  $('flight-phase').textContent = `Demo replay · ${phase}`; $('flight-bar').style.width = Math.round(t / DEMO_FLIGHT_S * 100) + '%';
  $('altitude').innerHTML = `${alt.toFixed(1)} <small>m</small>`; $('flight-state').textContent = phase.split(' ')[0];
  drawWaiting('Demo replay — flight pattern', `${phase} · altitude ${alt.toFixed(1)} m`);
  $('camera-label').innerHTML = '<i></i> DEMO REPLAY';
}

// --------------------------------------------------------------- polling

const busy = {};
function every(ms, name, fn) { const run = async () => { if (busy[name]) return; busy[name] = true; try { await fn(); } catch {} finally { busy[name] = false; } }; run(); setInterval(run, ms); }

async function pollTelemetry() {
  const data = await getJson('/api/telemetry/latest');
  state.telemetry = data.sample && data.sample.provenance === 'live' ? data.sample : null;
  state.connected = true; renderTelemetry(); renderDrone(); renderMapChip();
}
async function pollIncident() { state.incident = (await getJson('/api/incident')).incident; renderIncident(); }
async function pollFlight() { state.flight = await getJson('/api/flight'); renderFlight(); renderDrone(); }
// A stored row without a summary (e.g. a database round-trip check) is not an analysis: ignore it.
async function pollAnalysis() { const m = await getJson('/api/analysis/latest'); state.analysisMeta = m; if (typeof m.analysis?.summary === 'string') state.analysis = m.analysis; renderAnalysis(); }
async function pollStatus() {
  try { state.status = await getJson('/api/status'); state.connected = true; } catch (e) { state.connected = false; renderHeading(); throw e; }
  const s = state.status; state.site = s.site || state.site; $('map-location').textContent = state.site.name;
  $('parrot-status').textContent = s.video?.available && s.video.age_ms < 3000 ? `Live · ${Math.round(s.video.fps)} fps` : s.telemetry?.available ? 'Telemetry only' : 'Waiting';
  $('tiger-status').textContent = s.storage?.status === 'postgres' ? 'Connected' : s.storage?.status === 'postgres-unavailable' ? 'Unavailable' : 'Memory only';
  $('gemini-status').textContent = !s.gemini?.configured ? 'Not configured' : s.gemini.last_error && (!s.gemini.last_ok_at || s.gemini.last_error_at > s.gemini.last_ok_at) ? 'Cannot connect' : s.gemini.last_ok_at ? 'Connected' : `Ready · ${s.gemini.model}`;
  renderHeading();
}

async function renderHistory() {
  const data = await getJson('/api/telemetry/summary?minutes=60');
  const pts = data.buckets.filter(b => b.avg_altitude_m != null);
  $('history-source').textContent = `${data.source} · ${data.buckets.length} min`;
  // The chart stretches to the dialog width, so labels live in HTML, not in the SVG.
  if (!pts.length) { $('history-svg').innerHTML = '<line x1="0" y1="66" x2="300" y2="66" stroke="#CFC8B8" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>'; $('history-source').textContent += ' · no flight data in the last hour'; return; }
  const max = Math.max(1, ...pts.map(p => p.max_altitude_m ?? p.avg_altitude_m));
  const xy = pts.map((p, i) => `${pts.length === 1 ? 150 : i / (pts.length - 1) * 300},${66 - p.avg_altitude_m / max * 60}`);
  $('history-svg').innerHTML = `<polyline points="${xy.join(' ')}" fill="none" stroke="#2F8F8A" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  $('history-source').textContent += ` · peak ${max.toFixed(1)} m`;
}

// --------------------------------------------------------------- controls

function setPlayButton() { $('play').innerHTML = `<svg aria-hidden="true"><use href="#${state.playing ? 'i-pause' : 'i-play'}"/></svg>`; $('play').setAttribute('aria-label', state.playing ? 'Pause spread projection' : 'Play spread projection'); }
function scenarioControls(sc) {
  for (const [id, key, out] of [['wind-input', 'wind', 'wind-output'], ['dry-input', 'dryness', 'dry-output'], ['temp-input', 'temp', 'temp-output'], ['rh-input', 'rh', 'rh-output']]) { $(id).value = sc[key]; $(out).textContent = Math.round(sc[key]); }
  $('direction-input').value = sc.direction; $('direction-output').textContent = `${Math.round(sc.direction)}° · ${M.compass(sc.direction)}`;
}
let pending = {...M.BASE};

function bindUi() {
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => { const r = d.getBoundingClientRect(); if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close(); });
  $('scenario-open').onclick = () => { pending = {...state.scenario}; scenarioControls(pending); $('scenario-intro').textContent = state.detectedScenario ? 'Started from the conditions reported with the detected fire. Adjust them to see how the spread changes.' : 'These conditions drive the projected spread on the map.'; openDialog('scenario-dialog'); };
  for (const [id, key] of [['wind-input', 'wind'], ['direction-input', 'direction'], ['dry-input', 'dryness'], ['temp-input', 'temp'], ['rh-input', 'rh']]) $(id).oninput = () => { pending[key] = +$(id).value; scenarioControls(pending); };
  $('reset-scenario').onclick = () => { pending = {...(state.detectedScenario || M.BASE)}; scenarioControls(pending); };
  $('apply-scenario').onclick = () => { state.scenario = {...pending}; markPlanDirty(); renderSpread(); refreshFireTiming(); $('scenario-dialog').close(); };
  $('play').onclick = () => { state.playing = !state.playing; setPlayButton(); };
  $('speed').onclick = () => { state.speed = state.speed === 4 ? 1 : state.speed * 2; $('speed').textContent = state.speed + '×'; };
  $('timeline').oninput = () => { state.playing = false; setPlayButton(); state.minute = +$('timeline').value; renderSpread(); };
  for (const b of document.querySelectorAll('[data-minute]')) b.onclick = () => { state.playing = false; setPlayButton(); state.minute = +b.dataset.minute; renderSpread(); };
  $('layers-open').onclick = () => { $('layer-menu').hidden = !$('layer-menu').hidden; $('layers-open').setAttribute('aria-expanded', String(!$('layer-menu').hidden)); };
  for (const [box, layer] of [['layer-spread', 'spread'], ['layer-fire', 'fire'], ['layer-drone', 'drone'], ['layer-wind', 'wind']]) $(box).onchange = () => $(box).checked ? state.map.addLayer(state.layers[layer]) : state.map.removeLayer(state.layers[layer]);
  $('zoom-in').onclick = () => state.map.zoomIn(); $('zoom-out').onclick = () => state.map.zoomOut(); $('zoom-reset').onclick = fitToFire;
  $('dismiss-fire').onclick = async () => { const inc = state.incident; if (!inc) return; try { await api('/api/incident/dismiss', {method: 'POST', body: {episode_id: inc.episode_id}}); toast('Marked as a false alarm.'); await pollIncident(); } catch (e) { toast(e.message); } };
  $('analyze').onclick = async () => {
    $('analyze').disabled = true; $('analysis-source').textContent = 'ANALYZING…';
    try { state.analysis = await getJson('/api/analyze', {method: 'POST', body: {}, timeout: 90000}); state.analysisMeta = {...state.analysisMeta, error: null, pending: false}; toast('Gemini analysis updated.'); }
    catch (e) { if (e.status === 409 || e.status === 429) toast(e.message); else state.analysisMeta = {...state.analysisMeta, configured: e.status !== 503, error: {message: e.message, at: new Date().toISOString()}}; }
    finally { $('analyze').disabled = false; renderAnalysis(); }
  };
  $('generate-plan').onclick = generatePlan;
  $('objective').onchange = markPlanDirty; $('notes').oninput = markPlanDirty;
  $('demo-toggle').onclick = toggleDemo; $('demo-fire').onchange = () => selectDemo($('demo-fire').value);
  for (const id of ['open-integrations', 'top-integrations']) $(id).onclick = () => { openDialog('integrations-dialog'); pollStatus().catch(() => {}); renderHistory().catch(() => { $('history-source').textContent = 'unavailable'; }); };
  $('connect-api').onclick = async () => { const t = $('api-token').value.trim(); if (t) state.token = t; await connect(); };
  $('export-brief').onclick = exportBrief;
}

function exportBrief() {
  const inc = activeFire(), a = state.analysis, p = state.plan, proj = projection();
  const lines = ['# BOSCO incident brief', '', `Generated: ${new Date().toISOString()}`, `Site: ${state.site.name} (${state.site.latitude}, ${state.site.longitude})`, `Mode: ${state.mode}`, '',
    '## People · rescue leads', peopleBrief(), '',
    '## Fire', inc ? [`Detected ${inc.first_detected_at} by ANAFI-01 (${inc.latest.source}, ${inc.latest.label}, max confidence ${Math.round(inc.max_confidence * 100)}%), ${inc.sightings} sightings.`, `Position: ${inc.latest.fire.latitude}, ${inc.latest.fire.longitude} — ${inc.latest.fire.distance_m} m from the drone, bearing ${inc.latest.fire.bearing_deg}° (${inc.latest.fire.position_source}).`, `Details: ${JSON.stringify(inc.latest.details)}`].join('\n') : 'No active fire.', '',
    '## Projected spread', proj ? `At +${proj.minutes_ahead} min: ${proj.area_ha} ha, head ${proj.head_distance_m} m toward ${proj.toward} at ${proj.spread_rate_m_per_min} m/min.\nConditions: ${JSON.stringify(state.scenario)}` : '—', '',
    '## Drone telemetry', state.telemetry ? '```json\n' + JSON.stringify(state.telemetry, null, 2) + '\n```' : 'No telemetry.', '',
    '## Gemini analysis', a ? `${a.summary}\n\nSeverity: ${a.severity ?? '—'}\nSpread outlook: ${a.spread_outlook ?? '—'}\nUnknowns: ${(a.unknowns || []).join('; ') || '—'}\nLimitations: ${a.limitations ?? '—'}\n(${a.model}, ${a.created_at})` : 'None yet.', '',
    '## Operational plan', p ? `${p.title}\n\n${p.situation}\n\nAdvantage: ${p.advantage}\n\n${p.actions.map(x => `${x.priority}. ${x.action} — ${x.owner || ''} (${x.timing || ''})`).join('\n')}\n\n${p.approvedBy ? `Approved by ${p.approvedBy} at ${p.approvedAt}` : 'Not yet approved.'}${state.planDirty ? '\n(Conditions changed after this plan was generated.)' : ''}` : 'None yet.'];
  download('bosco-incident-brief.md', lines.join('\n'), 'text/markdown'); toast('Incident brief exported.');
}

// ------------------------------------------------------------------ boot

let started = false;
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
function animate(now) {
  const delta = Math.min(now - (lastFrame || now), 100); lastFrame = now;
  if (state.playing) { state.minute = (state.minute + delta * .002 * state.speed) % 60; if (now - lastSpread > 66) { lastSpread = now; renderSpread(); } }
  animateDemoFlight(now);
  tickPeopleDemo(now);
  requestAnimationFrame(animate);
}

async function boot() {
  initMap(); bindUi(); drawWaiting('Waiting for live video', 'The bridge relays the ANAFI camera through the backend'); renderSpread(); renderMapChip();
  // Opened straight from disk there is no backend to talk to: say so instead of asking for a token.
  if (location.protocol === 'file:') {
    setBanner('warn', '<strong>Opened from a file.</strong> Live data needs the backend: run <code>npm start</code> and open <code>http://127.0.0.1:8787</code>.');
    setModePill('demo', 'Not connected'); $('connection-result').textContent = 'Not connected: this page was opened from a file, not from the BOSCO backend.';
    requestAnimationFrame(animate); return;
  }
  try { const s = await (await fetch('/api/session')).json(); state.token = s.token || ''; } catch {}
  if (!state.token) { setBanner('warn', '<strong>Enter the dashboard token.</strong> Open Integrations — the token is only provided automatically on this computer.'); setModePill('demo', 'Not connected'); openDialog('integrations-dialog'); }
  else await connect();
  requestAnimationFrame(animate);
}
boot();
