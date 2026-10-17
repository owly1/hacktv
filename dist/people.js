'use strict';
/* BOSCO person search on the dashboard: rescue leads, their 95% location areas,
   the "seen from" directions, the drone's coverage of the ground and suggested
   next looks. Live data comes from /api/people; demo mode replays the seeded
   simulation from /api/demo/people through the same pipeline.
   Loaded before app.js; uses its state and helpers at call time. */

const PEOPLE_DEMO_SPEED = 3;          // simulated seconds per real second
const PEOPLE_DEMO_HOLD_S = 25;        // pause on the final picture before replaying
const LEAD_STATUS = {
  'possible-person': {label: 'Possible person', cls: 'st-possible'},
  'needs-another-view': {label: 'Needs another angle', cls: 'st-candidate'},
  'not-re-seen': {label: 'Not re-seen', cls: 'st-unseen'},
  closed: {label: 'Closed', cls: 'st-closed'},
};
const CLOSE_OUTCOMES = [['found', 'Person found / reached'], ['not-a-person', 'Not a person'], ['duplicate', 'Duplicate of another lead'], ['handed-off', 'Handed off to another team']];
const peopleState = {snap: null, listKey: '', covKey: '', demo: null, seen: new Set(), crops: new Map(), focus: null};

function peopleLL(ref, e, n) { return [ref.lat + n / 111320, ref.lon + e / (111320 * Math.cos(ref.lat * Math.PI / 180))]; }
function fmtAgo(s) { return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`; }
function fmtCoord(l) { return `${l.latitude.toFixed(6)}, ${l.longitude.toFixed(6)}`; }
function peopleDemoActive() { return state.mode === 'demo' && state.demo.selected?.id === 'people'; }

function peopleInitMap() {
  for (const name of ['coverage', 'people', 'mission']) state.layers[name] = L.layerGroup().addTo(state.map);
  state.layers.coverage.setZIndex?.(0);
  for (const [box, layer] of [['layer-people', 'people'], ['layer-coverage', 'coverage'], ['layer-mission', 'mission']]) {
    $(box).onchange = () => { $(box).checked ? state.map.addLayer(state.layers[layer]) : state.map.removeLayer(state.layers[layer]); $('coverage-legend').hidden = !$('layer-coverage').checked || !peopleState.snap?.coverage?.cells?.length; };
  }
  try { $('responder-name').value = localStorage.getItem('bosco-responder') || ''; } catch {}
  $('responder-name').addEventListener('input', () => { try { localStorage.setItem('bosco-responder', $('responder-name').value.trim()); } catch {} });
  $('lead-list').addEventListener('click', onLeadAction);
}

// ------------------------------------------------------------------ data

async function pollPeople() {
  if (state.mode === 'demo') return;
  const snap = await getJson('/api/people');
  renderPeople(snap);
}

function startPeopleDemo() {
  peopleState.demo = {started: performance.now(), lastFetch: 0, inflight: false, t: 0};
  peopleState.listKey = ''; peopleState.covKey = ''; peopleState.seen.clear();
  $('people-source').textContent = 'Simulated'; $('people-source').className = 'pill warn';
  $('flight-progress').hidden = false;
}
function stopPeopleDemo() {
  if (!peopleState.demo) return;
  peopleState.demo = null; peopleState.listKey = ''; peopleState.covKey = ''; peopleState.seen.clear();
  for (const name of ['coverage', 'people', 'mission']) state.layers[name].clearLayers();
  $('people-source').textContent = 'Live'; $('people-source').className = 'pill muted';
  renderPeople({leads: [], counts: {open: 0, possible_people: 0, unacknowledged: 0}, coverage: {cells: []}});
}

function tickPeopleDemo(now) {
  const d = peopleState.demo;
  if (!d || !peopleDemoActive() || d.inflight || now - d.lastFetch < 1000) return;
  const duration = peopleState.snap?.duration_s ?? 420;
  let t = (now - d.started) / 1000 * PEOPLE_DEMO_SPEED;
  if (t > duration + PEOPLE_DEMO_HOLD_S * PEOPLE_DEMO_SPEED) { d.started = now; t = 0; peopleState.listKey = ''; peopleState.covKey = ''; peopleState.seen.clear(); }
  d.lastFetch = now; d.inflight = true;
  getJson(`/api/demo/people?t=${Math.min(t, duration).toFixed(1)}`).then(snap => { if (peopleDemoActive()) renderPeople(snap); })
    .catch(e => toast('Simulated search unavailable: ' + e.message)).finally(() => { d.inflight = false; });
}

// ------------------------------------------------------------- rendering

function renderPeople(snap) {
  const prev = peopleState.snap; peopleState.snap = snap;
  const open = snap.leads.filter(l => !l.closed);
  const multi = open.filter(l => l.views >= 2).length;
  $('people-open').textContent = open.length; $('people-multi').textContent = multi; $('people-unack').textContent = snap.counts?.unacknowledged ?? 0;
  const sec = snap.coverage?.sector;
  $('people-coverage').textContent = sec ? `${Math.round(sec.well_pct + sec.partial_pct)}%` : snap.coverage?.cells?.length ? `${snap.coverage.cells.length} cells` : '—';
  $('people-coverage').title = sec ? `${sec.well_pct}% from 2+ directions, ${sec.partial_pct}% from one, ${sec.hidden_pct}% not yet observed` : '';
  $('people-value').textContent = open.length; $('people-unit').textContent = open.length === 1 ? 'lead' : 'leads';
  $('people-context').textContent = open.length ? `${multi} seen from 2+ angles · ${snap.counts?.unacknowledged ?? 0} need acknowledging` : 'no one reported yet';
  const badge = $('rail-people-badge'), unack = snap.counts?.unacknowledged ?? 0;
  badge.hidden = !unack; badge.textContent = unack;
  for (const l of open) {
    if (l.views >= 2 && !peopleState.seen.has(l.id)) {
      peopleState.seen.add(l.id);
      if (prev) toast(`${l.title} · ±${l.uncertainty.major_95_m} m. Needs a responder to acknowledge.`);
    }
  }
  renderLeadList(snap); renderPeopleMap(snap); renderMission(snap);
}

function viewRose(lead) {
  // Mini compass: one spoke per direction the lead has been seen from.
  const spokes = lead.view_azimuths_deg.map(az => { const r = (az + 180) * Math.PI / 180; return `<line x1="20" y1="20" x2="${(20 + 15 * Math.sin(r)).toFixed(1)}" y2="${(20 - 15 * Math.cos(r)).toFixed(1)}"/>`; }).join('');
  return `<svg class="view-rose" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17"/><text x="20" y="7.5">N</text>${spokes}<circle class="hub" cx="20" cy="20" r="3"/></svg>`;
}

