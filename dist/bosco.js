/* BOSCO presentation layer. Reads state that app.js already writes into the
   page and reflects it visually: the workspace mode (drives the map frame and
   mode switch), service status colours, and the top-bar service strip.
   It never calls the backend and never changes app state. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  // ---- workspace mode: idle | live | alert | demo
  function syncMode() {
    const pill = $('mode-pill'), mapPill = $('map-pill');
    let mode = 'idle';
    if (mapPill && mapPill.textContent.trim() === 'Demo') mode = 'demo';
    else if (pill.classList.contains('alert-badge')) mode = 'alert';
    else if (pill.classList.contains('live-badge')) mode = 'live';
    document.body.dataset.mode = mode;
    const toggle = $('demo-toggle');
    toggle.setAttribute('aria-pressed', String(mode === 'demo'));
  }

  // ---- service status → ok | warn | bad | off
  const RULES = {
    'parrot-status': t => /^Live/.test(t) ? 'ok' : /Telemetry only/.test(t) ? 'warn' : 'off',
    'tiger-status': t => t === 'Connected' ? 'ok' : t === 'Unavailable' ? 'bad' : /Memory/.test(t) ? 'warn' : 'off',
    'gemini-status': t => /^(Connected|Ready)/.test(t) ? 'ok' : /Cannot connect/.test(t) ? 'bad' : 'off',
  };
  const PILL = {ok: 'pill ok', warn: 'pill warn', bad: 'pill warn', off: 'pill muted'};

  function syncService(id) {
    const el = $(id); if (!el) return;
    const text = el.textContent.trim();
    const unset = !text || text === '—' || text === 'Not checked';
    const level = unset ? 'off' : RULES[id](text);
    const cls = PILL[level] + (id === 'gemini-status' && level === 'ok' ? ' ai' : '');
    if (el.className !== cls) el.className = cls;
    const chip = document.querySelector(`.svc[data-svc="${id}"]`);
    if (chip) {
      chip.className = 'svc ' + level + (id === 'gemini-status' ? ' ai' : '');
      chip.title = `${chip.textContent.trim()}: ${unset ? 'not checked yet' : text}`;
    }
  }

  function syncDrone() {
    const el = $('drone-source'), t = el.textContent.trim();
    const cls = t === 'Live telemetry' ? 'pill ok' : /stale/i.test(t) ? 'pill warn' : 'pill muted';
    if (el.className !== cls) el.className = cls;
  }

  const watch = (el, fn) => el && new MutationObserver(fn).observe(el, {attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true});

  watch($('mode-pill'), syncMode); watch($('map-pill'), syncMode);
  for (const id of Object.keys(RULES)) { watch($(id), () => syncService(id)); syncService(id); }
  watch($('drone-source'), syncDrone);
  syncMode(); syncDrone();

  // Remove the lens intro once it has played so it never sits over the page.
  const intro = document.querySelector('.bx-intro');
  if (intro) {
    intro.addEventListener('animationend', e => { if (e.target === intro) intro.remove(); });
    setTimeout(() => intro.remove(), 1600);
  }
})();
