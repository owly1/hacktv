/* BoscoMark: the animated BOSCO logo mark, shared by Home, the Dashboard and
   the page-transition cover. Plain browser script; exposes window.BoscoMark.
   The geometry matches assets/bosco-mark.svg: a four-segment reticle ring,
   the flame core in accent red, and the blue drone light orbiting the centre.
   Motion lives in mark.css and stops under prefers-reduced-motion. */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FLAME = 'M50 32.5 C52.2 39.5 61.5 44.5 61.5 55.6 C61.5 62.4 56.3 67.5 50 67.5 C43.7 67.5 38.5 62.4 38.5 55.6 C38.5 50.2 41.4 46.4 44.6 43.8 C44.6 47.9 46.2 50.6 48.3 51.6 C47.7 45.2 48.3 38.6 50 32.5 Z M50 52.2 C52.6 55.1 54.6 57.3 54.6 60.2 C54.6 62.8 52.5 64.8 50 64.8 C47.5 64.8 45.4 62.8 45.4 60.2 C45.4 57.4 47.4 55.1 50 52.2 Z';

  /** Create an SVG element with the given attributes. */
  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  /**
   * Build the mark as an <svg> element (decorative: aria-hidden).
   * size: CSS length (number = px; '0.86em' etc. for the wordmark).
   * animated: flame sway and orbiting dot. ringColor / bgColor: CSS colours
   * for the ring and for the dot's cut-out stroke (match what sits behind it).
   */
  function BoscoMark({ size = 32, animated = true, ringColor = 'var(--text)', bgColor = 'var(--bg)' } = {}) {
    const svg = el('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false', class: 'bx-mark' + (animated ? ' is-animated' : '') });
    const len = typeof size === 'number' ? size + 'px' : size;
    svg.style.width = len;
    svg.style.height = len;
    svg.appendChild(el('circle', {
      cx: 50, cy: 50, r: 40, fill: 'none', stroke: ringColor, 'stroke-width': 15,
      'stroke-dasharray': '52.8 10', 'stroke-dashoffset': -5, transform: 'rotate(-90 50 50)',
    }));
    const flame = el('g', { class: 'bx-mark-flame' });
    flame.appendChild(el('path', { d: FLAME, fill: 'var(--accent)', 'fill-rule': 'evenodd' }));
    svg.appendChild(flame);
    const orbit = el('g', { class: 'bx-mark-orbit' });
    orbit.appendChild(el('circle', { cx: 50, cy: 3, r: 6, fill: 'var(--drone-blue)', stroke: bgColor, 'stroke-width': 3 }));
    svg.appendChild(orbit);
    return svg;
  }

  /**
   * Fill `host` with the BOSCO wordmark: "B" + mark (0.86em, replacing the O)
   * + "SCO". The host keeps its own font styling and gets aria-label="BOSCO".
   */
  function mountWordmark(host, options = {}) {
    host.setAttribute('aria-label', 'BOSCO');
    host.classList.add('bx-wordmark');
    host.replaceChildren();
    const b = document.createElement('span'); b.textContent = 'B'; b.setAttribute('aria-hidden', 'true');
    const sco = document.createElement('span'); sco.textContent = 'SCO'; sco.setAttribute('aria-hidden', 'true');
    host.append(b, BoscoMark({ size: '0.86em', ...options }), sco);
  }

  /** Replace every [data-bosco-mark] placeholder with a mark, reading its data-* options. */
  function mountAll(root = document) {
    for (const slot of root.querySelectorAll('[data-bosco-mark]')) {
      const d = slot.dataset;
      const mark = BoscoMark({
        size: d.size ? (isNaN(d.size) ? d.size : Number(d.size)) : 32,
        animated: d.animated !== 'false',
        ringColor: d.ringColor || undefined,
        bgColor: d.bgColor || undefined,
      });
      for (const c of slot.classList) mark.classList.add(c);
      slot.replaceWith(mark);
    }
    for (const host of root.querySelectorAll('[data-bosco-wordmark]')) {
      mountWordmark(host, { bgColor: host.dataset.bgColor || undefined });
    }
  }

  window.BoscoMark = Object.assign(BoscoMark, { mountWordmark, mountAll });
})();
