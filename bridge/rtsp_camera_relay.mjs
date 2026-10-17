// Camera reception only. No Olympe session, piloting, gimbal or flight commands.
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const MAX_JPEG = 2 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// FFmpeg stdout chunks do not necessarily align with JPEG boundaries.
export class JpegFrames {
  buffer = Buffer.alloc(0);
  constructor(onFrame) { this.onFrame = onFrame; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        return;
      }
      this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(EOI, 2);
      if (end < 0) {
        if (this.buffer.length > MAX_JPEG) throw new Error('Camera frame exceeds 2 MiB.');
        return;
      }
      const length = end + 2;
      if (length > MAX_JPEG) throw new Error('Camera frame exceeds 2 MiB.');
      this.onFrame(Buffer.from(this.buffer.subarray(0, length)));
      this.buffer = this.buffer.subarray(length);
    }
  }
}

export async function main() {
  const { values } = parseArgs({ options: {
    backend: { type: 'string', default: 'http://127.0.0.1:8787' },
    url: { type: 'string', default: 'rtsp://192.168.53.1/live' },
    fps: { type: 'string', default: '10' },
    width: { type: 'string', default: '960' },
    ffmpeg: { type: 'string', default: 'ffmpeg' },
  }});
  const backend = new URL(values.backend);
  if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname)
      || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('Backend must be a plain HTTP loopback origin.');
  }
  const stream = new URL(values.url);
  if (stream.protocol !== 'rtsp:' || stream.username || stream.password) {
    throw new Error('Use an RTSP URL without embedded credentials.');
  }
  const fps = Number(values.fps), width = Number(values.width);
  if (!Number.isFinite(fps) || fps < 1 || fps > 15) throw new Error('FPS must be 1-15.');
  if (!Number.isInteger(width) || (width !== 0 && (width < 320 || width > 1920 || width % 2))) {
    throw new Error('Width must be 0 for native size, or an even value from 320 to 1920.');
  }
  const token = process.env.INGEST_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw new Error('Set INGEST_TOKEN through the local environment file.');
  const sessionResponse = await fetch(new URL('/api/session', backend), { signal: AbortSignal.timeout(5000) });
  if (!sessionResponse.ok) throw new Error('Local backend is unavailable.');
  const session = await sessionResponse.json();
  if (session.contract !== 'emberwatch.v1' || !process.env.DASHBOARD_TOKEN
      || session.token !== process.env.DASHBOARD_TOKEN) {
    throw new Error('Environment file does not match the active local backend.');
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-rtsp_transport', 'udp', '-timeout', '6000000', '-analyzeduration', '2000000',
    '-probesize', '1000000', '-i', stream.href, '-map', '0:v:0', '-an',
    '-vf', `fps=${fps}${width ? `,scale=${width}:-2` : ''}`,
    '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1'];
  const child = spawn(values.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let latest = null, busy = false, stopped = false, failed = false;
  let sent = 0, dropped = 0, lastSentAt = null, failures = 0, lastStats = Date.now();
  let lastSent = 0, lastReceived = Date.now();
  const stop = () => { stopped = true; latest = null; child.kill(); };
  const fail = (message) => { failed = true; console.error(message); stop(); };
  const sendLatest = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      while (latest && !stopped) {
        const frame = latest; latest = null;
        try {
          const reply = await fetch(new URL('/api/ingest/frame', backend), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg',
              'X-Captured-At': frame.receivedAt }, body: frame.jpeg,
          });
          await reply.body?.cancel();
          if (reply.status === 401 || reply.status === 403) {
            fail('Backend rejected camera authentication. Check the environment file.'); break;
          }
          if (reply.status !== 204) throw new Error('Frame not accepted.');
          sent++; lastSentAt = frame.receivedAt; failures = 0;
        } catch {
          if (++failures >= 5) fail('Camera stopped after repeated backend delivery failures.');
        }
      }
    } finally { busy = false; }
  };
  const parser = new JpegFrames((jpeg) => {
    lastReceived = Date.now();
    if (stopped) return;
    if (latest) dropped++;
    latest = { jpeg, receivedAt: new Date().toISOString() };
    void sendLatest();
  });
  child.stdout.on('data', (chunk) => {
    try { parser.push(chunk); } catch (error) { fail(error.message); }
  });
  // Suppress FFmpeg's RTSP metadata, which can include aircraft identifiers.
  child.stderr.on('data', () => {});
  const stats = setInterval(() => {
    const now = Date.now();
    console.log(JSON.stringify({ camera_only: true, frames_sent: sent,
      delivered_fps: Number(((sent - lastSent) * 1000 / (now - lastStats)).toFixed(1)),
      dropped_frames: dropped, last_frame_received_at: lastSentAt }));
    lastSent = sent; lastStats = now;
    if (now - lastReceived > 15000) fail('No decoded camera frame for 15 seconds. Check controller and aircraft.');
  }, 5000);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log('Camera-only relay started. No telemetry or flight control is provided. Ctrl+C stops reception.');
  const code = await new Promise((resolve) => {
    child.once('error', () => { failed = true; console.error('Could not start FFmpeg. Check its installation.'); resolve(1); });
    child.once('close', (exitCode) => resolve(exitCode));
  });
  const wasStopped = stopped;
  stop(); clearInterval(stats);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (failed || (!wasStopped && code !== 0)) throw new Error('Camera relay ended. Check USB, controller and aircraft connections.');
  console.log(`Camera relay stopped; delivered ${sent} frames. No flight command sent.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
