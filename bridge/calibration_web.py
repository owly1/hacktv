"""Local browser capture UI; reads camera snapshots, never controls the drone."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import cv2
from calibrate_camera import board_corners, board_pattern, fetch_camera, rejection_reason

PAGE = r'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Drone camera calibration</title>
<style>[hidden]{display:none}body{font:17px system-ui;margin:30px auto;max-width:1080px;padding:0 20px;background:#f3f4f0;color:#18312b}h1{margin-bottom:6px}p{line-height:1.5}button,input{font:inherit;padding:10px;border:1px solid #9baaa2;border-radius:8px}button{background:#155746;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:wait}input{width:60px}section{background:white;padding:20px;border-radius:14px;margin:18px 0}img{width:100%;display:block;background:#14221e;min-height:100px;border-radius:8px}.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#result{white-space:pre-line}#progress{font-weight:700}small{color:#52665d}</style>
<h1>Calibrate the drone camera</h1><p>Keep the drone grounded. Move the checkerboard, hold it still, then capture. No flight commands are enabled.</p>
<section><div class="controls"><label>Squares across <input id="columns" type="number" min="4" max="20"></label><label>Squares down <input id="rows" type="number" min="4" max="20"></label><button id="capture">Capture photo</button><span id="progress">0 / 20 saved</span><button id="new-session" disabled>Start new photo set</button></div><p id="result" role="status">Loading camera…</p><p id="coverage"></p><small id="folder"></small></section>
<section><h2>Live drone view</h2><p>Attach the sheet flat to a rigid board. Keep all squares visible; vary the board’s tilt, distance and position across the image.</p><p id="video-status" role="status">Connecting to continuous video…</p><img id="live" alt="Live view from the drone camera"></section>
<section><h2>Last capture result</h2><p>Accepted photos show coloured corner markers. Rejected photos are also shown so you can see the problem.</p><img id="attempt" alt="Last processed capture" hidden></section>
<script>
const $=id=>document.getElementById(id); let busy=false;
function status(s){$('columns').value=s.columns;$('rows').value=s.rows;$('columns').disabled=$('rows').disabled=s.count>0;$('progress').textContent=`${s.count} / 20 saved`;$('folder').textContent=`Saved locally: ${s.directory}`;$('capture').disabled=busy||s.count>=20;$('new-session').disabled=busy||s.count===0;$('coverage').textContent=s.coverage;if(s.message)$('result').textContent=s.message;}
fetch('/status').then(r=>r.json()).then(status);
let retry=null, wasFresh=null;
function live(){clearTimeout(retry);$('live').src='/video?t='+Date.now();}
$('live').onerror=()=>{clearTimeout(retry);retry=setTimeout(live,1000);};live();
async function videoStatus(){try{const r=await fetch('/video-status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();$('video-status').textContent=s.fresh?`Receiving ${s.fps.toFixed(1)} FPS · continuous video`:'Waiting for live drone video…';if(s.fresh&&wasFresh===false)live();wasFresh=!!s.fresh;}catch{$('video-status').textContent='Camera connection unavailable; retrying…';wasFresh=false;}finally{setTimeout(videoStatus,2000);}}videoStatus();
async function submit(path){let errorMessage=null;busy=true;$('capture').disabled=$('new-session').disabled=true;$('result').textContent=path==='/capture'?'Processing the photo… looking for checkerboard corners.':'Starting a separate photo folder; previous photos will be kept.';try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({columns:Number($('columns').value),rows:Number($('rows').value)})});const s=await r.json();if(!r.ok)throw Error(s.error);status(s);$('attempt').hidden=path!=='/capture';if(path==='/capture')$('attempt').src='/attempt.jpg?t='+Date.now();}catch(e){errorMessage=e.message;}finally{busy=false;try{const s=await(await fetch('/status')).json();status(s);}catch{errorMessage=errorMessage||'Capture server disconnected.';$('capture').disabled=false;}if(errorMessage)$('result').textContent=errorMessage;}}
$('capture').onclick=()=>submit('/capture');$('new-session').onclick=()=>submit('/new-session');
</script>'''


class CaptureSession:
    def __init__(self, root, columns, rows, camera, resume=False):
        board_pattern(columns, rows)
        self.root, self.columns, self.rows, self.camera = root, columns, rows, camera
        self.base_root = root
        self.centers = []
        root.mkdir(parents=True, exist_ok=True)
        files = sorted(root.glob('view-*.png'))
        if files and not resume:
            raise ValueError('This folder already contains views; use --directory with a new folder')
        self.count = 0
        self.size = self.last_stamp = None
        self.message = 'Ready. Attach the sheet flat to a rigid board, hold the full checkerboard in view and click Capture photo.'
        self.lock = threading.Lock()
        if files:
            saved = json.loads((root/'session.json').read_text())
            board_pattern(saved['columns'], saved['rows'])
            if len(files)>20 or [p.name for p in files] != [f'view-{i:02}.png' for i in range(1,len(files)+1)]:
                raise ValueError('Saved views are not a complete numbered sequence; use a new folder')
            self.columns, self.rows = saved['columns'], saved['rows']
            for path in files:
                image = cv2.imread(str(path))
                if image is None:
                    raise ValueError('A saved view cannot be read; use a new folder')
                size = tuple(image.shape[1::-1])
                if self.size is not None and size != self.size:
                    raise ValueError('Saved views have different resolutions; use a new folder')
                self.size = size
                corners = board_corners(image, board_pattern(self.columns,self.rows))
                if corners is not None:
                    self.centers.append(corners.reshape(-1,2).mean(axis=0)/size)
            if saved.get('image_size') and list(self.size) != saved['image_size']:
                raise ValueError('Saved view resolution does not match this session')
            self.count = len(files)
            self.message = f'Restored {self.count}/20 photos. Existing photos are preserved.'

    def status(self):
        if self.centers:
            xs, ys = zip(*self.centers)
            horizontal, vertical = (max(xs)-min(xs))*100, (max(ys)-min(ys))*100
            coverage = f'Board-position coverage: horizontal {horizontal:.0f}% / 25% needed; vertical {vertical:.0f}% / 25% needed. '
            directions = []
            if horizontal < 25: directions.append('left and right')
            if vertical < 25: directions.append('up and down')
            coverage += ('Move the board '+', then '.join(directions)+', keeping every square visible.' if directions
                         else 'Position coverage reached. Also vary gentle tilts and distance; the final fit still checks accuracy.')
        else:
            coverage = 'Start with the flat board filling about half the view. Use gentle tilts and move across the image; corners must stay visible.'
        return dict(count=self.count, columns=self.columns, rows=self.rows,
                    directory=str(self.root.resolve()), message=self.message, coverage=coverage)

    def new_session(self):
        if not self.lock.acquire(blocking=False):
            raise ValueError('A photo is already being processed')
        try:
            self.root = Path(tempfile.mkdtemp(prefix=self.base_root.name+'-retake-',dir=self.base_root.parent))
            self.count = 0
            self.size = self.last_stamp = None
            self.centers = []
            self.message = 'New photo set ready. Previous photos are preserved. Attach the sheet flat to a rigid board before capturing.'
            return self.status()
        finally:
            self.lock.release()

    def capture(self, columns, rows):
        if not self.lock.acquire(blocking=False):
            raise ValueError('A photo is already being processed')
        try:
            pattern = board_pattern(columns, rows)
            if self.count >= 20:
                raise ValueError('All 20 photos are saved')
            if self.count and (columns, rows) != (self.columns, self.rows):
                raise ValueError('Board size is locked for this session; start a new folder to change it')
            self.columns, self.rows = columns, rows
            image, stamp = self.camera()
            size = tuple(image.shape[1::-1])
            if self.size and size != self.size:
                raise ValueError('Camera resolution changed; restore the original mode or start a new session')
            if stamp == self.last_stamp:
                raise ValueError('Same camera frame; wait for the live view to update')
            self.last_stamp = stamp
            if not cv2.imwrite(str(self.root/'last-attempt.jpg'), image):
                raise ValueError('Could not save the capture preview')
            corners = board_corners(image, pattern)
            if corners is None:
                self.message = rejection_reason(image, columns, rows) + '\nNo calibration view saved. See the last capture below.'
            else:
                index = self.count+1
                if not cv2.imwrite(str(self.root/f'view-{index:02}.png'), image):
                    raise ValueError('Could not save the calibration photo')
                preview = image.copy()
                cv2.drawChessboardCorners(preview, pattern, corners, True)
                cv2.imwrite(str(self.root/f'corners-{index:02}.jpg'), preview)
                cv2.imwrite(str(self.root/'last-attempt.jpg'), preview)
                (self.root/'session.json').write_text(json.dumps({'columns':columns,'rows':rows,'image_size':size})+'\n')
                self.count, self.size = index, size
                self.centers.append(corners.reshape(-1,2).mean(axis=0)/size)
                self.message = f'Saved photo {index}/20 — {len(corners)} corners detected at {size[0]} × {size[1]}. Move or gently tilt the board for the next photo.'
                if index == 20:
                    self.message = 'Twenty photos saved. Tell Codex “done” and the measured width of one square in millimetres.'
            return self.status()
        except ValueError as error:
            self.message = str(error)
            raise
        finally:
            self.lock.release()


def handler_for(session, stream=None, video_status=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, code, data, kind='application/json'):
            if kind=='application/json': data=json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type',kind)
            self.send_header('Content-Length',str(len(data)))
            self.send_header('Cache-Control','no-store')
            self.send_header('Cross-Origin-Resource-Policy','same-origin')
            self.send_header('X-Frame-Options','DENY')
            self.end_headers()
            self.wfile.write(data)

        def local_request(self, write=False):
            host=self.headers.get('Host','')
            valid={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
            origin=self.headers.get('Origin')
            return (host in valid and self.headers.get('Sec-Fetch-Site') != 'cross-site'
                    and (not write or origin==f'http://{host}'))

        def do_GET(self):
            if not self.local_request(): return self.respond(403,{'error':'Use the local capture page'})
            route=urlsplit(self.path).path
            try:
                if route=='/': return self.respond(200,PAGE.encode(),'text/html; charset=utf-8')
                if route=='/status': return self.respond(200,session.status())
                if route=='/video-status' and video_status:
                    return self.respond(200,video_status())
                if route=='/video' and stream:
                    # Forward the backend's JPEG stream verbatim. No snapshot
                    # polling, decoding, re-encoding or frame-rate limiter here.
                    with stream() as upstream:
                        self.send_response(200)
                        self.send_header('Content-Type',upstream.headers['Content-Type'])
                        self.send_header('Cache-Control','no-store')
                        self.send_header('Cross-Origin-Resource-Policy','same-origin')
                        self.end_headers()
                        try:
                            while chunk := upstream.read1(64*1024):
                                self.wfile.write(chunk)
                                self.wfile.flush()
                        except (OSError,TimeoutError):
                            pass  # Browser closed, or receiver needs reconnecting.
                    return
                if route=='/live.jpg':
                    image,_=session.camera()
                    ok,jpeg=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,85])
                    if not ok: raise ValueError('Camera image could not be encoded')
                    return self.respond(200,jpeg.tobytes(),'image/jpeg')
                if route=='/attempt.jpg':
                    return self.respond(200,(session.root/'last-attempt.jpg').read_bytes(),'image/jpeg')
                return self.respond(404,{'error':'Not found'})
            except Exception as error:
                return self.respond(503,{'error':str(error) if isinstance(error,ValueError) else 'Camera unavailable; check the observation receiver'})

        def do_POST(self):
            if not self.local_request(write=True): return self.respond(403,{'error':'Capture must come from this local page'})
            if self.path not in ('/capture','/new-session'): return self.respond(404,{'error':'Not found'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=1024: raise ValueError('Invalid capture request')
                body=json.loads(self.rfile.read(length))
                return self.respond(200,session.new_session() if self.path=='/new-session' else session.capture(body['columns'],body['rows']))
            except (ValueError,KeyError,TypeError) as error:
                return self.respond(400,{'error':str(error)})
            except Exception:
                return self.respond(503,{'error':'Capture failed; check camera connection and local folder permissions'})
    return Handler


def serve(args):
    url=urlsplit(args.backend)
    if url.scheme!='http' or url.hostname not in ('localhost','127.0.0.1') or url.path not in ('','/'):
        raise ValueError('Use a local BOSCO backend URL')
    base=args.backend.rstrip('/')
    with urlopen(base+'/api/session',timeout=5) as response:
        token=json.load(response)['token']
    session=CaptureSession(args.directory,args.columns,args.rows,lambda:fetch_camera(base,token),resume=True)
    def request(path):
        return urlopen(Request(base+path,headers={'Authorization':'Bearer '+token}),timeout=5)
    def video_status():
        with request('/api/status') as response:
            return json.load(response).get('video',{'fresh':False,'fps':0})
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler_for(session,lambda:request('/api/video'),video_status))
    print(f'Open http://127.0.0.1:{server.server_port}/ — use Capture photo; no Enter key or second terminal needed.',flush=True)
    try: server.serve_forever()
    finally: server.server_close()
