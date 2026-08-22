// In-process metrics for the agent service itself — CineOps watches CineOps
// in the same Grafana. Counters only, zero dependencies, Prometheus text
// exposition at GET /metrics.

const counters = new Map();

export function increment(name, labels = {}) {
  const key = JSON.stringify([name, labels]);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function formatServiceMetrics({ uptimeSeconds = process.uptime(), timestampSeconds = Date.now() / 1000 } = {}) {
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
  lines.push('# HELP cineops_service_last_updated_timestamp_seconds Last metrics update', '# TYPE cineops_service_last_updated_timestamp_seconds gauge');
  lines.push(`cineops_service_last_updated_timestamp_seconds ${Math.floor(timestampSeconds)}`);
  return `${lines.join('\n')}\n`;
}
