/* BOSCO incident Dashboard.
   Reads every incident value from window.BoscoFixtures, builds each region's
   DOM once, then updates only what a state change touches. Nothing here talks
   to the backend or to an aircraft: the timeline projection, lead reviews and
   log are local to this page and reset on reload.

   State ownership: `state` is the single source of truth; set() applies a
   patch and calls the renderers for the keys that changed. The playback
   interval is the only timer; it is cleared on pause, on the return
   transition to Home and on pagehide. */
(function () {
  'use strict';

  const F = window.BoscoFixtures;
  const T = window.BoscoTransition;
  const $ = id => document.getElementById(id);

  const SPEEDS = [1, 2, 4];
  const TICK_MS = 120;                 // timeline playback tick
  const MINUTES_PER_TICK = 0.5;        // × speed
  const FOLLOW_EVERY_MIN = 15;         // Follow searcher hands over to the next drone every 15 min
  const MAP_W = 1000, MAP_H = 600;     // terrain drawing size (SVG user units)
  const LOG_FILTERS = [['all', 'All'], ['people', 'People'], ['fire', 'Fire'], ['drones', 'Drones'], ['review', 'Reviews']];
  const REASONS = Object.fromEntries(F.closeReasons.map(r => [r.id, r]));

  const state = {
    mode: 'replay',            // 'replay' | 'live'
    minute: 0,                 // 0–60, projected minutes from now
    playing: false,
    speedIdx: 0,
    showCond: false,
    drone: 0,                  // selected drone index
    follow: true,
    replaySpeed: '8',
    responder: '',
    filter: 'all',
    leads: F.leads.map(() => ({ status: 'open', by: '', reason: '' })),  // 'open' | 'ack' | 'closed'
    events: [],                // reviews logged on this page, newest first
    view: { z: 1, cx: MAP_W / 2, cy: MAP_H / 2 },
  };

  // ---------------------------------------------------------------- helpers

  /** Escape text for insertion into an HTML template. */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Format a signed number with a typographic minus. */
  const signed = (n, dp) => (n < 0 ? '−' : '') + Math.abs(n).toFixed(dp);
  /** Latitude/longitude as shown on lead cards, e.g. "56.62398, −111.37620". */
  const latLon = l => `${signed(l.lat, 5)}, ${signed(l.lon, 5)}`;
  const altText = d => d.altitudeM.toFixed(1) + ' m';
  const spdText = d => d.groundSpeedMs.toFixed(1) + ' m/s';
  const droneColor = i => `var(--drone-${i + 1})`;
  /** Fire growth factor k for a timeline minute (outline scale; area grows with k²). */
  const growth = minute => 1 + minute / F.spread.horizonMin * F.spread.growthPerHour;

  /** Wall-clock stamp for new log entries, e.g. "3:47:40 AM". */
  function stamp() {
    const d = new Date();
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${ap}`;
  }

  /** Lead counts derived from review state. */
  function leadCounts() {
    const open = [], unack = [];
    let ground = 0;
    state.leads.forEach((s, i) => {
      if (s.status !== 'closed') open.push(i);
      if (s.status === 'open') unack.push(i);
      if (s.status === 'closed' && REASONS[s.reason] && REASONS[s.reason].groundObserved) ground++;
    });
    const multi = open.filter(i => F.leads[i].angles >= 2).length;
    return { open: open.length, unack: unack.length, multi, ground };
  }

  /** Projected fire ETA/distance text for a lead at the current timeline minute. */
  function fireText(l) {
    const p = F.leadProjection;
    const eta = Math.max(p.minEtaMin, Math.round(l.fireEtaMin - state.minute * p.etaMinPerMinute));
    const dist = Math.max(p.minDistanceM, Math.round(l.fireDistanceM - state.minute * p.distanceMPerMinute));
    return `Fire in ~${eta} min · ${dist} m away`;
  }

  /** Trigger a browser download of a text file built on this page. */
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------- one-time build

  /** Static incident text, connections, conditions and the incident selector. */
  function buildStatic() {
    const inc = F.incident;
    $('incident-kicker').textContent = inc.kicker;
    $('incident-name').textContent = inc.name;
    $('fire-tag').hidden = !inc.fireDetected;
    $('incident-sub').textContent = inc.subtitle;
    $('banner-label').textContent = inc.bannerLabel;
    $('map-sub').textContent = inc.patrolCaption;
    $('map-pill').textContent = `${inc.name} · ${inc.region}`;
    const opt = document.createElement('option');
    opt.value = inc.id; opt.textContent = inc.name;
    $('incident-select').appendChild(opt);

    $('conn-chip').innerHTML = F.connections.map(c =>
      `<span><i class="${c.connected ? '' : 'is-off'}" aria-hidden="true"></i>${esc(c.label)}<span class="sr-only"> ${c.connected ? 'connected' : 'not connected'}</span></span>`).join('');

    $('kpi-wind').textContent = F.conditions.windSpeedKmh;
    $('kpi-wind-dir').textContent = `toward ${F.conditions.windTowardLabel} ↗`;
    $('kpi-detect').textContent = F.conditions.detectionConfidencePct;
    $('fleet-size').textContent = `${F.drones.length} DRONE FLEET`;
    const ig = F.spread.ignition;
    $('m-ignition').setAttribute('transform', `translate(${ig.x} ${ig.y})`);
  }

  const presetBtns = [];
  /** Now / +30 / +60 timeline presets. */
  function buildPresets() {
    for (const m of [0, 30, 60]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip-btn';
      b.textContent = m === 0 ? 'Now' : `+${m} min`;
      b.addEventListener('click', () => set({ minute: m }));
      $('presets').appendChild(b);
      presetBtns.push([m, b]);
    }
  }

  const droneCards = [];
  /** Fleet carousel cards; clicking one selects it and turns Follow searcher off. */
  function buildDroneCards() {
    F.drones.forEach((d, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'drone-card';
      b.style.setProperty('--drone-color', droneColor(i));
      b.innerHTML = `
        <span class="dc-head"><b>${esc(d.id)}</b><span>${d.batteryPct}%</span></span>
        <span class="feed-thumb tone-${d.feed.tone}" aria-hidden="true">
          <svg viewBox="0 0 160 78" preserveAspectRatio="none"><path class="feed-ground" d="${d.feed.ridge}"/><path class="feed-burn" fill-opacity="0.75" d="${d.feed.burn}"/></svg>
          <span class="reticle"></span>
          <span class="hud">ALT ${altText(d)}<br>SPD ${spdText(d)}</span>
        </span>
        <span class="dc-state">${esc(d.state)}</span>
        <span class="dc-meta">${altText(d)} high · ${spdText(d)}<br>${d.peopleSpotted} people spotted</span>`;
      b.setAttribute('aria-label', `${d.id}, ${d.state}, battery ${d.batteryPct}%`);
      b.addEventListener('click', () => set({ drone: i, follow: false }));
      $('drone-cards').appendChild(b);
      droneCards.push(b);
    });
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const leadMarkers = [], droneMarkers = [];
  /** Numbered lead and drone markers on the terrain drawing. */
  function buildMapMarkers() {
    F.leads.forEach(l => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'm-lead');
      g.setAttribute('transform', `translate(${l.map.x} ${l.map.y})`);
      g.innerHTML = `<circle r="9" stroke-width="1.6"/><text y="3.8" text-anchor="middle">${l.id}</text>`;
      $('m-leads').appendChild(g);
      leadMarkers.push(g);
    });
    F.drones.forEach((d, i) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'm-drone');
      g.setAttribute('transform', `translate(${d.map.x} ${d.map.y})`);
      const c = droneColor(i);
      g.innerHTML = `
        <path class="cone" d="M0 0 L120 -36 A126 126 0 0 1 120 36 Z" fill="url(#m-fov)" transform="rotate(${d.map.coneDeg})"/>
        <circle class="ring" stroke-width="1.5" opacity="0.5" style="stroke:${c}"/>
        <circle class="body" r="11" stroke-width="2.2" style="stroke:${c}"/>
        <text y="3.8" text-anchor="middle" style="fill:${c}">${i + 1}</text>`;
      $('m-drones').appendChild(g);
      droneMarkers.push({ g, cone: g.querySelector('.cone'), ring: g.querySelector('.ring') });
    });
  }

  const leadCards = [];
  /** The seven rescue-lead cards with their acknowledge / close controls. */
  function buildLeadCards() {
    const reasonOptions = F.closeReasons.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
    F.leads.forEach((l, i) => {
      const possible = l.kind === 'possible';
      const el = document.createElement('article');
      el.className = 'lead' + (possible ? ' is-possible' : '');
      el.setAttribute('aria-labelledby', `lead-${l.id}-title`);
      const src = l.sourceDrones.join(', ');
      el.innerHTML = `
        <div class="lead-top">
          <span class="lead-num" aria-hidden="true">${l.id}</span>
          <div class="lead-title">
            <h3 id="lead-${l.id}-title">${possible ? 'Possible person' : 'Candidate'} — Target ${l.id}</h3>
            <span class="lead-tag">${possible ? 'POSSIBLE PERSON' : 'NEEDS ANOTHER ANGLE'}</span>
          </div>
          <svg class="compass" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Bearing ${l.bearingDeg} degrees">
            <circle cx="16" cy="16" r="14" stroke-width="1.5"/>
            <g transform="rotate(${l.bearingDeg} 16 16)"><path class="n" d="M16 5 19 16h-6Z"/><path class="s" d="M16 27 13 16h6Z"/></g>
          </svg>
        </div>
        <dl>
          <dt>Location</dt><dd class="loc">${latLon(l)}</dd>
          <dt>Accuracy</dt><dd>±${l.accuracyM} m</dd>
          <dt>Last seen</dt><dd>${esc(l.lastSeen)} · <a href="#fleet" data-drone="${esc(l.sourceDrones[0])}">image</a></dd>
          <dt>Evidence</dt><dd>${l.sightings} sightings · ${l.angles} angles (${l.angleSeparationDeg}° apart) · visible</dd>
          <dt>Source drones</dt><dd>${esc(src)}</dd>
          <dt>Movement</dt><dd>${esc(l.movement)}</dd>
          <dt>Fire</dt><dd class="fire"></dd>
        </dl>
        <span class="lead-perimeter">Person seen at the perimeter</span>
        <details>
          <summary>Sightings (${l.sightings})</summary>
          <span>${esc(src)} · ${l.sightings} frames · first ${esc(l.lastSeen)} · bearing ${l.bearingDeg}°</span>
        </details>
        <span class="lead-status" hidden></span>
        <div class="lead-actions">
          <button type="button" class="ack-btn"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg><span>Acknowledge</span></button>
          <span class="close-group">
          <label class="select-wrap">
            <span class="sr-only">Close reason for target ${l.id}</span>
            <select><option value="">Close lead…</option>${reasonOptions}</select>
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><use href="#i-chevron"/></svg>
          </label>
          <button type="button" class="close-btn" disabled>Close</button>
          </span>
        </div>`;
      const refs = {
        el,
        fire: el.querySelector('dd.fire'),
        status: el.querySelector('.lead-status'),
        ack: el.querySelector('.ack-btn'),
        ackLabel: el.querySelector('.ack-btn span'),
        select: el.querySelector('select'),
        close: el.querySelector('.close-btn'),
      };
      refs.ack.addEventListener('click', () => acknowledge(i));
      refs.select.addEventListener('change', () => setLead(i, { reason: refs.select.value }));
      refs.close.addEventListener('click', () => closeLead(i));
      el.querySelector('a[data-drone]').addEventListener('click', () => {
        const idx = F.drones.findIndex(d => d.id === l.sourceDrones[0]);
        if (idx >= 0) set({ drone: idx, follow: false });
      });
      $('lead-grid').appendChild(el);
      leadCards.push(refs);
    });
  }

  const filterBtns = [];
  /** Search-log filter chips plus the Export button. */
  function buildLogFilters() {
    for (const [id, label] of LOG_FILTERS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip-btn'; b.textContent = label;
      b.addEventListener('click', () => set({ filter: id }));
      $('log-filters').appendChild(b);
      filterBtns.push([id, b]);
    }
    const exp = document.createElement('button');
    exp.type = 'button'; exp.className = 'chip-btn'; exp.textContent = 'Export';
    exp.addEventListener('click', exportLog);
    $('log-filters').appendChild(exp);
  }

  // ------------------------------------------------------------- lead actions

  /** Replace one lead's review state. */
  function setLead(i, patch) {
    const leads = state.leads.slice();
    leads[i] = Object.assign({}, leads[i], patch);
    set({ leads });
  }

  /** Prepend an event to the search log. */
  function logEvent(kind, text) {
    set({ events: [{ time: stamp(), kind, text }].concat(state.events) });
  }

  /** Acknowledge an open lead, recording the responder's name. */
  function acknowledge(i) {
    if (state.leads[i].status !== 'open') return;
    const name = state.responder.trim();
    setLead(i, { status: 'ack', by: name });
    logEvent('review', `Target ${F.leads[i].id} acknowledged${name ? ' by ' + name : ''}.`);
  }

  /** Close a lead with its chosen reason. */
  function closeLead(i) {
    const s = state.leads[i];
    if (s.status === 'closed' || !s.reason) return;
    const name = state.responder.trim();
    setLead(i, { status: 'closed', by: name });
    logEvent('review', `Target ${F.leads[i].id} closed · ${REASONS[s.reason].label}${name ? ' · ' + name : ''}.`);
  }

  // ---------------------------------------------------------------- renderers

  /** Replay / Live demo pill, toggle and mode tag. */
  function renderMode() {
    const live = state.mode === 'live';
    $('mode-label').textContent = live ? 'Live demo' : 'Replay';
    $('mode-pill').classList.toggle('is-live', live);
    $('live-toggle').setAttribute('aria-pressed', String(live));
    $('mode-tag').textContent = live ? 'LIVE DEMO' : 'REPLAY';
    $('feed-burn').setAttribute('fill-opacity', live ? '0.55' : '0.7');
  }

  /** Everything that depends on the timeline minute. */
  function renderMinute() {
    const m = state.minute, k = growth(m);
    $('t-minute').textContent = String(Math.round(m));
    const slider = $('minute');
    if (Number(slider.value) !== m) slider.value = String(m);
    slider.setAttribute('aria-valuetext', `${Math.round(m)} minutes from now`);
    for (const [pm, b] of presetBtns) b.setAttribute('aria-pressed', String(Math.round(m) === pm));
    $('kpi-area').textContent = (F.spread.baseAreaHa * k * k).toFixed(1);
    $('kpi-area-when').textContent = m === 0 ? 'now' : 'projected';
    const ig = F.spread.ignition;
    $('m-fire').setAttribute('transform', `translate(${ig.x} ${ig.y}) rotate(${F.spread.outlineRotateDeg}) scale(${k.toFixed(3)})`);
    F.leads.forEach((l, i) => { leadCards[i].fire.textContent = fireText(l); });
    renderHudRight();
  }

  /** Right-hand HUD column (needs both the drone and the minute). */
  function renderHudRight() {
    const d = F.drones[state.drone];
    $('hud-right').innerHTML = `EDGE ${d.fireEdgeM} m<br>PPL ${d.peopleSpotted}<br>T+${Math.round(state.minute)}:00`;
  }

  /** Selected drone: carousel, map cones, camera feed, stats, KPI and banner. */
  function renderDrone() {
    const i = state.drone, d = F.drones[i];
    droneCards.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    droneMarkers.forEach((m, j) => {
      m.cone.setAttribute('opacity', j === i ? '1' : '0');
      m.ring.setAttribute('r', j === i ? '20' : '15');
    });
    const panel = $('fleet');
    panel.style.setProperty('--drone-color', droneColor(i));
    $('fleet-drone-id').textContent = d.id;
    const feed = $('feed');
    feed.className = `feed tone-${d.feed.tone}`;
    feed.setAttribute('aria-label', `${d.id} camera feed, ${d.state.toLowerCase()}`);
    $('feed-burn').setAttribute('d', d.feed.burnLarge);
    $('hud-id').textContent = d.id.toLowerCase();
    $('hud-hdg').textContent = `HDG ${d.headingDeg}° · CAM ${signed(d.cameraTiltDeg, 0)}°`;
    $('hud-left').innerHTML = `ALT ${altText(d)}<br>SPD ${spdText(d)}<br>BAT ${d.batteryPct}%<br>LNK OK`;
    $('hud-state').textContent = `${d.id.toLowerCase()} · ${d.state.toLowerCase()}`;
    $('st-alt').textContent = altText(d);
    $('st-spd').textContent = spdText(d);
    $('st-bat').textContent = `${d.batteryPct} %`;
    $('st-state').textContent = d.state;
    $('fleet-foot').textContent = `${d.id} · heading ${d.headingDeg}° · camera ${signed(d.cameraTiltDeg, 0)}° · ${d.fireEdgeM} m from fire edge`;
    $('kpi-bat').textContent = d.batteryPct;
    $('kpi-bat-note').textContent = `${d.id} battery`;
    renderHudRight();
    renderSummary();
  }

  /** Banner and fleet caption (depend on drone, open leads and replay speed). */
  function renderSummary() {
    const d = F.drones[state.drone], c = leadCounts();
    $('banner-text').textContent = `${d.id} ${d.state.toLowerCase()}; ${F.drones.length} drones in aerial observation · ${c.open} unique people spotted.`;
    $('fleet-caption').textContent = `Perimeter patrol · ${c.open} unique people · ${d.id} ${d.state.toLowerCase()} · ${state.replaySpeed}× replay`;
  }

  /** Lead cards' review state, counts, rail badge and map markers. */
  function renderLeads() {
    state.leads.forEach((s, i) => {
      const r = leadCards[i];
      const closed = s.status === 'closed', acked = s.status === 'ack';
      r.el.classList.toggle('is-ack', acked);
      r.el.classList.toggle('is-closed', closed);
      r.ack.disabled = acked || closed;
      r.ackLabel.textContent = acked ? 'Acknowledged' : 'Acknowledge';
      if (r.select.value !== s.reason) r.select.value = s.reason;
      r.select.disabled = closed;
      r.close.disabled = closed || !s.reason;
      r.status.hidden = !(acked || closed);
      const by = s.by ? ' · ' + s.by.toUpperCase() : '';
      r.status.textContent = closed ? `CLOSED · ${REASONS[s.reason].label.toUpperCase()}${by}` : `ACKNOWLEDGED${by}`;
      leadMarkers[i].setAttribute('opacity', closed ? '0.3' : '1');
    });
    const c = leadCounts();
    $('c-open').textContent = c.open;
    $('c-multi').textContent = c.multi;
    $('c-unack').textContent = c.unack;
    $('c-ground').textContent = c.ground ? String(c.ground) : '—';
    $('kpi-open').textContent = c.open;
    $('kpi-open-note').textContent = `${c.multi} seen from 2+ angles · ${c.unack} not acknowledged`;
    $('leads-open-tag').textContent = `${c.open} OPEN`;
    const badge = $('rail-badge');
    badge.textContent = c.open;
    badge.hidden = c.open === 0;
    $('rail-leads').setAttribute('aria-label', `Rescue leads, ${c.open} open`);
    renderSummary();
  }

  /** Search log list for the active filter. */
  function renderLog() {
    for (const [id, b] of filterBtns) b.setAttribute('aria-pressed', String(id === state.filter));
    const rows = state.events.concat(F.log).filter(e => state.filter === 'all' || e.kind === state.filter);
    $('log-list').innerHTML = rows.length
      ? rows.map(e => `<li><time>${esc(e.time)}</time><span><i class="k-${esc(e.kind)}" aria-hidden="true">●</i> ${esc(e.text)}</span></li>`).join('')
      : '<li class="log-empty">No entries for this filter yet.</li>';
  }

  /** Play/pause button state. */
  function renderPlay() {
    const b = $('play');
    b.setAttribute('aria-pressed', String(state.playing));
    b.setAttribute('aria-label', state.playing ? 'Pause projection' : 'Play projection');
  }

  /** Playback speed button. */
  function renderSpeed() {
    const s = SPEEDS[state.speedIdx] + '×';
    $('speed').textContent = s;
    $('speed').setAttribute('aria-label', `Playback speed ${s}`);
  }

  /** Conditions toggle shows the wind arrows on the map. */
  function renderCond() {
    $('cond-toggle').setAttribute('aria-pressed', String(state.showCond));
    $('m-cond').toggleAttribute('hidden', !state.showCond);
  }

  /** Follow searcher toggle and replay speed select. */
  function renderFollow() {
    $('follow').setAttribute('aria-pressed', String(state.follow));
    if ($('replay-speed').value !== state.replaySpeed) $('replay-speed').value = state.replaySpeed;
  }

  /** Apply the map zoom/centre as an SVG viewBox, kept inside the drawing. */
  function renderView() {
    const { z } = state.view;
    const w = MAP_W / z, h = MAP_H / z;
    const cx = Math.min(MAP_W - w / 2, Math.max(w / 2, state.view.cx));
    const cy = Math.min(MAP_H - h / 2, Math.max(h / 2, state.view.cy));
    $('map-svg').setAttribute('viewBox', `${(cx - w / 2).toFixed(1)} ${(cy - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  const RENDERERS = {
    mode: [renderMode],
    minute: [renderMinute],
    drone: [renderDrone],
    leads: [renderLeads],
    events: [renderLog],
    filter: [renderLog],
    playing: [renderPlay],
    speedIdx: [renderSpeed],
    showCond: [renderCond],
    follow: [renderFollow],
    replaySpeed: [renderFollow, renderSummary],
    view: [renderView],
  };

  /** Apply a state patch and run the renderers for the keys that changed. */
  function set(patch) {
    const run = new Set();
    for (const [k, v] of Object.entries(patch)) {
      if (state[k] === v) continue;
      state[k] = v;
      (RENDERERS[k] || []).forEach(fn => run.add(fn));
    }
    run.forEach(fn => fn());
  }

  /** Render every region once at start-up. */
  function renderAll() {
    new Set(Object.values(RENDERERS).flat()).forEach(fn => fn());
  }

  // ---------------------------------------------------------------- playback

  let timer = 0;
  /** Stop the projection playback interval. */
  function stopPlayback() {
    if (timer) { clearInterval(timer); timer = 0; }
    set({ playing: false });
  }
  /** Advance the timeline every tick; wraps at +60. Follow searcher rotates the selected drone every 15 min. */
  function startPlayback() {
    if (timer) return;
    set({ playing: true });
    timer = setInterval(() => {
      const step = MINUTES_PER_TICK * SPEEDS[state.speedIdx];
      const m = state.minute >= F.spread.horizonMin ? 0 : Math.min(F.spread.horizonMin, state.minute + step);
      const patch = { minute: m };
      if (state.follow) patch.drone = Math.floor(m / FOLLOW_EVERY_MIN) % F.drones.length;
      set(patch);
    }, TICK_MS);
  }

  // ---------------------------------------------------------------- map view

  /** Zoom by a factor around the current centre (1× to 3×). */
  const zoomBy = f => set({ view: { ...state.view, z: Math.min(3, Math.max(1, state.view.z * f)) } });
  /** Centre on the selected drone. */
  function locateFleet() {
    const d = F.drones[state.drone];
    set({ view: { z: Math.max(1.6, state.view.z), cx: d.map.x, cy: d.map.y } });
  }
  /** Frame the projected fire outline (its drawing spans about 300×150 units × k, rotated). */
  function fitFire() {
    const k = growth(state.minute), ig = F.spread.ignition, rad = F.spread.outlineRotateDeg * Math.PI / 180;
    const w = (300 * Math.abs(Math.cos(rad)) + 150 * Math.abs(Math.sin(rad))) * k * 1.35;
    const h = (300 * Math.abs(Math.sin(rad)) + 150 * Math.abs(Math.cos(rad))) * k * 1.35;
    const z = Math.min(3, Math.max(1, Math.min(MAP_W / w, MAP_H / h)));
    set({ view: { z, cx: ig.x + 80 * k * Math.cos(rad), cy: ig.y + 80 * k * Math.sin(rad) } });
  }

  // ---------------------------------------------------------------- expand

  let expanded = null;
  /** Show one panel full-window (or restore it). Escape restores. */
  function toggleExpand(btn) {
    const panel = $(btn.dataset.expand);
    const on = expanded !== panel;
    if (expanded) {
      expanded.classList.remove('is-expanded');
      document.querySelector(`[data-expand="${expanded.id}"]`).setAttribute('aria-pressed', 'false');
    }
    expanded = on ? panel : null;
    if (on) panel.classList.add('is-expanded');
    btn.setAttribute('aria-pressed', String(on));
    document.documentElement.classList.toggle('has-expanded', on);
    btn.focus();
  }

  // ---------------------------------------------------------------- exports

  /** Download a plain-text incident brief built from the current page state. */
  function exportBrief() {
    const c = leadCounts(), d = F.drones[state.drone], k = growth(state.minute);
    const lines = [
      `BOSCO incident brief — ${F.incident.name}`,
      `${F.incident.subtitle}`,
      `Mode: ${state.mode === 'live' ? 'Live demo' : 'Replay'} · exported ${stamp()}`,
      '',
      `Fire area: ${(F.spread.baseAreaHa * k * k).toFixed(1)} ha (${state.minute === 0 ? 'now' : 'projected T+' + Math.round(state.minute) + ' min'})`,
      `Wind: ${F.conditions.windSpeedKmh} km/h toward ${F.conditions.windTowardLabel}`,
      `Detection confidence: ${F.conditions.detectionConfidencePct}%`,
      `Selected drone: ${d.id} · ${d.state} · battery ${d.batteryPct}%`,
      '',
      `Rescue leads: ${c.open} open · ${c.multi} seen from 2+ angles · ${c.unack} not acknowledged · ${c.ground} ground observed`,
      ...F.leads.map((l, i) => {
        const s = state.leads[i];
        const st = s.status === 'closed' ? `closed (${REASONS[s.reason].label})` : s.status === 'ack' ? 'acknowledged' : 'open';
        return `  Target ${l.id} · ${l.kind === 'possible' ? 'possible person' : 'candidate'} · ${latLon(l)} ±${l.accuracyM} m · ${fireText(l)} · ${st}${s.by ? ' by ' + s.by : ''}`;
      }),
      '',
      'Illustrative replay data. Leads carry uncertainty and require human review.',
    ];
    download(`bosco-brief-${F.incident.id}.txt`, lines.join('\n') + '\n');
  }

  /** Download the search log (current filter) as text. */
  function exportLog() {
    const rows = state.events.concat(F.log).filter(e => state.filter === 'all' || e.kind === state.filter);
    download(`bosco-search-log-${F.incident.id}.txt`, rows.map(e => `${e.time}\t${e.kind}\t${e.text}`).join('\n') + '\n');
  }

  // ---------------------------------------------------------------- theme

  const THEME_KEY = 'bx-theme';
  /** Switch the Dashboard between dark and light tokens and remember the choice (best effort). */
  function setTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim();
    const btn = $('theme-toggle');
    btn.setAttribute('aria-pressed', String(theme === 'light'));
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* storage blocked: the theme still applies for this visit */ }
  }

  // ---------------------------------------------------------------- rail

  /** Mark the rail link for the section currently in view. */
  function watchSections() {
    if (!('IntersectionObserver' in window)) return;
    const links = [...document.querySelectorAll('.rail-link[data-section]')];
    const visible = new Map();
    const io = new IntersectionObserver(entries => {
      for (const e of entries) visible.set(e.target.id, e.intersectionRatio);
      let best = 'map', bestR = -1;
      for (const [id, r] of visible) if (r > bestR) { best = id; bestR = r; }
      links.forEach(a => a.setAttribute('aria-current', String(a.dataset.section === best)));
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    links.forEach(a => io.observe($(a.dataset.section)));
    return io;
  }

  // ---------------------------------------------------------------- wiring

  window.BoscoMark.mountAll();
  buildStatic();
  buildPresets();
  buildDroneCards();
  buildMapMarkers();
  buildLeadCards();
  buildLogFilters();
  renderAll();
  const sectionObserver = watchSections();

  $('theme-toggle').setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'light'));
  $('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('live-toggle').addEventListener('click', () => set({ mode: state.mode === 'live' ? 'replay' : 'live' }));
  $('cond-toggle').addEventListener('click', () => set({ showCond: !state.showCond }));
  $('minute').addEventListener('input', e => set({ minute: Number(e.target.value) }));
  $('play').addEventListener('click', () => (timer ? stopPlayback() : startPlayback()));
  $('speed').addEventListener('click', () => set({ speedIdx: (state.speedIdx + 1) % SPEEDS.length }));
  $('follow').addEventListener('click', () => set(state.follow ? { follow: false } : { follow: true, drone: 0 }));
  $('replay-speed').addEventListener('change', e => set({ replaySpeed: e.target.value }));
  $('responder').addEventListener('input', e => { state.responder = e.target.value; });
  $('export-brief').addEventListener('click', exportBrief);
  $('map-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('map-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  $('map-locate').addEventListener('click', locateFleet);
  $('map-fit').addEventListener('click', fitFire);
  $('map-recentre').addEventListener('click', () => set({ view: { z: 1, cx: MAP_W / 2, cy: MAP_H / 2 } }));
  document.querySelectorAll('.expand-btn').forEach(b => b.addEventListener('click', () => toggleExpand(b)));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && expanded) toggleExpand(document.querySelector(`[data-expand="${expanded.id}"]`));
  });
  window.addEventListener('pagehide', () => {
    if (timer) { clearInterval(timer); timer = 0; }
    if (sectionObserver) sectionObserver.disconnect();
  });

  // The Dashboard always mounts under the transition cover.
  T.arrive({ content: $('dash-content') });

  // Rail logo → Home: the mirror of Get started. Playback stops first, and the
  // one-shot flag tells Home to play its arrive intro.
  T.bindLink($('rail-home'), () => ({ content: $('dash-content'), beforeLeave: stopPlayback, flag: T.HOME_INTRO_FLAG }));
})();
