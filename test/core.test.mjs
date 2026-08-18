import test from 'node:test';
import assert from 'node:assert/strict';

import {
  investigateIncident,
  summarizePipeline,
} from '../src/core.mjs';
import { scenarios } from '../src/scenarios.mjs';

test('investigates transcode failure with ranked Grafana evidence', () => {
  const result = investigateIncident(scenarios['premiere-night']);

  assert.equal(result.severity, 'critical');
  assert.equal(result.status, 'root_cause_identified');
  assert.equal(result.rootCause.stage, 'transcode');
  assert.match(result.rootCause.finding, /Queue is 7.8× baseline/i);
  assert.ok(result.confidence >= 0.9);
  assert.deepEqual(
    result.evidence.map((item) => item.id),
    ['queue-depth', 'gpu-utilization', 'error-rate'],
  );
  assert.deepEqual(
    result.toolCalls.map((call) => call.tool),
    ['query_prometheus', 'query_loki_logs', 'search_dashboards'],
  );
  assert.ok(result.toolCalls.every((call) => call.server === 'grafana' && call.readOnly));
});

test('summarizes pipeline state without hiding blocked stages', () => {
  const summary = summarizePipeline(scenarios['premiere-night'].stages);

  assert.deepEqual(summary, {
    healthy: 3,
    degraded: 1,
    failed: 1,
    waiting: 1,
    unknown: 0,
    total: 6,
  });
});

test('rejects malformed incidents at trust boundary', () => {
  assert.throws(
    () => investigateIncident({ id: 'bad', stages: [] }),
    /incident title is required/i,
  );
  assert.throws(
    () => investigateIncident({ title: 'bad', stages: [{id: 's', label: 'l', detail: 'd', status: 'healthy'}], signals: [{id: '1'}], toolCalls: undefined }),
    /incident toolCalls are required/i,
  );
});

test('uses supplied operator question in investigation record', () => {
  const query = 'Can we still make the 21:00 premiere?';
  const result = investigateIncident(scenarios['premiere-night'], query);

  assert.equal(result.query, query);
  assert.match(result.decision, /premiere/i);
});
