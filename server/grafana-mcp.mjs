// Read-only MCP client for Grafana Cloud (streamable HTTP transport).
// The transport is injectable so the full JSON-RPC flow — initialize,
// session handling, tools/call — is testable without credentials.
//
// Live verification against a real Grafana Cloud MCP endpoint is pending
// credentials; the mappers in grafana-mcp-mappers.mjs document the shapes.

export const MCP_READ_ONLY_TOOLS = new Set(['query_prometheus', 'query_loki_logs', 'search_dashboards']);

export function mcpAvailable() {
  return Boolean(process.env.GRAFANA_URL);
}

function parseSseBody(text) {
  // Streamable HTTP may answer JSON-RPC over SSE framing; the message is the
  // last `data:` line that parses to an object with an id or method.
  for (const line of text.split('\n').reverse()) {
    if (!line.startsWith('data:')) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message && typeof message === 'object' && ('id' in message || 'method' in message)) return message;
    } catch {
      // skip non-JSON keep-alive or comment lines
    }
  }
  throw new Error('MCP response contained no JSON-RPC message');
}

export function createMcpClient({
  url = process.env.GRAFANA_URL,
  token = process.env.GRAFANA_API_KEY,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!url) throw new Error('GRAFANA_URL is not set');
  let sessionId;
  let nextRequestId = 1;

  async function rpc(method, params, { notification = false } = {}) {
    const message = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    if (!notification) message.id = nextRequestId++;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal,
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Grafana MCP ${response.status}: ${detail.slice(0, 200)}`);
    }
    if (notification || response.status === 202) return null;
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream')
      ? parseSseBody(await response.text())
      : await response.json();
    if (body.error) throw new Error(`Grafana MCP error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  return {
    async callTool(name, args = {}) {
      if (!MCP_READ_ONLY_TOOLS.has(name)) {
        throw new Error(`tool not in the read-only allowlist: ${name}`);
      }
      await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'cineops-agent', version: '0.1.0' },
      });
      await rpc('notifications/initialized', undefined, { notification: true });
      const result = await rpc('tools/call', { name, arguments: args });
      if (!result || !Array.isArray(result.content)) {
        throw new Error(`Grafana MCP returned no content for ${name}`);
      }
      if (result.isError) {
        const text = result.content.map((part) => part.text ?? '').join(' ');
        throw new Error(`Grafana MCP tool ${name} failed: ${text.slice(0, 200)}`);
      }
      return result.content
        .filter((part) => part.type === 'text')
        .map((part) => {
          try {
            return JSON.parse(part.text);
          } catch {
            return part.text;
          }
        });
    },
  };
}
