// Evaluation cases: scripted agent behavior with expected outcomes and
// latency budgets. Scripted cases drive the Gemini loop through an injected
// model; deterministic cases run the fallback engine directly. The runner
// (run.mjs) executes these and gates CI on the results.

import { scenarios } from '../src/scenarios.mjs';

const premiere = scenarios['premiere-night'];

function modelReply(parts) {
  return { candidates: [{ content: { parts } }] };
}

function verdict(overrides = {}) {
  return modelReply([{
    text: JSON.stringify({
      status: 'root_cause_identified',
      severity: 'critical',
      confidence: 0.92,
      rootCause: { stage: 'transcode', finding: 'GPU saturation stalled the 4K HEVC queue.' },
      decision: 'Pause non-premiere 4K jobs and drain the priority queue.',
      actions: ['Pause non-premiere 4K HEVC jobs.', 'Route priority transcodes to the recovery pool.'],
      evidence: [{ id: 'queue-depth' }, { id: 'gpu-utilization' }],
      reasoning: 'Queue depth and GPU saturation point at transcode capacity exhaustion.',
      ...overrides,
    }),
  }]);
}

// Scenario variant: every signal is weak, so no root cause may be claimed.
const weakSignals = {
  ...premiere,
  signals: premiere.signals.map((signal) => ({ ...signal, score: 20 })),
};

export const CASES = [
  {
    id: 'det-premiere',
    kind: 'deterministic',
    description: 'deterministic engine identifies the transcode root cause',
    latencyBudgetMs: 250,
    expect: {
      status: 'root_cause_identified',
      rootCauseStage: 'transcode',
      evidenceIds: ['queue-depth', 'gpu-utilization', 'error-rate'],
      decisionPattern: /premiere/i,
    },
  },
  {
    id: 'det-weak-signals',
    kind: 'deterministic',
    scenario: weakSignals,
    description: 'weak signals yield monitoring, never a fabricated root cause',
    latencyBudgetMs: 250,
    expect: {
      status: 'monitoring',
      evidenceIds: [],
      decisionPattern: /escalate/i,
    },
  },
  {
    id: 'gemini-grounded',
    kind: 'scripted',
    description: 'grounded verdict: only tool-returned evidence passes',
    latencyBudgetMs: 500,
    modelTurns: () => [
      modelReply([{ text: 'Checking the failed transcode stage metrics first.' }, { functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }]),
      verdict(),
    ],
    expect: {
      status: 'root_cause_identified',
      rootCauseStage: 'transcode',
      evidenceIds: ['queue-depth', 'gpu-utilization'],
      evidenceExcludes: ['subtitle-lag'],
      thoughtEmitted: true,
    },
  },
  {
    id: 'gemini-hallucination',
    kind: 'scripted',
    description: 'hallucinated and unqueried citations are dropped',
    latencyBudgetMs: 500,
    modelTurns: () => [
      modelReply([{ functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }]),
      verdict({ evidence: [{ id: 'queue-depth' }, { id: 'invented-signal' }, { id: 'subtitle-lag' }] }),
    ],
    expect: {
      evidenceIds: ['queue-depth'],
      evidenceExcludes: ['invented-signal', 'subtitle-lag'],
    },
  },
  {
    id: 'gemini-runaway',
    kind: 'scripted',
    description: 'runaway tool loops are bounded and fall back deterministically',
    latencyBudgetMs: 1000,
    modelTurns: () => async () => modelReply([{ functionCall: { name: 'query_prometheus', args: {} } }]),
    expect: {
      status: 'root_cause_identified',
      rootCauseStage: 'transcode',
      maxToolCalls: 11, // exactly 8 bounded Gemini turns + 3 deterministic replay calls
      fallbackEmitted: true,
    },
  },
  {
    id: 'gemini-outage',
    kind: 'scripted',
    description: 'model outage resets output and completes on the deterministic engine',
    latencyBudgetMs: 750,
    modelTurns: () => async () => {
      throw new Error('simulated outage');
    },
    expect: {
      status: 'root_cause_identified',
      fallbackEmitted: true,
      resetEmitted: true,
    },
  },
];
