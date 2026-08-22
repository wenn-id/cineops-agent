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
  assert.match(result.rootCause.finding, /Queue is 7\.8× baseline/i);
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
});

test('uses supplied operator question in investigation record', () => {
  const query = 'Can we still make the 21:00 premiere?';
  const result = investigateIncident(scenarios['premiere-night'], query);

  assert.equal(result.query, query);
  assert.match(result.decision, /premiere/i);
});

test('rejects signals with missing or malformed fields', () => {
  const base = scenarios['premiere-night'];
  const variant = (index, patch) => ({
    ...base,
    signals: base.signals.map((signal, i) => (i === index ? { ...signal, ...patch } : signal)),
  });

  assert.throws(
    () => investigateIncident(variant(0, { score: undefined })),
    /signal score must be a finite number/i,
  );
  assert.throws(
    () => investigateIncident(variant(0, { score: 'high' })),
    /signal score must be a finite number/i,
  );
  assert.throws(
    () => investigateIncident(variant(1, { value: Number.NaN })),
    /signal value must be a finite number/i,
  );
  assert.throws(
    () => investigateIncident(variant(2, { finding: ' ' })),
    /signal finding is required/i,
  );
});

test('rejects malformed scenario playbooks', () => {
  const base = scenarios['premiere-night'];

  assert.throws(
    () => investigateIncident({ ...base, playbooks: { transcode: { decision: 'Ok', actions: [] } } }),
    /playbook actions for transcode are required/i,
  );
  assert.throws(
    () => investigateIncident({ ...base, playbooks: { transcode: { decision: 'Ok' } } }),
    /playbook actions for transcode are required/i,
  );
});

test('uses the playbook supplied by the scenario', () => {
  const base = scenarios['premiere-night'];
  const incident = {
    ...base,
    playbooks: { ...base.playbooks, transcode: { decision: 'Custom decision.', actions: ['Custom action.'] } },
  };
  const result = investigateIncident(incident);

  assert.equal(result.decision, 'Custom decision.');
  assert.deepEqual(result.actions, ['Custom action.']);
});

test('falls back to escalation for a stage with no playbook', () => {
  const base = scenarios['premiere-night'];
  const incident = { ...base, signals: [{ ...base.signals[0], stage: 'ingest' }] };
  const result = investigateIncident(incident);

  assert.equal(result.rootCause.stage, 'ingest');
  assert.match(result.decision, /escalate to human operator/i);
  assert.deepEqual(result.actions, ['Escalate to human operator.']);
});

test('excludes weak signals from evidence entirely', () => {
  const base = scenarios['premiere-night'];
  const weakOnly = { ...base, signals: base.signals.map((signal) => ({ ...signal, score: 20 })) };
  const result = investigateIncident(weakOnly);

  assert.deepEqual(result.evidence, []);
  assert.equal(result.confidence, 0);
  assert.equal(result.rootCause.stage, 'unknown');
  assert.match(result.decision, /escalate to human operator/i);
});

test('keeps signals at or above the evidence threshold', () => {
  const base = scenarios['premiere-night'];
  const incident = { ...base, signals: [{ ...base.signals[0], score: 50 }] };
  const result = investigateIncident(incident);

  assert.equal(result.evidence.length, 1);
  assert.equal(result.confidence, 0.5);
});

test('summarizes unrecognized stage statuses as unknown', () => {
  const summary = summarizePipeline([{ status: 'paused' }, { status: 'healthy' }]);

  assert.deepEqual(summary, {
    healthy: 1,
    degraded: 0,
    failed: 0,
    waiting: 0,
    unknown: 1,
    total: 2,
  });
});
