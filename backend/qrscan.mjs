// QR marker decoding for the indoor demo: the printed markers carry the
// scenario inside the code, so the camera seeing an "EW1:" marker is
// simulated-fire evidence (source qr-test), and an "EWP:" marker is a
// person-sighting marker for the vulnerable-people track (source qr-person).
// Everything derived from a marker is simulation evidence, never a real
// fire or a real person detection — provenance stays labelled end to end.
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';

// EW1:name|area_ha|intensity|spread_m_per_min|fuel|wind_kmh|toward_deg|temp_c|rh_pct|side_cm
// Matches bridge/make_test_marker.py's payload format.
const EW1_RE = /^EW1:([A-Za-z0-9_-]{1,12})\|(-?\d+(?:\.\d+)?)\|(L|M|H|X)\|(-?\d+(?:\.\d+)?)\|(F|G|M|S)\|(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?)$/;
// EWP:name|free-text note (e.g. EWP:resident-1|elderly, mobility-limited)
const EWP_RE = /^EWP:([A-Za-z0-9_-]{1,24})(?:\|(.{1,80}))?$/;

const INTENSITY = { L: 'low', M: 'moderate', H: 'high', X: 'extreme' };
const FUEL = {
  F: 'dry conifer forest',
  G: 'cured grass',
  M: 'dry mixed forest and grass',
  S: 'brush and shrub',
};

// Decode a JPEG frame to { text, bbox } with the QR's bounding box normalized
// to 0..1 (the same shape detectors report), or null when no QR is present.
export function decodeQr(jpegBuf) {
  let img;
  try {
    img = jpeg.decode(jpegBuf, { maxMemoryUsageInMB: 64 });
  } catch {
    return null;
  }
  if (!img?.data || !img.width || !img.height) return null;
  const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  if (!found?.data) return null;
  const c = found.location;
  const xs = [c.topLeftCorner.x, c.topRightCorner.x, c.bottomRightCorner.x, c.bottomLeftCorner.x];
  const ys = [c.topLeftCorner.y, c.topRightCorner.y, c.bottomRightCorner.y, c.bottomLeftCorner.y];
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const bbox = [
    clamp(Math.min(...xs) / img.width), clamp(Math.min(...ys) / img.height),
    clamp(Math.max(...xs) / img.width), clamp(Math.max(...ys) / img.height),
  ];
  return { text: found.data, bbox };
}

// Parse QR text into a marker. Returns null for non-Emberwatch payloads so
// stray QR codes (badges, venue signage) never reach the detection pipeline.
export function parseMarkerPayload(text) {
  if (typeof text !== 'string') return null;
  const f = EW1_RE.exec(text);
  if (f) {
    const [, name, area, intensity, spread, fuel, wind, toward, temp, rh, side] = f;
    return {
      kind: 'fire',
      name,
      scenario: {
        name,
        area_ha: Number(area),
        intensity: INTENSITY[intensity],
        spread_m_per_min: Number(spread),
        fuel: FUEL[fuel],
        wind_kmh: Number(wind),
        toward_deg: Number(toward),
        temp_c: Number(temp),
        rh_pct: Number(rh),
        side_cm: Number(side),
      },
    };
  }
  const p = EWP_RE.exec(text);
  if (p) {
    return { kind: 'person', name: p[1], note: p[2]?.trim() || null };
  }
  return null;
}

export function markerEpisodeId(marker) {
  const slug = marker.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  return marker.kind === 'fire' ? `qrfire-${slug}` : `qrperson-${slug}`;
}
