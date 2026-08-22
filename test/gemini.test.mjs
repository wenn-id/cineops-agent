import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { investigateStream } from '../server/agent.mjs';
import { executeTool, geminiInvestigation } from '../server/gemini-agent.mjs';

const scenario = scenarios['premiere-night'];

async function collect(stream) {
  const events = [];
  for await (const message of stream) events.push(message);
  return events;
}

function modelReply(parts) {
  return { candidates: [{ content: { parts } }] };
}

function finalVerdict(overrides = {}) {
  return modelReply([{
    text: JSON.stringify({
      status: 'root_cause_identified',
      severity: 'critical',
      confidence: 0.93,
      rootCause: { stage: 'transcode', finding: 'GPU saturation stalled the 4K HEVC queue.' },
      decision: 'Pause non-premiere 4K jobs and drain the priority queue.',
      actions: ['Pause non-premiere 4K HEVC jobs.', 'Route priority transcodes to the recovery pool.'],
      evidence: [
        { id: 'queue-depth', finding: 'Queue depth is 7.8x baseline — the primary blocker.' },
        { id: 'made-up-signal' },
      ],
      reasoning: 'Prometheus shows the transcode queue saturated with GPU workers pinned; Loki confirms the timeout burst started with the 4K HEVC batch.',
      ...overrides,
    }),
  }]);
}

test('gemini loop: model thinking alongside tool calls streams as thought events', async () => {
  const turns = [
    modelReply([
      { text: 'The pipeline summary shows transcode failed. I will pull its Prometheus metrics first.' },
      { functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } },
    ]),
    finalVerdict(),
  ];
  const events = await collect(geminiInvestigation({ scenario, query: 'q', callModel: async () => turns.shift() }));

  const thought = events.find((item) => item.event === 'thought');
  assert.ok(thought, 'expected a thought event');
  assert.match(thought.data.text, /transcode failed/);
  const thoughtIndex = events.findIndex((item) => item.event === 'thought');
  const toolIndex = events.findIndex((item) => item.event === 'tool_call');
  assert.ok(thoughtIndex < toolIndex, 'thinking precedes the tool call it explains');
});

test('gemini loop: thoughts are sanitized — no code dumps, capped length', async () => {
  const turns = [
    modelReply([
      { text: 'Querying now. ```json\n{"result":[{"metric":{"__name__":"secret"},"value":[1,"999"]}]}\n``` see metrics' },
      { functionCall: { name: 'query_prometheus', args: {} } },
    ]),
    finalVerdict(),
  ];
  const events = await collect(geminiInvestigation({ scenario, query: 'q', callModel: async () => turns.shift() }));
  const thought = events.find((item) => item.event === 'thought');

  assert.ok(thought);
  assert.ok(!thought.data.text.includes('```'), 'fenced tool payloads must not leak into the trace');
  assert.ok(!thought.data.text.includes('"__name__"'));
  assert.ok(thought.data.text.length <= 300);
  assert.match(thought.data.text, /Querying now/i);
});

test('gemini loop: tool calls are executed and the verdict streams through the event contract', async () => {
  const turns = [
    modelReply([{ functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }]),
    modelReply([{ functionCall: { name: 'query_loki_logs', args: { stage: 'transcode' } } }]),
    finalVerdict(),
  ];
  const seenContents = [];
  const callModel = async (request) => {
    seenContents.push(request.contents);
    return turns.shift();
  };

  const events = await collect(geminiInvestigation({ scenario, query: 'Can we make the premiere?', callModel }));

  const toolCalls = events.filter((item) => item.event === 'tool_call').map((item) => item.data.tool);
  assert.deepEqual(toolCalls, ['query_prometheus', 'query_loki_logs']);
  assert.ok(events.filter((item) => item.event === 'tool_call').every((item) => item.data.replay === true && item.data.readOnly === true));

  const result = events.find((item) => item.event === 'result').data;
  assert.equal(result.engine, 'gemini');
  assert.equal(result.status, 'root_cause_identified');
  assert.equal(result.rootCause.stage, 'transcode');
  assert.equal(result.confidence, 0.93);
  assert.deepEqual(result.toolCalls.map((call) => call.tool), ['query_prometheus', 'query_loki_logs']);
  assert.equal(result.pipeline.failed, 1);
  assert.match(result.decision, /pause non-premiere/i);
  assert.ok(result.reasoning.length > 10);
});

test('gemini loop: hallucinated and unqueried evidence ids are dropped, fixture values win', async () => {
  // subtitle-lag exists in the fixture but no tool queried the subtitles
  // stage — it must not pass as grounded evidence either.
  const turns = [
    modelReply([{ functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }]),
    finalVerdict({ evidence: [
      { id: 'queue-depth', finding: 'Queue depth is 7.8x baseline — the primary blocker.' },
      { id: 'made-up-signal' },
      { id: 'subtitle-lag' },
    ] }),
  ];
  const events = await collect(geminiInvestigation({ scenario, query: 'q', callModel: async () => turns.shift() }));
  const result = events.find((item) => item.event === 'result').data;

  assert.deepEqual(result.evidence.map((item) => item.id), ['queue-depth']);
  const queueDepth = result.evidence[0];
  const fixture = scenario.signals.find((signal) => signal.id === 'queue-depth');
  assert.equal(queueDepth.value, fixture.value);
  assert.equal(queueDepth.query, fixture.query);
  assert.equal(queueDepth.finding, 'Queue depth is 7.8x baseline — the primary blocker.');
});

