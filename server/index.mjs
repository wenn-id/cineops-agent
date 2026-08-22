import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scenarios } from '../src/scenarios.mjs';
import { investigateStream } from './agent.mjs';
import { resolveStatic } from './static.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const MAX_BODY_BYTES = 10_000;

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
  const query = typeof payload?.query === 'string' ? payload.query : '';

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.on('close', () => { req.destroy(); });
  try {
    for await (const message of investigateStream(scenario, query)) {
      res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
  }
  res.end();
}

export function startServer({ port = Number(process.env.PORT) || 8000, host = process.env.HOST || '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, engine: 'deterministic', replayAvailable: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/investigate') {
        await handleInvestigate(req, res);
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
