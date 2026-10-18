"""Bounded, asynchronous flight evidence recording; no SDK or video re-encode.

video.mjpeg is a stream of JPEG images playable by ffmpeg/VLC. frames.jsonl
contains capture timestamps and byte offsets, so playback/analysis can retain
real timing even when the camera drops frames. Sessions include preflight.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import queue
import secrets
import shutil
import threading
import time


def json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


class FlightRecorder:
    def __init__(self, root, frame_capacity=60):
        name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-')+secrets.token_hex(4)
        self.path = Path(root)/'flights'/name
        self.path.mkdir(parents=True, exist_ok=False)
        self.frames = queue.Queue(maxsize=frame_capacity)
        self.events = queue.Queue(maxsize=2048)
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.stats = {'frames': 0, 'dropped_frames': 0, 'dropped_events': 0, 'bytes': 0, 'error': None}
        self.worker = threading.Thread(target=self._write, name='flight-recording', daemon=True)
        self.worker.start()
        self.event('recording_started', {'format': 'mjpeg', 'path': str(self.path)})

    def frame(self, jpeg, captured_at):
        with self.lock:
            if self.stopping.is_set() or self.stats['error']:
                return
            try:
                self.frames.put_nowait((jpeg, captured_at))
            except queue.Full:
                self.stats['dropped_frames'] += 1

    def event(self, kind, data):
        with self.lock:
            if self.stopping.is_set() or self.stats['error']:
                return
            entry = {'at_unix': time.time(), 'monotonic': time.monotonic(), 'kind': kind, 'data': data}
            try:
                self.events.put_nowait(entry)
            except queue.Full:
                self.stats['dropped_events'] += 1

    def _write(self):
        try:
            with (self.path/'video.mjpeg').open('wb') as video, \
                 (self.path/'frames.jsonl').open('w') as index, \
                 (self.path/'events.jsonl').open('w') as events:
                flushed = 0.
                while not self.stopping.is_set() or not self.frames.empty() or not self.events.empty():
                    # Event evidence cannot get stuck behind a video backlog.
                    for _ in range(128):
                        try:
                            entry = self.events.get_nowait()
                        except queue.Empty:
                            break
                        events.write(json.dumps(json_safe(entry), allow_nan=False)+'\n')
                    try:
                        jpeg, captured = self.frames.get(timeout=.025)
                    except queue.Empty:
                        pass
                    else:
                        index.write(json.dumps({'frame': self.stats['frames'], 'captured_at_unix': captured,
                                               'offset': video.tell(), 'bytes': len(jpeg)})+'\n')
                        video.write(jpeg)
                        self.stats['frames'] += 1
                        self.stats['bytes'] += len(jpeg)
                    if time.monotonic()-flushed >= 1:
                        for stream in (video, index, events):
                            stream.flush()
                        if shutil.disk_usage(self.path).free < 256*1024*1024:
                            raise OSError('recording stopped: less than 256 MiB free storage')
                        flushed = time.monotonic()
                        self._summary(False)
        except Exception as error:
            self.stats['error'] = str(error)
            print(f'[!] Flight recording failed: {error}', flush=True)
        finally:
            self._summary(True)

    def _summary(self, closed):
        try:
            target = self.path/'recording.json'
            temp = target.with_suffix('.tmp')
            temp.write_text(json.dumps({**self.stats, 'closed': closed})+'\n')
            temp.replace(target)
        except OSError:
            pass  # Disk failure must never block landing or flight supervision.

    def close(self):
        with self.lock:
            self.stopping.set()
        self.worker.join(timeout=5)