function leadCard(l) {
  const st = LEAD_STATUS[l.status] || LEAD_STATUS['needs-another-view'];
  const mv = escapeHTML(l.movement.detail);
  const sensors = l.sensors.map(s => s === 'thermal' ? 'thermal' : 'visible').join(' + ');
  const crops = l.evidence.filter(e => e.crop).slice(0, 3).map(e => `<img class="lead-crop" data-crop="${escapeHTML(e.id)}" alt="Camera crop, ${escapeHTML(e.sensor)}, ${fmtTime(e.at)}">`).join('');
  const ev = l.evidence.slice(0, 4).map(e => `<li><span>${fmtTime(e.at)}</span> ${escapeHTML(e.sensor)} from the ${escapeHTML(e.from)} · ${e.range_m} m · ±${e.individual_95_m} m${e.delayed ? ` <b class="delayed">delayed ${e.delay_s} s</b>` : ''}</li>`).join('');
  const nl = l.next_look;
  const ack = l.acknowledged
    ? `<p class="lead-ack"><svg><use href="#i-check"/></svg>Acknowledged by <b>${escapeHTML(l.acknowledged.by)}</b> at ${fmtTime(l.acknowledged.at)}</p>`
    : l.closed ? '' : `<button class="button primary compact" data-action="ack" data-id="${l.id}"><svg><use href="#i-check"/></svg>Acknowledge</button>`;
  const close = l.closed
    ? `<p class="lead-ack closed">Closed by <b>${escapeHTML(l.closed.by)}</b> · ${escapeHTML(CLOSE_OUTCOMES.find(o => o[0] === l.closed.outcome)?.[1] || l.closed.outcome)} · ${fmtTime(l.closed.at)}</p>`
    : `<span class="lead-close"><select data-close-for="${l.id}" aria-label="Close ${escapeHTML(l.title)} with outcome"><option value="">Close lead…</option>${CLOSE_OUTCOMES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select><button class="button compact" data-action="close" data-id="${l.id}">Close</button></span>`;
  return `<article class="lead-card ${st.cls}${l.acknowledged ? ' is-ack' : ''}" data-lead="${l.id}">
    <header><span class="lead-num">${l.number}</span><div><h3>${escapeHTML(l.title)}</h3><p class="lead-status"><span class="lead-chip">${st.label}</span>${escapeHTML(l.status_text)}</p></div>${viewRose(l)}</header>
    <dl class="lead-facts">
      <div><dt>Location</dt><dd><button class="linkish" data-action="locate" data-id="${l.id}" title="Show on the map">${fmtCoord(l)}</button> <button class="icon-btn" data-action="copy" data-id="${l.id}" aria-label="Copy coordinates" title="Copy coordinates"><svg><use href="#i-link"/></svg></button></dd></div>
      <div><dt>Uncertainty</dt><dd>±${l.uncertainty.major_95_m} m <small>(95% area, ${l.uncertainty.major_95_m} × ${l.uncertainty.minor_95_m} m)</small></dd></div>
      <div><dt>Last seen</dt><dd>${fmtTime(l.last_seen_at)} <small>${fmtAgo(l.last_seen_age_s)}</small></dd></div>
      <div><dt>Evidence</dt><dd>${l.observations} sighting${l.observations === 1 ? '' : 's'} · ${l.views} angle${l.views === 1 ? '' : 's'}${l.views > 1 ? ` (${l.angle_span_deg}° apart)` : ''} · ${sensors}</dd></div>
      <div><dt>Movement</dt><dd>${mv}</dd></div>
      ${l.fire_distance_m != null ? `<div><dt>Fire</dt><dd>${l.fire_distance_m} m from the detected fire</dd></div>` : ''}
    </dl>
    ${l.priority.reasons.length ? `<ul class="lead-reasons">${l.priority.reasons.map(r => `<li>${escapeHTML(r)}</li>`).join('')}</ul>` : ''}
    ${l.delayed.any ? `<p class="lead-delayed">Includes observations stored during a link outage, delivered up to ${l.delayed.max_delay_s} s late. The person may have moved since.</p>` : ''}
    ${nl && !l.closed ? `<div class="next-look"><strong>Suggested next look · from the ${escapeHTML(nl.from)}</strong><p>${escapeHTML(nl.reason)} About ${nl.flight_s} s away, ${nl.altitude_m} m up, camera ${nl.gimbal_pitch_deg}°.</p></div>` : ''}
    ${crops ? `<div class="lead-crops">${crops}</div>` : ''}
    <details class="lead-evidence"><summary>Sightings</summary><ul>${ev}</ul></details>
    <footer>${ack}${close}</footer>
  </article>`;
}

