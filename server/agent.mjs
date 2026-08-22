import { investigateIncident } from '../src/core.mjs';
import { geminiAvailable } from './gemini.mjs';
import { geminiInvestigation } from './gemini-agent.mjs';

const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 0);

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Deterministic investigation engine: streams the replayed Grafana tool trace,
// then the ranked evidence and recovery decision from src/core.mjs.
export async function* deterministicInvestigation(scenario, query, { signal } = {}) {
  yield {
    event: 'status',
    data: { phase: 'planning', engine: 'deterministic', label: 'Planning investigation across pipeline stages…' },
  };

  for (const call of scenario.toolCalls) {
    if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS, signal);
    yield {
      event: 'tool_call',
      data: { tool: call.tool, purpose: call.purpose, server: 'grafana', readOnly: true, replay: true },
    };
  }

  if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS, signal);
  yield {
    event: 'status',
    data: { phase: 'concluding', engine: 'deterministic', label: 'Ranking evidence and deciding recovery…' },
  };

  const result = investigateIncident(scenario, query);

  for (const item of result.evidence) {
    if (STREAM_DELAY_MS > 0) await sleep(STREAM_DELAY_MS, signal);
    yield { event: 'observation', data: item };
  }

  yield { event: 'result', data: result };
}

// Engine dispatch: 'auto' picks Gemini when a key is configured and falls back
// to the deterministic engine on any Gemini failure, streaming an honest
// status event about the switch. The callModel injection point is for tests.
export async function* investigateStream(scenario, query, { signal, engine = 'auto', callModel } = {}) {
  const wantsGemini = engine === 'gemini' || (engine === 'auto' && geminiAvailable());
  if (wantsGemini) {
    try {
      yield* geminiInvestigation({ scenario, query, signal, ...(callModel ? { callModel } : {}) });
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Partial Gemini output may already be on the client: tell it to reset
      // the evidence and tool ledger before the deterministic engine replays.
      yield { event: 'reset', data: { engine: 'deterministic' } };
      yield {
        event: 'status',
        data: { phase: 'fallback', engine: 'deterministic', label: `Gemini unavailable (${error.message}) — switching to the deterministic engine…` },
      };
    }
  }
  yield* deterministicInvestigation(scenario, query, { signal });
}
