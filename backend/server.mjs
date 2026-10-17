// Emberwatch backend — emberwatch.v1 contract.
// Node 22 built-in http only; `pg` is an optional dependency used when
// DATABASE_URL is configured. Every dependency below is injectable so tests
// can exercise the API without TigerData, Gemini, or a drone.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ApiError,
  EVIDENCE_FRESH_MS,
  INGEST_CLOCK_WINDOW_MS,
  ageMs,
  isFresh,
  isOriginAllowed,
  parseAllowedOrigins,
  validateSnapshotEnvelope,
  validateTelemetry,
} from './validation.mjs';

const CONTRACT = 'emberwatch.v1';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_JSON_BODY = 8 * 1024 * 1024; // fits a 5 MB base64 snapshot envelope
const GEMINI_MIN_INTERVAL_MS = 30_000;  // one started request per 30 s
const GEMINI_UPSTREAM_TIMEOUT_MS = 20_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
};

// ---------------------------------------------------------------- storage

export class MemoryStorage {
  constructor() {
    this.telemetry = [];
    this.analyses = [];
    this.kind = 'memory only';
  }
  status() {
    return this.kind;
  }
  async insertTelemetry(sample) {
    this.telemetry.push(sample);
  }
  async latestTelemetry() {
    if (this.telemetry.length === 0) return null;
    return this.telemetry.reduce((a, b) =>
      Date.parse(a.observed_at) >= Date.parse(b.observed_at) ? a : b);
  }
  async telemetryHistory({ limit = 50, sinceMs = null } = {}) {
    let rows = this.telemetry.slice().sort(
      (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at),
    );
    if (sinceMs !== null) rows = rows.filter((r) => Date.parse(r.observed_at) >= sinceMs);
    return rows.slice(0, limit);
  }
  async insertAnalysis(record) {
    this.analyses.push(record);
  }
  async latestAnalyses(limit = 10) {
    return this.analyses.slice(-limit).reverse();
  }
}

