// Contract tests for the live pipeline: video relay, fire detections and the
// automatic Gemini analysis they trigger, flight events, plans, TigerData
// summaries, the localhost session bootstrap, demo data and the tile cache.
// Every external service is faked — these are not live Gemini/TigerData calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, MemoryStorage, makeGeminiTransport, buildAnalysisParts } from '../backend/server.mjs';

const INGEST = 'ingest-token-aaa';
const DASH = 'dashboard-token-bbb';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const analysisReply = {
  candidates: [{ content: { parts: [{ text: JSON.stringify({
    summary: 'Extreme fire in dry grass.', severity: 'extreme', observations: ['Flame front visible'],
    spread_outlook: 'Toward the ENE at 35 m/min.', unknowns: ['Fuel continuity'], falsifiers: [], limitations: 'Single frame.',
  }) }] } }],
};
const planReply = {
  candidates: [{ content: { parts: [{ text: JSON.stringify({
    title: 'Initial attack — Alpha', situation: 'A 120 ha fire spreading ENE.', objectives: ['Hold the east flank'],
    actions: [{ priority: 2, action: 'Stage tender', owner: 'Tender 1', timing: 'T+10' }, { priority: 1, action: 'Anchor east flank', owner: 'Engine 1', timing: 'now' }],
    resources: ['2 engines'], triggers: ['Wind > 40 km/h'], risks: ['Spotting'], advantage: 'Live position and spread timing.',
  }) }] } }],
};

async function startApp(options = {}) {
  const calls = [];
  const replies = options.replies ?? [];
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'emberwatch-test-'));
  const storage = new MemoryStorage();
  const app = createApp({
    ingestToken: INGEST,
    dashboardToken: DASH,
    allowedOrigins: [],
    storage,
    dataDir,
    geminiTransport: options.noGemini ? null : async (body) => {
      calls.push(structuredClone(body));
      const reply = replies.shift();
      if (!reply) throw new Error('no queued reply');
      return reply;
    },
    geminiModel: 'fake-model',
    demoFires: [{ id: 'f1', name: 'Fire One' }],
    tileFetch: options.tileFetch,
    now: options.now,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, { token, body, headers } = {}) => fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const close = async () => { server.close(); server.closeAllConnections?.(); await rm(dataDir, { recursive: true, force: true }); };
  return { base, req, calls, storage, close };
}

const now = () => new Date().toISOString();
const detection = (over = {}) => ({
  detected_at: now(), episode_id: 'ep-test-1', source: 'qr-test', label: 'fire', confidence: 1,
  bbox: [0.4, 0.4, 0.6, 0.6],
  fire: { latitude: 43.7866, longitude: -79.1902, distance_m: 1.7, bearing_deg: 94, position_source: 'home+odometry+marker-size' },
  drone: { latitude: 43.7866, longitude: -79.1903, altitude_m: 1 },
  details: { name: 'Alpha', area_ha: 120, spread_m_per_min: 35, wind_kmh: 30, wind_dir_deg: 60 },
  frame_jpeg_base64: JPEG.toString('base64'),
  ...over,
});
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('Gemini retries timed-out inference and keeps the response-body timeout active', async () => {
  let calls = 0;
  const transport = makeGeminiTransport({ apiKey:'test', model:'fake', retryDelayMs:0, timeoutMs:5,
    fetchImpl: async (_url, {signal}) => {
      calls++;
      if (calls === 1) return {ok:true, json:() => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('timeout','AbortError')), {once:true});
      })};
      return {ok:true, json:async()=>analysisReply};
    } });
  assert.deepEqual(await transport({}), analysisReply);
  assert.equal(calls, 2);
});

