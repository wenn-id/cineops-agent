# CineOps Agent

Production incident investigation for media pipelines. Built for the Grafana
track of Agentic Cinema: The Blockbuster Hackathon.

![CineOps Agent incident room](docs/cineops-agent-demo.png)

## What works now

- Interactive incident room for upload, ingest, transcode, subtitles, quality
  control, and publishing stages.
- Deterministic local investigator that ranks metrics and logs, identifies a
  root cause, and produces a recovery decision.
- Read-only Grafana MCP tool trace for `query_prometheus`, `query_loki_logs`,
  and `search_dashboards`.
- Responsive, accessible, zero-dependency UI.
- Node test suite covering evidence ranking, pipeline summaries, validation,
  and operator queries.

Public demo currently replays a deterministic incident fixture so it works
without credentials or cloud billing. Gemini reasoning, Google ADK, live
Grafana telemetry, and Cloud Run deployment remain the next runtime milestone.
Interface labels replayed data explicitly; it does not present fixture data as
a live external tool call.

## Run locally

```bash
npm test
npm start            # builds dist/ then serves it (use start:windows on Windows)
```

Open <http://127.0.0.1:8000>. The server only exposes the built `dist/`
directory — never the repository, `.git/`, or `.agents/`.

## Architecture

```text
Browser incident room
  └─ deterministic local investigator
       ├─ pipeline state
       ├─ ranked evidence
       ├─ recovery decision
       └─ Grafana MCP tool trace (replay)

Planned runtime:
Browser → Google ADK/Gemini on Cloud Run → Grafana Cloud MCP (read-only)
```

## Repository layout

```text
web/       incident room UI (static, zero-dependency)
src/       shared domain logic (investigator core, scenarios)
server/    Cloud Run agent service (scaffold)
infra/     deployment & telemetry stack configuration (scaffold)
eval/      agent evaluation harness (scaffold)
scripts/   build & validation
test/      unit tests
```

## Grafana MCP

Antigravity config lives at `.agents/mcp_config.json`. First connection needs
Grafana OAuth authorization. No Grafana credential is stored in this repo.

A real read-only connectivity test already completed in Antigravity using the
Grafana tools `list_datasources` and `search_dashboards`. Production runtime
integration will reuse the same OAuth-based Cloud MCP path.

## Project

- Live local-replay demo: <https://wenn-id.github.io/cineops-agent/>
- Repository: <https://github.com/wenn-id/cineops-agent>
- Google Cloud project: `cineops-agentic-cinema-2026`
- License: MIT
