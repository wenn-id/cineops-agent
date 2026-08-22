// Pure simulation engine: turns a scenario into evolving telemetry.
// Deterministic given (fraction, tick) — no IO, fully unit-testable.

import { scenarios } from '../src/scenarios.mjs';

export function metricNameFromQuery(query) {
  const match = /[a-z_]+\((?:[a-z_]+,\s*)?([a-z_:][a-z0-9_:]*)/.exec(query ?? '');
  return match ? match[1] : null;
}

function pseudoJitter(seed) {
  // Deterministic squiggle in [-1, 1) without a PRNG dependency.
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

// Value curve: healthy baseline before the incident, then rises toward the
// incident value following the replay fraction, with deterministic jitter so
// repeated demos look organic without becoming flaky.
export function valueAt(signal, fraction, tick) {
  const rampStart = 0.15;
  const ramp = fraction <= rampStart ? 0 : (fraction - rampStart) / (1 - rampStart);
  const eased = ramp * ramp * (3 - 2 * ramp); // smoothstep
  const jitter = pseudoJitter(tick * 7 + signal.value) * (2 + eased * 6);
  const current = signal.baseline + (signal.value - signal.baseline) * eased + jitter;
  return Math.max(0, Number(current.toFixed(signal.value % 1 === 0 ? 0 : 1)));
}

export function metricsSnapshot(scenario, fraction, tick) {
  const metrics = [];
  for (const signal of scenario.signals) {
    const name = metricNameFromQuery(signal.query);
    if (!name) continue; // Loki signals stream as logs, not gauges
    metrics.push({
      name,
      help: signal.label,
      stage: signal.stage,
      value: valueAt(signal, fraction, tick),
    });
  }
  return metrics;
}

export function formatMetrics(metrics) {
  const lines = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} gauge`);
    lines.push(`${metric.name}{stage="${metric.stage}"} ${metric.value}`);
  }
  return `${lines.join('\n')}\n`;
}

// Encoder timeout log lines: sparse before the incident, a burst afterwards.
export function logBatch(scenario, fraction, tick) {
  const errorSignal = scenario.signals.find((signal) => signal.source === 'Loki');
  if (!errorSignal) return [];
  const rampStart = 0.15;
  const burst = fraction <= rampStart ? 0 : Math.round((fraction - rampStart) * 12) + 1;
  const lines = [];
  for (let index = 0; index < burst; index++) {
    const jobId = 4100 + ((tick * 13 + index * 7) % 96);
    lines.push(`level=error ts=2026-08-22T20:${String(12 + tick % 48).padStart(2, '0')}:00Z caller=encoder.go:214 job_id=${jobId} codec=hevc resolution=4k msg="transcode deadline exceeded" attempt=3 backoff=2.75s`);
  }
  return lines.map((line) => ({ labels: { service: 'transcoder', stage: 'transcode', job: 'cineops-simulator' }, line }));
}

// Incident arc: ramp up over the replay window, then a real recovery descent
// back to baseline before the arc completes and restarts. A sustained peak
// with an abrupt reset would not be honest recovery telemetry.
export function arcFraction(elapsed, windowSec, recoverySec) {
  if (elapsed <= windowSec) {
    return { fraction: Math.min(1, elapsed / windowSec), phase: 'incident' };
  }
  const recoveryFraction = 1 - (elapsed - windowSec) / recoverySec;
  if (recoveryFraction > 0) {
    return { fraction: recoveryFraction, phase: 'recovery' };
  }
  return { fraction: 0, phase: 'complete' };
}

// Pipeline stage statuses derived from the incident arc — the same function
// drives the dashboard story and the UI recovery view, so what the operator
// sees healing is exactly what the telemetry is doing. Each stage's fixture
// status is its peak: stages reach it as the arc ramps and heal on descent.
export function stageStatuses(scenario, fraction) {
  const anyFailedPeaking = scenario.stages.some((stage) => stage.status === 'failed' && fraction > 0.3);
  return scenario.stages.map((stage) => {
    let status = 'healthy';
    if (stage.status === 'healthy') {
      status = 'healthy';
    } else if (stage.status === 'waiting') {
      status = anyFailedPeaking ? 'waiting' : 'healthy';
    } else if (fraction > 0.3) {
      status = stage.status;
    } else if (fraction > 0.15) {
      status = 'degraded';
    }
    return { id: stage.id, label: stage.label, status, detail: stage.detail };
  });
}

export { scenarios };