function renderLeadList(snap) {
  const key = JSON.stringify(snap.leads.map(l => [l.id, l.status, l.observations, l.acknowledged?.at, l.closed?.at, l.uncertainty.major_95_m, l.movement.status, l.missed_looks, l.next_look?.from, Math.floor(l.last_seen_age_s / 15)]));
  if (key === peopleState.listKey) return;
  // Don't wipe a half-chosen close outcome out from under the responder.
  if (document.activeElement?.closest?.('#lead-list select')) return;
  peopleState.listKey = key;
  const list = $('lead-list');
  if (!snap.leads.length) {
    list.innerHTML = `<div class="lead-empty"><h3>No one found yet.</h3><p>${snap.simulated ? 'The simulated drone is surveying its sector. Candidates appear here as soon as it sees a person-shaped heat signature.' : 'When the drone sees a person-shaped heat signature or figure, it becomes a lead here. It shows where the person is, how sure that location is, and how many angles have confirmed it.'}</p></div>`;
    return;
  }
  list.innerHTML = snap.leads.map(leadCard).join('');
  for (const img of list.querySelectorAll('img[data-crop]')) loadCrop(img);
}

async function loadCrop(img) {
  const id = img.dataset.crop;
  if (!peopleState.crops.has(id)) peopleState.crops.set(id, api(`/api/people/crop/${encodeURIComponent(id)}`).then(r => r.blob()).then(b => URL.createObjectURL(b)).catch(() => null));
  const url = await peopleState.crops.get(id);
  if (url) img.src = url; else img.remove();
}