test('gemini loop: verdicts without any tool calls yield no evidence', async () => {
  const turns = [finalVerdict()];
  const events = await collect(geminiInvestigation({ scenario, query: 'q', callModel: async () => turns.shift() }));
  const result = events.find((item) => item.event === 'result').data;
  assert.deepEqual(result.evidence, []);
});

test('gemini loop: function responses carry the executed tool data back to the model', async () => {
  const contentsLog = [];
  const turns = [
    modelReply([{ functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }]),
    finalVerdict(),
  ];
  await collect(geminiInvestigation({
    scenario,
    query: 'q',
    callModel: async (request) => {
      contentsLog.push(request.contents);
      return turns.shift();
    },
  }));

  const secondCallContents = contentsLog[1];
  const responses = secondCallContents.filter((part) => part.role === 'user').flatMap((part) => part.parts);
  const functionResponse = responses.find((part) => part.functionResponse);
  assert.equal(functionResponse.functionResponse.name, 'query_prometheus');
  const returned = functionResponse.functionResponse.response.signals.map((signal) => signal.id);
  assert.deepEqual(returned, ['queue-depth', 'gpu-utilization']);
});

test('investigateStream: gemini failures reset output and fall back to the deterministic engine', async () => {
  const events = await collect(investigateStream(scenario, 'query', {
    engine: 'gemini',
    callModel: async () => {
      throw new Error('quota exceeded');
    },
  }));

  const resetIndex = events.findIndex((item) => item.event === 'reset');
  const fallback = events.find((item) => item.event === 'status' && item.data.phase === 'fallback');
  assert.ok(resetIndex !== -1, 'expected a reset event');
  assert.ok(fallback, 'expected a fallback status event');
  assert.match(fallback.data.label, /quota exceeded/);
  assert.ok(resetIndex < events.findIndex((item) => item.event === 'result'), 'reset must precede the deterministic result');

  const result = events.find((item) => item.event === 'result').data;
  assert.equal(result.status, 'root_cause_identified');
  assert.deepEqual(result.toolCalls.map((call) => call.tool), ['query_prometheus', 'query_loki_logs', 'search_dashboards']);
});

test('gemini loop: parallel tool calls return as one grouped function-response content', async () => {
  const turns = [
    modelReply([
      { functionCall: { name: 'query_prometheus', args: {} } },
      { functionCall: { name: 'query_loki_logs', args: {} } },
    ]),
    finalVerdict(),
  ];
  let lastContents;
  const events = await collect(geminiInvestigation({
    scenario,
    query: 'q',
    callModel: async (request) => {
      lastContents = request.contents;
      return turns.shift();
    },
  }));

  const last = lastContents[lastContents.length - 1];
  assert.equal(last.role, 'user');
  const responses = last.parts.filter((part) => part.functionResponse);
  assert.deepEqual(responses.map((part) => part.functionResponse.name), ['query_prometheus', 'query_loki_logs']);
  assert.equal(events.filter((item) => item.event === 'tool_call').length, 2);
});

test('investigateStream: auto without a key stays deterministic', async () => {
  const events = await collect(investigateStream(scenario, 'query'));
  const result = events.find((item) => item.event === 'result').data;
  assert.equal(result.engine, undefined);
  assert.equal(result.rootCause.stage, 'transcode');
});

test('investigateStream: runaway tool loops are bounded and fall back', async () => {
  const events = await collect(investigateStream(scenario, 'query', {
    engine: 'gemini',
    callModel: async () => modelReply([{ functionCall: { name: 'query_prometheus', args: {} } }]),
  }));
  // 9 bounded Gemini turns, then the deterministic engine's 3 replayed calls.
  const toolCallCount = events.filter((item) => item.event === 'tool_call').length;
  assert.equal(toolCallCount, 12);
  const fallback = events.find((item) => item.event === 'status' && item.data.phase === 'fallback');
  assert.ok(fallback);
  const result = events.find((item) => item.event === 'result').data;
  assert.equal(result.rootCause.stage, 'transcode');
});

test('executeTool: filters by source and stage, and rejects unknown tools', () => {
  const prometheus = executeTool(scenario, 'query_prometheus', { stage: 'transcode' });
  assert.deepEqual(prometheus.signals.map((signal) => signal.id), ['queue-depth', 'gpu-utilization']);

  const loki = executeTool(scenario, 'query_loki_logs', {});
  assert.deepEqual(loki.signals.map((signal) => signal.id), ['error-rate']);

  const dashboards = executeTool(scenario, 'search_dashboards', { query: 'subtitle' });
  assert.deepEqual(dashboards.dashboards, [{ title: 'subtitles — Subtitle processing lag', query: 'max(cineops_subtitle_lag_minutes)' }]);

  assert.deepEqual(executeTool(scenario, 'drop_tables', {}), { error: 'unknown tool: drop_tables' });
});
