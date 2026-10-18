"""Shared RGB fire/smoke and EW1 fire-marker QR detector; no aircraft SDK or controls."""
import math
import os
import time
import cv2
import numpy as np
from qr_visual_track import QRVisualTrack, QRTemplateTrack
from qr_contrast import decode_candidate_crop

QR_PREFIX = "EW1:"
# The one QR code the drone treats as a fire: the printed FireSimulationDemo
# marker (dist/test-marker.html, bridge/orbit-marker.txt). Any other code,
# including other EW1: payloads, is ignored. Must match
# bridge/make_test_marker.py and backend/validation.mjs.
FIRE_MARKER_PAYLOAD = "EW1:Alpha|120|X|35|M|30|60|31|18|18"

# YOLO false-alarm filters
DEFAULT_CONF = 0.65           # minimum YOLO score
MIN_BOX_AREA = 0.0005         # boxes smaller than this fraction of the frame are noise
MAX_BOX_AREA = 0.6            # ...and larger than this are whole-frame washes (sky, sun, lens flare)
FLAME_HSV_LO = (0, 100, 170)  # bright, saturated red-orange-yellow pixels
FLAME_HSV_HI = (35, 255, 255)
MIN_FLAME_FRACTION = 0.04     # share of a "fire" box that must be flame-coloured

# Confirmation: a QR payload is exact, a YOLO box needs a longer, steadier run
QR_CONFIRM_HITS = 3
YOLO_CONFIRM_HITS = 5
TRACK_MIN_IOU = 0.1           # a YOLO hit must overlap the previous one to extend the run

INTENSITY_CODES = {"L": "low", "M": "moderate", "H": "high", "X": "extreme"}
FUEL_CODES = {"F": "dry conifer forest", "G": "cured grass", "M": "dry mixed forest and grass", "S": "brush and shrub"}


def parse_marker(text):
    """Decode the Emberwatch fire marker into fire details, or None.

    Only FIRE_MARKER_PAYLOAD is accepted, byte for byte; every other QR code
    (other EW1: payloads included) returns None and is never reported as a fire.
    Payload (kept short so the code has few, large modules and reads from ~2 m):
    EW1:name|area_ha|intensity|spread_m_per_min|fuel|wind_kmh|toward_deg|temp_c|rh_pct|side_cm
    """
    if text != FIRE_MARKER_PAYLOAD:
        return None
    fields = text[len(QR_PREFIX):].split("|")
    if len(fields) != 10:
        return None
    try:
        name, area, inten, spread, fuel, wind, toward, temp, rh, side = fields
        values = [float(x) for x in (area, spread, wind, toward, temp, rh, side)]
        if not all(math.isfinite(x) for x in values) or inten not in INTENSITY_CODES or fuel not in FUEL_CODES:
            return None
        if not (0 <= values[0] <= 1e7 and 0 <= values[1] <= 10000 and 0 <= values[2] <= 500
                and 0 <= values[3] <= 360 and -100 <= values[4] <= 100
                and 0 <= values[5] <= 100 and 0 < values[6] <= 1000):
            return None
        return {
            "name": name or "Test fire",
            "area_ha": float(area),
            "intensity": INTENSITY_CODES.get(inten, inten),
            "spread_m_per_min": float(spread),
            "fuel": FUEL_CODES.get(fuel, fuel),
            "wind_kmh": float(wind),
            "wind_dir_deg": float(toward),
            "temp_c": float(temp),
            "rh_pct": float(rh),
            "marker_size_m": float(side) / 100,
            "test_marker": True,
        }
    except ValueError:
        return None


