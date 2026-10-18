/* Emberwatch fire-spread model on real map coordinates.
   A detected fire starts as a disc of its reported (or camera-estimated) area,
   then grows as a wind-driven ellipse: the head runs downwind at the spread
   rate, the back burns slowly, and stronger wind makes the shape longer and
   narrower. Heat, dryness and low humidity speed it up. */
(function(root) {
  const BASE = Object.freeze({wind:18, direction:45, dryness:65, temp:20, rh:40});
  const M_PER_DEG = 111320;
  /** Convert a clockwise-from-north bearing into an eight-point compass label. */
  function compass(deg) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(((deg%360)+360)%360/45)%8]; }
  /** Approximate a geographic offset from a bearing in degrees and distance in metres. */
  function destPoint(lat, lon, bearingDeg, distM) {
    const b = bearingDeg*Math.PI/180;
    return [lat + distM*Math.cos(b)/M_PER_DEG, lon + distM*Math.sin(b)/(M_PER_DEG*Math.cos(lat*Math.PI/180))];
  }
  /* Hotter, drier, less humid -> faster. Clamped so extreme inputs stay readable. */
  function envFactor(sc) {
    return Math.max(.5, Math.min(2.2, 1 + (sc.dryness-50)/120 + (sc.temp-20)/90 - (sc.rh-40)/140));
  }
  /* Wind drives the head-fire rate superlinearly, then saturates: published
     grass-fire curves (McArthur / CSIRO) are convex in wind speed until
     flame-front heat transfer, not wind, becomes the limit. Coefficient is
     tuned so the 18 km/h baseline matches the previous linear model; the
     ~60 km/h cap marks where extrapolation would be irresponsible rather
     than a physical constant. Illustrative — honest shape, not fitted data. */
  const RATE_WIND_EXP = 1.2, RATE_WIND_COEF = .505, RATE_WIND_CAP_KMH = 60;
  function windRateFactor(kmh) { return RATE_WIND_COEF * Math.pow(Math.min(Math.max(0, kmh), RATE_WIND_CAP_KMH), RATE_WIND_EXP); }
  /* Head-fire spread rate in metres per minute. */
  function baseRate(sc) { return (1.5 + windRateFactor(sc.wind)) * envFactor(sc); }
  /* A reported rate holds at the reported conditions; changing the inputs scales it. */
  function spreadRate(sc, details) {
    if (details && Number.isFinite(details.spread_m_per_min)) return details.spread_m_per_min*baseRate(sc)/baseRate(scenarioFrom(details));
    return baseRate(sc);
  }
  /** Convert reported hectares into an equivalent initial fire radius in metres. */
  function startRadius(details) {
    const ha = details && Number.isFinite(details.area_ha) && details.area_ha > 0 ? details.area_ha : .05;
    return Math.sqrt(ha*10000/Math.PI);
  }
  /* Scenario inputs implied by a detection's reported conditions. */
  function scenarioFrom(details) {
    const d = details || {};
    return {
      wind: Number.isFinite(d.wind_kmh) ? d.wind_kmh : BASE.wind,
      direction: Number.isFinite(d.wind_dir_deg) ? d.wind_dir_deg : BASE.direction,
      dryness: Number.isFinite(d.rh_pct) ? Math.max(0, Math.min(100, 100-d.rh_pct)) : BASE.dryness,
      temp: Number.isFinite(d.temp_c) ? d.temp_c : BASE.temp,
      rh: Number.isFinite(d.rh_pct) ? d.rh_pct : BASE.rh,
    };
  }
  /* Fire outline after `minutes`, as [lat, lon] points. scale < 1 gives the
     hotter inner bands, which sit toward the head of the fire. */
  function footprint(origin, minutes, sc, details, scale=1) {
    const r0 = startRadius(details), t = Math.max(0, minutes);
    const rate = spreadRate(sc, details);
    const lw = Math.min(4, 1 + sc.wind/35);                // length-to-width ratio
    const head = r0 + rate*t, back = r0 + rate*t*.12;
    const a = (head+back)/2, b = Math.max(r0, a/lw);
    const shift = (head-back)/2 + (1-scale)*a*Math.min(.5, .2 + sc.wind/80); // inner bands lean downwind, more so in stronger wind
    const centre = destPoint(origin[0], origin[1], sc.direction, shift);
    const pts = [];
    for (let i = 0; i < 72; i++) {
      const ang = i/72*Math.PI*2;
      const wob = 1 + .06*Math.sin(ang*5 + sc.direction/40) + .035*Math.cos(ang*9);
      const u = a*scale*Math.cos(ang)*wob, v = b*scale*Math.sin(ang)*wob;
      pts.push(destPoint(centre[0], centre[1], sc.direction + Math.atan2(v, u)*180/Math.PI, Math.hypot(u, v)));
    }
    return pts;
  }
  /** Estimate polygon area in hectares using a local geographic projection. */
  function areaHa(points) {
    if (!points.length) return 0;
    const lat0 = points[0][0]*Math.PI/180;
    let s = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i+1)%points.length];
      s += (p[1]*Math.cos(lat0))*q[0] - (q[1]*Math.cos(lat0))*p[0];
    }
    return Math.abs(s)/2*M_PER_DEG*M_PER_DEG/10000;
  }
  /** Return projected downwind head distance in metres after the specified minutes. */
  function headDistance(minutes, sc, details) { return startRadius(details) + spreadRate(sc, details)*Math.max(0, minutes); }
  /* Recorded burn ellipse for a historical (demo) fire, elongated along its spread direction. */
  function recordedPerimeter(f) {
    const area = f.areaHa*10000, a = Math.sqrt(area*2.4/Math.PI), b = area/(Math.PI*a);
    const centre = destPoint(f.lat, f.lon, f.directionDeg, a*.45), pts = [];
    for (let i = 0; i < 64; i++) {
      const ang = i/64*Math.PI*2, wob = 1 + .08*Math.sin(ang*5 + f.directionDeg) + .05*Math.cos(ang*7);
      const u = a*Math.cos(ang)*wob, v = b*Math.sin(ang)*wob;
      pts.push(destPoint(centre[0], centre[1], f.directionDeg + Math.atan2(v, u)*180/Math.PI, Math.hypot(u, v)));
    }
    return pts;
  }
  /** Test whether a latitude/longitude point lies within the modeled outline. */
  function insidePolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /* Minutes until the projected fire outline first covers `point` ([lat, lon]):
     0 if it is inside the fire now, null if not within `maxMin`. The outline only
     grows, so a bisection on time is enough. A projection, not a forecast. */
  function arrivalMinutes(origin, point, sc, details, maxMin=180) {
    if (insidePolygon(point, footprint(origin, 0, sc, details))) return 0;
    if (!insidePolygon(point, footprint(origin, maxMin, sc, details))) return null;
    let lo = 0, hi = maxMin;
    while (hi - lo > .5) { const mid = (lo + hi)/2; if (insidePolygon(point, footprint(origin, mid, sc, details))) hi = mid; else lo = mid; }
    return Math.round(hi);
  }
  const api = {BASE, compass, destPoint, envFactor, windRateFactor, spreadRate, startRadius, scenarioFrom, footprint, areaHa, headDistance, recordedPerimeter, insidePolygon, arrivalMinutes};
  root.EmberModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
