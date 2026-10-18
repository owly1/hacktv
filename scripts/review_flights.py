#!/usr/bin/env python3
"""Summarize recorded flight evidence and create local MP4 previews, offline."""
import argparse
import json
from pathlib import Path


def lines(path):
    """Load available JSONL records while tolerating a final partial crash-written line."""
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        try:
            entries.append(json.loads(line))
        except ValueError:
            pass  # Preserve and tolerate the final partial line after a crash.
    return entries


def review(path):
    """Write recording statistics, airborne height range and movement/control failures to review.json."""
    events, frames = lines(path/'events.jsonl'), lines(path/'frames.jsonl')
    controls = [e for e in events if e['kind'] == 'flight_control']
    failures = [e for e in events if e['kind'] == 'move_failed' or
                (e['kind'] == 'flight_control' and e['data'].get('phase') in ('aborted', 'error'))]
    samples = [e['data'] for e in events if e['kind'] == 'telemetry' and
               e['data'].get('state') in ('hovering', 'flying')]
    heights = [s['altitude_m'] for s in samples if isinstance(s.get('altitude_m'), (int, float))]
    elapsed = frames[-1]['captured_at_unix']-frames[0]['captured_at_unix'] if len(frames)>1 else 0
    report = {'video_frames': len(frames), 'video_seconds': elapsed,
              'average_recorded_fps': (len(frames)-1)/elapsed if elapsed>0 else 0,
              'hover_flight_height_min_m': min(heights) if heights else None,
              'hover_flight_height_max_m': max(heights) if heights else None,
              'last_control_event': controls[-1] if controls else None,
              'failures': failures,
              'move_results': [e for e in events if e['kind'] == 'move_completed']}
    (path/'review.json').write_text(json.dumps(report, indent=2)+'\n')
    return report


def preview(path):
    """Use original timestamps to preserve pauses in a 30 fps MP4 preview."""
    import cv2
    import numpy as np
    frames = lines(path/'frames.jsonl')
    if not frames:
        return
    target = path/'preview.mp4'
    if target.exists() and target.stat().st_mtime >= (path/'video.mjpeg').stat().st_mtime:
        return
    writer = None
    try:
        with (path/'video.mjpeg').open('rb') as source:
            for i, entry in enumerate(frames):
                source.seek(entry['offset'])
                frame = cv2.imdecode(np.frombuffer(source.read(entry['bytes']), dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                if writer is None:
                    size = (frame.shape[1], frame.shape[0])
                    writer = cv2.VideoWriter(str(target), cv2.VideoWriter_fourcc(*'mp4v'), 30., size)
                    if not writer.isOpened():
                        raise OSError('MP4 encoder unavailable; original MJPEG and timing index are retained')
                next_at = frames[i+1]['captured_at_unix'] if i+1<len(frames) else entry['captured_at_unix']+1/30
                count = max(0, round((next_at-frames[0]['captured_at_unix'])*30)-
                            round((entry['captured_at_unix']-frames[0]['captured_at_unix'])*30))
                for _ in range(count):
                    writer.write(cv2.resize(frame, size) if frame.shape[1::-1] != size else frame)
    finally:
        if writer is not None:
            writer.release()


def main():
    """Review each recorded session and attempt a local timestamp-preserving MP4 preview."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    for path in sorted(args.directory.iterdir()):
        if not path.is_dir() or not (path/'events.jsonl').exists():
            continue
        report = review(path)
        try:
            preview(path)
        except (ImportError, OSError) as error:
            print(f'{path.name}: preview unavailable: {error}')
        print(f'{path.name}: {report["video_frames"]} frames, {report["average_recorded_fps"]:.1f} fps; '
              f'{len(report["failures"])} failure events; review.json contains measurements')


if __name__ == '__main__':
    main()
