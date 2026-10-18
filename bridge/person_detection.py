"""Laptop-only person recognition/tracking. No aircraft SDK or control channel."""
import math
from pathlib import Path
import secrets
from datetime import datetime

from fire_detection import box_iou


class PersonDetector:
    """Read the person class from an installed COCO/compatible YOLO model."""
    def __init__(self, model_path, confidence=.5):
        self.model, self.class_id = None, None
        self.confidence = confidence
        self.name = Path(model_path).name
        self.model_status = 'missing'
        if not Path(model_path).is_file():
            print(f'Person model missing: {model_path}; install weights or use --person-model.', flush=True)
            return
        try:
            from ultralytics import YOLO
            model = YOLO(model_path)
            self.class_id = next(k for k, v in model.names.items() if str(v).lower() == 'person')
            self.model = model
            self.model_status = 'ready'
        except Exception as error:
            self.model_status = 'error'
            print(f'Person model unavailable: {type(error).__name__}', flush=True)

    def detect(self, image):
        """Return at most nine normalized person boxes for one real camera frame."""
        if self.model is None:
            return []
        result = self.model(image, imgsz=640, conf=self.confidence,
                            classes=[self.class_id], verbose=False)[0]
        hits = []
        for box, score in zip(result.boxes.xyxyn.tolist(), result.boxes.conf.tolist()):
            if len(box) != 4 or not all(math.isfinite(v) and 0 <= v <= 1 for v in box):
                continue
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            hits.append({'source': 'yolo', 'label': 'person', 'confidence': round(float(score), 3),
                         'bbox': [round(float(v), 4) for v in box]})
        return hits[:9]


class PersonTracks:
    """Associate boxes one-to-one; require three fresh frames and publish every two seconds."""
    def __init__(self):
        self.session = secrets.token_hex(5)
        self.counter = 0
        self.tracks = {}
        self.last_capture = None

    def observe(self, hits, captured, now):
        """Return confirmed tracks needing delivery; duplicate/stale images never add evidence."""
        if not 0 <= now-captured < 2 or (self.last_capture is not None and captured <= self.last_capture):
            return []
        self.last_capture = captured
        self.tracks = {k: v for k, v in self.tracks.items() if captured-v['seen'] < 4}
        matched, ready = set(), []
        for hit in hits:
            candidates = [(box_iou(hit['bbox'], v['bbox']), k) for k, v in self.tracks.items() if k not in matched]
            score, key = max(candidates, default=(0, None))
            if score < .25:
                self.counter += 1
                key = f'p-{self.session}-{self.counter}'
                self.tracks[key] = {'id': key, 'hits': 0, 'seen': captured, 'posted': -math.inf}
            track = self.tracks[key]
            if captured-track['seen'] > 1.5:
                track['hits'] = 0
            track.update(bbox=hit['bbox'], confidence=hit['confidence'], seen=captured, hits=track['hits']+1)
            matched.add(key)
            if track['hits'] >= 3 and now-track['posted'] >= 2:
                ready.append(dict(track))
        for key, track in self.tracks.items():
            if key not in matched:
                track['hits'] = 0
        return ready

    def acknowledged(self, key, now):
        """Advance delivery throttling only after the backend accepts the observation."""
        self.tracks[key]['posted'] = now


def person_payload(track, captured_at, sample, shape, detector):
    """Build actual person evidence; missing pose stays null for camera-only notes."""
    extra = (sample or {}).get('extra') or {}
    pose = {key: (sample or {}).get(key) for key in ('latitude', 'longitude', 'altitude_m')}
    pose.update(heading_deg=extra.get('heading_deg', ((sample or {}).get('attitude_deg') or {}).get('yaw')),
                gimbal_pitch_deg=extra.get('gimbal_pitch_deg'), position_source=extra.get('position_source', 'gps'))
    if pose['heading_deg'] is None:
        pose['heading_deg'] = ((sample or {}).get('attitude_deg') or {}).get('yaw')
    usable = all(isinstance(pose[k], (int, float)) and math.isfinite(pose[k]) for k in
                 ('latitude', 'longitude', 'altitude_m', 'heading_deg', 'gimbal_pitch_deg'))
    usable = usable and pose['altitude_m'] > .5
    if sample and sample.get('gps_fix') is False and pose['position_source'] == 'gps':
        usable = False
    if sample and sample.get('observed_at'):
        pose_at = datetime.fromisoformat(sample['observed_at'].replace('Z', '+00:00')).timestamp()
        frame_at = datetime.fromisoformat(captured_at.replace('Z', '+00:00')).timestamp()
        usable = usable and abs(pose_at-frame_at) <= 2
    return {'obs_id': f"{track['id']}-{int(track['seen']*1000)}", 'observed_at': captured_at,
            'provenance': 'live', 'sensor': 'visible', 'label': 'person', 'detector': detector,
            'track_id': track['id'], 'detector_score': track['confidence'], 'bbox': track['bbox'],
            'drone': pose if usable else None, 'camera': {'hfov_deg': 69, 'aspect': shape[1]/shape[0]},
            'location_reason': 'pose-unavailable'}
