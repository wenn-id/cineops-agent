# Judge guide — verify CineOps Agent in ~3 minutes

Everything below is verifiable by clicking and reading code. No integration is
claimed that is not called somewhere in this repository.

## 1. See it work (60 seconds)

- **Instant (replay mode):** open the [live incident room](https://wenn-id.github.io/cineops-agent/)
  and press **Run investigation**. Note the `LOCAL REPLAY` badge — the
  deterministic investigator runs in the browser against the incident
  fixture. Switch scenarios from the top bar (four incidents ship in the
  library).
- **The real thing:** run the full stack and use the agent service instead:

  ```bash
  npm run stack:up      # Prometheus + Loki + Grafana + simulator + agent
  ```

  Open <http://localhost:8080> — the badge reads `LIVE SERVICE` (server-side
  investigation, SSE streaming, agent trace timeline). Grafana at
  <http://localhost:3000> (admin / cineops) shows the **Neon Harbor** incident
  dashboard and the **Agent Self-Health** dashboard — the service monitors
  itself in the same Grafana.

## 2. Watch the agent work (60 seconds)

In live mode, press **Run investigation** and watch the **AGENT TRACE**
timeline fill: phase changes, tool calls with arguments, evidence arriving,
and the verdict with a **WHY THIS VERDICT** narrative. Ask follow-up questions
in the thread — answers cite the evidence they rest on, and unsupported
questions are marked **NOT SUPPORTED BY THE EVIDENCE**. Approve the recovery
plan and watch the pipeline stages heal, live, in the UI and in Grafana.

## 3. Read the code (60 seconds)

| Claim | Verify here |
| --- | --- |
| Gemini runs the investigation loop (multi-turn tool calling, structured verdicts) | `server/gemini-agent.mjs` — `TOOL_DECLARATIONS`, the `functionCall` → execute → `functionResponse` loop, `RESULT_SCHEMA` |
| Gemini is really called (REST, no SDK) | `server/gemini.mjs` — `generateContent`, header auth, `GEMINI_MODEL` |
| Grafana MCP client is read-only | `server/grafana-mcp.mjs` — `MCP_READ_ONLY_TOOLS` allowlist; nothing else can be called |
| Evidence cannot be hallucinated | `server/gemini-agent.mjs` — `assembleResult`: only tool-returned ids pass; fixture values override model numbers |
| Follow-ups are grounded, not invented | `server/followup.mjs` — context-bound, citation-filtered, honest `supported:false` |
| Humans approve recovery, never the agent | `server/index.mjs` — `/api/recovery` requires an explicit approval referencing a server-stored investigation |
| The telemetry is real, not a recording | `simulator/` — Prometheus exposition + Loki push; `infra/docker-compose.yml` wires the stack |
| Claims are tested, continuously | `npm test` (65+) and `npm run eval` (9 outcome cases with latency budgets) run in CI on every push |

## Honesty checklist

- Replay vs live is always labeled in the UI (`LOCAL REPLAY`, `SERVER AGENT ·
  DETERMINISTIC CORE`, `SERVER AGENT · GEMINI`, `MCP TOOL TRACE · LIVE`).
- Tool data is fixture-backed until `GRAFANA_URL` + `GRAFANA_API_KEY` are set;
  every tool event carries `replay: true/false`, and live values are flagged
  `liveValue`.
- Any Gemini/MCP failure streams an honest fallback status and completes on
  the deterministic engine.

## Deployment

`gcloud run deploy` instructions (and the automated CD pipeline via Workload
Identity Federation) are in [`infra/README.md`](../infra/README.md). Secrets
live in Google Secret Manager — never in this repository.
