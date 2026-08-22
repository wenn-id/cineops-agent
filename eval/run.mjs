// Evaluation runner: executes eval/cases.mjs against the real investigation
// pipeline (mocked model where scripted), checks expected outcomes and latency
// budgets, prints a results table, and exits non-zero on any failure so CI
// gates on it. With GEMINI_API_KEY set, an additional live-model case runs.

import { scenarios } from '../src/scenarios.mjs';
import { investigateStream } from '../server/agent.mjs';
import { callGemini, geminiAvailable } from '../server/gemini.mjs';
import { CASES } from './cases.mjs';

const premiere = scenarios['premiere-night'];

async function collectEvents(caseDef) {
  const events = [];
  const options = {};
  if (caseDef.kind === 'scripted') {
    options.engine = 'gemini';
    // modelTurns() builds the model once: an array is a scripted turn
    // sequence, a function is the callModel itself, anything else is a
    // constant reply.
    const built = caseDef.modelTurns();
    if (Array.isArray(built)) {
      const turns = [...built];
      options.callModel = async () => turns.shift();
    } else if (built instanceof Function) {
      options.callModel = built;
    } else {
      options.callModel = async () => built;
    }
  }
  for await (const message of investigateStream(caseDef.scenario ?? premiere, caseDef.query ?? 'Can we still make the 21:00 premiere?', options)) {
    events.push(message);
  }
  return events;
}

async function runLiveCase() {
  const started = performance.now();
  const events = [];
  for await (const message of investigateStream(premiere, 'Can we still make the 21:00 premiere?', { engine: 'gemini', callModel: callGemini })) {
    events.push(message);
  }
  const latencyMs = performance.now() - started;
  const result = events.find((item) => item.event === 'result')?.data;
  const fixtureIds = new Set(premiere.signals.map((signal) => signal.id));
  const checks = [
    { label: 'returns a verdict', pass: Boolean(result) },
    { label: 'identifies the transcode root cause', pass: result?.rootCause?.stage === 'transcode' },
    { label: 'evidence cites real signals', pass: (result?.evidence ?? []).length > 0 && result.evidence.every((item) => fixtureIds.has(item.id)) },
    { label: 'latency within 20s', pass: latencyMs < 20_000 },
  ];
  return { id: 'live-gemini', latencyMs, checks };
}

function checkCase(caseDef, events, latencyMs) {
  const result = events.find((item) => item.event === 'result')?.data;
  const toolCallEvents = events.filter((item) => item.event === 'tool_call');
  const checks = [];
  const expect = caseDef.expect ?? {};

  if (expect.status) {
    checks.push({ label: `status = ${expect.status}`, pass: result?.status === expect.status });
  }
  if (expect.rootCauseStage) {
    checks.push({ label: `root cause stage = ${expect.rootCauseStage}`, pass: result?.rootCause?.stage === expect.rootCauseStage });
  }
  if (expect.evidenceIds) {
    const ids = (result?.evidence ?? []).map((item) => item.id);
    checks.push({ label: `evidence = [${expect.evidenceIds.join(', ')}]`, pass: JSON.stringify(ids) === JSON.stringify(expect.evidenceIds) });
  }
  if (expect.evidenceExcludes) {
    const ids = new Set((result?.evidence ?? []).map((item) => item.id));
    checks.push({ label: `excludes [${expect.evidenceExcludes.join(', ')}]`, pass: expect.evidenceExcludes.every((id) => !ids.has(id)) });
  }
  if (expect.decisionPattern) {
    checks.push({ label: 'decision matches', pass: expect.decisionPattern.test(result?.decision ?? '') });
  }
  if (expect.thoughtEmitted) {
    checks.push({ label: 'thought event emitted', pass: events.some((item) => item.event === 'thought') });
  }
  if (expect.fallbackEmitted) {
    checks.push({ label: 'fallback status emitted', pass: events.some((item) => item.event === 'status' && item.data.phase === 'fallback') });
  }
  if (expect.resetEmitted) {
    checks.push({ label: 'reset event emitted', pass: events.some((item) => item.event === 'reset') });
  }
  if (expect.maxToolCalls !== undefined) {
    checks.push({ label: `≤ ${expect.maxToolCalls} tool calls`, pass: toolCallEvents.length <= expect.maxToolCalls });
  }
  checks.push({ label: `latency ≤ ${caseDef.latencyBudgetMs}ms`, pass: latencyMs <= caseDef.latencyBudgetMs });
  return checks;
}

const rows = [];
let failures = 0;

for (const caseDef of CASES) {
  const started = performance.now();
  try {
    const events = await collectEvents(caseDef);
    const latencyMs = performance.now() - started;
    const checks = checkCase(caseDef, events, latencyMs);
    const failed = checks.filter((check) => !check.pass);
    if (failed.length) failures += 1;
    rows.push({ id: caseDef.id, kind: caseDef.kind, latencyMs, budget: caseDef.latencyBudgetMs, failed });
  } catch (error) {
    failures += 1;
    rows.push({ id: caseDef.id, kind: caseDef.kind, latencyMs: performance.now() - started, budget: caseDef.latencyBudgetMs, failed: [{ label: `threw: ${error.message}`, pass: false }] });
  }
}

if (geminiAvailable()) {
  try {
    const live = await runLiveCase();
    if (live.checks.some((check) => !check.pass)) failures += 1;
    rows.push({ id: live.id, latencyMs: live.latencyMs, budget: 20_000, failed: live.checks.filter((check) => !check.pass) });
  } catch (error) {
    failures += 1;
    rows.push({ id: 'live-gemini', latencyMs: 0, budget: 20_000, failed: [{ label: `threw: ${error.message}`, pass: false }] });
  }
} else {
  rows.push({ id: 'live-gemini', latencyMs: null, budget: 20_000, failed: [], skipped: true });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`\nCineOps evaluation — ${rows.length} cases\n`);
console.log(`${pad('ID', 22)}${pad('RESULT', 10)}${pad('LATENCY', 18)}NOTES`);
for (const row of rows) {
  const result = row.skipped ? 'SKIP' : row.failed.length ? 'FAIL' : 'PASS';
  const latency = row.latencyMs === null ? '—' : `${Math.round(row.latencyMs)}ms / ${row.budget}ms`;
  const notes = row.skipped ? 'no GEMINI_API_KEY — live model case skipped' : row.failed.map((check) => check.label).join('; ');
  console.log(`${pad(row.id, 22)}${pad(result, 10)}${pad(latency, 18)}${notes}`);
}
console.log('');
const passed = rows.filter((row) => !row.skipped && !row.failed.length).length;
const executed = rows.filter((row) => !row.skipped).length;
console.log(`${passed}/${executed} passed${rows.some((row) => row.skipped) ? ' (1 live case skipped: no key)' : ''}`);
if (failures > 0) {
  console.error(`\n${failures} case(s) failed — accuracy or latency regression.`);
  process.exit(1);
}