function ellipsePoints(l) {
  const {major_95_m: a, minor_95_m: b, bearing_deg: brg} = l.uncertainty, pts = [];
  for (let i = 0; i < 48; i++) {
    const t = i / 48 * Math.PI * 2, u = Math.max(a, .5) * Math.cos(t), v = Math.max(b, .5) * Math.sin(t);
    pts.push(M.destPoint(l.latitude, l.longitude, brg + Math.atan2(v, u) * 180 / Math.PI, Math.hypot(u, v)));
  }
  return pts;
}

function renderPeopleMap(snap) {
  const lp = state.layers.people, lm = state.layers.mission; lp.clearLayers(); lm.clearLayers();
  for (const l of snap.leads) {
    const st = LEAD_STATUS[l.status] || LEAD_STATUS['needs-another-view'];
    const colour = l.closed ? '#8C8679' : l.status === 'possible-person' ? '#E8562A' : l.status === 'not-re-seen' ? '#5E5A50' : '#B8860B';
    for (const e of l.evidence) {
      // "Seen from" spokes: back along each sighting's line of sight toward the drone.
      L.polyline([[l.latitude, l.longitude], M.destPoint(l.latitude, l.longitude, e.view_az_deg + 180, Math.min(e.range_m, 60))], {color: colour, weight: 1, opacity: .45, dashArray: '2 4', interactive: false}).addTo(lp);
    }
    L.polygon(ellipsePoints(l), {color: colour, weight: 1.6, fillColor: colour, fillOpacity: l.closed ? .05 : .16, dashArray: l.views >= 2 ? null : '5 4'}).addTo(lp)
      .bindTooltip(`${escapeHTML(l.title)} · 95% area ±${l.uncertainty.major_95_m} m`);
    L.marker([l.latitude, l.longitude], {icon: L.divIcon({className: 'lead-pin-wrap', html: `<div class="lead-pin ${st.cls}${l.acknowledged ? ' is-ack' : ''}">${l.number}</div>`, iconSize: [28, 28], iconAnchor: [14, 14]}), zIndexOffset: 500})
      .addTo(lp).on('click', () => focusLead(l.id))
      .bindTooltip(`<b>${escapeHTML(l.title)}</b><br>${escapeHTML(l.status_text)}<br>Last seen ${fmtTime(l.last_seen_at)}`);
    if (l.next_look && !l.closed) {
      const v = [l.next_look.latitude, l.next_look.longitude];
      L.polyline([v, [l.latitude, l.longitude]], {color: '#2F8F8A', weight: 1.5, dashArray: '6 5', interactive: false}).addTo(lm);
      L.circleMarker(v, {radius: 6, color: '#2F8F8A', weight: 2, fillColor: '#FBF9F4', fillOpacity: 1}).addTo(lm)
        .bindTooltip(`Suggested look at Target ${l.number} from the ${escapeHTML(l.next_look.from)} · ${l.next_look.flight_s} s away`);
    }
  }
  renderCoverage(snap.coverage);
  if (snap.simulated) {
    if (snap.track?.length) L.polyline(snap.track, {color: '#2F8F8A', weight: 2, opacity: .7, dashArray: '4 5', interactive: false}).addTo(lm);
    if (snap.drone) {
      const m = L.marker([snap.drone.latitude, snap.drone.longitude], {icon: L.divIcon({className: 'drone-icon-wrap', html: `<div class="drone-icon" style="transform:rotate(${snap.drone.heading_deg}deg)"><span>▲</span></div>`, iconSize: [30, 30], iconAnchor: [15, 15]}), zIndexOffset: 800}).addTo(lm);
      m.bindTooltip(`Simulated drone · ${snap.drone.altitude_m} m · heading ${snap.drone.heading_deg}°`);
    }
    if (snap.fire) {
      L.marker([snap.fire.latitude, snap.fire.longitude], {icon: L.divIcon({className: 'fire-pin-wrap', html: '<div class="fire-pin">🔥</div>', iconSize: [34, 34], iconAnchor: [17, 17]})}).addTo(lm).bindTooltip('Simulated fire');
      const sel = state.demo.selected;
      if (sel?.id === 'people' && sel.lat == null) { sel.lat = snap.fire.latitude; sel.lon = snap.fire.longitude; renderSpread(); }
    }
  }
}