test('connection freshness expires and recovers on the same backend and video subscription', async () => {
  let clock = Date.now();
  const t = await startApp({ noGemini: true, now: () => clock });
  const abort = new AbortController();
  try {
    const status = async () => (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal((await status()).connection.state, 'waiting');
    const viewer = await fetch(`${t.base}/api/video`, {
      headers: { authorization: `Bearer ${DASH}` }, signal: abort.signal,
    });
    const reader = viewer.body.getReader();
    const publish = async () => {
      const at = new Date(clock).toISOString();
      assert.equal((await t.req('POST', '/api/ingest/telemetry', {
        token: INGEST, body: { provenance: 'live', drone_id: 'ANAFI-01', observed_at: at, battery_pct: 80 },
      })).status, 200);
      assert.equal((await t.req('POST', '/api/ingest/frame', {
        token: INGEST, body: JPEG, headers: { 'content-type': 'image/jpeg', 'x-captured-at': at },
      })).status, 204);
      let payload = '';
      while (!payload.includes('\xff\xd9')) payload += Buffer.from((await reader.read()).value).toString('latin1');
      assert.ok(payload.includes(at));
    };
    await publish();
    assert.deepEqual((await status()).connection, { connected: true, state: 'live' });
    clock += 4000;
    assert.equal((await status()).connection.state, 'telemetry-only');
    clock += 7000;
    const stale = await status();
    assert.deepEqual(stale.connection, { connected: false, state: 'disconnected' });
    assert.equal(stale.telemetry.available, true);
    assert.equal(stale.telemetry.fresh, false);
    assert.equal(stale.camera.fresh, false);
    assert.equal(stale.video.fps, 0);
    await publish();
    assert.deepEqual((await status()).connection, { connected: true, state: 'live' });
  } finally { abort.abort(); await t.close(); }
});

test('video frames are relayed to /api/video viewers with capture time and overlay boxes', async () => {
  const t = await startApp({ noGemini: true });
  try {
    const controller = new AbortController();
    const viewer = await fetch(`${t.base}/api/video`, { headers: { authorization: `Bearer ${DASH}` }, signal: controller.signal });
    assert.match(viewer.headers.get('content-type'), /multipart\/x-mixed-replace/);
    const captured = now();
    const post = await t.req('POST', '/api/ingest/frame', {
      token: INGEST, body: JPEG,
      headers: { 'content-type': 'image/jpeg', 'x-captured-at': captured, 'x-detections': JSON.stringify([{ label: 'fire', confidence: 0.9, bbox: [0, 0, 1, 1] }]) },
    });
    assert.equal(post.status, 204);
    const reader = viewer.body.getReader();
    let text = '';
    while (!text.includes('\xff\xd9')) text += Buffer.from((await reader.read()).value).toString('latin1');
    assert.match(text, /--emberframe/);
    assert.match(text, new RegExp(`X-Captured-At: ${captured.replace(/\./g, '\\.')}`));
    assert.match(text, /X-Detections: \[\{"label":"fire"/);
    controller.abort();
    const status = await (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal(status.video.available, true);
    assert.equal(status.camera.available, true); // the latest frame is also Gemini evidence
  } finally { await t.close(); }
});

test('vision health is authenticated, expires, and never creates a fire by itself', async () => {
  let clock = Date.now();
  const t = await startApp({ noGemini: true, now: () => clock });
  try {
    const body = { observed_at: new Date(clock).toISOString(), model_status: 'ready', camera_state: 'live' };
    assert.equal((await t.req('POST', '/api/ingest/vision', { token: DASH, body })).status, 401);
    assert.equal((await t.req('POST', '/api/ingest/vision', { token: INGEST, body: {...body, model_status:'imaginary'} })).status, 400);
    assert.equal((await t.req('POST', '/api/ingest/vision', { token: INGEST, body })).status, 200);
    let status = await (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal(status.vision.fresh, true);
    assert.equal(status.detection.active, false);
    clock += 10001;
    status = await (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal(status.vision.fresh, false);
  } finally { await t.close(); }
});

test('RGB fire without GPS activates an incident and automatic analysis', async () => {
  const t = await startApp({ replies: [analysisReply] });
  try {
    const post = await t.req('POST', '/api/ingest/detection', { token: INGEST,
      body: detection({ source: 'yolo', episode_id: 'rgb-no-gps', details: null,
        fire: { latitude: null, longitude: null, position_source: 'unavailable' } }) });
    assert.equal(post.status, 200);
    const incident = (await (await t.req('GET', '/api/incident', { token: DASH })).json()).incident;
    assert.equal(incident.active, true);
    assert.equal(incident.latest.fire.latitude, null);
    await waitFor(async () => (await (await t.req('GET', '/api/analysis/latest', { token: DASH })).json()).analysis);
    assert.equal(t.calls.length, 1);
  } finally { await t.close(); }
});

test('Pi observer snapshots also reach existing camera viewers and retain capture metadata', async () => {
  const t = await startApp({ noGemini: true });
  const controller = new AbortController();
  try {
    const synthetic = await t.req('POST', '/api/ingest/snapshot', {
      token: INGEST, body: {
        provenance: 'simulation', mime_type: 'image/jpeg', captured_at: now(),
        data: JPEG.toString('base64'),
      },
    });
    assert.equal(synthetic.status, 400);
    const missing = await t.req('GET', '/api/snapshot', { token: DASH });
    assert.equal(missing.status, 404);
    const viewer = await fetch(`${t.base}/api/video`, {
      headers: { authorization: `Bearer ${DASH}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    const captured = now();
    const post = await t.req('POST', '/api/ingest/snapshot', {
      token: INGEST, body: {
        provenance: 'live', mime_type: 'image/jpeg', captured_at: captured,
        data: JPEG.toString('base64'),
      },
    });
    assert.equal(post.status, 200);
    const reader = viewer.body.getReader();
    let payload = '';
    while (!payload.includes('\xff\xd9')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      payload += Buffer.from(chunk.value).toString('latin1');
    }
    assert.ok(payload.includes(`X-Captured-At: ${captured}`));
    assert.ok(payload.includes('X-Detections: []'));
    controller.abort();
    const status = await (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal(status.video.available, true);
    assert.equal(status.camera.available, true);
    const snapshot = await t.req('GET', '/api/snapshot', { token: DASH });
    assert.equal(snapshot.headers.get('x-captured-at'), captured);
    assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), JPEG);
  } finally { controller.abort(); await t.close(); }
});

test('frames must be JPEG with a fresh capture time', async () => {
  const t = await startApp({ noGemini: true });
  try {
    const bad = await t.req('POST', '/api/ingest/frame', { token: INGEST, body: Buffer.from('not a jpeg'), headers: { 'content-type': 'image/jpeg', 'x-captured-at': now() } });
    assert.equal(bad.status, 400);
    const stale = await t.req('POST', '/api/ingest/frame', { token: INGEST, body: JPEG, headers: { 'content-type': 'image/jpeg', 'x-captured-at': new Date(Date.now() - 120_000).toISOString() } });
    assert.equal(stale.status, 400);
    const noAuth = await t.req('POST', '/api/ingest/frame', { token: DASH, body: JPEG, headers: { 'content-type': 'image/jpeg', 'x-captured-at': now() } });
    assert.equal(noAuth.status, 401);
  } finally { await t.close(); }
});

test('a new detection episode activates the incident and triggers one automatic Gemini analysis', async () => {
  const t = await startApp({ replies: [analysisReply] });
  try {
    const first = await (await t.req('POST', '/api/ingest/detection', { token: INGEST, body: detection() })).json();
    assert.equal(first.new_episode, true);
    const again = await (await t.req('POST', '/api/ingest/detection', { token: INGEST, body: detection({ confidence: 0.9 }) })).json();
    assert.equal(again.new_episode, false);

    const { incident } = await (await t.req('GET', '/api/incident', { token: DASH })).json();
    assert.equal(incident.active, true);
    assert.equal(incident.sightings, 2);
    assert.equal(incident.max_confidence, 1);
    assert.equal(incident.latest.details.name, 'Alpha');
    const image = await t.req('GET', incident.image_url, { token: DASH });
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);

    const latest = await waitFor(async () => {
      const body = await (await t.req('GET', '/api/analysis/latest', { token: DASH })).json();
      return body.analysis && !body.pending ? body : null;
    });
    assert.equal(latest.analysis.trigger, 'auto-detection');
    assert.equal(latest.analysis.episode_id, 'ep-test-1');
    assert.equal(latest.analysis.severity, 'extreme');
    assert.equal(t.calls.length, 1, 'one analysis per episode, not per sighting');
    const prompt = t.calls[0].contents[0].parts.map((p) => p.text ?? '').join(' ');
    assert.match(prompt, /test marker/);
    assert.match(prompt, /TOWARD/);
    assert.ok(t.calls[0].contents[0].parts.some((p) => p.inline_data?.mime_type === 'image/jpeg'));
  } finally { await t.close(); }
});

test('a Gemini failure is reported, not swallowed', async () => {
  const t = await startApp({ replies: [] });
  try {
    await t.req('POST', '/api/ingest/detection', { token: INGEST, body: detection() });
    const body = await waitFor(async () => {
      const b = await (await t.req('GET', '/api/analysis/latest', { token: DASH })).json();
      return b.error ? b : null;
    });
    assert.equal(body.analysis, null);
    assert.match(body.error.message, /no queued reply/);
  } finally { await t.close(); }
});

test('false alarm dismissal deactivates the incident', async () => {
  const t = await startApp({ noGemini: true });
  try {
    await t.req('POST', '/api/ingest/detection', { token: INGEST, body: detection() });
    const res = await t.req('POST', '/api/incident/dismiss', { token: DASH, body: { episode_id: 'ep-test-1' } });
    assert.equal(res.status, 200);
    const { incident } = await (await t.req('GET', '/api/incident', { token: DASH })).json();
    assert.equal(incident.active, false);
    assert.equal(incident.status, 'false_alarm');
    const missing = await t.req('POST', '/api/incident/dismiss', { token: DASH, body: { episode_id: 'nope' } });
    assert.equal(missing.status, 404);
  } finally { await t.close(); }
});

test('malformed detections are rejected', async () => {
  const t = await startApp({ noGemini: true });
  try {
    for (const body of [
      detection({ bbox: [0, 0, 2, 1] }),
      detection({ fire: { latitude: 43.7 } }),
      detection({ source: 'guess' }),
      detection({ confidence: 1.5 }),
      detection({ detected_at: new Date(Date.now() - 120_000).toISOString() }),
      detection({ frame_jpeg_base64: Buffer.from('png?').toString('base64') }),
    ]) {
      const res = await t.req('POST', '/api/ingest/detection', { token: INGEST, body });
      assert.equal(res.status, 400, JSON.stringify(await res.json()));
    }
  } finally { await t.close(); }
});

test('flight events and the flight path are served together', async () => {
  const t = await startApp({ noGemini: true });
  try {
    await t.req('POST', '/api/ingest/flight', { token: INGEST, body: { at: now(), phase: 'circle', step: 3, steps: 8, message: 'x' } });
    const bad = await t.req('POST', '/api/ingest/flight', { token: INGEST, body: { at: now(), phase: 'loop-the-loop' } });
    assert.equal(bad.status, 400);
    await t.req('POST', '/api/ingest/telemetry', { token: INGEST, body: { observed_at: now(), provenance: 'live', battery_pct: 80, latitude: 43.7866, longitude: -79.1903 } });
    const flight = await (await t.req('GET', '/api/flight', { token: DASH })).json();
    assert.equal(flight.events.at(-1).phase, 'circle');
    assert.equal(flight.events.at(-1).step, 3);
    assert.equal(flight.path.length, 1);
    assert.equal(flight.path[0].latitude, 43.7866);
    const status = await (await t.req('GET', '/api/status', { token: DASH })).json();
    assert.equal(status.flight.phase, 'circle');
  } finally { await t.close(); }
});

test('telemetry summary buckets samples per minute', async () => {
  const t = await startApp({ noGemini: true });
  try {
    for (const altitude_m of [1, 3]) {
      await t.req('POST', '/api/ingest/telemetry', { token: INGEST, body: { observed_at: now(), provenance: 'live', altitude_m, battery_pct: 90 - altitude_m } });
    }
    const summary = await (await t.req('GET', '/api/telemetry/summary?minutes=5', { token: DASH })).json();
    const samples = summary.buckets.reduce((n, b) => n + b.samples, 0);
    assert.equal(samples, 2);
    assert.equal(Math.min(...summary.buckets.map((b) => b.min_battery_pct)), 87);
  } finally { await t.close(); }
});

test('operational plans come from Gemini, are validated, sorted and stored', async () => {
  const t = await startApp({ replies: [planReply, { candidates: [{ content: { parts: [{ text: '{"title":"x"}' }] } }] }] });
  try {
    const res = await t.req('POST', '/api/plan', { token: DASH, body: { objective: 'initial-attack', notes: 'two engines', scenario: { wind: 30 } } });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.deepEqual(plan.actions.map((a) => a.priority), [1, 2]);
    assert.equal(plan.provenance, 'gemini');
    const prompt = t.calls[0].contents[0].parts.map((p) => p.text ?? '').join(' ');
    assert.match(prompt, /operational advantage/);
    assert.match(prompt, /two engines/);
    const latest = await (await t.req('GET', '/api/plan/latest', { token: DASH })).json();
    assert.equal(latest.plan.id, plan.id);
  } finally { await t.close(); }
});

test('plan requests fail clearly without Gemini', async () => {
  const t = await startApp({ noGemini: true });
  try {
    const res = await t.req('POST', '/api/plan', { token: DASH, body: {} });
    assert.equal(res.status, 503);
  } finally { await t.close(); }
});

test('the session token is only handed to localhost pages', async () => {
  const t = await startApp({ noGemini: true });
  try {
    const ok = await (await t.req('GET', '/api/session')).json();
    assert.equal(ok.token, DASH);
    const rebound = await new Promise((resolve) => {
      const u = new URL(t.base);
      http.get({ host: u.hostname, port: u.port, path: '/api/session', headers: { host: 'evil.example' } }, resolve);
    });
    assert.equal(rebound.statusCode, 403);
  } finally { await t.close(); }
});

test('demo fires are served from the examples dataset', async () => {
  const t = await startApp({ noGemini: true });
  try {
    const body = await (await t.req('GET', '/api/demo/fires', { token: DASH })).json();
    assert.equal(body.fires[0].name, 'Fire One');
    assert.equal((await t.req('GET', '/api/demo/fires')).status, 401);
  } finally { await t.close(); }
});

test('demo cases get live Gemini analysis and plans that are never stored', async () => {
  const t = await startApp({ replies: [analysisReply, planReply] });
  const demoCase = { id: 'jasper-2024', name: 'Jasper townsite complex', drone: { telemetry: { provenance: 'demo-simulated' } } };
  try {
    const analysis = await (await t.req('POST', '/api/demo/analyze', { token: DASH, body: { case: demoCase, scenario: { wind: 50 }, image: 'AAAA', trigger: 'auto-detection' } })).json();
    assert.equal(analysis.severity, 'extreme');
    assert.equal(analysis.provenance, 'gemini-demo');
    assert.equal(analysis.case_id, 'jasper-2024');
    assert.equal(analysis.trigger, 'auto-detection');
    assert.equal(analysis.evidence_kind, 'rgb-snapshot');
    const parts = t.calls[0].contents[0].parts, prompt = parts.map((p) => p.text ?? '').join(' ');
    assert.match(prompt, /just been detected by ANAFI-01/);
    assert.match(prompt, /Jasper townsite complex/);
    assert.equal(parts.at(-1).inline_data.data, 'AAAA', 'the drone camera frame goes to Gemini');
    assert.equal(t.calls[0].tools, undefined, 'demo analysis must not call tools that read live drone data');

    // Rate limit: one demo Gemini request per 10 s.
    assert.equal((await t.req('POST', '/api/demo/plan', { token: DASH, body: { case: demoCase } })).status, 429);

    const nothingStored = await (await t.req('GET', '/api/analysis/latest', { token: DASH })).json();
    assert.equal(nothingStored.analysis, null);
    assert.equal((await t.req('GET', '/api/plan/latest', { token: DASH }).then((r) => r.json())).plan, null);
    assert.equal((await t.req('POST', '/api/demo/analyze', { token: DASH, body: {} })).status, 400);
    assert.equal((await t.req('POST', '/api/demo/analyze', { body: { case: demoCase } })).status, 401);
  } finally { await t.close(); }
});

test('map tiles are fetched once, then served from the disk cache', async () => {
  let fetches = 0;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const t = await startApp({ noGemini: true, tileFetch: async () => { fetches++; return new Response(png); } });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await t.req('GET', '/tiles/osm/18/73407/95495.png');
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    }
    assert.equal(fetches, 1);
    assert.equal((await t.req('GET', '/tiles/osm/18/999999999/1.png')).status, 404);
  } finally { await t.close(); }
});

test('satellite tiles use the imagery service z/y/x order', async () => {
  const urls = [];
  const t = await startApp({ noGemini: true, tileFetch: async (url) => { urls.push(url); return new Response(Buffer.from([0xff, 0xd8, 0xff])); } });
  try {
    const res = await t.req('GET', '/tiles/sat/16/18000/21000.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(urls[0], /World_Imagery\/MapServer\/tile\/16\/21000\/18000$/);
  } finally { await t.close(); }
});

test('Gemini transport retries an overloaded model, then falls back', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url.match(/models\/([^:]+)/)[1]);
    return seen.length <= 2
      ? new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 })
      : new Response(JSON.stringify(analysisReply));
  };
  const transport = makeGeminiTransport({ apiKey: 'k', model: 'main', fallbackModels: ['backup'], fetchImpl, retryDelayMs: 1 });
  const reply = await transport({});
  assert.deepEqual(seen, ['main', 'main', 'backup']);
  assert.ok(reply.candidates);
  const failing = makeGeminiTransport({ apiKey: 'k', model: 'main', fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 400 }), retryDelayMs: 1 });
  await assert.rejects(failing({}), /HTTP 400: bad key/);
});

test('analysis prompt carries the detection context', () => {
  const parts = buildAnalysisParts({ kind: 'telemetry-only', telemetry: { battery_pct: 50 }, detection: detection() });
  const text = parts.map((p) => p.text).join(' ');
  assert.match(text, /Fire detection from the drone camera \(qr-test/);
  assert.match(text, /Telemetry-only/);
});
