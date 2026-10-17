#!/usr/bin/env python3
"""Grounded camera calibration. Reads local BOSCO snapshots; no aircraft SDK.

Capture from the read-only observer with --camera-width 0. Never change zoom,
crop or video mode between capture, pose validation and the intended flight.
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np

PATTERN = (9, 6)


def board_corners(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ok, corners = cv2.findChessboardCornersSB(gray, PATTERN,
        flags=cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY)
    return corners if ok else None


def fetch_camera(base, token):
    request = Request(base+"/api/snapshot", headers={"Authorization": "Bearer "+token})
    with urlopen(request, timeout=5) as response:
        stamp = response.headers["X-Captured-At"]
        captured = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        data = response.read(8_000_001)
    if not -1 <= time.time()-captured <= 2:
        raise ValueError("Camera is stale; restore a live feed before collecting")
    if len(data) > 8_000_000:
        raise ValueError("Image exceeds capture size limit")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Camera image could not be decoded")
    return image, stamp


def capture(args):
    url = urlparse(args.backend)
    if url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1") or url.path not in ("", "/"):
        raise ValueError("Use a local BOSCO backend URL")
    base = args.backend.rstrip("/")
    with urlopen(base+"/api/session", timeout=5) as response:
        token = json.load(response)["token"]
    root = args.directory
    root.mkdir(parents=True, exist_ok=True)
    if any(root.glob("view-*.png")):
        raise ValueError("This folder already contains views; use a new folder to avoid mixing sessions")
    last_stamp, size = None, None
    print("GROUND ONLY. Use the native-size read-only receiver. Keep camera zoom fixed.")
    print("Hold the whole board in view; vary its tilt, distance and image position.")
    for index in range(1, 21):
        while True:
            answer = input(f"View {index}/20: reposition the board, press Enter to capture, or q to stop: ")
            if answer.strip().lower() == "q":
                return
            image, stamp = fetch_camera(base, token)
            if stamp == last_stamp:
                print("Same camera frame; wait for a new image.")
                continue
            current_size = tuple(image.shape[1::-1])
            if size is None:
                size = current_size
                print(f"Decoded image size: {size[0]} x {size[1]}. Confirm native capture was selected.")
            if current_size != size:
                raise ValueError("Camera resolution changed; start a new capture session")
            corners = board_corners(image)
            if corners is None:
                print("Board not found. Show all 10 x 7 squares, reduce glare and try again.")
                continue
            clean = root/f"view-{index:02}.png"
            if not cv2.imwrite(str(clean), image):
                raise ValueError("Could not save image")
            preview = image.copy()
            cv2.drawChessboardCorners(preview, PATTERN, corners, True)
            cv2.imwrite(str(root/f"corners-{index:02}.jpg"), preview)
            last_stamp = stamp
            print(f"Saved view {index}; check the corners image if unsure about the board detection.")
            break
    print("Twenty views saved. Next run the fit command.")


def fit_views(views, image_size, square_m):
    if len(views) < 15:
        raise ValueError("At least 15 usable, varied board views are required (aim for 20)")
    if not math.isfinite(square_m) or not .005 <= square_m <= .1:
        raise ValueError("Measured square edge must be 5-100 mm")
    centers = np.array([v.reshape(-1, 2).mean(axis=0) for v in views]) / np.array(image_size)
    if np.ptp(centers[:, 0]) < .25 or np.ptp(centers[:, 1]) < .25:
        raise ValueError("Views are too concentrated; collect views across the image, including its edges")
    objects = np.zeros((PATTERN[0]*PATTERN[1], 3), np.float32)
    objects[:, :2] = np.mgrid[0:PATTERN[0], 0:PATTERN[1]].T.reshape(-1, 2)*square_m
    rms, k, dist, rvecs, tvecs = cv2.calibrateCamera(
        [objects.copy() for _ in views], [np.asarray(v, np.float32) for v in views], image_size, None, None)
    per_view = []
    for points, r, t in zip(views, rvecs, tvecs):
        predicted, _ = cv2.projectPoints(objects, r, t, k, dist)
        per_view.append(float(np.sqrt(np.mean(np.sum((predicted.reshape(-1, 2)-points.reshape(-1, 2))**2, axis=1)))))
    if (not np.isfinite(k).all() or not np.isfinite(dist).all() or not math.isfinite(rms)
            or rms > 1 or max(per_view) > 2 or k[0, 0] <= 0 or k[1, 1] <= 0):
        raise ValueError(f"Calibration quality failed (RMS {rms:.2f} px); improve board views and repeat")
    return k, dist, float(rms), per_view


def fit(args):
    output = args.directory/"camera.local.json"
    if output.exists():
        raise ValueError("camera.local.json already exists; use a new session folder")
    views, size = [], None
    for path in sorted(args.directory.glob("view-*.png")):
        image = cv2.imread(str(path))
        if image is None:
            continue
        current_size = tuple(image.shape[1::-1])
        if size is not None and current_size != size:
            raise ValueError("Images have different resolutions; do not combine camera modes")
        size = current_size
        corners = board_corners(image)
        if corners is not None:
            views.append(corners)
    k, dist, rms, per_view = fit_views(views, size, args.square_mm/1000)
    result = {"measured_and_verified": False, "image_size": list(size), "camera_matrix": k.tolist(),
              "distortion_coefficients": dist.reshape(-1).tolist(), "camera_offset_body_m": [None, None, None],
              "qr_black_square_side_m": args.qr_side_cm/100, "rms_px": rms, "per_view_rms_px": per_view,
              "views": len(views), "created_at": datetime.now(timezone.utc).isoformat(),
              "notes": "Estimated intrinsics only. Measure the camera offset, validate independent QR target poses and gimbal axes, then record verification. Native resolution, crop and zoom must match the orbit stream."}
    output.write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(f"Saved {output}; RMS {rms:.3f} px from {len(views)} views.")
    print("Flight remains disabled: camera offset and independent physical pose checks are still required.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capture", "fit"))
    parser.add_argument("--directory", type=Path, default=Path("anafi_out/calibration"))
    parser.add_argument("--backend", default="http://127.0.0.1:8787")
    parser.add_argument("--square-mm", type=float, default=20)
    parser.add_argument("--qr-side-cm", type=float, default=18)
    args = parser.parse_args()
    if not math.isfinite(args.qr_side_cm) or not 15 <= args.qr_side_cm <= 60:
        parser.error("Measured QR black-square side must be 15-60 cm")
    try:
        (capture if args.action == "capture" else fit)(args)
    except KeyboardInterrupt:
        print("Stopped. Saved images remain local.")
    except Exception as error:
        parser.error(str(error) if isinstance(error, ValueError) else "Capture/fit failed; check the backend and local files. Credentials were not logged.")


if __name__ == "__main__":
    main()
