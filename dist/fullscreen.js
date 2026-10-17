/* Panel full-screen mode. Sidebar links and each panel's expand button show one dashboard feature filling the screen. */
(function () {
  'use strict';
  const PANELS = {
    'map-panel': 'Fire spread explorer',
    'drone-panel': 'ANAFI-01 drone feed',
    'analysis-panel': 'Gemini analysis',
    'response-panel': 'Response planning assistant',
  };
  const railLinks = [...document.querySelectorAll('.rail-links a[href^="#"]')];
  let current = null;

  function setButton(panel, on) {
    const button = panel.querySelector('.fs-button');
    button.innerHTML = `<svg aria-hidden="true"><use href="#${on ? 'i-shrink' : 'i-expand'}"/></svg>`;
    button.setAttribute('aria-label', `${on ? 'Exit full screen' : 'Full screen'}: ${PANELS[panel.id]}`);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Exit full screen (Esc)' : 'Full screen';
  }

  function syncRail() {
    for (const link of railLinks) link.classList.toggle('active', !!current && link.hash === '#' + current.id);
  }

  function open(panel) {
    if (current === panel) return;
    if (current) close(true);
    current = panel;
    panel.classList.add('is-fullscreen');
    document.body.classList.add('panel-fullscreen');
    setButton(panel, true);
    syncRail();
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    refit();
    showHint();
    panel.querySelector('.fs-button').focus({ preventScroll: true });
  }

  // Leaflet measures its container on resize; re-measure after the open animation too.
  function refit() {
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
  }

  function showHint() {
    document.querySelector('.fs-hint')?.remove();
    const hint = document.createElement('div');
    hint.className = 'fs-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = 'Full screen · press Esc to exit';
    document.body.append(hint);
    setTimeout(() => hint.remove(), 2800);
  }

  function close(keepBrowserFullscreen = false) {
    if (!current) return;
    const panel = current;
    current = null;
    panel.classList.remove('is-fullscreen');
    document.body.classList.remove('panel-fullscreen');
    setButton(panel, false);
    syncRail();
    if (!keepBrowserFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.querySelector('.fs-hint')?.remove();
    refit();
  }

  for (const id of Object.keys(PANELS)) {
    const panel = document.getElementById(id);
    const header = panel && panel.querySelector('.panel-header');
    if (!header) continue;
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    if (header.children.length > 1) actions.append(header.lastElementChild);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fs-button';
    button.addEventListener('click', () => (current === panel ? close() : open(panel)));
    actions.append(button);
    header.append(actions);
    setButton(panel, false);
  }

  for (const link of railLinks) {
    link.addEventListener('click', (event) => {
      const panel = document.getElementById(link.hash.slice(1));
      if (!panel || !(panel.id in PANELS)) return;
      event.preventDefault();
      current === panel ? close() : open(panel);
    });
  }

  // The wordmark returns to the dashboard overview from any full-screen feature.
  // The logo does the same while a panel is full screen; otherwise it opens the BOSCO home page.
  for (const home of document.querySelectorAll('.brand-mark, .wordmark')) {
    home.addEventListener('click', (event) => {
      if (home.classList.contains('brand-mark') && !current) return;
      event.preventDefault();
      close();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Browser Esc leaves native full screen first; collapse the panel with it.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && current) close(true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current && !document.querySelector('dialog[open]')) close();
  });
})();