function renderCoverage(cov) {
  const layer = state.layers.coverage;
  const cells = cov?.cells || [];
  $('coverage-legend').hidden = !cells.length || !$('layer-coverage').checked;
  const key = `${cells.length}|${cov?.ref?.lat}|${cov?.sector?.well_pct}`;
  if (key === peopleState.covKey) return;
  peopleState.covKey = key; layer.clearLayers();
  if (!cells.length || !cov.ref) return;
  const c = cov.cell_m;
  if (cov.sector) {
    const [s, w, n, e] = cov.sector.bounds;
    L.rectangle([[s, w], [n, e]], {color: '#5E5A50', weight: 1.2, dashArray: '6 6', fillColor: '#8C8679', fillOpacity: .12, interactive: true}).addTo(layer)
      .bindTooltip(`Assigned search sector · ${cov.sector.hidden_pct}% not yet observed`);
  }
  // One pixel per cell, painted once, shown as a single image over the map.
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [i, j] of cells) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
  const W = i1 - i0 + 1, H = j1 - j0 + 1;
  if (W * H > 4e6) return;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
  for (const [i, j, cls] of cells) {
    const k = ((j1 - j) * W + (i - i0)) * 4;
    const rgba = cls === 2 ? [47, 143, 138, 80] : [255, 179, 71, 90];
    img.data.set(rgba, k);
  }
  ctx.putImageData(img, 0, 0);
  const sw = peopleLL(cov.ref, i0 * c, j0 * c), ne = peopleLL(cov.ref, (i1 + 1) * c, (j1 + 1) * c);
  L.imageOverlay(canvas.toDataURL(), [sw, ne], {className: 'coverage-overlay', interactive: false, opacity: 1}).addTo(layer);
}

function renderMission(snap) {
  const log = $('mission-log'), steps = $('loop-steps');
  const m = snap.mission;
  let active = null;
  if (m) {
    active = m.mode === 'revisit' ? 'revisit' : m.mode === 'done' ? 'report' : 'survey';
    const latest = m.log[0]?.text || '';
    if (/^Proposed/.test(latest)) active = 'propose';
    else if (/^Resolved/.test(latest)) active = 'resolve';
    else if (/possible person|Alert sent/.test(latest)) active = 'report';
    log.innerHTML = (m.link === 'down' ? `<li class="link-down"><b>Link down</b> · ${m.stored} observation${m.stored === 1 ? '' : 's'} stored on board</li>` : '')
      + m.log.map(e => `<li><span>${fmtTime(e.at)}</span> ${escapeHTML(e.text)}</li>`).join('');
    const d = snap.drone;
    if (d && peopleDemoActive()) {
      $('flight-phase').textContent = `Simulated search · ${m.mode}${m.link === 'down' ? ' · link down' : ''}`;
      $('flight-bar').style.width = Math.round(snap.t / snap.duration_s * 100) + '%';
      $('altitude').innerHTML = `${d.altitude_m} <small>m</small>`; $('flight-state').textContent = m.mode === 'revisit' ? 'Revisiting' : m.mode === 'done' ? 'Holding' : 'Surveying';
      $('ground-speed').innerHTML = `${m.mode === 'done' ? 0 : 9} <small>m/s</small>`;
      drawWaiting('Simulated person search', `${m.mode === 'revisit' ? 'revisiting a candidate' : m.mode} · heading ${d.heading_deg}° · camera ${d.gimbal_pitch_deg}°`);
      $('camera-label').innerHTML = '<i></i> SIMULATED';
    }
  } else {
    const open = snap.leads.filter(l => !l.closed);
    active = open.some(l => l.next_look) ? 'propose' : open.length ? 'report' : 'survey';
    log.innerHTML = open.length
      ? open.slice(0, 8).map(l => `<li><span>${fmtTime(l.last_seen_at)}</span> ${escapeHTML(l.title)}: ${escapeHTML(l.status_text.toLowerCase())}.</li>`).join('')
      : '<li class="muted-text">No person detections yet. Coverage builds as the drone flies with its camera tilted down.</li>';
  }
  for (const li of steps.children) li.classList.toggle('active', li.dataset.step === active);
}

