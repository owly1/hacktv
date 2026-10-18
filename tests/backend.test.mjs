import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, MemoryStorage, validateAnalysisContent, createPgPool } from '../backend/server.mjs';
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
let fakeGeminiReplies;

const geminiTextReply = (jsonText) => ({
  candidates: [{ content: { parts: [{ text: jsonText }] } }],
});

const geminiCallReply = (name, args = {}) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
});

function makeApp() {
  nowMs = Date.now();
  fakeGeminiCalls = [];
  fakeGeminiReplies = [
    geminiTextReply(JSON.stringify({
      summary: 'A possible smoke plume above the tree canopy.',
      unknowns: ['Fire perimeter and wind conditions cannot be established.'],
      falsifiers: ['A clear view showing unburned canopy in the same sector.'],
      limitations: 'Single uncalibrated RGB frame; no thermal data.',
    })),
  ];
  storage = new MemoryStorage();
  return createApp({
    ingestToken: INGEST,
    dashboardToken: DASH,
    allowedOrigins: [ORIGIN],
    storage,
    geminiTransport: async (requestBody) => {
      // deep-copy: the server keeps appending turns to contents between rounds
      fakeGeminiCalls.push(structuredClone(requestBody));
      if (fakeGeminiReplies.length === 0) {
        throw new ApiError(502, 'fake transport: no queued reply');
      }
      return fakeGeminiReplies.shift();
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

test('ANAFI flight-state fields survive ingest (bridge handoff shape)', async () => {
  nowMs += 1_000; // avoid observed_at ties — latestTelemetry keeps the earlier row
  const res = await req('POST', '/api/ingest/telemetry', {
    token: INGEST,
    body: {
      ...goodTelemetry(),
      state: 'landed',
      gps_fix: false,
      vertical_speed_mps: -0.4,
      attitude_deg: { roll: -4, pitch: 20, yaw: -155 },
      extra: { gimbal_pitch_deg: -12, link_quality: 'wifi' },
      unknown_field_will_be_dropped: 'x',
    },
  });
  assert.equal(res.status, 200);

  const latest = await req('GET', '/api/telemetry/latest', { token: DASH });
  const s = (await latest.json()).sample;
  assert.equal(s.state, 'landed');
  assert.equal(s.gps_fix, 'no fix');            // boolean normalized
  assert.equal(s.vertical_speed_mps, -0.4);
  assert.deepEqual(s.attitude_deg, { roll: -4, pitch: 20, yaw: -155 });
  assert.deepEqual(s.extra, { gimbal_pitch_deg: -12, link_quality: 'wifi' });
  assert.equal('unknown_field_will_be_dropped' in s, false);
});

test('malformed attitude_deg is rejected', async () => {
  const res = await req('POST', '/api/ingest/telemetry', {
    token: INGEST,
    body: { ...goodTelemetry(), attitude_deg: { roll: 'steep' } },
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
  assert.equal(Array.isArray(json.falsifiers), true);
  assert.deepEqual(json.tool_trace, []);
  // the instruction part must acknowledge absence of visual evidence
  const promptText = JSON.stringify(fakeGeminiCalls.at(-1).contents);
  assert.match(promptText, /Telemetry-only/);
});

test('wind_estimate passes through when Gemini derives one from stabilization', async () => {
  nowMs += 31_000;
  await req('POST', '/api/ingest/telemetry', { token: INGEST, body: goodTelemetry() });
  fakeGeminiReplies = [geminiTextReply(JSON.stringify({
    summary: 'Hover tilt suggests a light crosswind.',
    unknowns: ['No anemometer — estimate is derived, not measured.'],
    falsifiers: ['A ground wind reading contradicting the tilt direction.'],
    wind_estimate: {
      speed_mps: 4.5,
      direction_deg: 225,
      method: 'sustained pitch/roll tilt while position-holding',
      confidence: 'low — tilt-to-wind mapping is uncalibrated for this airframe',
    },
    limitations: 'Derived from attitude history; not a sensor measurement.',
  }))];
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.wind_estimate, {
    speed_mps: 4.5,
    direction_deg: 225,
    method: 'sustained pitch/roll tilt while position-holding',
    confidence: 'low — tilt-to-wind mapping is uncalibrated for this airframe',
  });
});

test('malformed wind_estimate surfaces as 502', async () => {
  nowMs += 31_000;
  await req('POST', '/api/ingest/telemetry', { token: INGEST, body: goodTelemetry() });
  fakeGeminiReplies = [geminiTextReply(JSON.stringify({
    summary: 'x',
    unknowns: [],
    wind_estimate: { speed_mps: 'fast' }, // no method/confidence, bad speed
    limitations: 'x',
  }))];
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 502);
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
  fakeGeminiReplies = [geminiTextReply('not json at all')];
  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 502);
});

// ---- evidence-seeking agent loop ----

test('agentic analyze executes declared tools and records the trace', async () => {
  nowMs += 31_000;
  await req('POST', '/api/ingest/telemetry', { token: INGEST, body: goodTelemetry() });
  await req('POST', '/api/ingest/snapshot', {
    token: INGEST,
    body: { captured_at: new Date(nowMs).toISOString(), jpeg_base64: JPEG_B64 },
  });
  // model asks for history, then the camera, then answers
  fakeGeminiReplies = [
    geminiCallReply('get_telemetry_history', { limit: 5 }),
    geminiCallReply('get_snapshot'),
    geminiTextReply(JSON.stringify({
      summary: 'Telemetry stable; frame shows possible smoke.',
      unknowns: ['Wind speed unknown.'],
      falsifiers: ['A follow-up frame with no smoke column.'],
      limitations: 'Single frame, no thermal.',
    })),
  ];

  const res = await req('POST', '/api/analyze', { token: DASH, body: {} });
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.deepEqual(
    json.tool_trace.map((t) => t.tool),
    ['get_telemetry_history', 'get_snapshot'],
  );
  assert.equal(json.tool_trace.every((t) => t.ok), true);
  assert.equal(json.evidence_kind, 'rgb-snapshot');
  assert.equal(json.provenance, 'gemini-unverified');

  // round 2 request must carry the functionResponse turn; snapshot tool's
  // image must arrive as inline data in that same turn
  const followUp = fakeGeminiCalls.at(-2).contents.at(-1).parts;
  assert.equal(followUp[0].functionResponse.name, 'get_telemetry_history');
  const imagePart = fakeGeminiCalls.at(-1).contents.at(-1).parts.find((p) => p.inline_data);
  assert.equal(imagePart.inline_data.mime_type, 'image/jpeg');

  // final round forbids further tool calls
  assert.equal(
    fakeGeminiCalls.at(-1).toolConfig.functionCallingConfig.mode,
    'NONE',
  );
});

test('telemetry history endpoint returns newest-first samples', async () => {
  nowMs += 31_000;
  for (const battery of [90, 80]) {
    await req('POST', '/api/ingest/telemetry', {
      token: INGEST,
      body: { ...goodTelemetry(), battery_pct: battery, observed_at: new Date(nowMs).toISOString() },
    });
    nowMs += 1000;
  }
  const res = await req('GET', '/api/telemetry/history?limit=10', { token: DASH });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.count >= 2, true);
  assert.equal(json.samples[0].battery_pct, 80);
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

test('wind_estimate sanity bounds reject implausible model output', () => {
  const base = { summary: 's', unknowns: [], limitations: 'l' };
  // derived calm is a legitimate estimate — speed 0 must pass
  assert.equal(
    validateAnalysisContent({ ...base, wind_estimate: { speed_mps: 0, method: 'no tilt in position hold', confidence: 'medium' } }).wind_estimate.speed_mps,
    0,
  );
  assert.throws(
    () => validateAnalysisContent({ ...base, wind_estimate: { speed_mps: -1, method: 'm', confidence: 'low' } }),
    /speed_mps.*0–60/,
  );
  assert.throws(
    () => validateAnalysisContent({ ...base, wind_estimate: { speed_mps: 500, method: 'm', confidence: 'low' } }),
    /speed_mps.*0–60/,
  );
  assert.throws(
    () => validateAnalysisContent({ ...base, wind_estimate: { method: 'm', confidence: 'low', direction_deg: 360 } }),
    /direction_deg/,
  );
  // "moving air, direction unknown" stays valid — direction optional
  assert.equal(
    validateAnalysisContent({ ...base, wind_estimate: { method: 'ground-track drift', confidence: 'low' } }).wind_estimate.direction_deg,
    null,
  );
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

test('a lost idle database connection does not crash the backend', async () => {
  const pool = await createPgPool({ databaseUrl: 'postgres://user:pass@127.0.0.1:1/none' });
  assert.ok(pool.listenerCount('error') >= 1, 'pool has an error listener');
  const logged = [];
  const orig = console.error;
  console.error = (msg) => logged.push(String(msg));
  try {
    pool.emit('error', Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  } finally {
    console.error = orig;
  }
  assert.match(logged.join(' '), /idle connection lost \(ETIMEDOUT\)/);
  await pool.end();
});
