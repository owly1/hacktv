import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, MemoryStorage } from '../backend/server.mjs';
import { ApiError } from '../backend/validation.mjs';

const INGEST = 'ingest-token-aaa';
const DASH = 'dashboard-token-bbb';
const ORIGIN = 'http://127.0.0.1:8787';

// A minimal 1x1-ish JPEG byte sequence (SOI + marker + payload).
const JPEG_B64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xd9,
]).toString('base64');

let server;
let base;
let storage;
let nowMs;
let fakeGeminiCalls;
let fakeGeminiReply;

function makeApp() {
  nowMs = Date.now();
  fakeGeminiCalls = [];
  fakeGeminiReply = JSON.stringify({
    summary: 'A possible smoke plume above the tree canopy.',
    unknowns: ['Fire perimeter and wind conditions cannot be established.'],
    limitations: 'Single uncalibrated RGB frame; no thermal data.',
  });
  storage = new MemoryStorage();
  return createApp({
    ingestToken: INGEST,
    dashboardToken: DASH,
    allowedOrigins: [ORIGIN],
    storage,
    geminiTransport: async (parts) => {
      fakeGeminiCalls.push(parts);
      return fakeGeminiReply;
    },
    geminiModel: 'fake-model',
    now: () => nowMs,
  });
}

before(async () => {
  server = http.createServer(makeApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  server.closeAllConnections?.();
});

function req(method, path, { token, body, origin } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const goodTelemetry = () => ({
  drone_id: 'ANAFI-01',
  provenance: 'live',
  observed_at: new Date(nowMs).toISOString(),
  battery_pct: 78,
  altitude_m: 62.4,
  ground_speed_mps: 3.2,
  latitude: null,
  longitude: null,
});

// ---- auth ----

test('missing token is rejected with 401', async () => {
  const res = await req('GET', '/api/status');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.length > 0, true);
});

test('ingest token cannot call dashboard routes', async () => {
  const res = await req('GET', '/api/telemetry/latest', { token: INGEST });
  assert.equal(res.status, 401);
});

test('dashboard token cannot call ingest routes', async () => {
  const res = await req('POST', '/api/ingest/telemetry', {
    token: DASH,
    body: goodTelemetry(),
  });
  assert.equal(res.status, 401);
});

// ---- origin allowlist ----

test('browser origin outside the allowlist is rejected with 403', async () => {
  const res = await req('GET', '/api/status', {
    token: DASH,
    origin: 'https://evil.example',
  });
  assert.equal(res.status, 403);
});

test('allowed origin gets CORS headers on API responses', async () => {
  const res = await req('GET', '/api/status', { token: DASH, origin: ORIGIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

// ---- status ----

test('status reports contract and memory-only storage honestly', async () => {
  const res = await req('GET', '/api/status', { token: DASH });
  const json = await res.json();
  assert.equal(json.contract, 'emberwatch.v1');
  assert.equal(json.storage.status, 'memory only');
  assert.equal(json.gemini.configured, true); // injected transport = configured
  assert.equal(json.telemetry.available, false);
  assert.equal(json.camera.available, false);
});

// ---- telemetry ingest ----

test('valid live telemetry is accepted and returned by latest', async () => {
  const res = await req('POST', '/api/ingest/telemetry', {
    token: INGEST,
    body: goodTelemetry(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, stored: 'memory only' });

  const latest = await req('GET', '/api/telemetry/latest', { token: DASH });
  const json = await latest.json();
  assert.equal(json.sample.drone_id, 'ANAFI-01');
  assert.equal(json.sample.battery_pct, 78);
});

test('stale observation outside the ±30s window is rejected', async () => {
  const stale = { ...goodTelemetry(), observed_at: new Date(nowMs - 60_000).toISOString() };
  const res = await req('POST', '/api/ingest/telemetry', { token: INGEST, body: stale });
  assert.equal(res.status, 400);
});

test('synthetic provenance cannot be posted as live', async () => {
  for (const provenance of ['sim', 'simulation', 'synthetic', 'fixture', 'demo']) {
    const res = await req('POST', '/api/ingest/telemetry', {
      token: INGEST,
      body: { ...goodTelemetry(), provenance },
    });
    assert.equal(res.status, 400, `provenance "${provenance}" should be rejected`);
  }
});

test('GPS must be a pair — latitude without longitude is rejected', async () => {
  const res = await req('POST', '/api/ingest/telemetry', {
    token: INGEST,
    body: { ...goodTelemetry(), latitude: 43.7 },
  });
  assert.equal(res.status, 400);
});

test('telemetry with no measurements is rejected', async () => {
  const res = await req('POST', '/api/ingest/telemetry', {
    token: INGEST,
    body: { drone_id: 'X', provenance: 'live', observed_at: new Date(nowMs).toISOString() },
  });
  assert.equal(res.status, 400);
});

// ---- snapshot ingest ----

test('snapshot roundtrip serves JPEG with X-Captured-At', async () => {
  const res = await req('POST', '/api/ingest/snapshot', {
    token: INGEST,
    body: { captured_at: new Date(nowMs).toISOString(), jpeg_base64: JPEG_B64 },
  });
  assert.equal(res.status, 200);

  const get = await req('GET', '/api/snapshot', { token: DASH });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/jpeg');
  assert.equal(get.headers.get('x-captured-at'), new Date(nowMs).toISOString());
  const buf = Buffer.from(await get.arrayBuffer());
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
});

test('non-JPEG payload is rejected with 400', async () => {
  const res = await req('POST', '/api/ingest/snapshot', {
    token: INGEST,
    body: {
      captured_at: new Date(nowMs).toISOString(),
      jpeg_base64: Buffer.from('not an image').toString('base64'),
    },
  });
  assert.equal(res.status, 400);
});

test('snapshot 404 when none has been ingested', async () => {
  storage && (storage = new MemoryStorage());
  // fresh app without any snapshot
  const freshServer = http.createServer(makeApp());
  await new Promise((r) => freshServer.listen(0, '127.0.0.1', r));
  const port = freshServer.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
    headers: { authorization: `Bearer ${DASH}` },
  });
  assert.equal(res.status, 404);
  freshServer.close();
  freshServer.closeAllConnections?.();
});

// ---- analyze ----

test('analyze returns 409 when no fresh evidence exists', async () => {
  const freshServer = http.createServer(makeApp());
  await new Promise((r) => freshServer.listen(0, '127.0.0.1', r));
  const port = freshServer.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DASH}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 409);
  freshServer.close();
  freshServer.closeAllConnections?.();
});

test('analyze returns 503 when Gemini is not configured', async () => {
  const app = createApp({
    ingestToken: INGEST,
    dashboardToken: DASH,
    allowedOrigins: [ORIGIN],
    storage: new MemoryStorage(),
    geminiTransport: null,
    now: () => nowMs,
  });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DASH}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 503);
  s.close();
  s.closeAllConnections?.();
});

