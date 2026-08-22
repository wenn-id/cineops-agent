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

async function handleInvestigate(req, res) {
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
  const query = payload.query;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  // Live Grafana telemetry needs the live engine: without a Gemini key the
  // deterministic engine runs on fixture data and MCP is not dialed at all.
  const mcp = geminiAvailable() && mcpAvailable() ? createMcpClient({ signal: abort.signal }) : undefined;
  try {
    for await (const message of investigateStream(scenario, query, { signal: abort.signal, mcp })) {
      if (abort.signal.aborted || res.destroyed) break;
      if (message.event === 'result') {
        const investigationRef = rememberInvestigation(scenario.id, message.data);
        message.data = { ...message.data, investigationRef };
      }
      res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
  } catch (error) {
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
  const response = await fetch(`${process.env.SIMULATOR_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`simulator responded ${response.status}`);
  return response.json();
}

export function startServer({ port = Number(process.env.PORT) || 8000, host = process.env.HOST || '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          engine: geminiAvailable() ? 'gemini' : 'deterministic',
          mcp: mcpAvailable(),
          replayAvailable: true,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/investigate') {
        await handleInvestigate(req, res);
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
        try {
          const answer = await answerFollowUp({
            question: payload.question,
            scenarioId: stored.scenarioId,
            context: stored.result,
            history: payload.history,
          });
          sendJson(res, 200, answer);
        } catch (error) {
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
        if (payload?.approved !== true) {
          sendJson(res, 400, { error: 'recovery requires explicit approval' });
          return;
        }
        if (!simulatorAvailable()) {
          sendJson(res, 503, { error: 'recovery drill requires the telemetry simulator (set SIMULATOR_URL)' });
          return;
        }
        try {
          const outcome = await callSimulator('/recover', { method: 'POST' });
          sendJson(res, 200, { acknowledged: true, ...outcome });
        } catch (error) {
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
    } catch {
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
