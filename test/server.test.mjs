import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { startServer } from '../server/index.mjs';
import { resolveStatic } from '../server/static.mjs';

function parseEvents(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    let name = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event: name, data: JSON.parse(dataLines.join('\n')) });
  }
  return events;
}

test('resolveStatic serves dist/ only and blocks traversal', () => {
  const distRoot = resolve('dist');
  const index = resolveStatic(distRoot, '/');
  assert.equal(index.path, resolve(distRoot, 'index.html'));
  assert.equal(index.type, 'text/html; charset=utf-8');

  const module = resolveStatic(distRoot, '/app.mjs');
  assert.equal(module.type, 'text/javascript; charset=utf-8');

  const inside = resolveStatic(distRoot, '/package.json');
  assert.equal(inside.path, resolve(distRoot, 'package.json'));
  assert.equal(resolveStatic(distRoot, '/../server/index.mjs'), null);
  assert.equal(resolveStatic(distRoot, '/%2e%2e/.git/config'), null);
  assert.equal(resolveStatic(distRoot, '/..%5c..%5cserver%5cindex.mjs'), null);
  assert.equal(resolveStatic(distRoot, '/unknown-type.bin'), null);
});

test('server: health reports deterministic engine', async () => {
  const { server, port } = await startServer({ port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.engine, 'deterministic');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('server: investigate streams tool calls, observations, and a result', async () => {
  const { server, port } = await startServer({ port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'premiere-night', query: 'Can we still make the 21:00 premiere?' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const events = parseEvents(await response.text());
    const toolCalls = events.filter((item) => item.event === 'tool_call');
    assert.deepEqual(
      toolCalls.map((item) => item.data.tool),
      ['query_prometheus', 'query_loki_logs', 'search_dashboards'],
    );
    assert.ok(toolCalls.every((item) => item.data.replay === true && item.data.readOnly === true));

    const observations = events.filter((item) => item.event === 'observation');
    assert.equal(observations.length, 3);

    const result = events.find((item) => item.event === 'result').data;
    assert.equal(result.status, 'root_cause_identified');
    assert.equal(result.rootCause.stage, 'transcode');
    assert.equal(result.query, 'Can we still make the 21:00 premiere?');

    const statuses = events.filter((item) => item.event === 'status');
    assert.deepEqual(statuses.map((item) => item.data.phase), ['planning', 'concluding']);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('server: investigate rejects unknown scenarios and malformed bodies', async () => {
  const { server, port } = await startServer({ port: 0 });
  try {
    const notFound = await fetch(`http://127.0.0.1:${port}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'does-not-exist' }),
    });
    assert.equal(notFound.status, 404);

    const badJson = await fetch(`http://127.0.0.1:${port}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);

    const emptyQuery = await fetch(`http://127.0.0.1:${port}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'premiere-night', query: '   ' }),
    });
    assert.equal(emptyQuery.status, 400);
    assert.equal((await emptyQuery.json()).error, 'query is required');

    const missingQuery = await fetch(`http://127.0.0.1:${port}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'premiere-night' }),
    });
    assert.equal(missingQuery.status, 400);

    const method = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'DELETE' });
    assert.equal(method.status, 405);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('server: static serving exposes only built assets', async () => {
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /CineOps/);

    const missing = await fetch(`${base}/package.json`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
