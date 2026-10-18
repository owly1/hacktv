/* Real-camera distance advice only. This module has no aircraft or network API. */
(function (root) {
  'use strict';
  const EDGE_BUFFER_M = 100;
  const MAX_AGE_MS = 10000;

  /** Estimate circular fire radius plus the operator's 100 m edge buffer.
   * Uses captured camera evidence, never forecast area, QR data or demo anchors.
   * Distances describe the aircraft at capture time, not its present position.
   */
  function advisory(detection, nowMs = Date.now()) {
    if (detection?.source !== 'yolo' || detection.label !== 'fire') return null;
    const d = detection, details = d.details || {}, pose = d.drone || {};
    const result = {status: 'unavailable', edge_buffer_m: EDGE_BUFFER_M,
      captured_at: d.detected_at, area_ha: null, equivalent_radius_m: null,
      target_center_distance_m: null, capture_edge_clearance_m: null,
      capture_shortfall_m: null, reason: ''};
    const captured = Date.parse(d.detected_at), poseAt = Date.parse(pose.observed_at);
    if (!Number.isFinite(captured) || !Number.isFinite(nowMs) || nowMs < captured || nowMs-captured > MAX_AGE_MS) {
      return {...result, status: 'stale', reason: 'Waiting for a fresh fire observation.'};
    }
    if (details.position_simulated || details.area_source !== 'camera-box-estimate'
        || pose.provenance !== 'live' || pose.gps_fix !== true || pose.extra?.position_source !== 'gps'
        || !Number.isFinite(poseAt) || Math.abs(poseAt-captured) > 2000
        || d.fire?.position_source !== 'gps+camera-ray-flat-ground') {
      return {...result, reason: 'A synchronized camera size estimate and live GPS pose are required.'};
    }
    const area = details.area_ha;
    if (!Number.isFinite(area) || area <= 0 || area > 1e7) {
      return {...result, reason: 'Physical fire size is unavailable.'};
    }
    const radius = Math.sqrt(area * 10000 / Math.PI);
    const target = radius + EDGE_BUFFER_M;
    const distance = d.fire?.distance_m;
    const hasRange = Number.isFinite(distance) && distance >= 0;
    return {...result, status: 'estimated', area_ha: area, equivalent_radius_m: radius,
      target_center_distance_m: target,
      capture_edge_clearance_m: hasRange ? distance-radius : null,
      capture_shortfall_m: hasRange ? Math.max(0, target-distance) : null};
  }

  /** Describe the estimate and its assumptions without implying a flight command or guaranteed clearance. */
  function describe(advice) {
    if (!advice) return '';
    if (advice.status !== 'estimated') return `Standoff advisory unavailable. ${advice.reason} Configured edge buffer: ${EDGE_BUFFER_M} m.`;
    const range = advice.capture_edge_clearance_m === null ? 'Range at capture unavailable.'
      : `At capture: estimated edge clearance ${Math.round(advice.capture_edge_clearance_m)} m; buffer shortfall ${Math.ceil(advice.capture_shortfall_m)} m.`;
    return `Standoff advisory: ${Math.ceil(advice.target_center_distance_m)} m from estimated fire centre (${EDGE_BUFFER_M} m beyond estimated edge). ${range} Camera box / circular fire / flat-ground approximation; not a verified perimeter or safe-flight clearance. Advisory only; no flight command.`;
  }

  root.FireStandoff = {advisory, describe};
})(globalThis);