// TigerData / Timescale PostgreSQL adapter. A configured database failure
// must never silently switch to memory: errors surface as 503 and the status
// endpoint reports the database as unavailable.
export class PgStorage {
  constructor(pool) {
    this.pool = pool;
    this.kind = 'postgres';
    this.lastError = null;
  }
  status() {
    return this.lastError ? 'postgres-unavailable' : 'postgres';
  }
  async insertTelemetry(sample) {
    try {
      await this.pool.query(
        'INSERT INTO telemetry (observed_at, drone_id, provenance, payload) VALUES ($1, $2, $3, $4)',
        [sample.observed_at, sample.drone_id, sample.provenance, JSON.stringify(sample)],
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
  async latestTelemetry() {
    try {
      const { rows } = await this.pool.query(
        'SELECT payload FROM telemetry ORDER BY observed_at DESC LIMIT 1',
      );
      this.lastError = null;
      return rows.length ? rows[0].payload : null;
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
  async telemetryHistory({ limit = 50, sinceMs = null } = {}) {
    try {
      const since = sinceMs !== null ? new Date(sinceMs).toISOString() : null;
      const { rows } = await this.pool.query(
        `SELECT payload FROM telemetry
         WHERE ($1::timestamptz IS NULL OR observed_at >= $1)
         ORDER BY observed_at DESC LIMIT $2`,
        [since, limit],
      );
      this.lastError = null;
      return rows.map((r) => r.payload);
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
  async insertAnalysis(record) {
    try {
      await this.pool.query(
        'INSERT INTO analyses (id, created_at, evidence_at, payload) VALUES ($1, $2, $3, $4)',
        [record.id, record.created_at, record.evidence_at, JSON.stringify(record)],
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
  async latestAnalyses(limit = 10) {
    try {
      const { rows } = await this.pool.query(
        'SELECT payload FROM analyses ORDER BY created_at DESC LIMIT $1',
        [limit],
      );
      this.lastError = null;
      return rows.map((r) => r.payload);
    } catch (err) {
      this.lastError = err.message;
      throw new ApiError(503, `storage failure: ${err.message}`);
    }
  }
}

export async function createStorage({ databaseUrl, pgCaFile } = {}) {
  if (!databaseUrl) return new MemoryStorage();
  let pg;
  try {
    pg = await import('pg');
  } catch {
    // DATABASE_URL is set but the driver is missing — report an unavailable
    // configured database rather than silently falling back to memory.
    const broken = new PgStorage({ query: async () => { throw new Error('pg package not installed'); } });
    broken.lastError = 'pg package not installed';
    return broken;
  }
  const config = { connectionString: databaseUrl };
  if (pgCaFile) {
    config.ssl = { ca: await readFile(pgCaFile, 'utf8'), rejectUnauthorized: true };
  }
  const pool = new pg.default.Pool(config);
  return new PgStorage(pool);
}

// ------------------------------------------------------------------ gemini

export const ANALYSIS_INSTRUCTIONS = [
  'You are assisting a wildfire incident-review dashboard.',
  'Describe only what the supplied evidence shows, with explicit uncertainty.',
  'List information that this evidence cannot establish under "unknowns".',
  'Do not infer temperature, reliable fire perimeter, geographic location, or safe access from uncalibrated RGB imagery.',
  'If only telemetry is supplied (no image), explicitly acknowledge the absence of visual fire evidence.',
  'Do not generate tactical firefighting commands, dispatch orders, safe-route claims, evacuation orders, or aircraft commands.',
].join(' ');

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    unknowns: { type: 'ARRAY', items: { type: 'STRING' } },
    falsifiers: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Specific evidence or observations that would overturn this assessment — the model states how it could be wrong.',
    },
    limitations: { type: 'STRING' },
  },
  required: ['summary', 'unknowns', 'limitations'],
};

// The Gemini-track differentiator: the model is an evidence-seeking agent.
// It may call these tools to pull fresh observations before writing its
// structured assessment; every call lands in the record's tool_trace.
const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_latest_telemetry',
      description: 'Returns the most recent drone telemetry observation (battery, altitude, ground speed, GPS fix) with its source timestamp.',
    },
    {
      name: 'get_telemetry_history',
      description: 'Returns recent drone telemetry observations, newest first, for trend analysis.',
      parameters: {
        type: 'OBJECT',
        properties: {
          limit: { type: 'INTEGER', description: 'Max samples, default 20' },
          since_minutes: { type: 'NUMBER', description: 'Only samples observed within the last N minutes' },
        },
      },
    },
    {
      name: 'get_snapshot',
      description: 'Returns the latest drone camera JPEG as image content plus its capture timestamp.',
    },
  ],
}];

const MAX_TOOL_ROUNDS = 2; // then a forced tool-free final answer

export function buildAnalysisParts(evidence) {
  const parts = [{ text: ANALYSIS_INSTRUCTIONS }];
  if (evidence.kind === 'rgb-snapshot') {
    parts.push({
      text: `Telemetry accompanying the image: ${JSON.stringify(evidence.telemetry ?? null)}`,
    });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: evidence.jpeg.toString('base64'),
      },
    });
  } else {
    parts.push({
      text: `Telemetry-only evidence (no image supplied): ${JSON.stringify(evidence.telemetry)}`,
    });
  }
  return parts;
}

function candidateParts(apiResponse) {
  return apiResponse?.candidates?.[0]?.content?.parts ?? [];
}

function extractGeminiText(apiResponse) {
  const text = candidateParts(apiResponse).map((p) => p.text ?? '').join('');
  if (!text) throw new ApiError(502, 'Gemini response contained no text content');
  return text;
}

