import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { createMcpClient } from '../server/grafana-mcp.mjs';
import { attachDashboardUrls, createLiveToolExecutor, extractDashboards, extractNumber } from '../server/grafana-live.mjs';
import { geminiInvestigation } from '../server/gemini-agent.mjs';

const scenario = scenarios['premiere-night'];

function jsonResponse(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function sseResponse(message, sessionId) {
  const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : sessionId && name === 'mcp-session-id' ? sessionId : null) },
    text: async () => payload,
  };
}

function prometheusContent(value) {
  return [{ type: 'text', text: JSON.stringify({ resultType: 'vector', result: [{ metric: { __name__: 'cineops_transcode_queue_depth', stage: 'transcode' }, value: [1710000000, String(value)] }] }) }];
}

// What createMcpClient actually returns: the parsed text contents.
function parsedPrometheus(value) {
  return [JSON.parse(prometheusContent(value)[0].text)];
}

test('mcp client: initialize handshake, session header, bearer auth, tools/call', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }, { 'mcp-session-id': 'sess-42' });
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: prometheusContent(186) } });
  };

  const client = createMcpClient({ url: 'https://mcp.example/mcp', token: 'tok', fetchImpl });
  const contents = await client.callTool('query_prometheus', { promql: 'max(cineops_transcode_queue_depth)' });
  await client.callTool('query_loki_logs', { logql: '{service="transcoder"}' });

  assert.equal(contents[0].result[0].value[1], '186');
  assert.equal(calls.length, 4, 'second call must reuse the session — no re-initialize');
  assert.equal(calls[0].body.method, 'initialize');
  assert.equal(calls[1].body.method, 'notifications/initialized');
  assert.ok(!('id' in calls[1].body), 'notifications carry no id');
  assert.equal(calls[2].body.method, 'tools/call');
  assert.equal(calls[2].body.params.name, 'query_prometheus');
  assert.equal(calls[2].body.params.arguments.promql, 'max(cineops_transcode_queue_depth)');
  assert.equal(calls[2].init.headers['mcp-session-id'], 'sess-42');
  assert.equal(calls[2].init.headers.authorization, 'Bearer tok');
  assert.equal(calls[3].body.method, 'tools/call', 'subsequent calls skip the handshake');
  assert.equal(calls[3].init.headers['mcp-session-id'], 'sess-42');
});

test('mcp client: parses SSE-framed JSON-RPC responses', async () => {
  const message = { jsonrpc: '2.0', id: 9, result: { content: prometheusContent(42) } };
  const fetchImpl = async () => sseResponse(message);
  const client = createMcpClient({ url: 'https://mcp.example/mcp', token: 't', fetchImpl });
  const contents = await client.callTool('query_prometheus', { promql: 'up' });
  assert.equal(contents[0].result[0].value[1], '42');
});

test('mcp client: enforces the read-only allowlist and surfaces tool errors', async () => {
  const fetchImpl = async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  const client = createMcpClient({ url: 'https://mcp.example/mcp', fetchImpl });

  await assert.rejects(() => client.callTool('delete_dashboard', {}), /read-only allowlist/);

  const failing = async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
  const failingClient = createMcpClient({ url: 'https://mcp.example/mcp', fetchImpl: failing });
  await assert.rejects(() => failingClient.callTool('query_prometheus', {}), /tool query_prometheus failed: boom/);
});

test('extractors: prometheus values, loki line counts, dashboards', () => {
  assert.equal(extractNumber(parsedPrometheus(186)), 186);
  assert.equal(extractNumber([{ data: { result: [{ stream: { service: 'transcoder' }, values: [['1', 'x'], ['2', 'y']] }, { stream: {}, values: [['3', 'z']] }] } }]), 3);
  assert.equal(extractNumber([{ type: 'text', text: '42' }]), null);
  assert.equal(extractNumber([{ value: 7 }]), 7);

  assert.deepEqual(
    extractDashboards([[{ title: 'Transcode — queue', url: '/d/abc' }, { title: 'no url' }]]),
    [{ title: 'Transcode — queue', url: '/d/abc' }],
  );
  assert.deepEqual(extractDashboards([{ dashboards: [{ title: 'x', url: '/d/x' }] }]), [{ title: 'x', url: '/d/x' }]);
});

