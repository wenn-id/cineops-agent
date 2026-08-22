# server/

The Cloud Run agent service lives here: the investigation orchestrator, the
Gemini adapter, and the Grafana MCP client. The browser UI never performs
investigation logic in live mode — it talks to this service.

Status: scaffold. Tracked in:

- #28 — server-side agent orchestrator service on Cloud Run
- #29 — real Gemini integration (multi-step investigation loop)
- #30 — Grafana Cloud MCP client (read-only)
