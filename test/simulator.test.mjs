import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { formatMetrics, logBatch, metricNameFromQuery, metricsSnapshot, valueAt } from '../simulator/engine.mjs';
import { startSimulator } from '../simulator/index.mjs';

const scenario = scenarios['premiere-night'];

test('engine: derives metric names from scenario queries', () => {
  assert.equal(metricNameFromQuery('max(cineops_transcode_queue_depth)'), 'cineops_transcode_queue_depth');
  assert.equal(metricNameFromQuery('avg(cineops_gpu_utilization_percent)'), 'cineops_gpu_utilization_percent');
  assert.equal(metricNameFromQuery('{service="transcoder"} |= "deadline exceeded"'), null);
});

test('engine: values evolve from baseline toward the incident value', () => {
  const queueDepth = scenario.signals.find((signal) => signal.id === 'queue-depth');
  const early = valueAt(queueDepth, 0.05, 1);
  const mid = valueAt(queueDepth, 0.5, 5);
  const peak = valueAt(queueDepth, 1, 10);

  assert.ok(early < 60, `early value should stay near baseline, got ${early}`);
  assert.ok(mid > early, 'value must grow as the incident develops');
  assert.ok(Math.abs(peak - queueDepth.value) < 10, `peak should approach the incident value ${queueDepth.value}, got ${peak}`);
  assert.ok(mid > early);
});

test('engine: snapshots format as a valid Prometheus exposition', () => {
  const metrics = metricsSnapshot(scenario, 0.8, 7);
  assert.ok(metrics.length >= 3, 'Prometheus-backed signals must become gauges');
  assert.ok(metrics.every((metric) => metric.name.startsWith('cineops_')));

  const text = formatMetrics(metrics);
  for (const metric of metrics) {
    assert.match(text, new RegExp(`# TYPE ${metric.name} gauge`));
    assert.match(text, new RegExp(`${metric.name}\\{stage="${metric.stage}"\\} [0-9.]+`));
  }
});

test('engine: log burst grows with the incident fraction', () => {
  assert.deepEqual(logBatch(scenario, 0.05, 1), []);
  const developing = logBatch(scenario, 0.5, 5);
  const peak = logBatch(scenario, 1, 8);
  assert.ok(developing.length > 0);
  assert.ok(peak.length >= developing.length);
  assert.match(developing[0].line, /deadline exceeded/);
  assert.equal(developing[0].labels.service, 'transcoder');
});

test('simulator: /metrics serves the exposition over HTTP', async () => {
  const { server, port } = await startSimulator({ port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    const text = await response.text();
    assert.match(text, /cineops_transcode_queue_depth\{stage="transcode"\}/);
    assert.match(text, /# TYPE cineops_gpu_utilization_percent gauge/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
