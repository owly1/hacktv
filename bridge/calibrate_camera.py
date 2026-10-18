#!/usr/bin/env python3
"""Grounded camera calibration. Reads local BOSCO snapshots; no aircraft SDK.

Capture using Start-HoverCheckout.ps1 -NativeVideo, or observer --camera-width 0. Never change zoom,
crop or video mode between capture, pose validation and the intended flight.
"""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# OpenCV worker threads otherwise attempt an unwritable OpenCL cache on this Mac.
os.environ.setdefault("OPENCV_OPENCL_RUNTIME", "disabled")
import cv2
import numpy as np

PATTERN = (9, 6)


def board_pattern(columns=10, rows=7):
    """User-facing dimensions count squares; OpenCV counts inner corners."""
    if not all(isinstance(n, int) and 4 <= n <= 20 for n in (columns, rows)):
        raise ValueError("Board dimensions must be 4-20 squares across and down")
    return columns-1, rows-1


def board_corners(image, pattern=PATTERN):
    # CPU detection avoids macOS OpenCL cache-write failures during capture.
    cv2.ocl.setUseOpenCL(False)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Normalization handles uneven indoor lighting. The classic detector also
    # recovers some boards rejected by the sector-based detector.
    ok, corners = cv2.findChessboardCornersSB(gray, pattern,
        flags=cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_ACCURACY | cv2.CALIB_CB_EXHAUSTIVE)
    if ok:
        return corners
    ok, corners = cv2.findChessboardCorners(gray, pattern,
        flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE)
    if ok:
        return cv2.cornerSubPix(gray, corners, (5, 5), (-1, -1),
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 40, .001))
    return None


def session_pattern(root, columns, rows):
    path = root / "session.json"
    if path.exists():
        saved = json.loads(path.read_text())
        return board_pattern(saved['columns'], saved['rows'])
    return board_pattern(columns, rows)


def rejection_reason(image, columns, rows):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    reason = f"Could not find {columns-1} × {rows-1} inner corners for a {columns} × {rows}-square board."
    if np.percentile(gray, 90) < 45:
        return reason + " The captured image is mostly dark or the lens is covered."
    return reason + " Check the saved photo: confirm the square count, keep the whole board visible, and make its squares larger and sharp in the image."


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
    pattern = board_pattern(args.columns, args.rows)
    if args.web:
        from calibration_web import serve
        return serve(args)
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
    (root/"session.json").write_text(json.dumps({"columns": args.columns, "rows": args.rows})+"\n")
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
            print(f"Processing {current_size[0]} × {current_size[1]} photo for {args.columns} × {args.rows} squares…", flush=True)
            cv2.imwrite(str(root/"last-attempt.jpg"), image)
            corners = board_corners(image, pattern)
            if corners is None:
                print(rejection_reason(image, args.columns, args.rows))
                print(f"Actual rejected camera photo: {(root/'last-attempt.jpg').resolve()}")
                continue
            clean = root/f"view-{index:02}.png"
            if not cv2.imwrite(str(clean), image):
                raise ValueError("Could not save image")
            preview = image.copy()
            cv2.drawChessboardCorners(preview, pattern, corners, True)
            cv2.imwrite(str(root/f"corners-{index:02}.jpg"), preview)
            last_stamp = stamp
            print(f"Saved view {index}; check the corners image if unsure about the board detection.")
            break
    print("Twenty views saved. Next run the fit command.")


def fit_views(views, image_size, square_m, pattern=PATTERN):
    if len(views) < 15:
        raise ValueError("At least 15 usable, varied board views are required (aim for 20)")
    if not math.isfinite(square_m) or not .005 <= square_m <= .1:
        raise ValueError("Measured square edge must be 5-100 mm")
    centers = np.array([v.reshape(-1, 2).mean(axis=0) for v in views]) / np.array(image_size)
    if np.ptp(centers[:, 0]) < .25 or np.ptp(centers[:, 1]) < .25:
        raise ValueError("Views are too concentrated; collect views across the image, including its edges")
    objects = np.zeros((pattern[0]*pattern[1], 3), np.float32)
    objects[:, :2] = np.mgrid[0:pattern[0], 0:pattern[1]].T.reshape(-1, 2)*square_m
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
    pattern = session_pattern(args.directory, args.columns, args.rows)
    views, size = [], None
    for path in sorted(args.directory.glob("view-*.png")):
        image = cv2.imread(str(path))
        if image is None:
            continue
        current_size = tuple(image.shape[1::-1])
        if size is not None and current_size != size:
            raise ValueError("Images have different resolutions; do not combine camera modes")
        size = current_size
        corners = board_corners(image, pattern)
        if corners is not None:
            views.append(corners)
    k, dist, rms, per_view = fit_views(views, size, args.square_mm/1000, pattern)
    result = {"measured_and_verified": False, "image_size": list(size), "camera_matrix": k.tolist(),
              "distortion_coefficients": dist.reshape(-1).tolist(), "camera_offset_body_m": [None, None, None],
              "qr_black_square_side_m": args.qr_side_cm/100, "rms_px": rms, "per_view_rms_px": per_view,
              "board_squares": [pattern[0]+1, pattern[1]+1], "views": len(views), "created_at": datetime.now(timezone.utc).isoformat(),
              "notes": "Estimated intrinsics only. Measure the camera offset, validate independent QR target poses and gimbal axes, then record verification. Native resolution, crop and zoom must match the orbit stream."}
    output.write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(f"Saved {output}; RMS {rms:.3f} px from {len(views)} views.")
    print("Flight remains disabled: camera offset and independent physical pose checks are still required.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capture", "fit"))
    parser.add_argument("--directory", type=Path, default=Path("anafi_out/calibration"))
    parser.add_argument("--backend", default="http://127.0.0.1:8787")
    parser.add_argument("--columns", type=int, default=10, help="number of squares across, NOT inner corners")
    parser.add_argument("--rows", type=int, default=7, help="number of squares down, NOT inner corners")
    parser.add_argument("--web", action="store_true", help="capture with a browser button and photo preview")
    parser.add_argument("--port", type=int, default=8791, help="local capture page port")
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
