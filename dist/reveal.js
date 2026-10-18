/* Home page exploded view. Scroll position maps straight to one frame of the
   drone image sequence, drawn into a canvas; nothing plays on a timer.
   Scrolling down takes the drone from assembled to exploded, scrolling up
   puts it back together. */
(function () {
  'use strict';

  // ---- settings
  // Frames are FRAME_DIR/full/frame-0001.jpg … (1920×1080) and the same names in
  // FRAME_DIR/small (960×540), numbered in playback order.
  const FRAME_DIR = 'assets/exploded';
  const FRAME_COUNT = 205;
  const BACKDROP = `${FRAME_DIR}/backdrop.jpg`;  // the empty studio, for filling letterbox bars
  const STILL_FRAME = FRAME_COUNT - 1;  // shown alone with reduced motion: the full exploded view
  const FULL_SET_MIN_PX = 1100;         // drawn width (device px) above which the 1920 set is used
  // The scroll length lives in home.html: --reveal-scroll on .reveal.

  const section = document.getElementById('reveal');
  if (!section) return;
  const sticky = section.querySelector('.reveal-sticky');
  const canvas = section.querySelector('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const background = getComputedStyle(section).backgroundColor;  // --reveal-backdrop
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const IDLE = 0, LOADING = 1, READY = 2, FAILED = 3;
  const images = new Array(FRAME_COUNT);
  const status = new Uint8Array(FRAME_COUNT);
  // Coarse-to-fine order, so a fast scrub always finds a frame close by.
  const order = [];
  for (const step of [32, 16, 8, 4, 2, 1]) {
    for (let i = 0; i < FRAME_COUNT; i += step) if (!order.includes(i)) order.push(i);
  }
  if (!order.includes(FRAME_COUNT - 1)) order.splice(1, 0, FRAME_COUNT - 1);

  let set = '';            // 'full' or 'small', picked once from the drawn size
  let maxInFlight = 4;
  let inFlight = 0;
  let orderCursor = 0;
  let loadAll = false;     // true once the section is near the viewport
  let target = reducedMotion.matches ? STILL_FRAME : 0;  // frame the scroll position asks for
  let drawn = -1;          // frame currently on the canvas
  let dirty = true;        // canvas resized or cleared: repaint even if drawn === target
  let raf = 0;
  let stopped = false;

  // Letterbox bars are filled by stretching the empty studio's edge pixels, so
  // the photo's own backdrop runs to the canvas edges without a seam.
  const backdrop = new Image();
  backdrop.onload = () => { dirty = true; schedule(); };
  backdrop.src = BACKDROP;

  const still = () => reducedMotion.matches;
  const url = i => `${FRAME_DIR}/${set}/frame-${String(i + 1).padStart(4, '0')}.jpg`;

  function load(i) {
    status[i] = LOADING;
    inFlight++;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (stopped) return;
      images[i] = img;
      status[i] = READY;
      inFlight--;
      if (drawn === -1 || Math.abs(i - target) < Math.abs(drawn - target)) schedule();
      pump();
    };
    img.onerror = () => {
      if (stopped) return;
      status[i] = FAILED;
      inFlight--;
      pump();
    };
    img.src = url(i);
  }

  function nextToLoad() {
    // The requested frame and its neighbours first, then everything else.
    const reach = loadAll && !still() ? 6 : 0;
    for (let d = 0; d <= reach; d++) {
      for (const i of d ? [target + d, target - d] : [target]) {
        if (i >= 0 && i < FRAME_COUNT && status[i] === IDLE) return i;
      }
    }
    if (!loadAll || still()) return -1;
    while (orderCursor < order.length && status[order[orderCursor]] !== IDLE) orderCursor++;
    return orderCursor < order.length ? order[orderCursor] : -1;
  }

  function pump() {
    if (!set || stopped) return;
    let i;
    while (inFlight < maxInFlight && (i = nextToLoad()) !== -1) load(i);
  }

  function progress() {
    const distance = section.offsetHeight - sticky.offsetHeight;
    if (distance <= 0) return 0;
    const p = -section.getBoundingClientRect().top / distance;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function schedule() {
    if (!raf && !stopped) raf = requestAnimationFrame(render);
  }

  function render() {
    raf = 0;
    const want = still() ? STILL_FRAME : Math.round(progress() * (FRAME_COUNT - 1));
    if (want !== target) { target = want; pump(); }
    // Draw the requested frame; while it loads, keep whatever is on the canvas
    // unless a loaded frame closer to the request is available.
    let pick = status[target] === READY ? target : -1;
    if (pick === -1) {
      const limit = drawn === -1 || dirty ? FRAME_COUNT : Math.abs(drawn - target);
      for (let d = 1; d < limit && pick === -1; d++) {
        if (status[target - d] === READY) pick = target - d;
        else if (status[target + d] === READY) pick = target + d;
      }
    }
    if (pick === -1 || (pick === drawn && !dirty)) return;
    paint(pick);
  }

  function paint(i) {
    const img = images[i];
    const w = canvas.width, h = canvas.height;
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = Math.round(img.naturalWidth * scale), dh = Math.round(img.naturalHeight * scale);
    const dx = Math.round((w - dw) / 2), dy = Math.round((h - dh) / 2);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    if (backdrop.complete && backdrop.naturalWidth) {
      const bw = backdrop.naturalWidth, bh = backdrop.naturalHeight, r = w - dx - dw, b = h - dy - dh;
      // edges (1 px overlap into the photo hides rounding seams), then corners
      if (dx > 0) { ctx.drawImage(backdrop, 0, 0, 1, bh, 0, dy, dx + 1, dh); ctx.drawImage(backdrop, bw - 1, 0, 1, bh, dx + dw - 1, dy, r + 1, dh); }
      if (dy > 0) { ctx.drawImage(backdrop, 0, 0, bw, 1, dx, 0, dw, dy + 1); ctx.drawImage(backdrop, 0, bh - 1, bw, 1, dx, dy + dh - 1, dw, b + 1); }
      if (dx > 0 && dy > 0) {
        ctx.drawImage(backdrop, 0, 0, 1, 1, 0, 0, dx + 1, dy + 1);
        ctx.drawImage(backdrop, bw - 1, 0, 1, 1, dx + dw - 1, 0, r + 1, dy + 1);
        ctx.drawImage(backdrop, 0, bh - 1, 1, 1, 0, dy + dh - 1, dx + 1, b + 1);
        ctx.drawImage(backdrop, bw - 1, bh - 1, 1, 1, dx + dw - 1, dy + dh - 1, r + 1, b + 1);
      }
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    // Letterbox bars fade from the photo's edge to the flat backdrop grey.
    const clear = background.replace(/^rgb\((.*)\)$/, 'rgba($1, 0)');
    const band = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, clear); g.addColorStop(1, background);
      ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    };
    if (dy > 0) { band(0, dy, 0, 0, 0, 0, w, dy); band(0, dy + dh, 0, h, 0, dy + dh, w, h - dy - dh); }
    if (dx > 0) { band(dx, 0, 0, 0, 0, 0, dx, h); band(dx + dw, 0, w, 0, dx + dw, 0, w - dx - dw, h); }
    // Melt the top edge into the flat grey the page fades into above the section.
    const fade = Math.round(h * 0.14);
    const grad = ctx.createLinearGradient(0, 0, 0, fade);
    grad.addColorStop(0, background);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, fade);
    drawn = i;
    dirty = false;
    canvas.dataset.frame = String(i + 1);
    // Decode the neighbours ahead of time so the next scroll step draws without a stall.
    for (const j of [i - 1, i + 1, i + 2]) if (status[j] === READY) images[j].decode().catch(() => {});
  }

  function resize() {
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);  // past 2× only costs memory
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (!set) {
      // Phones get the 960 px frames: their drawn width rarely needs more.
      const drawnPx = Math.min(w, h * 16 / 9);
      set = drawnPx > FULL_SET_MIN_PX ? 'full' : 'small';
      maxInFlight = set === 'full' ? 6 : 4;
      pump();
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    }
    schedule();
  }

  const onScroll = () => { if (loadAll) schedule(); };
  const onMotionChange = () => { dirty = true; schedule(); pump(); };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sticky);
  // Start fetching the sequence a viewport before the section arrives.
  const nearObserver = new IntersectionObserver(entries => {
    const near = entries.some(e => e.isIntersecting);
    if (near && !loadAll) { loadAll = true; pump(); }
    if (near) schedule();
  }, { rootMargin: '100% 0px 100% 0px' });
  nearObserver.observe(section);
  window.addEventListener('scroll', onScroll, { passive: true });
  reducedMotion.addEventListener('change', onMotionChange);
  resize();

  function destroy() {
    stopped = true;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    nearObserver.disconnect();
    window.removeEventListener('scroll', onScroll);
    reducedMotion.removeEventListener('change', onMotionChange);
  }
  // A page kept in the back/forward cache keeps running; a page being discarded cleans up.
  window.addEventListener('pagehide', e => { if (!e.persisted) destroy(); });
})();
