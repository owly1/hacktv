import {TINY_FIRE_MARKER_DETAILS} from './validation.mjs';

// Marker identity remains the printed Tiny payload. This explicit outdoor
// profile changes only the simulated initial area, never the measured QR size.
export const OUTDOOR_CONTOUR_PROFILE = 'outdoor-50m-live-wind';
export const OUTDOOR_CONTOUR_DETAILS = Object.freeze({...TINY_FIRE_MARKER_DETAILS,
  area_ha: Math.PI * 25 ** 2 / 10000});

/** Verify the fixed outdoor assumptions independently of received live weather. */
export function matchesOutdoorDetails(details) {
  return Object.entries(OUTDOOR_CONTOUR_DETAILS).every(([key,value])=>details?.[key]===value);
}

/** Preserve measured/stale wind or an explicit scenario assumption without presenting it as telemetry. */
export function measuredContourWeather(value) {
  const w=value?.wind, s=value?.effective_scenario;
  const assumed=w?.source==='qr-scenario-assumption';
  if (!w || !['flight-controller','qr-scenario-assumption'].includes(w.source) || !Number.isFinite(w.speed_mps)
      || w.speed_mps<0 || w.speed_mps>60/3.6
      || (w.direction_deg!==null && (!Number.isFinite(w.direction_deg) || w.direction_deg<0 || w.direction_deg>=360))
      || (w.speed_mps>0 && w.direction_deg===null)
      || !s) return null;
  if (assumed) {
    if (value.wind_status!=='assumed' || w.observed_at!==null || w.age_s!==null
        || Math.abs(w.speed_mps-OUTDOOR_CONTOUR_DETAILS.wind_kmh/3.6)>1e-10
        || w.direction_deg!==OUTDOOR_CONTOUR_DETAILS.wind_dir_deg) return null;
  } else if (typeof w.observed_at!=='string' || !Number.isFinite(Date.parse(w.observed_at))
      || !Number.isFinite(w.age_s) || w.age_s<0 || !['measured','stale'].includes(value.wind_status)) return null;
  const expected={wind:Math.min(60,w.speed_mps*3.6),direction:w.direction_deg??0,
    dryness:100-OUTDOOR_CONTOUR_DETAILS.rh_pct,temp:OUTDOOR_CONTOUR_DETAILS.temp_c,
    rh:OUTDOOR_CONTOUR_DETAILS.rh_pct};
  if (!Object.entries(expected).every(([key,n])=>Number.isFinite(s[key]) && Math.abs(s[key]-n)<1e-8)) return null;
  return {effective_scenario:expected,wind_status:value.wind_status,
    wind_reason:typeof value.wind_reason==='string'?value.wind_reason.slice(0,300):null,
    wind:{source:w.source,speed_mps:w.speed_mps,
    direction_deg:w.direction_deg,observed_at:w.observed_at,age_s:w.age_s}};
}
