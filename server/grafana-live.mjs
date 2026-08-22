// Live tool execution against Grafana MCP. The model-facing tool contract is
// stage-scoped ({ stage }); this executor translates each stage query from the
// scenario into real MCP calls (query_prometheus/query_loki_logs take PromQL/
// LogQL strings) and maps live values back onto the signal metadata.
//
// Field-level extraction paths document the expected API shapes; they are the
// single seam to adjust against real Grafana MCP responses when credentials
// land. Signals whose live value could not be extracted keep the fixture value
// and are flagged liveValue:false — provenance stays honest.

function firstJsonContent(contents) {
  return contents.find((content) => content && typeof content === 'object') ?? null;
}

export function extractNumber(contents) {
  const content = firstJsonContent(contents);
  if (!content) return null;
  if (typeof content === 'number') return Number.isFinite(content) ? content : null;
  const vector = content?.result ?? content?.data?.result;
  if (Array.isArray(vector) && vector.length) {
    const sample = Array.isArray(vector[0]?.value) ? vector[0].value[1] : vector[0]?.value;
    const value = Number(sample);
    if (Number.isFinite(value)) return value;
  }
  if (typeof content.value === 'number') return content.value;
  if (Array.isArray(content?.data?.result)) {
    // Loki stream results: the count of returned entries is the usable signal.
    const lines = content.data.result.reduce((sum, stream) => sum + (stream?.values?.length ?? 0), 0);
    if (lines > 0) return lines;
  }
  return null;
}

export function extractDashboards(contents) {
  const content = firstJsonContent(contents);
  if (!content) return [];
  const list = Array.isArray(content) ? content : content.dashboards ?? content.data ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .filter((dashboard) => dashboard && (dashboard.url || dashboard.title))
    .map((dashboard) => ({ title: String(dashboard.title ?? 'dashboard'), url: String(dashboard.url ?? '') }))
    .filter((dashboard) => dashboard.url);
}

// mcp: { callTool(name, args) } — the protocol client or a test double.
export function createLiveToolExecutor({ scenario, mcp }) {
  return async function executeLiveTool(name, args = {}) {
    if (name === 'query_prometheus' || name === 'query_loki_logs') {
      const source = name === 'query_prometheus' ? 'Prometheus' : 'Loki';
      const queryKey = name === 'query_prometheus' ? 'promql' : 'logql';
      const targets = scenario.signals.filter(
        (signal) => signal.source === source && (!args.stage || signal.stage === args.stage),
      );
      const signals = [];
      for (const target of targets) {
        const contents = await mcp.callTool(name, { [queryKey]: target.query });
        const liveValue = extractNumber(contents);
        signals.push({ ...target, ...(liveValue !== null ? { value: liveValue, liveValue: true } : { liveValue: false }) });
      }
      return { stage: args.stage ?? 'all', signals };
    }
    if (name === 'search_dashboards') {
      const contents = await mcp.callTool('search_dashboards', { query: String(args.query ?? '') });
      return { dashboards: extractDashboards(contents) };
    }
    return { error: `unknown tool: ${name}` };
  };
}

// Best-effort cross-linking: evidence cards link to the dashboard whose title
// mentions the signal's stage, so judges can cross-check in one click.
export function attachDashboardUrls(signals, dashboards) {
  if (!dashboards?.length) return signals;
  return signals.map((signal) => {
    const match = dashboards.find((dashboard) => dashboard.title.toLowerCase().includes(signal.stage.toLowerCase()));
    return match ? { ...signal, url: match.url } : signal;
  });
}