export function validateAnalysisContent(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(502, 'Gemini output is not a JSON object');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) {
    throw new ApiError(502, 'Gemini output missing "summary"');
  }
  if (!Array.isArray(parsed.unknowns) || !parsed.unknowns.every((u) => typeof u === 'string')) {
    throw new ApiError(502, 'Gemini output "unknowns" must be an array of strings');
  }
  if (parsed.falsifiers !== undefined
      && (!Array.isArray(parsed.falsifiers) || !parsed.falsifiers.every((f) => typeof f === 'string'))) {
    throw new ApiError(502, 'Gemini output "falsifiers" must be an array of strings');
  }
  if (typeof parsed.limitations !== 'string' || parsed.limitations.length === 0) {
    throw new ApiError(502, 'Gemini output missing "limitations"');
  }
  return {
    summary: parsed.summary,
    unknowns: parsed.unknowns,
    falsifiers: parsed.falsifiers ?? [],
    limitations: parsed.limitations,
  };
}

// Default transport: real Gemini generateContent call. Takes the full request
// body (contents + generationConfig + tools/toolConfig) and resolves to the
// parsed API response. In tests an injected fake transport replaces this — a
// passing fixture test is not a live call.
export function makeGeminiTransport({ apiKey, model, fetchImpl = fetch }) {
  return async function geminiTransport(requestBody) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ApiError(502, `Gemini upstream returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      return res.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.name === 'AbortError') {
        throw new ApiError(502, `Gemini upstream exceeded ${GEMINI_UPSTREAM_TIMEOUT_MS / 1000}s timeout`);
      }
      throw new ApiError(502, `Gemini request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

// -------------------------------------------------------------------- http

async function readBody(req, maxBytes = MAX_JSON_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'request body is not valid JSON');
  }
}

function tokenFrom(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

function tokenEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof ApiError ? err.message : 'internal error';
  sendJson(res, status, { error: message });
}

async function serveStatic(res, staticDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.normalize(path.join(staticDir, rel));
  if (!target.startsWith(path.normalize(staticDir + path.sep))) {
    throw new ApiError(404, 'not found');
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new ApiError(404, 'not found');
  }
  if (info.isDirectory()) throw new ApiError(404, 'not found');
  const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
}

