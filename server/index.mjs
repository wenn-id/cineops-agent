import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scenarios } from '../src/scenarios.mjs';
import { investigateStream } from './agent.mjs';
import { geminiAvailable } from './gemini.mjs';
import { createMcpClient, mcpAvailable } from './grafana-mcp.mjs';
import { answerFollowUp } from './followup.mjs';
import { createRateLimiter, parseLimit } from './ratelimit.mjs';
import { logEvent } from './log.mjs';
import { formatServiceMetrics, increment as incrementMetric } from './metrics.mjs';
import { resolveStatic } from './static.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const MAX_BODY_BYTES = 10_000;

// Follow-ups never trust a client-supplied context: each streamed
// investigation result is stored here under an unguessable reference, and the
// client answers with that reference. In-memory per process — documented
// limitation for single-instance Cloud Run deployments.
const investigations = new Map();
const MAX_STORED_INVESTIGATIONS = 50;

function rememberInvestigation(scenarioId, result) {
  const ref = randomUUID();
  investigations.set(ref, { scenarioId, result });
  if (investigations.size > MAX_STORED_INVESTIGATIONS) {
    investigations.delete(investigations.keys().next().value);
  }
  return ref;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function sendStatic(res, resolved) {
  const info = await stat(resolved.path).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const body = await readFile(resolved.path);
  res.writeHead(200, { 'content-type': resolved.type, 'content-length': body.length });
  res.end(body);
}

async function handleInvestigate(req, res, { consumeAllowance } = {}) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const scenario = scenarios[payload?.scenarioId];
  if (!scenario) {
    sendJson(res, 404, { error: `unknown scenario: ${String(payload?.scenarioId)}` });
    return;
  }
  if (typeof payload?.query !== 'string' || !payload.query.trim()) {
    sendJson(res, 400, { error: 'query is required' });
    return;
  }
  // Only a valid request consumes the investigation allowance: rejected
  // traffic must not be able to starve real investigations.
  if (consumeAllowance && consumeAllowance()) return;
  const query = payload.query;

  const scenarioKey = payload.scenarioId;

  const requestId = randomUUID();
  const startedAt = Date.now();
  const engineName = geminiAvailable() ? 'gemini' : 'deterministic';
  incrementMetric('cineops_investigations_total', { engine: engineName });
  logEvent('info', 'investigate.start', {
    requestId,
    scenarioId: scenarioKey,
    engine: engineName,
    mcp: mcpAvailable(),
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let actualEngine = engineName;
  // Live Grafana telemetry needs the live engine: without a Gemini key the
  // deterministic engine runs on fixture data and MCP is not dialed at all.
  const mcp = geminiAvailable() && mcpAvailable() ? createMcpClient({ signal: abort.signal }) : undefined;
  try {
    for await (const message of investigateStream(scenario, query, { signal: abort.signal, mcp })) {
      if (abort.signal.aborted || res.destroyed) break;
      if (message.event === 'status' && message.data?.phase === 'fallback') actualEngine = 'deterministic';
      if (message.event === 'result') {
        if (message.data?.engine === 'gemini') actualEngine = 'gemini';
        const investigationRef = rememberInvestigation(scenarioKey, message.data);
        message.data = { ...message.data, investigationRef };
      }
      res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
    const outcome = abort.signal.aborted || res.destroyed ? 'aborted' : 'completed';
    logEvent('info', 'investigate.end', {
      requestId,
      durationMs: Math.round(Date.now() - startedAt),
      outcome,
      engine: actualEngine,
    });
    incrementMetric('cineops_investigations_completed_total', { engine: actualEngine, outcome });
  } catch (error) {
    logEvent('error', 'investigate.error', { requestId, message: error.message });
    incrementMetric('cineops_investigations_failed_total');
    if (!abort.signal.aborted && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    }
  }
  res.end();
}

export function simulatorAvailable() {
  return Boolean(process.env.SIMULATOR_URL);
}

async function callSimulator(path, init) {
  const base = (process.env.SIMULATOR_URL ?? '').replace(/\/+$/, '');
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`simulator responded ${response.status}`);
  return response.json();
}

export function startServer({ port = Number(process.env.PORT) || 8000, host = process.env.HOST || '127.0.0.1' } = {}) {
  // Expensive endpoints carry model calls; their rate limits protect the
  // Gemini quota as much as the process itself. Limits fall back to safe
  // defaults when the env is empty or malformed.
  const investigateLimiter = createRateLimiter({ max: parseLimit(process.env.RATE_LIMIT_INVESTIGATE_PER_MIN, 10) });
  const followupLimiter = createRateLimiter({ max: parseLimit(process.env.RATE_LIMIT_FOLLOWUP_PER_MIN, 20) });
  // Identity comes from the socket unless an explicitly configured trusted
  // proxy normalizes forwarding headers — otherwise callers could rotate
  // X-Forwarded-For to sidestep the per-client limits.
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const clientKey = (req) => {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
      if (hops.length) return hops.at(-1);
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const rateLimited = (req, res, limiter, bucket) => {
    const decision = limiter(`${bucket}:${clientKey(req)}`);
    if (decision.allowed) return false;
    const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    logEvent('warn', 'ratelimit.block', { bucket, retryAfterSec });
    incrementMetric('cineops_ratelimit_blocks_total', { bucket });
    const body = JSON.stringify({ error: `rate limit exceeded — retry in ${retryAfterSec}s` });
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfterSec), 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/metrics') {
        // Self-monitoring: the same Grafana that shows the incident watches
        // the agent service itself.
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(formatServiceMetrics());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          engine: geminiAvailable() ? 'gemini' : 'deterministic',
          mcp: mcpAvailable(),
          simulator: simulatorAvailable(),
          simulatorScenario: simulatorAvailable() ? (process.env.SIMULATOR_SCENARIO ?? 'premiere-night') : undefined,
          replayAvailable: true,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/investigate') {
        // Malformed requests are rejected without touching the allowance;
        // valid ones consume it just before the investigation starts.
        const consumeAllowance = () => rateLimited(req, res, investigateLimiter, 'investigate');
        await handleInvestigate(req, res, { consumeAllowance });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/followup') {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (typeof payload?.question !== 'string' || !payload.question.trim()) {
          sendJson(res, 400, { error: 'question is required' });
          return;
        }
        if (!geminiAvailable()) {
          sendJson(res, 503, { error: 'follow-up Q&A requires the live engine (set GEMINI_API_KEY)' });
          return;
        }
        const investigationRef = payload?.investigationRef;
        if (typeof investigationRef !== 'string' || !investigationRef) {
          sendJson(res, 400, { error: 'investigationRef is required' });
          return;
        }
        const stored = investigations.get(investigationRef);
        if (!stored) {
          sendJson(res, 404, { error: 'unknown investigation' });
          return;
        }
        if (rateLimited(req, res, followupLimiter, 'followup')) return;
        try {
          const answer = await answerFollowUp({
            question: payload.question,
            scenarioId: stored.scenarioId,
            context: stored.result,
            history: payload.history,
          });
          logEvent('info', 'followup.answer', { scenarioId: stored.scenarioId, supported: answer.supported, citations: answer.citations.length });
          incrementMetric('cineops_followups_total', { supported: answer.supported ? 'yes' : 'no' });
          sendJson(res, 200, answer);
        } catch (error) {
          logEvent('error', 'followup.error', { message: error.message });
          incrementMetric('cineops_followups_failed_total');
          sendJson(res, error.statusCode ?? 502, { error: `follow-up failed: ${error.message}` });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/recovery') {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        // Browser-originated approvals must come from this service (basic
        // CSRF guard); operator authentication is documented as out of scope
        // for the single-user demo deployment.
        const origin = req.headers.origin;
        if (origin) {
          try {
            if (new URL(origin).host !== req.headers.host) {
              sendJson(res, 403, { error: 'cross-origin recovery requests are rejected' });
              return;
            }
          } catch {
            sendJson(res, 403, { error: 'invalid origin header' });
            return;
          }
        }
        if (payload?.approved !== true) {
          sendJson(res, 400, { error: 'recovery requires explicit approval' });
          return;
        }
        // The approval must reference the investigation whose plan is being
        // approved, so an anonymous flag flip alone cannot act.
        const stored = typeof payload?.investigationRef === 'string' ? investigations.get(payload.investigationRef) : undefined;
        if (!stored) {
          sendJson(res, 404, { error: 'unknown investigation — approval must reference the investigation being approved' });
          return;
        }
        if (!simulatorAvailable()) {
          sendJson(res, 503, { error: 'recovery drill requires the telemetry simulator (set SIMULATOR_URL)' });
          return;
        }
        try {
          const outcome = await callSimulator('/recover', { method: 'POST' });
          logEvent('info', 'recovery.approved', { investigationRef: payload.investigationRef, phase: outcome.phase });
          incrementMetric('cineops_recoveries_total', { phase: outcome.phase ?? 'unknown' });
          sendJson(res, 200, { acknowledged: true, ...outcome });
        } catch (error) {
          logEvent('error', 'recovery.error', { investigationRef: payload.investigationRef, message: error.message });
          sendJson(res, 502, { error: `recovery failed: ${error.message}` });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/incident-state') {
        if (!simulatorAvailable()) {
          sendJson(res, 503, { error: 'incident state requires the telemetry simulator (set SIMULATOR_URL)' });
          return;
        }
        try {
          const state = await callSimulator('/state');
          sendJson(res, 200, state);
        } catch (error) {
          sendJson(res, 502, { error: `incident state failed: ${error.message}` });
        }
        return;
      }
      if (req.method === 'GET') {
        const resolved = resolveStatic(DIST, url.pathname);
        if (resolved) {
          await sendStatic(res, resolved);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
      res.end('Method not allowed');
    } catch (error) {
      logEvent('error', 'request.error', { path: url.pathname, method: req.method, message: error.message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(port, host, () => resolvePromise({ server, port: server.address().port, host }));
  });
}

const isMainEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainEntry) {
  const { port, host } = await startServer();
  console.log(`CineOps Agent service running at http://${host}:${port} (live mode, serving dist/ only)`);
}