test('live executor: one MCP call per scenario query, live values flagged', async () => {
  const mcpCalls = [];
  const mcp = {
    async callTool(name, args) {
      mcpCalls.push({ name, args });
      if (name === 'query_prometheus') return parsedPrometheus(240);
      return [[{ title: 'transcode — overview', url: '/d/transcode' }]];
    },
  };
  const execute = createLiveToolExecutor({ scenario, mcp });

  const result = await execute('query_prometheus', { stage: 'transcode' });
  assert.deepEqual(mcpCalls.map((call) => call.args.promql), [
    'max(cineops_transcode_queue_depth)',
    'avg(cineops_gpu_utilization_percent)',
  ]);
  assert.deepEqual(result.signals.map((signal) => signal.id), ['queue-depth', 'gpu-utilization']);
  assert.ok(result.signals.every((signal) => signal.liveValue === true && signal.value === 240));

  const unextractable = createLiveToolExecutor({ scenario, mcp: { callTool: async () => [{ type: 'text', text: 'unavailable' }] } });
  const kept = await unextractable('query_prometheus', { stage: 'transcode' });
  assert.ok(kept.signals.every((signal) => signal.liveValue === false));
  assert.equal(kept.signals[0].value, scenario.signals[0].value);

  const flaky = createLiveToolExecutor({
    scenario,
    mcp: {
      callTool: async (name, args) => {
        if (String(args.promql ?? '').includes('gpu')) throw new Error('upstream 503');
        return parsedPrometheus(240);
      },
    },
  });
  const mixed = await flaky('query_prometheus', { stage: 'transcode' });
  assert.equal(mixed.signals.length, 2, 'a failing query must not drop the other live results');
  assert.deepEqual(mixed.signals.map((signal) => signal.liveValue), [true, false]);
  assert.equal(mixed.signals[0].value, 240);
  assert.equal(mixed.signals[1].value, scenario.signals[1].value, 'failed target keeps the fixture value');
  assert.match(mixed.signals[1].liveError, /503/);

  const dashboards = await execute('search_dashboards', { query: 'transcode' });
  assert.deepEqual(dashboards.dashboards, [{ title: 'transcode — overview', url: '/d/transcode' }]);

  assert.deepEqual((await execute('drop_tables', {})), { error: 'unknown tool: drop_tables' });
});

test('gemini loop with live mcp: replay:false, live values win, dashboard urls attach', async () => {
  const mcp = {
    async callTool(name) {
      if (name === 'query_prometheus') return parsedPrometheus(240);
      return [[{ title: 'Transcode — all signals', url: 'https://grafana.example/d/transcode' }]];
    },
  };
  const finalText = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            status: 'root_cause_identified',
            severity: 'critical',
            confidence: 0.9,
            rootCause: { stage: 'transcode', finding: 'Queue stalled.' },
            decision: 'Drain the queue.',
            actions: ['Pause non-premiere jobs.'],
            evidence: [{ id: 'queue-depth', finding: 'Live queue depth far above baseline.' }],
          }),
        }],
      },
    }],
  };
  const turns = [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'query_prometheus', args: { stage: 'transcode' } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'search_dashboards', args: { query: 'transcode' } } }] } }] },
    finalText,
  ];

  const events = [];
  for await (const message of geminiInvestigation({ scenario, query: 'q', callModel: async () => turns.shift(), mcp })) {
    events.push(message);
  }

  const toolCallEvents = events.filter((item) => item.event === 'tool_call');
  assert.ok(toolCallEvents.length >= 2);
  assert.ok(toolCallEvents.every((item) => item.data.replay === false));

  const result = events.find((item) => item.event === 'result').data;
  assert.ok(result.toolCalls.every((call) => call.replay === false));
  const queueDepth = result.evidence.find((signal) => signal.id === 'queue-depth');
  assert.equal(queueDepth.value, 240, 'live MCP value must override the fixture value');
  assert.equal(queueDepth.liveValue, true);
  assert.equal(queueDepth.finding, 'Live queue depth far above baseline.');
  assert.equal(queueDepth.url, 'https://grafana.example/d/transcode');
});

test('attachDashboardUrls: links by stage mention only', () => {
  const signals = [{ id: 'a', stage: 'transcode', query: 'x' }, { id: 'b', stage: 'publish', query: 'y' }];
  const dashboards = [{ title: 'Transcode overview', url: '/d/t' }];
  assert.deepEqual(attachDashboardUrls(signals, dashboards), [
    { id: 'a', stage: 'transcode', query: 'x', url: '/d/t' },
    { id: 'b', stage: 'publish', query: 'y' },
  ]);
});
