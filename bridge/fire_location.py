"""Flat-ground fire location estimates from a known camera pose; no aircraft commands."""
import math


def locate_fire(hit, telemetry, frame_shape, hfov_deg=69):
    """Return (fire, estimated_area_ha). Unknown pose or horizon stays unlocated.

    Altitude is above takeoff, so this estimate assumes the target is on the
    same ground plane. It is a camera estimate, never a measured fire GPS fix.
    """
    missing = {'latitude': None, 'longitude': None, 'distance_m': None,
               'bearing_deg': None, 'position_source': 'unavailable'}
    t = telemetry or {}
    extra = t.get('extra') or {}
    lat, lon, alt = (t.get(k) for k in ('latitude', 'longitude', 'altitude_m'))
    heading = extra.get('heading_deg')
    if heading is None:
        heading = (t.get('attitude_deg') or {}).get('yaw')
    pitch = extra.get('gimbal_pitch_deg')
    if not all(isinstance(x, (int, float)) and math.isfinite(x)
               for x in (lat, lon, alt, heading, pitch)) or alt <= .5 or abs(lat) >= 89:
        return missing, None
    h, w = frame_shape[:2]
    hfov = math.radians(hfov_deg)
    vfov = 2 * math.atan(math.tan(hfov / 2) * h / w)
    x1, y1, x2, y2 = hit['bbox']
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
