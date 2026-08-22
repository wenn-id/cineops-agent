import test from 'node:test';
import assert from 'node:assert/strict';

import { formatServiceMetrics, increment } from '../server/metrics.mjs';
import { startServer } from '../server/index.mjs';

test('metrics: counters render as a valid exposition with labels', () => {
  increment('cineops_investigations_total', { engine: 'deterministic' });
  increment('cineops_investigations_total', { engine: 'deterministic' });
  increment('cineops_investigations_total', { engine: 'gemini' });
  increment('cineops_followups_total', { supported: 'yes' });

  const text = formatServiceMetrics({ uptimeSeconds: 12.34, timestampSeconds: 1787372421 });
  assert.match(text, /# TYPE cineops_investigations_total counter/);
  assert.match(text, /cineops_investigations_total\{engine="deterministic"\} 2/);
  assert.match(text, /cineops_investigations_total\{engine="gemini"\} 1/);
  assert.match(text, /cineops_followups_total\{supported="yes"\} 1/);
  assert.match(text, /cineops_service_uptime_seconds 12\.3/);
  assert.match(text, /cineops_service_last_updated_timestamp_seconds 1787372421/);
});

test('metrics: /metrics serves the agent service exposition over HTTP', async () => {
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    // Generate some real traffic so counters carry live values.
    const investigation = await fetch(`${base}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'premiere-night', query: 'metrics smoke' }),
    });
    await investigation.text();

    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    const text = await response.text();
    assert.match(text, /cineops_investigations_total\{engine=/);
    assert.match(text, /cineops_investigations_completed_total\{outcome="completed"\} 1/);
    assert.match(text, /cineops_service_uptime_seconds/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