export function createApp({
  ingestToken,
  dashboardToken,
  allowedOrigins,
  storage,
  geminiTransport = null,
  geminiModel = null,
  now = () => Date.now(),
  staticDir = null,
}) {
  if (!ingestToken || !dashboardToken || ingestToken === dashboardToken) {
    throw new Error('INGEST_TOKEN and DASHBOARD_TOKEN must be non-empty and different');
  }
  const state = {
    latestSnapshot: null, // { jpeg, capturedAtMs }
    lastGeminiStart: -Infinity,
  };

  function requireAuth(req, kind) {
    const token = tokenFrom(req);
    const expected = kind === 'ingest' ? ingestToken : dashboardToken;
    if (token === null || !tokenEquals(token, expected)) {
      throw new ApiError(401, 'missing or invalid credentials');
    }
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, allowedOrigins)) {
      throw new ApiError(403, 'origin not allowed');
    }
    return origin;
  }

  function corsHeaders(origin) {
    return isOriginAllowed(origin, allowedOrigins) && origin
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {};
  }

  function selectEvidence() {
    const nowMs = now();
    const snap = state.latestSnapshot;
    if (snap && isFresh(snap.capturedAtMs, nowMs)) {
      return { kind: 'rgb-snapshot', at: snap.capturedAtMs, jpeg: snap.jpeg };
    }
    return null;
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/status') {
      requireAuth(req, 'dashboard');
      const nowMs = now();
      let latest = null;
      try {
        latest = await storage.latestTelemetry();
      } catch {
        // A configured-but-failing store must not take the status endpoint
        // down — status is how the dashboard learns it is down.
        latest = null;
      }
      sendJson(res, 200, {
        contract: CONTRACT,
        server_time: new Date(nowMs).toISOString(),
        storage: { status: storage.status() },
        gemini: {
          configured: Boolean(geminiTransport),
          model: geminiModel,
          // `configured` only means a key is set — it is not evidence of a
          // successful call; verify a real response before demoing.
          note: 'configured is not proof of a successful upstream call',
        },
        telemetry: latest
          ? { available: true, observed_at: latest.observed_at, age_ms: ageMs(Date.parse(latest.observed_at), nowMs) }
          : { available: false },
        camera: state.latestSnapshot
          ? { available: true, captured_at: new Date(state.latestSnapshot.capturedAtMs).toISOString(), age_ms: ageMs(state.latestSnapshot.capturedAtMs, nowMs) }
          : { available: false },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/telemetry') {
      requireAuth(req, 'ingest');
      const body = await readJson(req);
      const sample = validateTelemetry(body, now());
      await storage.insertTelemetry(sample);
      sendJson(res, 200, { accepted: true, stored: storage.status() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry/latest') {
      requireAuth(req, 'dashboard');
      const sample = await storage.latestTelemetry();
      sendJson(res, 200, {
        sample,
        age_ms: sample ? ageMs(Date.parse(sample.observed_at), now()) : null,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry/history') {
      requireAuth(req, 'dashboard');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
      const sinceMinutes = Number(url.searchParams.get('since_minutes'));
      const sinceMs = Number.isFinite(sinceMinutes) && sinceMinutes > 0
        ? now() - sinceMinutes * 60_000
        : null;
      const samples = await storage.telemetryHistory({ limit, sinceMs });
      sendJson(res, 200, { samples, count: samples.length });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest/snapshot') {
      requireAuth(req, 'ingest');
      const body = await readJson(req);
      const { capturedAtMs, jpeg } = validateSnapshotEnvelope(body, now());
      state.latestSnapshot = { jpeg, capturedAtMs };
      sendJson(res, 200, { accepted: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      requireAuth(req, 'dashboard');
      const snap = state.latestSnapshot;
      if (!snap) throw new ApiError(404, 'no snapshot available');
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'x-captured-at': new Date(snap.capturedAtMs).toISOString(),
      });
      res.end(snap.jpeg);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/analyze') {
      requireAuth(req, 'dashboard');
      const body = await readJson(req);
      if (Object.keys(body).length !== 0) {
        throw new ApiError(400, 'request body must be an empty JSON object');
      }
      if (!geminiTransport) {
        throw new ApiError(503, 'Gemini is not configured on this backend');
      }
      const nowMs = now();
      if (nowMs - state.lastGeminiStart < GEMINI_MIN_INTERVAL_MS) {
        throw new ApiError(429, 'Gemini is limited to one request per 30 seconds');
      }
      const telemetry = await storage.latestTelemetry();
      const snap = state.latestSnapshot;
      const snapFresh = snap && isFresh(snap.capturedAtMs, nowMs);
      const teleFresh = telemetry && isFresh(Date.parse(telemetry.observed_at), nowMs);
      if (!snapFresh && !teleFresh) {
        throw new ApiError(409, 'no fresh evidence (≤30s) is available for analysis');
      }
      state.lastGeminiStart = nowMs;
      const evidence = snapFresh
        ? { kind: 'rgb-snapshot', at: snap.capturedAtMs, jpeg: snap.jpeg, telemetry }
        : { kind: 'telemetry-only', at: Date.parse(telemetry.observed_at), telemetry };

      // ---- evidence-seeking agent loop ----
      // Gemini may call the declared tools; each round appends the model's
      // functionCall turn and our functionResponse turn. After MAX_TOOL_ROUNDS
      // we forbid further calls and require the structured assessment.
      const executeTool = async (name, args = {}) => {
        if (name === 'get_latest_telemetry') {
          return { sample: await storage.latestTelemetry() };
        }
        if (name === 'get_telemetry_history') {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
          const sinceMs = Number.isFinite(Number(args.since_minutes)) && Number(args.since_minutes) > 0
            ? now() - Number(args.since_minutes) * 60_000
            : null;
          const samples = await storage.telemetryHistory({ limit, sinceMs });
          return { samples, count: samples.length };
        }
        if (name === 'get_snapshot') {
          const s = state.latestSnapshot;
          return s
            ? { available: true, captured_at: new Date(s.capturedAtMs).toISOString() }
            : { available: false };
        }
        return { error: `unknown tool ${name}` };
      };

      const contents = [{ role: 'user', parts: buildAnalysisParts(evidence) }];
      const toolTrace = [];
      let apiResponse = null;
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        apiResponse = await geminiTransport({
          contents,
          tools: lastRound ? undefined : GEMINI_TOOLS,
          toolConfig: lastRound
            ? { functionCallingConfig: { mode: 'NONE' } }
            : { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        });
        const parts = candidateParts(apiResponse);
        const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
        if (calls.length === 0 || lastRound) break;

        contents.push({ role: 'model', parts });
        const responseParts = [];
        for (const call of calls.slice(0, 4)) {
          const result = await executeTool(call.name, call.args ?? {});
          toolTrace.push({
            tool: call.name,
            args: call.args ?? {},
            ok: !result.error,
          });
          responseParts.push({
            functionResponse: { name: call.name, response: result },
          });
          // Image payloads ride the follow-up turn as inline content — the
          // model receives the actual frame it asked for.
          if (call.name === 'get_snapshot' && result.available && state.latestSnapshot) {
            responseParts.push({
              inline_data: {
                mime_type: 'image/jpeg',
                data: state.latestSnapshot.jpeg.toString('base64'),
              },
            });
          }
        }
        contents.push({ role: 'user', parts: responseParts });
      }

      const text = extractGeminiText(apiResponse);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(502, 'Gemini returned non-JSON content');
      }
      const content = validateAnalysisContent(parsed);
      const record = {
        id: crypto.randomUUID(),
        created_at: new Date(nowMs).toISOString(),
        model: geminiModel,
        evidence_at: new Date(evidence.at).toISOString(),
        evidence_kind: evidence.kind,
        provenance: 'gemini-unverified',
        tool_trace: toolTrace,
        ...content,
      };
      await storage.insertAnalysis(record);
      sendJson(res, 200, record);
      return;
    }

    throw new ApiError(404, 'route not found');
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const origin = req.headers.origin;

    if (req.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        sendError(res, new ApiError(403, 'origin not allowed'));
        return;
      }
      res.writeHead(204, {
        ...corsHeaders(origin),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    try {
      checkOrigin(req);
      const acao = corsHeaders(origin);
      for (const [k, v] of Object.entries(acao)) res.setHeader(k, v);
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method === 'GET' && staticDir) {
        await serveStatic(res, staticDir, pathname);
        return;
      }
      throw new ApiError(404, 'route not found');
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  };
}

async function main() {
  const ingestToken = process.env.INGEST_TOKEN;
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  const databaseUrl = process.env.DATABASE_URL || null;
  const pgCaFile = process.env.PG_CA_FILE || null;
  const geminiApiKey = process.env.GEMINI_API_KEY || null;
  const geminiModel = process.env.GEMINI_MODEL || null;
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  const staticDir = path.resolve(process.env.STATIC_DIR || new URL('../dist', import.meta.url).pathname);

  const storage = await createStorage({ databaseUrl, pgCaFile });
  const geminiTransport = geminiApiKey
    ? makeGeminiTransport({ apiKey: geminiApiKey, model: geminiModel })
    : null;

  const handler = createApp({
    ingestToken,
    dashboardToken,
    allowedOrigins,
    storage,
    geminiTransport,
    geminiModel,
    staticDir,
  });

  http.createServer(handler).listen(port, host, () => {
    console.log(`emberwatch backend listening on http://${host}:${port}`);
    console.log(`storage: ${storage.status()} | gemini: ${geminiApiKey ? 'configured (unverified)' : 'not configured'}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`startup failed: ${err.message}`);
    process.exit(1);
  });
}
