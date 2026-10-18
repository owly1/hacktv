/* Page transitions between BOSCO Home and the Dashboard, built to read as one
   continuous motion across the navigation:
     leave(): content recedes (0.4 s), dark cover fades in (0.4 s) while the
              mark spins in at 132 px (0.45 s); navigation happens at 420 ms.
     arrive(): the next page mounts under the same cover; the mark spins out
              (0.6 s), the cover holds for 30 % of 0.8 s then fades, and the
              content rises 12 px over 0.7 s.
   Under prefers-reduced-motion both are skipped and navigation is immediate.
   Exposes window.BoscoTransition; depends on window.BoscoMark. */
(function () {
  'use strict';

  const NAVIGATE_AFTER_MS = 420;
  const COVER_GONE_MS = 900;     // 0.8 s veil plus a small margin
  const HOME_INTRO_FLAG = 'bx-home-intro';

  /** True when the visitor asked the OS for reduced motion. */
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Build the full-screen cover holding a 132 px mark; phase is 'in' or 'out'. */
  function makeCover(phase) {
    const cover = document.createElement('div');
    cover.className = 'bx-cover is-' + phase;
    cover.setAttribute('aria-hidden', 'true');
    cover.appendChild(window.BoscoMark({ size: 132, animated: false, ringColor: 'var(--cover-ring)', bgColor: 'var(--cover-bg)' }));
    return cover;
  }

  let leaving = false;
  let leaveTimer = 0;

  /**
   * Play the leave sequence over `content` (an element or list of elements),
   * then navigate to `href`. `beforeLeave` runs first (e.g. stop playback).
   * `flag` (optional) is written to sessionStorage so the next page plays its intro.
   */
  function leave({ href, content = [], beforeLeave, flag }) {
    if (leaving) return;
    if (beforeLeave) beforeLeave();
    if (flag) { try { sessionStorage.setItem(flag, '1'); } catch (err) { /* storage blocked: next page skips its intro */ } }
    if (reducedMotion()) { location.href = href; return; }
    leaving = true;
    // Drop a finished arrive animation first; otherwise it would override the recede.
    for (const el of [].concat(content)) if (el) { el.classList.remove('bx-rise'); el.classList.add('bx-leave'); }
    document.body.appendChild(makeCover('in'));
    leaveTimer = setTimeout(() => { location.href = href; }, NAVIGATE_AFTER_MS);
  }

  /** Undo a leave when the page is restored from the back/forward cache. */
  function resetLeave() {
    clearTimeout(leaveTimer);
    leaving = false;
    document.querySelectorAll('.bx-leave').forEach(el => el.classList.remove('bx-leave'));
    document.querySelectorAll('.bx-cover').forEach(el => el.remove());
  }
  window.addEventListener('pageshow', e => { if (e.persisted) resetLeave(); });

  /** Play the arrive sequence over `content`; the cover removes itself when done. */
  function arrive({ content = [] } = {}) {
    const preCover = () => document.documentElement.classList.remove('bx-pre-cover');
    if (reducedMotion()) { preCover(); return; }
    for (const el of [].concat(content)) if (el) el.classList.add('bx-rise');
    const cover = makeCover('out');
    document.body.appendChild(cover);
    preCover(); // the real cover now sits where the pre-paint placeholder was
    const done = () => cover.remove();
    cover.addEventListener('animationend', e => { if (e.target === cover) done(); });
    setTimeout(done, COVER_GONE_MS);
  }

  /** Read and clear a one-shot sessionStorage flag; false if absent or storage is blocked. */
  function takeFlag(flag) {
    try {
      const on = sessionStorage.getItem(flag) === '1';
      if (on) sessionStorage.removeItem(flag);
      return on;
    } catch (err) { return false; }
  }

  /**
   * Route plain left-clicks on `link` through leave(). Modified clicks
   * (new tab/window) keep normal browser behaviour.
   */
  function bindLink(link, options) {
    link.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      leave({ href: link.href, ...(typeof options === 'function' ? options() : options) });
    });
  }

  window.BoscoTransition = { leave, arrive, bindLink, takeFlag, HOME_INTRO_FLAG };
})();