class FireDetector:
    """One-frame YOLO/QR detection; the caller handles episode confirmation.
    YOLO boxes must be plausibly sized and, for fire, flame-coloured; smoke is
    ignored unless detect_smoke (it fires on fog, dust, haze and clouds)."""

    def __init__(self, model_path, conf=DEFAULT_CONF, use_yolo=True, detect_smoke=False):
        """Initialize QR readers and the optional filtered fire/smoke model."""
        self.conf = conf
        self.qr_track=QRVisualTrack()
        self.qr_template=QRTemplateTrack()
        self._qr_contrast_at=float('-inf')
        self.labels = ('fire', 'smoke') if detect_smoke else ('fire',)
        # Two QR readers: the classic one is fast; the ArUco-based one finds
        # small, tilted or noisy codes the classic one misses.
        self.qr_readers = [cv2.QRCodeDetector()]
        if hasattr(cv2, "QRCodeDetectorAruco"):
            self.qr_readers.append(cv2.QRCodeDetectorAruco())
        self.model = None
        self._model_warmed = False
        self.model_status = 'disabled' if not use_yolo else 'missing'
        if use_yolo:
            if os.path.exists(model_path):
                try:
                    from ultralytics import YOLO
                    self.model = YOLO(model_path)
                    names = {str(v).lower() for v in self.model.names.values()}
                    if not names or not names <= {'fire', 'smoke'}:
                        raise ValueError('Expected fire/smoke model classes')
                    self.model_status = 'ready'
                    print(f"[*] Fire model loaded: {model_path} {self.model.names}")
                except Exception as e:  # missing ultralytics/torch: QR marker still works
                    self.model = None
                    self.model_status = 'error'
                    print(f"[!] Fire model unavailable ({type(e).__name__}); QR test marker only")
            else:
                print(f"[!] Fire model not found at {model_path}; run bridge/setup.sh. QR test marker only")

    def warmup(self):
        """Initialize lazy RGB inference before live frames or readiness exist.

        Ultralytics creates its predictor on the first inference and can reset
        Torch's thread count during that creation. Restore the laptop budget
        after initialization, rather than repeatedly modifying it per frame.
        QR tracking is deliberately untouched by this synthetic image.
        """
        if self.model is None:return False
        if self._model_warmed:return True
        torch=None;failure=None
        try:
            import torch
            self.model(np.zeros((720,1280,3),np.uint8),imgsz=640,conf=self.conf,verbose=False)
        except Exception as error:
            failure=error
        finally:
            if torch is not None:
                try:torch.set_num_threads(2)
                except Exception as error:failure=error
        if failure is not None:
            self.model=None;self.model_status='error'
            print(f'[!] Fire model warmup failed ({type(failure).__name__}); QR test marker only',flush=True)
            return False
        self._model_warmed=True
        return True

    def detect(self, bgr, *, captured_at=None):
        """Best hit in this frame: dict(source, label, confidence, bbox, details) or None."""
        h, w = bgr.shape[:2]
        details = points = modules = None
        captured_at=time.time() if captured_at is None else captured_at
        other_code=False; candidates=[]; template_match=None
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        for reader in self.qr_readers:
            try:
                text, points, modules = reader.detectAndDecode(gray)
            except cv2.error:
                continue
            details = parse_marker(text)
            if points is not None:candidates.append(points.copy())
            other_code=other_code or bool(text and not details)
            if details and points is not None:
                break
        if not details and candidates and not other_code:
            text, recovered, recovered_modules, wrong = decode_candidate_crop(
                gray, candidates, self.qr_readers[0], FIRE_MARKER_PAYLOAD)
            other_code=other_code or wrong
            if recovered is not None:
                points,modules=recovered,recovered_modules
                details=parse_marker(text)
        if not details:
            # The repository PNG has no quiet zone. A white border also helps
            # when a displayed code reaches the image edge; undo it in boxes.
            pad = max(16, min(h, w) // 12)
            padded = cv2.copyMakeBorder(gray, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
            text, points, modules = self.qr_readers[0].detectAndDecode(padded)
            details = parse_marker(text)
            other_code=other_code or bool(text and not details)
            if points is not None:
                points = points - pad
                candidates.append(points.copy())
        if not details:
            # A flat screen seen obliquely compresses QR modules vertically.
            # Decode a stretched copy, but always publish corners in the
            # ORIGINAL camera pixels used by calibrated pose estimation.
            for scale in (1.5, 2.0):
                stretched = cv2.resize(gray, (w, round(h*scale)), interpolation=cv2.INTER_CUBIC)
                try:
                    text, candidate, modules = self.qr_readers[0].detectAndDecode(stretched)
                except cv2.error:
                    continue
                details = parse_marker(text)
                other_code=other_code or bool(text and not details)
                if candidate is not None:
                    original=candidate.astype(np.float32).copy()
                    original[...,1]=(original[...,1]+.5)/(stretched.shape[0]/h)-.5
                    candidates.append(original)
                if details and candidate is not None:
                    points = candidate.astype(np.float64).copy()
                    points[..., 1] = (points[..., 1]+.5)/(stretched.shape[0]/h)-.5
                    break
                details = None
        if (not details and not other_code
                and captured_at-self._qr_contrast_at>=.4):
            # One extra full-frame scan at most every 400 ms. Most recoverable
            # glare frames finish in the small candidate crop above instead.
            self._qr_contrast_at=captured_at
            contrast=cv2.adaptiveThreshold(gray,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                           cv2.THRESH_BINARY,21,5)
            try:
                text,candidate,recovered_modules=self.qr_readers[0].detectAndDecode(contrast)
            except cv2.error:
                text,candidate,recovered_modules='',None,None
            other_code=other_code or bool(text and not parse_marker(text))
            if candidate is not None:candidates.append(candidate.copy())
            if parse_marker(text) and candidate is not None:
                points,modules,details=candidate,recovered_modules,parse_marker(text)
        tracking='decoded';decoded_at=captured_at
        if details and points is not None:
            self.qr_template.seed(gray,points,captured_at,modules)
            if modules is not None:
                quad=np.asarray(points).reshape(4,2)
                edges=np.linalg.norm(quad-np.roll(quad,1,axis=0),axis=1)
                if min(edges)>=20 and max(edges)<=128:
                    # A successful payload decode does not guarantee a good
                    # inferred fourth corner, especially on a 50 px QR. Fit
                    # those exact decoded data cells to ORIGINAL gray pixels
                    # before using the corners for calibrated metric pose.
                    localized=self.qr_template.match(gray,[points],captured_at)
                    if localized is not None:points=localized['corners']
            self.qr_track.seed(gray,points,captured_at)
        elif other_code:
            self.qr_track.clear()
            self.qr_template.clear()
        else:
            flow=self.qr_track.follow(gray,captured_at)
            if flow is not None:candidates.append(flow)
            template_match=self.qr_template.match(gray,candidates,captured_at)
            if template_match is not None:
                points=template_match['corners'];text=FIRE_MARKER_PAYLOAD;details=parse_marker(text)
                tracking='visual-template';decoded_at=template_match['decoded_at']
            elif flow is not None:
                points=flow
                text=FIRE_MARKER_PAYLOAD;details=parse_marker(text)
                tracking='optical-flow';decoded_at=self.qr_track.decoded_at
        if details and points is not None:
            pts = points.reshape(-1, 2)
            x1, y1 = pts.min(axis=0)
            x2, y2 = pts.max(axis=0)
            side_px = float(np.mean([np.linalg.norm(pts[i] - pts[(i + 1) % 4]) for i in range(4)]))
            hit={"source": "qr-test", "label": "fire", "confidence": 1.0,
                    "bbox": [round(float(v), 4) for v in (max(0.0, x1 / w), max(0.0, y1 / h),
                                                          min(1.0, x2 / w), min(1.0, y2 / h))],
                    "details": details, "marker_side_px": side_px, "frame_w": w,
                    "qr_text": text, "qr_corners": pts.tolist(),
                    "qr_tracking":tracking,"qr_decoded_at":decoded_at*1000}
            if template_match is not None:
                hit.update(qr_template_score=template_match['score'],qr_template_data_score=template_match['data_score'],
                           qr_template_module_error=template_match['module_error'],
                           qr_template_module_coverage=template_match['module_coverage'])
            return hit
        if self.model is None:
            return None
        result = self.model(bgr, imgsz=640, conf=self.conf, verbose=False)[0]
        best = None
        for box, cls, score in zip(result.boxes.xyxyn.tolist(), result.boxes.cls.tolist(),
                                   result.boxes.conf.tolist()):
            label = str(self.model.names[int(cls)]).lower()
            if label not in self.labels:
                continue
            area = (box[2] - box[0]) * (box[3] - box[1])
            if not MIN_BOX_AREA <= area <= MAX_BOX_AREA:
                continue
            if label == "fire" and flame_fraction(bgr, box) < MIN_FLAME_FRACTION:
                continue
            # fire outranks smoke at equal confidence: it's the more specific evidence
            rank = score + (0.05 if label == "fire" else 0.0)
            if best is None or rank > best[0]:
                best = (rank, {"source": "yolo", "label": label, "confidence": round(float(score), 3),
                               "bbox": [round(v, 4) for v in box], "details": None})
        return best[1] if best else None


def flame_fraction(bgr, box):
    """Share of pixels inside a normalized box that look like flame (bright, warm, saturated)."""
    h, w = bgr.shape[:2]
    x1, y1 = int(box[0] * w), int(box[1] * h)
    x2, y2 = max(x1 + 1, int(box[2] * w)), max(y1 + 1, int(box[3] * h))
    mask = cv2.inRange(cv2.cvtColor(bgr[y1:y2, x1:x2], cv2.COLOR_BGR2HSV), FLAME_HSV_LO, FLAME_HSV_HI)
    return float(np.count_nonzero(mask)) / mask.size


def box_iou(a, b):
    """Measure normalized-box overlap for same-location fire confirmation."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def confirm_hits(hit):
    """Consecutive hits needed before this kind of hit opens an episode."""
    return QR_CONFIRM_HITS if hit["source"] == "qr-test" else YOLO_CONFIRM_HITS


def same_spot(hit, previous_bbox):
    """QR hits are matched by payload; YOLO hits must stay in roughly the same place."""
    return hit["source"] == "qr-test" or (previous_bbox is not None
                                           and box_iou(hit["bbox"], previous_bbox) >= TRACK_MIN_IOU)
