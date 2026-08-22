// In-process metrics for the agent service itself — CineOps watches CineOps
// in the same Grafana. Counters only, zero dependencies, Prometheus text
// exposition at GET /metrics.

const counters = new Map();
let lastEventAt = 0;

export function increment(name, labels = {}) {
  const key = JSON.stringify([name, labels]);
  counters.set(key, (counters.get(key) ?? 0) + 1);
  lastEventAt = Date.now();
}

export function formatServiceMetrics({ uptimeSeconds = process.uptime(), timestampSeconds } = {}) {
  const lines = [];
  const described = new Set();
  for (const [key, value] of counters) {
    const [name, labels] = JSON.parse(key);
    if (!described.has(name)) {
      described.add(name);
      lines.push(`# HELP ${name} CineOps agent service counter`, `# TYPE ${name} counter`);
    }
    const labelText = Object.entries(labels)
      .map(([labelKey, labelValue]) => `${labelKey}="${String(labelValue).replace(/"/g, '\\"')}"`)
      .join(',');
    lines.push(labelText ? `${name}{${labelText}} ${value}` : `${name} ${value}`);
  }
  lines.push('# HELP cineops_service_uptime_seconds Agent service uptime', '# TYPE cineops_service_uptime_seconds gauge');
  lines.push(`cineops_service_uptime_seconds ${Number(uptimeSeconds.toFixed(1))}`);
  // The timestamp updates only when a counter moves, so dashboards can detect
  // a stalled agent instead of seeing a fresh value on every scrape.
  lines.push('# HELP cineops_service_last_event_timestamp_seconds Last time any counter changed', '# TYPE cineops_service_last_event_timestamp_seconds gauge');
  lines.push(`cineops_service_last_event_timestamp_seconds ${Math.floor((timestampSeconds ?? lastEventAt) / 1000)}`);
  return `${lines.join('\n')}\n`;
}
