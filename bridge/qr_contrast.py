"""Bounded exact-payload recovery for small, unevenly illuminated QR images."""
import cv2
import numpy as np


def decode_candidate_crop(gray, candidates, reader, expected):
    """Try at most two small candidate crops; return original camera corners.

    A detected quadrilateral only selects pixels to inspect. It is never an
    identity match: an actual successful payload decode remains mandatory.
    """
    height, width = gray.shape
    attempted = []
    other_code = False
    for candidate in candidates:
        try:
            points = np.asarray(candidate, np.float32).reshape(-1, 2)
        except (ValueError, TypeError):
            continue
        if (points.shape != (4, 2) or not np.isfinite(points).all()
                or not cv2.isContourConvex(points) or np.any(points < 2)
                or np.any(points[:, 0] > width-3) or np.any(points[:, 1] > height-3)):
            continue
        edges = np.linalg.norm(points-np.roll(points, 1, axis=0), axis=1)
        if min(edges) < 20 or max(edges) > 256:
            continue
        low = np.floor(points.min(axis=0)-16).astype(int)
        high = np.ceil(points.max(axis=0)+16).astype(int)
        x0, y0 = max(0, low[0]), max(0, low[1])
        x1, y1 = min(width, high[0]), min(height, high[1])
        bounds = np.array([x0, y0, x1, y1])
        if any(np.max(np.abs(bounds-previous)) < 8 for previous in attempted):
            continue
        if len(attempted) >= 2:
            break
        attempted.append(bounds)
        crop = gray[y0:y1, x0:x1]
        # Magnifying the original intensities preserves weak data cells in
        # screen reflections. The second attempt removes a local light gradient.
        contrast = cv2.adaptiveThreshold(crop, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                         cv2.THRESH_BINARY, 21, 5)
        for source, scale in ((crop, 3), (contrast, 2)):
            enlarged = cv2.resize(source, None, fx=scale, fy=scale,
                                  interpolation=cv2.INTER_CUBIC)
            try:
                text, recovered, modules = reader.detectAndDecode(enlarged)
            except cv2.error:
                continue
            if text and text != expected:
                other_code = True
            if text != expected or recovered is None:
                continue
            recovered = (recovered.astype(np.float64)+.5)/scale-.5+[x0, y0]
            if (np.any(recovered < 2) or np.any(recovered[..., 0] > width-3)
                    or np.any(recovered[..., 1] > height-3)):
                continue
            return text, recovered, modules, other_code
    return '', None, None, other_code
