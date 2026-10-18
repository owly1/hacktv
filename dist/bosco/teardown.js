/* Drone teardown dialog on Home: a scroll-scrubbed exploded view of BSC-01.
   Performance model: all 120 frames are drawn to one <canvas>; scroll events
   only schedule one requestAnimationFrame, and the overlay DOM is touched only
   when the stage index or the 5 % progress counter changes. Frames load
   coarse-to-fine (every 8th, 4th, 2nd, then the rest) with at most six
   requests in flight, so any scroll position has a nearby frame early. */
(function () {
  'use strict';

  const FRAME_COUNT = 120;
  const FRAME_URL = i => `assets/teardown/frame-${String(i).padStart(3, '0')}.webp`;
  const MAX_IN_FLIGHT = 6;
  const FRAMES_END = 0.85;  // the last frame is reached at 85 % of the scroll
  const STAGES_END = 0.9;   // the last stage begins before the end of the scroll

  // Letter, word, callout title, callout body. Copy from reference/home.dc.html.
  const STAGES = [
    ['B', 'Bushfire', 'One airframe, five jobs.', 'Scroll to take BSC-01 apart. Each part maps to a stage of the BOSCO workflow.'],
    ['O', 'Observation', 'Stabilised gimbal camera', 'Watches the fire edge from above and streams it straight into the workspace. [Sensor: RGB / thermal]'],
    ['S', 'Simulation', 'Onboard flight computer', 'Tags every frame with position and time, so the fire-spread model starts from what the drone actually saw.'],
    ['C', 'Coordination', 'Nav lights and radio link', 'Keeps the unit visible to ground crews and in contact with the incident team.'],
    ['O', 'Operations', 'Swappable battery and airframe', 'Built to turn around fast between sorties. [Flight time per battery]'],
  ];
  const BLUE_KICKER = 3; // Coordination is about the nav lights: its kicker uses the drone-light blue.

  const $ = id => document.getElementById(id);
  const dialog = $('teardown');
  const canvas = $('teardown-canvas');
  const opener = $('open-teardown');
  const closeBtn = $('close-teardown');
  const pctEl = $('teardown-pct');
  const hint = $('teardown-hint');
  const end = $('teardown-end');
  const endLink = end.querySelector('a');
  if (!dialog || !canvas || !opener) return;

  const images = [];
  let drawn = -1;      // index of the frame currently on the canvas
  let wanted = 0;      // frame the scroll position asks for
  let raf = 0;
  let stage = -1, pct = -1;
  let ctx = null;

  // ---------- overlay DOM (built once) ----------
  const railItems = [], callouts = [];
  /** Build the B-O-S-C-O rail and the five callout cards. */
  function buildOverlay() {
    const rail = $('teardown-rail'), box = $('teardown-callouts');
    STAGES.forEach(([letter, word, title, body], i) => {
      const li = document.createElement('li');
      li.textContent = letter;
      const w = document.createElement('span'); w.className = 'word'; w.textContent = word;
      li.appendChild(w);
      rail.appendChild(li); railItems.push(li);

      const card = document.createElement('div');
      card.className = 'callout';
      card.setAttribute('aria-hidden', 'true');
      const k = document.createElement('div'); k.className = 'callout-kicker' + (i === BLUE_KICKER ? ' is-blue' : ''); k.textContent = word;
      const h = document.createElement('h2'); h.textContent = title;
      const p = document.createElement('p'); p.textContent = body;
      card.append(k, h, p);
      box.appendChild(card); callouts.push(card);
    });
  }
  buildOverlay();

  // ---------- frame loading ----------
  /** Whether a frame image has finished loading and can be drawn. */
  const ready = im => im && im.complete && im.naturalWidth > 0;

  /** Start loading every frame, coarse-to-fine, at most MAX_IN_FLIGHT at a time. Runs once per page. */
  function preload() {
    if (images.length) return;
    for (let i = 0; i < FRAME_COUNT; i++) images.push(new Image());
    const order = [], seen = new Set();
    for (const step of [8, 4, 2, 1]) {
      for (let i = 0; i < FRAME_COUNT; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
    let next = 0, busy = 0;
    const pump = () => {
      while (busy < MAX_IN_FLIGHT && next < order.length) {
        const i = order[next++], im = images[i];
        busy++;
        const done = () => {
          busy--;
          // A closer frame than the one on screen just arrived: show it.
          if (drawn < 0 || Math.abs(i - wanted) < Math.abs(drawn - wanted)) draw(wanted, true);
          pump();
        };
        im.onload = () => { (im.decode ? im.decode() : Promise.resolve()).then(done, done); };
        im.onerror = done;
        im.src = FRAME_URL(i);
      }
    };
    pump();
  }

  // ---------- drawing ----------
  /** Match the canvas backing store to its CSS box × devicePixelRatio (capped at 2). */
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; drawn = -1; }
  }

  /** Draw frame i (or the nearest loaded frame) with object-fit: contain. Skips redundant draws unless forced. */
  function draw(i, force) {
    wanted = i;
    let k = -1;
    for (let d = 0; d < FRAME_COUNT; d++) {
      if (ready(images[i - d])) { k = i - d; break; }
      if (ready(images[i + d])) { k = i + d; break; }
    }
    if (k < 0 || (k === drawn && !force)) return;
    const im = images[k];
    ctx = ctx || canvas.getContext('2d');
    const s = Math.min(canvas.width / im.naturalWidth, canvas.height / im.naturalHeight);
    const w = im.naturalWidth * s, h = im.naturalHeight * s;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(im, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    drawn = k;
  }

  // ---------- overlay state ----------
  /** Update the rail, callout, progress, hint and end CTA, only when the stage or 5 % counter changes. */
  function setOverlay(nextStage, nextPct) {
    if (nextStage !== stage) {
      railItems.forEach((li, i) => {
        li.classList.toggle('is-current', i === nextStage);
        li.classList.toggle('is-past', i < nextStage);
        if (i === nextStage) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      callouts.forEach((c, i) => {
        c.classList.toggle('is-current', i === nextStage);
        c.setAttribute('aria-hidden', String(i !== nextStage));
      });
      stage = nextStage;
    }
    if (nextPct !== pct) {
      pctEl.textContent = String(nextPct);
      hint.classList.toggle('is-hidden', nextPct !== 0);
      const atEnd = nextPct === 100;
      end.classList.toggle('is-visible', atEnd);
      endLink.tabIndex = atEnd ? 0 : -1;
      endLink.setAttribute('aria-hidden', String(!atEnd));
      pct = nextPct;
    }
  }

  /** Read the scroll position once per animation frame and update canvas + overlay. */
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const max = dialog.scrollHeight - dialog.clientHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, dialog.scrollTop / max)) : 0;
      draw(Math.round(Math.min(1, p / FRAMES_END) * (FRAME_COUNT - 1)));
      const nextStage = Math.min(STAGES.length - 1, Math.floor(Math.min(0.999, p / STAGES_END) * STAGES.length));
      const nextPct = p > 0.96 ? 100 : Math.floor(p * 20) * 5;
      setOverlay(nextStage, nextPct);
    });
  }

  /** Re-fit the canvas after a viewport change. */
  function onResize() { sizeCanvas(); draw(wanted, true); }

  /** Keep Tab focus inside the dialog; Escape closes it. */
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusables = [closeBtn, endLink].filter(el => el.tabIndex >= 0);
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  // ---------- open / close ----------
  /** Open the teardown at 0 %: start preloading, attach listeners, move focus to Close. */
  function open() {
    preload();
    dialog.hidden = false;
    document.documentElement.classList.add('is-teardown-open');
    dialog.scrollTop = 0;
    stage = -1; pct = -1; drawn = -1; wanted = 0;
    setOverlay(0, 0);
    sizeCanvas();
    draw(0, true);
    dialog.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    closeBtn.focus();
  }

  /** Close the dialog, remove its listeners and return focus to the drone chip. Loaded frames stay cached. */
  function close() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    document.documentElement.classList.remove('is-teardown-open');
    dialog.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    opener.focus();
  }

  opener.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  window.BoscoTeardown = { open, close };
})();
