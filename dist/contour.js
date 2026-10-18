/* Read-only contour geometry shared by the mission overlay and tiny-fire
   preview. This module never sends aircraft commands or invents live GPS. */
(function(root) {
  'use strict';
  const M = root.EmberModel, FORECAST_MINUTES = 5;
  const TINY = Object.freeze({name:'Tiny', area_ha:.0001, intensity:'low', spread_m_per_min:.01,
    fuel:'cured grass', wind_kmh:.2, wind_dir_deg:60, temp_c:22, rh_pct:45, marker_size_m:.18, test_marker:true});

  /** Build the uniform-fuel route at real elapsed minutes plus five minutes. */
  function forecast(origin, details, ageMinutes) {
    const sc = M.scenarioFrom(details), age = Math.max(0, ageMinutes);
    return {current:M.footprint(origin, age, sc, details, 1, {uniformFuel:true}),
      route:M.footprint(origin, age+FORECAST_MINUTES, sc, details, 1, {uniformFuel:true}),
      ageMinutes:age, speedMps:patrolSpeed(sc, details, age+FORECAST_MINUTES)};
  }

  /** Match the receiver's bounded tangent speed in m/s; growth uses real time. */
  function patrolSpeed(sc, details, minutes) {
    const growth = M.effectiveRate(sc, details, minutes)/60;
    return growth > 0 ? Math.max(.05, Math.min(.2, growth*30)) : 0;
  }

  /** Place the preview aircraft by metre distance along a closed geographic ring. */
  function alongRing(points, metres) {
    const cos = Math.cos(points[0][0]*Math.PI/180);
    const lengths = points.map((p,i) => {
      const q = points[(i+1)%points.length];
      return Math.hypot((q[0]-p[0])*111320, (q[1]-p[1])*111320*cos);
    });
    const perimeter = lengths.reduce((sum,n) => sum+n, 0);
    let remaining = ((metres%perimeter)+perimeter)%perimeter;
    for (let i=0;i<points.length;i++) {
      if (remaining <= lengths[i]) {
        const p=points[i], q=points[(i+1)%points.length], f=lengths[i]?remaining/lengths[i]:0;
        return [p[0]+(q[0]-p[0])*f,p[1]+(q[1]-p[1])*f];
      }
      remaining -= lengths[i];
    }
    return points[0];
  }
  root.BoscoContour = {TINY, FORECAST_MINUTES, forecast, patrolSpeed, alongRing};
})(typeof globalThis !== 'undefined' ? globalThis : this);
