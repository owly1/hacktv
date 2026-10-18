#!/usr/bin/env python3
"""Compare QR measurement corrections offline. Never writes flight calibration.

Each saved setup counts once; repeated camera frames are reduced to a median.
The first setup fits diagnostic offset/scale candidates; later setups evaluate
them. Passing these residual checks is not physical flight verification.
"""
import argparse
import json
import math
from pathlib import Path
import statistics


def read_points(path):
    report = json.loads(path.read_text())
    if 'points' in report:
        return [{'id': p['image'], 'measured_horizontal_m': p['measured_horizontal_m'],
                 'measured_down_m': p['measured_height_m'],
                 'estimated_horizontal_m': p['estimated_horizontal_m'],
                 'estimated_down_m': p['estimated_down_m']} for p in report['points']]
    samples = report.get('samples', [])
    if not samples:
        raise ValueError(f'{path}: no usable QR measurements')
    return [{'id': path.name, 'measured_horizontal_m': report['measured_horizontal_m'],
             'measured_down_m': report['measured_down_m'],
             'estimated_horizontal_m': statistics.median(s['horizontal_m'] for s in samples),
             'estimated_down_m': statistics.median(s['down_m'] for s in samples)}]


def assess(points, down_offset_m=-.20, tolerance_m=.05):
    if not points or not math.isfinite(down_offset_m) or not 0 < tolerance_m <= .2:
        raise ValueError('Need measurement setups, a finite offset and a positive tolerance <= 20 cm')
    fields = ('measured_horizontal_m', 'measured_down_m',
              'estimated_horizontal_m', 'estimated_down_m')
    for p in points:
        if any(not isinstance(p.get(k), (float, int)) or not math.isfinite(p[k]) or p[k] <= 0 for k in fields):
            raise ValueError('Measurements must be positive finite camera-relative metres')
    first = points[0]
    fitted_offset = first['measured_down_m'] - first['estimated_down_m']
    fitted_scale = first['measured_down_m'] / first['estimated_down_m']
    models = [
        ('uncorrected', 1., 0., False),
        ('requested_vertical_offset', 1., down_offset_m, False),
        ('vertical_offset_fit_first_setup', 1., fitted_offset, True),
        ('vertical_scale_fit_first_setup', fitted_scale, 0., True),
    ]
    results = []
    for name, scale, offset, fitted in models:
        rows = []
        for i, p in enumerate(points):
            down = p['estimated_down_m'] * scale + offset
            horizontal_error = p['estimated_horizontal_m'] - p['measured_horizontal_m']
            down_error = down - p['measured_down_m']
            rows.append({**p, 'used_for_fit': fitted and i == 0,
                         'corrected_down_m': down, 'horizontal_error_m': horizontal_error,
                         'down_error_m': down_error,
                         'position_error_m': math.hypot(horizontal_error, down_error),
                         'within_diagnostic_tolerance': down > 0 and math.hypot(horizontal_error, down_error) <= tolerance_m})
        validation = [r for r in rows if not r['used_for_fit']]
        results.append({'model': name, 'vertical_scale': scale, 'vertical_offset_m': offset,
                        'validation_setups': len(validation),
                        'validation_within_tolerance': bool(validation) and all(r['within_diagnostic_tolerance'] for r in validation),
                        'rows': rows})
    heights = [p['measured_down_m'] for p in points]
    reasons = ['Offline radial/vertical residuals do not verify lateral position, camera axes or flight tracking.']
    if max(heights) - min(heights) < .15:
        reasons.append('All checks have essentially the same target height; offset and scale cannot be distinguished across flight heights.')
    if not results[1]['validation_within_tolerance']:
        reasons.append('The requested vertical correction leaves position errors above the diagnostic tolerance.')
    return {'reference': 'camera lens; body offset is excluded from both measurement and estimate',
            'diagnostic_tolerance_m': tolerance_m, 'flight_verified': False,
            'flight_calibration_modified': False, 'measured_height_range_m': [min(heights), max(heights)],
            'limitations': reasons, 'models': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', type=Path, nargs='+', help='Saved metric QR check reports; first setup fits diagnostic candidates')
    parser.add_argument('--down-offset-m', type=float, default=-.20)
    parser.add_argument('--tolerance-m', type=float, default=.05, help='Diagnostic error tolerance, not a flight authorization threshold')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # Refuse an output that could replace a source report or operational calibration.
    if (args.output.resolve() in {p.resolve() for p in args.reports}
            or args.output.name == 'camera.local.json' or args.output.exists()):
        parser.error('Choose a new report output; existing files and flight calibration are never overwritten')
    try:
        result = assess([p for report in args.reports for p in read_points(report)], args.down_offset_m, args.tolerance_m)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    with args.output.open('x') as f:
        f.write(json.dumps(result, indent=2) + '\n')
    for row in result['models'][1]['rows']:
        print(f"{row['id']}: horizontal error {row['horizontal_error_m']*100:+.1f} cm; "
              f"corrected vertical error {row['down_error_m']*100:+.1f} cm")
    for reason in result['limitations']:
        print(reason)
    print(f'Report saved: {args.output}; flight calibration unchanged.')


if __name__ == '__main__':
    main()