// ------------------------------------------------------------- actions

function focusLead(id) {
  const l = peopleState.snap?.leads.find(x => x.id === id); if (!l) return;
  state.map.fitBounds(L.latLngBounds(ellipsePoints(l)).pad(1.2), {maxZoom: 19});
  const card = document.querySelector(`.lead-card[data-lead="${CSS.escape(id)}"]`);
  if (card) { card.scrollIntoView({behavior: 'smooth', block: 'nearest'}); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1200); }
}

function fitPeople() {
  const snap = peopleState.snap;
  if (snap?.coverage?.sector) { const [s, w, n, e] = snap.coverage.sector.bounds; state.map.fitBounds([[s, w], [n, e]], {padding: [20, 20]}); return true; }
  const open = snap?.leads.filter(l => !l.closed) || [];
  if (open.length) { state.map.fitBounds(L.latLngBounds(open.flatMap(ellipsePoints)).pad(.4), {maxZoom: 19}); return true; }
  return false;
}

async function onLeadAction(event) {
  const btn = event.target.closest('[data-action]'); if (!btn) return;
  const id = btn.dataset.id, l = peopleState.snap?.leads.find(x => x.id === id); if (!l) return;
  const action = btn.dataset.action;
  if (action === 'locate') { focusLead(id); return; }
  if (action === 'copy') { try { await navigator.clipboard.writeText(fmtCoord(l)); toast('Coordinates copied.'); } catch { toast(fmtCoord(l)); } return; }
  const by = $('responder-name').value.trim();
  if (!by) { $('responder-name').focus(); toast('Enter your name or call sign first, so the team knows who has this lead.'); return; }
  const body = {lead_id: id, by, demo: peopleDemoActive()};
  if (action === 'close') {
    const outcome = document.querySelector(`select[data-close-for="${CSS.escape(id)}"]`)?.value;
    if (!outcome) { toast('Choose an outcome to close the lead.'); return; }
    body.outcome = outcome;
  }
  btn.disabled = true;
  try {
    await api(action === 'ack' ? '/api/people/ack' : '/api/people/close', {method: 'POST', body});
    toast(action === 'ack' ? `${l.title} acknowledged by ${by}.` : `${l.title} closed.`);
    peopleState.listKey = '';
    if (peopleDemoActive()) peopleState.demo.lastFetch = 0; else await pollPeople();
  } catch (e) { toast(e.message); btn.disabled = false; }
}

function peopleBrief() {
  const snap = peopleState.snap, open = snap?.leads.filter(l => !l.closed) || [];
  if (!open.length) return 'No open rescue leads.';
  return open.map(l => [
    `### ${l.title}${snap.simulated ? ' (simulated)' : ''}`,
    `- Location: ${fmtCoord(l)} ±${l.uncertainty.major_95_m} m (95% area from the error model)`,
    `- Status: ${l.status_text}`,
    `- Last seen: ${l.last_seen_at} · ${l.observations} sightings from ${l.views} angle(s) · ${l.sensors.join(' + ')}`,
    `- Movement: ${l.movement.detail}`,
    l.delayed.any ? `- Includes observations delivered up to ${l.delayed.max_delay_s} s late (link outage)` : null,
    `- ${l.acknowledged ? `Acknowledged by ${l.acknowledged.by} at ${l.acknowledged.at}` : 'NOT YET ACKNOWLEDGED'}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}
