import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { investigateIncident } from '../src/core.mjs';
import { stageStatuses } from '../simulator/engine.mjs';

const EXPECTED_ROOT_CAUSES = {
  'premiere-night': 'transcode',
  'storage-surge': 'ingest',
  'subtitle-drift': 'subtitles',
  'cdn-origin-storm': 'publish',
};

test('scenario library: every scenario validates and investigates to its designed root cause', () => {
  assert.equal(Object.keys(scenarios).length, 4, 'the library ships four scenarios');
  for (const [id, scenario] of Object.entries(scenarios)) {
    const result = investigateIncident(scenario, `What is wrong with ${id}?`);
    assert.equal(result.status, 'root_cause_identified', `${id} must reach a root cause`);
    assert.equal(result.rootCause.stage, EXPECTED_ROOT_CAUSES[id], `${id} root cause stage`);
    assert.ok(result.evidence.length >= 2, `${id} must cite multiple evidence signals`);
    assert.ok(result.confidence > 0.5, `${id} confidence should be high`);
    assert.ok(result.actions.length >= 2, `${id} playbook must list concrete actions`);
    const decision = result.decision;
    assert.ok(typeof decision === 'string' && decision.length > 20, `${id} decision must be actionable`);
  }
});

test('scenario library: evidence only cites the failing incident\'s own signals', () => {
  for (const [id, scenario] of Object.entries(scenarios)) {
    const result = investigateIncident(scenario);
    const validIds = new Set(scenario.signals.map((signal) => signal.id));
    assert.ok(result.evidence.every((item) => validIds.has(item.id)), `${id} evidence must come from its own signals`);
  }
});

test('scenario library: stage statuses arc generically for every scenario', () => {
  for (const [id, scenario] of Object.entries(scenarios)) {
    const peak = new Map(stageStatuses(scenario, 1).map((stage) => [stage.id, stage.status]));
    assert.equal(peak.get(EXPECTED_ROOT_CAUSES[id]), 'failed', `${id} failing stage peaks as failed`);
    assert.ok(stageStatuses(scenario, 1).every((stage) => typeof stage.detail === 'string' && stage.detail.length > 0), `${id} stages keep their detail`);

    const healed = new Map(stageStatuses(scenario, 0.05).map((stage) => [stage.id, stage.status]));
    assert.equal(healed.get(EXPECTED_ROOT_CAUSES[id]), 'healthy', `${id} failing stage heals on descent`);
  }
});
