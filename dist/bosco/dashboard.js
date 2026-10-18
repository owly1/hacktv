/* BOSCO presentation only. app.js and people.js own all live/replay state,
   API requests, cameras, telemetry, forecasts and review actions. */
(function () {
  'use strict';
  const root = document.documentElement;
  const themeButton = document.getElementById('theme-toggle');
  const transition = window.BoscoTransition;
  window.BoscoMark.mountAll();

  /** Keep the theme control and browser chrome consistent with the selected theme. */
  function syncTheme() {
    const light = root.dataset.theme === 'light';
    const label = `Switch to ${light ? 'dark' : 'light'} theme`;
    themeButton.setAttribute('aria-label', label);
    themeButton.setAttribute('aria-pressed', String(light));
    themeButton.title = label;
    document.querySelector('meta[name="theme-color"]').content = light ? '#F4F3EF' : '#08080A';
  }
  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('bx-theme', root.dataset.theme); } catch { /* Still works without persistence. */ }
    syncTheme();
  });
  syncTheme();

  /** Show the scenario picker only when the real replay controller exposes it. */
  function syncReplayPicker() {
    document.getElementById('replay-picker').hidden = document.getElementById('demo-fire').hidden;
  }
  new MutationObserver(syncReplayPicker).observe(document.getElementById('demo-fire'), {
    attributes: true, attributeFilter: ['hidden'],
  });
  syncReplayPicker();

  // fullscreen.js handles overview navigation first; bindLink respects preventDefault.
  transition.bindLink(document.getElementById('rail-home'), {
    content: document.getElementById('overview'), flag: transition.HOME_INTRO_FLAG,
  });
  transition.arrive({ content: document.getElementById('overview') });
})();