test('telemetry-only analysis records provenance and evidence kind', async () => {
  // age the previously ingested snapshot past the freshness window so the
  // analyzer falls back to telemetry-only evidence
  nowMs += 31_000;
  await req('POST', '/api/ingest/telemetry', { token: INGEST, body: goodTelemetry() });
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.provenance, 'gemini-unverified');
  assert.equal(json.evidence_kind, 'telemetry-only');
  assert.equal(json.model, 'fake-model');
  assert.equal(Array.isArray(json.unknowns), true);
  assert.ok(json.id);
  // the instruction part must acknowledge absence of visual evidence
  const promptText = fakeGeminiCalls.at(-1).map((p) => p.text ?? '').join(' ');
  assert.match(promptText, /Telemetry-only/);
});

test('second analyze inside 30s is rate limited to 429', async () => {
  nowMs += 1_000; // still inside window of previous start
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 429);
});

test('stale evidence blocks analysis even after rate limit passes', async () => {
  nowMs += 31_000; // >30s: rate limit cleared but evidence now stale
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 409);
});

test('non-JSON Gemini output surfaces as 502', async () => {
  nowMs += 31_000; // clear both the rate limit and prior evidence freshness
  await req('POST', '/api/ingest/telemetry', { token: INGEST, body: goodTelemetry() });
  fakeGeminiReply = 'not json at all';
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 502);
});

// ---- configured-storage failure must not silently become memory ----

test('failing configured storage reports 503, not a memory fallback', async () => {
  const failing = {
    kind: 'postgres',
    status: () => 'postgres-unavailable',
    insertTelemetry: async () => { throw new ApiError(503, 'storage failure: connection refused'); },
    latestTelemetry: async () => { throw new ApiError(503, 'storage failure: connection refused'); },
    insertAnalysis: async () => { throw new ApiError(503, 'storage failure'); },
    latestAnalyses: async () => { throw new ApiError(503, 'storage failure'); },
  };
  const app = createApp({
    ingestToken: INGEST,
    dashboardToken: DASH,
    allowedOrigins: [ORIGIN],
    storage: failing,
    geminiTransport: null,
    now: () => nowMs,
  });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/ingest/telemetry`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/json' },
    body: JSON.stringify(goodTelemetry()),
  });
  assert.equal(res.status, 503);

  const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { authorization: `Bearer ${DASH}` },
  });
  const json = await status.json();
  assert.equal(json.storage.status, 'postgres-unavailable');
  s.close();
  s.closeAllConnections?.();
});

// ---- startup token contract ----

test('identical or empty tokens are refused at startup', () => {
  assert.throws(() =>
    createApp({
      ingestToken: 'same',
      dashboardToken: 'same',
      allowedOrigins: [],
      storage: new MemoryStorage(),
    }));
  assert.throws(() =>
    createApp({
      ingestToken: '',
      dashboardToken: 'x',
      allowedOrigins: [],
      storage: new MemoryStorage(),
    }));
});
