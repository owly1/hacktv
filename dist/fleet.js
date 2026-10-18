/* Fleet algorithms for BOSCO (docs/FLEET_MODEL.md): wind consensus across
   drones, measured fire extent, sector growth rates, and formation geometry.
   Pure math — no DOM, no network. Loadable in the browser (root.BoscoFleet)
   and node (module.exports). All angles are clockwise-from-north degrees and
   distances are metres unless noted. */
(function(root) {
  const M_PER_DEG = 111320, DEG = Math.PI/180;
  /** Offset a [lat, lon] by metres east/north. */
  function llMove(lat, lon, e, n) {
    return [lat + n/M_PER_DEG, lon + e/(M_PER_DEG*Math.cos(lat*DEG))];
  }
  /** Metres east/north of b relative to a. */
  function llDiff(a, b) {
    return [(b[1]-a[1])*M_PER_DEG*Math.cos(a[0]*DEG), (b[0]-a[0])*M_PER_DEG];
  }

  // ------------------------------------------------------- wind consensus

  /* Confidence in an FC wind estimate by flight state: the estimator is most
     reliable when the aircraft is stable. */
  const STATE_CONF = {hovering:1, holding:1, flying:.7, orbiting:.7, climbing:.4, descending:.4, maneuvering:.4, takingoff:.3, landing:.3, landed:0, emergency:0};
  const TAU_MS = 30000, MAX_ITER = 5, REJECT_DEG = 45, REJECT_RATIO = 3;

  /** Confidence weight for a flight state string (unknown states score mid). */
  function stateConfidence(state) { return STATE_CONF[state] ?? .6; }

  /** Bearing (deg, toward) of a (north, east) wind vector. */
  function towardDeg(north, east) { return (Math.atan2(east, north)/DEG + 360) % 360; }

  /* One trimmed-mean pass: return the weighted vector mean of samples that
     sit inside the acceptance cone of the current mean. A near-calm field
     (<0.5 m/s) cannot disagree directionally, so nothing is rejected. */
  function trimmedMean(samples, mean) {
    const mSpeed = Math.hypot(mean.north, mean.east);
    if (mSpeed < .5) return {mean, accepted: samples, rejected: []};
    const speeds = samples.map(s => Math.hypot(s.north, s.east)).sort((a, b) => a - b);
    const median = speeds.length ? speeds[Math.floor(speeds.length/2)] : 0;
    const accepted = [], rejected = [];
    for (const s of samples) {
      const speed = Math.hypot(s.north, s.east);
      const cos = (s.north*mean.north + s.east*mean.east)/((speed*mSpeed) || 1e-9);
      const dev = Math.acos(Math.max(-1, Math.min(1, cos)))/DEG;
      (dev <= REJECT_DEG && speed <= REJECT_RATIO*Math.max(median, .1) ? accepted : rejected).push(s);
    }
    if (!accepted.length) return {mean, accepted, rejected: samples.map(s => s.drone_id)};
    let n = 0, e = 0, w = 0;
    for (const s of accepted) { n += s.weight*s.north; e += s.weight*s.east; w += s.weight; }
    return {mean: {north: n/w, east: e/w}, accepted, rejected: rejected.map(s => s.drone_id)};
  }

  /* Weighted circular spread of accepted unit vectors — the honest
     "how much do the drones disagree" number. */
  function circularSpread(samples) {
    if (samples.length < 2) return 0;
    let x = 0, y = 0;
    for (const s of samples) { const m = Math.hypot(s.north, s.east) || 1e-9; x += s.east/m; y += s.north/m; }
    const R = Math.hypot(x, y)/samples.length;
    return R >= 1 ? 0 : Math.sqrt(-2*Math.log(R))/DEG;
  }

  /** Aggregate per-drone FC wind vectors into one consensus estimate.
      samples: [{drone_id, north, east, captured_at(ms), flight_state}]
      -> {vector:{north,east}, speed_kmh, toward_deg, sigma_dir_deg,
          sigma_mag_mps, samples, rejected, computed_at} */
  function windConsensus(samples, now = Date.now()) {
    /* FC wind is measured at flight altitude; higher drones feel more wind.
       Normalise every sample to the 10 m reference (Hellmann 1/7 power law)
       before fusing, so altitude never masquerades as disagreement. */
    const altScale = s => (root.EmberModel?.altitudeWindScale ? root.EmberModel.altitudeWindScale(s.alt_m ?? 10) : 1);
    const weighted = (samples || []).filter(s => Number.isFinite(s.north) && Number.isFinite(s.east))
      .map(s => { const k = altScale(s); return {...s, north: s.north/k, east: s.east/k, weight: Math.exp(-Math.max(0, now - s.captured_at)/TAU_MS)*stateConfidence(s.flight_state)}; })
      .filter(s => s.weight > 0);
    if (!weighted.length) return null;
    let mean = {north: weighted.reduce((a, s) => a + s.weight*s.north, 0)/weighted.reduce((a, s) => a + s.weight, 0),
                east: weighted.reduce((a, s) => a + s.weight*s.east, 0)/weighted.reduce((a, s) => a + s.weight, 0)};
    let pass = {accepted: weighted, rejected: []};
    for (let i = 0; i < MAX_ITER; i++) {
      pass = trimmedMean(weighted, mean);
      const next = pass.mean, moved = Math.hypot(next.north - mean.north, next.east - mean.east);
      mean = next;
      if (moved < 1e-6) break;
    }
    const mags = pass.accepted.map(s => Math.hypot(s.north, s.east));
    const sigmaMag = mags.length > 1 ? Math.sqrt(mags.reduce((a, m) => a + (m - mags.reduce((x, y) => x + y, 0)/mags.length)**2, 0)/(mags.length - 1)) : 0;
    return {vector: mean, speed_kmh: +(Math.hypot(mean.north, mean.east)*3.6).toFixed(1),
      toward_deg: Math.round(towardDeg(mean.north, mean.east)),
      sigma_dir_deg: +circularSpread(pass.accepted).toFixed(1), sigma_mag_mps: +sigmaMag.toFixed(2),
      samples: weighted.length, rejected: pass.rejected, computed_at: new Date(now).toISOString()};
  }

  // ----------------------------------------------------- formation geometry

  /* Cumulative arc-length table for an ellipse (centred, eccentric anomaly
     parameter): ds = sqrt(a² sin²E + b² cos²E) dE. 1440 samples ≈ mm accuracy. */
  function ellipseArcTable(a, b, steps = 1440) {
    const cum = [0]; let s = 0, prev = E => 0;
    prev = 0;
    let px = a, py = 0;
    for (let i = 1; i <= steps; i++) {
      const E = i/steps*2*Math.PI, x = a*Math.cos(E), y = b*Math.sin(E);
      s += Math.hypot(x - px, y - py); px = x; py = y; cum.push(s);
    }
    return {cum, steps, total: s};
  }

  /** Eccentric anomaly for arc length s along the ellipse table (linear interp). */
  function eccentricForArc(table, s) {
    const {cum, steps} = table;
    s = ((s % table.total) + table.total) % table.total;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (cum[mid] <= s ? lo = mid : hi = mid); }
    const k = cum[hi] === cum[lo] ? 0 : (s - cum[lo])/(cum[hi] - cum[lo]);
    return (lo + k)/steps*2*Math.PI;
  }

  /** N stations evenly spaced by arc length on the ellipse centred at
      [lat, lon] with semi-axes a, b metres, major axis rotated rotDeg
      clockwise from north. Returns [{latlon:[lat,lon], e, n, arc_m}]. */
  function ellipseStations(lat, lon, a, b, rotDeg, n) {
    const table = ellipseArcTable(a, b), rot = rotDeg*DEG, out = [];
    for (let k = 0; k < n; k++) {
      const E = eccentricForArc(table, k/n*table.total);
      const x = a*Math.cos(E), y = b*Math.sin(E);            // x along major
      const e = x*Math.sin(rot) + y*Math.cos(rot);           // rotate major->bearing
      const nn = x*Math.cos(rot) - y*Math.sin(rot);
      out.push({latlon: llMove(lat, lon, e, nn), e, n: nn, arc_m: +(k/n*table.total).toFixed(1)});
    }
    return out;
  }

  /** N stations evenly spaced by arc length along an arbitrary closed
      contour: pts is [[lat, lon], ...] (shape-free: circle, rectangle,
      measured perimeter). margin metres offsets each station outward along
      the local normal. */
  function contourStations(pts, n, margin = 0) {
    if (!pts || pts.length < 3 || n < 1) return [];
    const m = pts.map(p => p.slice()); // [lat, lon]
    const en = m.map(p => llDiff(m[0], p));
    const segs = []; let total = 0;
    for (let i = 0; i < en.length; i++) {
      const j = (i + 1)%en.length, dx = en[j][0] - en[i][0], dy = en[j][1] - en[i][1];
      const len = Math.hypot(dx, dy); segs.push({i, j, len, at: total}); total += len;
    }
    const centre = en.reduce((a, p) => [a[0] + p[0]/en.length, a[1] + p[1]/en.length], [0, 0]);
    const out = [];
    for (let k = 0; k < n; k++) {
      const target = k/n*total;
      const seg = segs.find(s => target < s.at + s.len) || segs[segs.length - 1];
      const t = seg.len ? (target - seg.at)/seg.len : 0;
      let e = en[seg.i][0] + (en[seg.j][0] - en[seg.i][0])*t;
      let nn = en[seg.i][1] + (en[seg.j][1] - en[seg.i][1])*t;
      if (margin) {
        const d = Math.hypot(e - centre[0], nn - centre[1]) || 1e-9;
        e += (e - centre[0])/d*margin; nn += (nn - centre[1])/d*margin;
      }
      out.push({latlon: llMove(m[0][0], m[0][1], e, nn), e, n: nn, arc_m: +target.toFixed(1)});
    }
    return out;
  }

  /** Hungarian assignment for an n×n cost matrix (min total cost).
      Returns array: row -> assigned column. O(n³), small n. */
  function hungarian(cost) {
    const n = cost.length, u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0),
      p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j++) if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
    }
    const assign = new Array(n).fill(-1);
    for (let j = 1; j <= n; j++) if (p[j] > 0) assign[p[j] - 1] = j - 1;
    return assign;
  }

  /** Re-assign drones (positions [[lat,lon]...]) to stations ({latlon}...)
      minimising total repositioning distance. Returns droneIdx -> stationIdx. */
  function assignStations(droneLls, stations) {
    const cost = droneLls.map(d => stations.map(s => Math.hypot(...llDiff(d, s.latlon))));
    return hungarian(cost);
  }

  // ----------------------------------------------- camera extent projection

  /** Ground footprint of the camera at pose: corners of the FOV frustum
      projected to z=0. pose: {lat, lon, alt, headingDeg, pitchDeg} with
      pitch = depression angle below horizontal; fovDeg horizontal FOV,
      aspect = height/width of frame. Returns [[lat,lon]×4] or null when the
      frustum does not meet the ground. */
  function cameraFootprint(pose, fovDeg = 69, aspect = 540/960) {
    const yaw = pose.headingDeg*DEG, pitch = pose.pitchDeg*DEG;
    const th = Math.tan(fovDeg/2*DEG), tv = th*aspect;
    const corners = [[-th, -tv], [th, -tv], [th, tv], [-th, tv]]; // right, up
    const out = [];
    for (const [u, v] of corners) {
      // camera frame: forward +, right +, down +
      const dCam = [1, u, v]; // fwd, right, down(un-normalised)
      // rotate by pitch (depression tilts fwd down) then yaw
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const fwd = dCam[0]*cp - dCam[2]*sp;
      const down = dCam[0]*sp + dCam[2]*cp;
      const right = dCam[1];
      const e = right*Math.cos(yaw) + fwd*Math.sin(yaw);
      const n = -right*Math.sin(yaw) + fwd*Math.cos(yaw);
      if (down <= 1e-6) return null; // ray parallel/above horizon
      const t = pose.alt/down;
      out.push(llMove(pose.lat, pose.lon, e*t, n*t));
    }
    return out;
  }

  // -------------------------------------------------- measured extent + ROS

  /** Centroid (e, n metres relative to first point) of a lat/lon polygon. */
  function polygonCentroidEN(pts) {
    const en = pts.map(p => llDiff(pts[0], p));
    return en.reduce((a, p) => [a[0] + p[0]/en.length, a[1] + p[1]/en.length], [0, 0]);
  }

  /** Per-45°-sector boundary radius (metres) of a polygon around its centroid.
      sector k covers bearings [k*45-22.5, k*45+22.5). */
  function sectorRadii(pts) {
    const c = polygonCentroidEN(pts), radii = new Array(8).fill(0), counts = new Array(8).fill(0);
    for (const p of pts) {
      const [e, n] = llDiff(pts[0], p);
      const b = ((Math.atan2(e - c[0], n - c[1])/DEG) + 360) % 360;
      const s = Math.floor(((b + 22.5) % 360)/45);
      radii[s] += Math.hypot(e - c[0], n - c[1]); counts[s]++;
    }
    return radii.map((r, i) => counts[i] ? r/counts[i] : null);
  }

  /** Fit per-sector rate of spread (m/min) between two measured extents.
      Missing sectors (unobserved arcs) stay null — never interpolated. */
  function sectorROS(prevPts, nextPts, dtMin) {
    if (!(dtMin > 0)) return new Array(8).fill(null);
    const r0 = sectorRadii(prevPts), r1 = sectorRadii(nextPts);
    return r0.map((r, i) => (r != null && r1[i] != null) ? (r1[i] - r)/dtMin : null);
  }

  /** Union of convex-ish observation polygons: convex hull of all vertices
      (Andrew monotone chain in e/n space). Adequate for camera footprints. */
  function fuseExtents(polygons) {
    const pts = polygons.flat();
    if (!pts.length) return [];
    const en = pts.map(p => ({p, en: llDiff(pts[0], p)})).sort((a, b) => a.en[0] - b.en[0] || a.en[1] - b.en[1]);
    const cross = (o, a, b) => (a.en[0] - o.en[0])*(b.en[1] - o.en[1]) - (a.en[1] - o.en[1])*(b.en[0] - o.en[0]);
    const half = seq => { const h = []; for (const q of seq) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); } return h; };
    const hull = [...half(en), ...half([...en].reverse()).slice(1, -1)];
    return hull.map(q => q.p);
  }

  // --------------------------------------------------- drone orbit contour

  /* Push every vertex of a polygon outward along its radial from the centroid
     by marginM — the drone's standoff orbit track. Shape-free: works on the
     projected ellipse or a measured perimeter contour. */
  function offsetContour(pts, marginM = 0) {
    if (!pts || pts.length < 3) return (pts || []).map(p => p.slice());
    if (!marginM) return pts.map(p => p.slice());
    const c = polygonCentroidEN(pts), o = pts[0];
    return pts.map(p => {
      const [e, n] = llDiff(o, p);
      const dx = e - c[0], dy = n - c[1], d = Math.hypot(dx, dy) || 1e-9;
      return llMove(p[0], p[1], dx/d*marginM, dy/d*marginM);
    });
  }

  /* The drone's hover station: the contour vertex nearest bearing brgDeg from
     the centroid (compass 'toward' degrees), pushed outward by marginM. */
  function orbitStation(pts, brgDeg, marginM = 0) {
    if (!pts || pts.length < 3) return null;
    const c = polygonCentroidEN(pts), o = pts[0];
    let best = null, bestErr = 1e9;
    for (const p of pts) {
      const [e, n] = llDiff(o, p);
      const b = (Math.atan2(e - c[0], n - c[1])*180/Math.PI + 360)%360;
      const err = Math.min(Math.abs(b - brgDeg), 360 - Math.abs(b - brgDeg));
      if (err < bestErr) { bestErr = err; best = {p, e: e - c[0], n: n - c[1]}; }
    }
    if (!marginM) return best.p;
    const d = Math.hypot(best.e, best.n) || 1e-9;
    return llMove(best.p[0], best.p[1], best.e/d*marginM, best.n/d*marginM);
  }

  /* Radial advance of the orbit station at brgDeg in m/s — the speed the
     drone must retreat (or advance) to hold standoff as the fire grows:
     if the fire reaches the drone at 5 m/s the station slides at 5 m/s.
     Finite difference on the station's position over dtMin of growth. */
  function orbitSpeedMps(origin, minutes, sc, details, brgDeg, marginM, M, dtMin = 1) {
    const s1 = orbitStation(M.footprint(origin, minutes, sc, details), brgDeg, marginM);
    const s2 = orbitStation(M.footprint(origin, minutes + dtMin, sc, details), brgDeg, marginM);
    if (!s1 || !s2) return null;
    return Math.hypot(...llDiff(s1, s2))/(dtMin*60);
  }

  const api = {llMove, llDiff, stateConfidence, towardDeg, windConsensus,
    ellipseStations, contourStations, hungarian, assignStations,
    cameraFootprint, sectorRadii, sectorROS, fuseExtents, polygonCentroidEN,
    offsetContour, orbitStation, orbitSpeedMps};
  root.BoscoFleet = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
