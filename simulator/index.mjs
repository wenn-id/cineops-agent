// Telemetry simulator: exposes the incident as Prometheus metrics and streams
// encoder logs to Loki. One tick advances the incident by TICK_SECONDS; the
// full arc takes scenario.replayWindowSec of simulated time, then it recovers
// and restarts so dashboards always show a living incident.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatMetrics, logBatch, metricsSnapshot, scenarios } from './engine.mjs';

const SCENARIO_ID = process.env.SCENARIO ?? 'premiere-night';
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9100);
const LOKI_URL = process.env.LOKI_URL ?? ''; // empty = metrics only
const TICK_MS = Number(process.env.TICK_MS ?? 5000);
const TICK_SECONDS = Number(process.env.TICK_SECONDS ?? 60);

const scenario = scenarios[SCENARIO_ID];
if (!scenario) throw new Error(`unknown scenario: ${SCENARIO_ID}`);

let tick = 0;

function state() {
  const elapsed = tick * TICK_SECONDS;
  const fraction = Math.min(1, elapsed / scenario.replayWindowSec);
  return { elapsed, fraction };
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

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') {
    const { fraction } = state();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(formatMetrics(metricsSnapshot(scenario, fraction, tick)));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

export function startSimulator({ port = METRICS_PORT, host = '0.0.0.0' } = {}) {
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      console.log(`CineOps simulator (${SCENARIO_ID}) metrics on :${server.address().port}${LOKI_URL ? `, logs → ${LOKI_URL}` : ''}`);
      resolvePromise({ server, port: server.address().port, host });
    });
  });
}

const isMainEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainEntry) {
  await startSimulator();
  setInterval(async () => {
    const { fraction, elapsed } = state();
    await pushToLoki(logBatch(scenario, fraction, tick));
    if (elapsed >= scenario.replayWindowSec + 5 * TICK_SECONDS) {
      tick = 0; // incident recovers, then repeats for the next viewer
    } else {
      tick += 1;
    }
  }, TICK_MS);
}
