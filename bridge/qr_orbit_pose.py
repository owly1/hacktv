"""Calibrated square-marker pose for a floor-level QR demonstration."""
import json
import math
from pathlib import Path

import cv2
import numpy as np

from qr_orbit_core import Marker


def rotation(roll, pitch, yaw):
    r, p, y = map(math.radians, (roll, pitch, yaw))
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    return np.array([[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
                     [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr], [-sp, cp*sr, cp*cr]])


class CalibratedPose:
    def __init__(self, path, require_verified=True):
        c = json.loads(Path(path).read_text(encoding="utf-8"))
        if require_verified and c.get("measured_and_verified") is not True:
            raise ValueError("Camera intrinsics, gimbal axes and camera offset have not been measured/verified")
        self.size = tuple(c["image_size"])
        self.k = np.array(c["camera_matrix"], dtype=float)
        self.dist = np.array(c["distortion_coefficients"], dtype=float)
        self.offset = np.array(c["camera_offset_body_m"], dtype=float)
        self.side = float(c["qr_black_square_side_m"])
        if (len(self.size) != 2 or any(not isinstance(x, int) or x <= 0 for x in self.size)
                or self.k.shape != (3, 3) or not np.isfinite(self.k).all()
                or self.k[0, 0] <= 0 or self.k[1, 1] <= 0 or not np.allclose(self.k[2], [0, 0, 1])
                or not np.isfinite(self.dist).all() or self.dist.size not in (4, 5, 8, 12, 14)
                or self.offset.shape != (3,) or not np.isfinite(self.offset).all()
                or np.linalg.norm(self.offset) > .3 or not .15 <= self.side <= .6):
            raise ValueError("Invalid calibration; use the exact decoded video resolution and measured QR size")
        s = self.side / 2
        # OpenCV's IPPE_SQUARE ordering matches QR decoder TL,TR,BR,BL order.
        self.object_points = np.array([[-s, s, 0], [s, s, 0], [s, -s, 0], [-s, -s, 0]], dtype=np.float64)

    def estimate(self, text, corners, shape, at, aircraft_yaw, gimbal_absolute):
        if (shape[1], shape[0]) != self.size:
            raise ValueError(f"Video resolution {shape[1]}x{shape[0]} does not match calibration {self.size}")
        points = np.array(corners, dtype=np.float64).reshape(4, 2)
        if not np.isfinite(points).all() or min(np.linalg.norm(points[i]-points[(i+1) % 4]) for i in range(4)) < 35:
            raise ValueError("QR corners too small or invalid for a flight pose")
        g = gimbal_absolute
        if not all(math.isfinite(v) for v in (aircraft_yaw, g["roll_absolute"], g["pitch_absolute"], g["yaw_absolute"])):
            raise ValueError("Gimbal/aircraft orientation unknown")
        # CV camera: right/down/forward -> level aircraft: forward/right/down.
        cv_to_frd = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]])
        world_camera = rotation(g["roll_absolute"], g["pitch_absolute"], g["yaw_absolute"]) @ cv_to_frd
        level_world = rotation(0, 0, -aircraft_yaw)
        transform = level_world @ world_camera
        ok, rvecs, tvecs, _ = cv2.solvePnPGeneric(self.object_points, points, self.k, self.dist,
                                                flags=cv2.SOLVEPNP_IPPE_SQUARE)
        if not ok:
            raise ValueError("No square-marker pose")
        candidates = []
        for r, t in zip(rvecs, tvecs):
            if t[2, 0] <= 0:
                continue
            projected, _ = cv2.projectPoints(self.object_points, r, t, self.k, self.dist)
            error = float(np.sqrt(np.mean(np.sum((projected.reshape(4, 2)-points)**2, axis=1))))
            center = transform @ t.reshape(3) + self.offset
            normal = transform @ cv2.Rodrigues(r)[0][:, 2]
            tilt = math.degrees(math.acos(float(np.clip(abs(normal[2]), 0, 1))))
            if tilt <= 12 and error <= 2:
                candidates.append((error, center, tilt))
        if not candidates:
            raise ValueError("Marker is not a consistent flat floor target")
        candidates.sort(key=lambda item: item[0])
        if len(candidates) > 1 and np.linalg.norm(candidates[0][1]-candidates[1][1]) > .08:
            raise ValueError("Ambiguous marker pose")
        error, center, tilt = candidates[0]
        return Marker(at, text, *map(float, center), tilt, error)
