import { investigateIncident } from '../src/core.mjs';

const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 0);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Deterministic investigation engine: streams the replayed Grafana tool trace,
// then the ranked evidence and recovery decision from src/core.mjs. The Gemini
// adapter (#29) will replace the engine behind the same event contract.
export async function* investigateStream(scenario, query) {
  yield {
    event: 'status',
    data: { phase: 'planning', engine: 'deterministic', label: 'Planning investigation across pipeline stages…' },
  };

  for (const call of scenario.toolCalls) {
    if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS);
    yield {
      event: 'tool_call',
      data: { tool: call.tool, purpose: call.purpose, server: 'grafana', readOnly: true, replay: true },
    };
  }

  if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS);
  yield {
    event: 'status',
    data: { phase: 'concluding', engine: 'deterministic', label: 'Ranking evidence and deciding recovery…' },
  };

  const result = investigateIncident(scenario, query);

  for (const item of result.evidence) {
    if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS);
    yield { event: 'observation', data: item };
  }

  yield { event: 'result', data: result };
}
