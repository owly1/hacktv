"""Flat-ground fire location estimates from a known camera pose; no aircraft commands."""
import math
from datetime import datetime


def locate_fire(hit, telemetry, frame_shape, hfov_deg=69, captured=None):
    """Return (fire, estimated_area_ha). Unknown pose or horizon stays unlocated.

    Altitude is above takeoff, so this estimate assumes the target is on the
    same ground plane. It is a camera estimate, never a measured fire GPS fix.
    """
    missing = {'latitude': None, 'longitude': None, 'distance_m': None,
               'bearing_deg': None, 'position_source': 'unavailable'}
    t = telemetry or {}
    if captured is not None:
        try:
            pose_time = datetime.fromisoformat(t['observed_at'].replace('Z', '+00:00'))
            if pose_time.tzinfo is None:
                return missing, None
            pose_at = pose_time.timestamp()
            if not math.isfinite(captured) or abs(pose_at-captured) > 2:
                return missing, None
        except (KeyError, ValueError, TypeError, AttributeError, OverflowError, OSError):
            return missing, None
    if t.get('gps_fix') is False:
        return missing, None
    extra = t.get('extra') or {}
    lat, lon, alt = (t.get(k) for k in ('latitude', 'longitude', 'altitude_m'))
    heading = extra.get('heading_deg')
    if heading is None:
        heading = (t.get('attitude_deg') or {}).get('yaw')
    pitch = extra.get('gimbal_pitch_deg')
    if not all(not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x)
               for x in (lat, lon, alt, heading, pitch)) or alt <= .5 or abs(lat) >= 89 or abs(lon) > 180:
        return missing, None
    h, w = frame_shape[:2]
    if h <= 0 or w <= 0 or not math.isfinite(hfov_deg) or not 0 < hfov_deg < 180:
        return missing, None
    hfov = math.radians(hfov_deg)
    vfov = 2 * math.atan(math.tan(hfov / 2) * h / w)
    x1, y1, x2, y2 = hit['bbox']
    # A frame-edge box may show only a small part of a larger fire. Do not
    # turn that partial view into a physical-size estimate.
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x1, y1, x2, y2)) or not (
            .01 < x1 < x2 < .99 and .01 < y1 < y2 < .99):
        return missing, None
    alpha = math.degrees(math.atan(((x1+x2)/2-.5)*2*math.tan(hfov/2)))
    beta = math.degrees(math.atan(((y1+y2)/2-.5)*2*math.tan(vfov/2)))
    depression = -pitch + beta
    if not 2 < depression <= 90:
        return missing, None
    distance = alt / math.tan(math.radians(depression))
    if distance > 500:
        return missing, None
    bearing = (heading + alpha) % 360
    b = math.radians(bearing)
    width = 2 * math.hypot(distance, alt) * math.tan(hfov/2) * (x2-x1)
    return {
        'latitude': round(lat + distance*math.cos(b)/111320, 7),
        'longitude': round(lon + distance*math.sin(b)/(111320*math.cos(math.radians(lat))), 7),
        'distance_m': round(distance, 1), 'bearing_deg': round(bearing, 1),
        'position_source': (extra.get('position_source') or 'telemetry') + '+camera-ray-flat-ground',
    }, round(math.pi*(width/2)**2/10000, 4)
