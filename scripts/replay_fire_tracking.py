#!/usr/bin/env python3
"""Replay saved MJPEG frames through QR detection without a backend or aircraft.

The recorded telemetry is too sparse to reconstruct exact gimbal pose during
ascent. Report camera-frame square fits, not invented world coordinates.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def json_lines(path):
    result = []
    for line in path.read_text().splitlines():
        try:
            result.append(json.loads(line))
        except ValueError:
            pass
    return result


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(part)
    return value.hexdigest()


def square_fit(hit, calibration):
    """Independent pixel/metric diagnostics using the same IPPE square model."""
    corners = np.asarray(hit['qr_corners'], dtype=float).reshape(4, 2)
    edges = np.linalg.norm(corners - np.roll(corners, -1, axis=0), axis=1)
    side = calibration['qr_black_square_side_m'] / 2
    points = np.array([[-side, side, 0], [side, side, 0],
                       [side, -side, 0], [-side, -side, 0]], dtype=float)
    k = np.array(calibration['camera_matrix'], dtype=float)
    dist = np.array(calibration['distortion_coefficients'], dtype=float)
    ok, rotations, translations, _ = cv2.solvePnPGeneric(
        points, corners, k, dist, flags=cv2.SOLVEPNP_IPPE_SQUARE)
    candidates = []
    if ok:
        for rotation, translation in zip(rotations, translations):
            if not np.isfinite(translation).all() or translation[2, 0] <= 0:
                continue
            projected, _ = cv2.projectPoints(points, rotation, translation, k, dist)
            error = np.sqrt(np.mean(np.sum((projected.reshape(4, 2) - corners) ** 2, axis=1)))
            if np.isfinite(error):
                candidates.append((float(error), translation.reshape(3)))
    candidates.sort(key=lambda x: x[0])
    if not candidates or candidates[0][0] > 2:
        ok, rotation, translation = cv2.solvePnP(points, corners, k, dist, flags=cv2.SOLVEPNP_ITERATIVE)
        if ok and np.isfinite(translation).all() and translation[2, 0] > 0:
            projected, _ = cv2.projectPoints(points, rotation, translation, k, dist)
            error = np.sqrt(np.mean(np.sum((projected.reshape(4, 2) - corners) ** 2, axis=1)))
            if np.isfinite(error) and error <= 2:
                candidates.append((float(error), translation.reshape(3)))
                candidates.sort(key=lambda x: x[0])
    best = candidates[0] if candidates else None
    width, height = calibration['image_size']
    clipped = bool(np.any(corners < 2) or np.any(corners[:, 0] > width - 3)
                   or np.any(corners[:, 1] > height - 3))
    convex = bool(cv2.isContourConvex(corners.astype(np.float32)))
    ambiguous = bool(best and any(error <= best[0] + .5 and np.linalg.norm(center - best[1]) > .08
                                  for error, center in candidates[1:]))
    return {'min_edge_px': float(edges.min()), 'mean_edge_px': float(edges.mean()),
            'corners': corners.tolist(), 'clipped': clipped, 'convex': convex,
            'fit_rms_px': best[0] if best else None,
            'camera_translation_m': best[1].tolist() if best else None,
            'ambiguous': ambiguous,
            'square_geometry_usable': bool(best and best[0] <= 2 and not ambiguous
                                           and edges.min() >= 20 and convex and not clipped)}


def replay(directory, calibration_path, detector, *, hz=5., until=None):
    if not np.isfinite(hz) or hz <= 0:
        raise ValueError('Sample rate must be positive')
    calibration = json.loads(calibration_path.read_text())
    index = json_lines(directory / 'frames.jsonl')
    events = json_lines(directory / 'events.jsonl')
    if not index:
        raise ValueError('Recording has no indexed frames')
    first = index[0]['captured_at_unix']
    start = events[0]['at_unix'] if events else first
    controls = [event for event in events if event['kind'] == 'flight_control']
    samples = []
    last = float('-inf')
    with (directory / 'video.mjpeg').open('rb') as stream:
        for entry in index:
            captured = entry['captured_at_unix']
            if until is not None and captured - start > until:
                break
            if captured - last < 1 / hz - .001:
                continue
            last = captured
            stream.seek(entry['offset'])
            image = cv2.imdecode(np.frombuffer(stream.read(entry['bytes']), np.uint8), cv2.IMREAD_COLOR)
            previous = [event for event in controls if event['at_unix'] <= captured]
            result = {'frame': entry['frame'], 'seconds': captured - start,
                      'phase': previous[-1]['data'].get('phase') if previous else 'preflight'}
            if image is None:
                result.update(method='invalid-frame', square_geometry_usable=False)
            elif list(image.shape[1::-1]) != calibration['image_size']:
                result.update(method='resolution-mismatch', resolution=list(image.shape[1::-1]),
                              square_geometry_usable=False)
            else:
                begun = time.perf_counter()
                hit = detector.detect(image, captured_at=captured)
                result['inference_ms'] = (time.perf_counter() - begun) * 1000
                result['method'] = hit.get('qr_tracking', 'decoded') if hit and hit.get('source') == 'qr-test' else 'missing'
                if result['method'] != 'missing':
                    result.update(square_fit(hit, calibration))
                else:
                    result['square_geometry_usable'] = False
            samples.append(result)
    by_phase = {}
    for phase in dict.fromkeys(sample['phase'] for sample in samples):
        values = [sample for sample in samples if sample['phase'] == phase]
        by_phase[phase] = {'frames': len(values), 'methods': dict(Counter(v['method'] for v in values)),
                           'usable_square_geometry': sum(v['square_geometry_usable'] for v in values)}
    return {'recording': directory.name, 'sample_hz': hz, 'samples': samples, 'phases': by_phase,
            'calibration': {'sha256': digest(calibration_path),
                            **{key: calibration.get(key) for key in ('image_size', 'qr_black_square_side_m',
                               'camera_offset_body_m', 'rms_px', 'views', 'qr_pose_verification')}},
            'evidence_sha256': {name: digest(directory / name)
                               for name in ('frames.jsonl', 'events.jsonl', 'video.mjpeg')},
            'limits': ['Offline detection replay does not simulate transport latency or flight dynamics.',
                       'Square-fit usability excludes camera/aircraft synchronization and world-coordinate bounds.',
                       'Recorded telemetry is not frequent enough to verify moving-frame pose exactly.',
                       'Calibration RMS is an image fit; it does not establish physical flight accuracy.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--calibration', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--hz', type=float, default=5.)
    parser.add_argument('--until', type=float)
    parser.add_argument('--detector-root', type=Path, default=ROOT / 'bridge',
                        help='Local saved detector source for a before/after comparison')
    args = parser.parse_args()
    sys.path.insert(0, str(args.detector_root))
    from fire_detection import FireDetector
    detector = FireDetector('', use_yolo=False)
    result = replay(args.recording, args.calibration, detector, hz=args.hz, until=args.until)
    result['detector_sha256'] = {name: digest(args.detector_root / name)
                                for name in ('fire_detection.py', 'qr_visual_track.py')}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['phases'], indent=2))


if __name__ == '__main__':
    main()
