import {ApiError, parseIsoTimestamp} from './validation.mjs';

/** Validate actual camera evidence without supplying a fictional geographic pose. */
export function validateCameraSighting(body, nowMs) {
  const at = parseIsoTimestamp(body?.observed_at, 'observed_at');
  if (at > nowMs + 30_000 || nowMs-at > 6*3600_000) throw new ApiError(400, 'person sighting timestamp is outside the accepted window');
  const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
  if (!id(body.obs_id) || !id(body.track_id) || body.provenance !== 'live'
      || body.label !== 'person' || body.sensor !== 'visible'
      || !Number.isFinite(body.detector_score) || body.detector_score < 0 || body.detector_score > 1
      || !Array.isArray(body.bbox) || body.bbox.length !== 4
      || !body.bbox.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      || body.bbox[0] >= body.bbox[2] || body.bbox[1] >= body.bbox[3]
      || !['pose-unavailable', 'ground-intersection-unavailable'].includes(body.location_reason)) {
    throw new ApiError(400, 'invalid live camera person sighting');
  }
  return {obs_id: body.obs_id, track_id: body.track_id, observed_at: new Date(at).toISOString(),
    provenance: 'live', sensor: 'visible', label: 'person', bbox: [...body.bbox],
    detector: typeof body.detector === 'string' ? body.detector.slice(0, 80) : null,
    detector_score: body.detector_score, location_status: 'unavailable', location_reason: body.location_reason};
}

/** Deduplicate camera tracks and cap retained unlocated notes at 200 records. */
export function recordCameraSighting(records, sighting) {
  const previous = records.get(sighting.track_id);
  if (previous && (sighting.obs_id === previous.obs_id || sighting.observed_at <= previous.observed_at)) return false;
  records.delete(sighting.track_id);
  records.set(sighting.track_id, {...previous, ...sighting, first_seen_at: previous?.first_seen_at ?? sighting.observed_at,
    sightings: (previous?.sightings ?? 0) + 1});
  while (records.size > 200) records.delete(records.keys().next().value);
  return true;
}
