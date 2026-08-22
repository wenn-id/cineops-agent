// Telemetry simulator: exposes the incident as Prometheus metrics and streams
// encoder logs to Loki. One tick advances the incident by TICK_SECONDS; the
// full arc takes scenario.replayWindowSec of simulated time, then it recovers
// and restarts so dashboards always show a living incident.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { arcFraction, formatMetrics, logBatch, metricsSnapshot, scenarios, stageStatuses } from './engine.mjs';

const SCENARIO_ID = process.env.SCENARIO ?? 'premiere-night';
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9100);
const LOKI_URL = process.env.LOKI_URL ?? ''; // empty = metrics only
const TICK_MS = Number(process.env.TICK_MS ?? 5000);
const TICK_SECONDS = Number(process.env.TICK_SECONDS ?? 60);
const RECOVERY_SECONDS = Number(process.env.RECOVERY_SECONDS ?? 6 * TICK_SECONDS);

const scenario = scenarios[SCENARIO_ID];
if (!scenario) throw new Error(`unknown scenario: ${SCENARIO_ID}`);

let tick = 0;

function state() {
  const elapsed = tick * TICK_SECONDS;
  return { elapsed, ...arcFraction(elapsed, scenario.replayWindowSec, RECOVERY_SECONDS) };
}

async function pushToLoki(batch) {
  if (!LOKI_URL || batch.length === 0) return;
  const streams = Object.values(batch.reduce((groups, entry) => {
    const key = JSON.stringify(entry.labels);
    groups[key] ??= { stream: entry.labels, values: [] };
    groups[key].values.push([String(Date.now() * 1_000_000), entry.line]);
    return groups;
  }, {}));
  try {
    const response = await fetch(`${LOKI_URL}/loki/api/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streams }),
    });
    if (!response.ok) console.error(`loki push failed: ${response.status}`);
  } catch (error) {
    console.error(`loki push error: ${error.message}`);
  }
}

function createSimulatorServer() {
  return createServer((req, res) => {
    const send = (statusCode, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(statusCode, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/metrics') {
      const { fraction } = state();
      send(200, formatMetrics(metricsSnapshot(scenario, fraction, tick)), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      const { elapsed, fraction, phase } = state();
      send(200, {
        scenarioId: SCENARIO_ID,
        phase,
        fraction: Number(fraction.toFixed(3)),
        elapsed,
        metrics: metricsSnapshot(scenario, fraction, tick),
        stages: stageStatuses(scenario, fraction),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/recover') {
      // Human-approved recovery only: jump the arc into its descending phase.
      const windowTicks = Math.ceil(scenario.replayWindowSec / TICK_SECONDS);
      tick = Math.max(tick, windowTicks);
      send(200, { ok: true, phase: 'recovery' });
      return;
    }
    send(404, 'Not found', 'text/plain; charset=utf-8');
  });
}

export function startSimulator({ port = METRICS_PORT, host = '0.0.0.0', server = createSimulatorServer() } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const failFast = (error) => rejectPromise(error);
    server.once('error', failFast);
    server.listen(port, host, () => {
      server.off('error', failFast);
      console.log(`CineOps simulator (${SCENARIO_ID}) metrics on :${server.address().port}${LOKI_URL ? `, logs → ${LOKI_URL}` : ''}`);
      resolvePromise({ server, port: server.address().port, host });
    });
  });
}

const isMainEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainEntry) {
  await startSimulator();
  setInterval(async () => {
    await pushToLoki(logBatch(scenario, state().fraction, tick));
    if (state().phase === 'complete') {
      tick = 0; // arc restarts: baseline → incident → recovery → baseline
    } else {
      tick += 1;
    }
  }, TICK_MS);
}
