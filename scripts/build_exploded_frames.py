#!/usr/bin/env python3
"""Rebuild the home page exploded-view frames from the teardown video.

Writes every decoded video frame, in order, as
dist/assets/exploded/full/frame-NNNN.webp (source size, 1920x1080) and
dist/assets/exploded/small/frame-NNNN.webp (half size, 960x540).
Old frame-*.jpg / frame-*.webp files in those folders are removed first.
dist/reveal.js must list the same FRAME_COUNT the script prints.

Needs OpenCV (cv2), Pillow and the cwebp encoder on PATH.

    python3 scripts/build_exploded_frames.py path/to/teardown.mp4
"""
import argparse
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'dist' / 'assets' / 'exploded'
SETS = {'full': (1.0, 90), 'small': (0.5, 88)}  # name: (scale, cwebp quality 0-100)


def encode(png: Path, out: Path, quality: int) -> None:
    """Encode one PNG to WebP with cwebp; sharp_yuv keeps thin edges crisp."""
    subprocess.run(['cwebp', '-quiet', '-q', str(quality), '-m', '6', '-sharp_yuv',
                    str(png), '-o', str(out)], check=True)


def main() -> int:
    """Decode the video, write both frame sets, and print the frame count."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('video', type=Path)
    args = ap.parse_args()

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        print(f'cannot open {args.video}', file=sys.stderr)
        return 1
    for name in SETS:
        d = OUT / name
        d.mkdir(parents=True, exist_ok=True)
        for old in list(d.glob('frame-*.jpg')) + list(d.glob('frame-*.webp')):
            old.unlink()

    jobs = []
    with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor(os.cpu_count()) as pool:
        n = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            n += 1
            im = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            for name, (scale, quality) in SETS.items():
                frame = im if scale == 1 else im.resize(
                    (round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
                png = Path(tmp) / f'{name}-{n:04d}.png'
                frame.save(png, compress_level=1)
                jobs.append(pool.submit(encode, png, OUT / name / f'frame-{n:04d}.webp', quality))
        for job in jobs:
            job.result()
    print(f'FRAME_COUNT = {n}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
