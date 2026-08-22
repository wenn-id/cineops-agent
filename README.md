# CineOps Agent

Production incident investigation for media pipelines. Built for the Grafana
track of Agentic Cinema: The Blockbuster Hackathon.

![CineOps Agent incident room](docs/cineops-agent-demo.png)

## What works now

- Interactive incident room for upload, ingest, transcode, subtitles, quality
  control, and publishing stages.
- Zero-dependency Node agent service (`server/`): server-side investigations
  streamed to the browser over SSE, health endpoint, static `dist/` serving,
  and a Dockerfile for Cloud Run.
- Deterministic investigation engine that ranks metrics and logs, identifies a
  root cause, and produces a recovery decision.
- Read-only Grafana MCP tool trace for `query_prometheus`, `query_loki_logs`,
  and `search_dashboards`.
- Responsive, accessible, zero-dependency UI with automatic live/replay mode:
  served by the agent service it streams server-side investigations; served
  statically (e.g. GitHub Pages) it falls back to in-browser replay.
- Node test suite covering evidence ranking, pipeline summaries, validation,
  operator queries, and the service API (SSE, errors, static safety).

The public Pages demo runs in replay mode so it works without credentials or
cloud billing; when served by the agent service the same UI runs the
investigation server-side with a deterministic engine. Gemini reasoning, live
Grafana telemetry, and Cloud Run deployment remain the next runtime milestone.
Interface labels replayed data explicitly; it does not present fixture data as
a live external tool call.

## Run locally

```bash
npm test
npm start            # build + agent service → http://127.0.0.1:8000 (live mode)
npm run start:replay # offline alternative: static replay server (python)
```

Both servers expose only the built `dist/` directory — never the repository,
`.git/`, or `.agents/`.

## Architecture

```text
Incident room (web/)
  ├─ live mode: fetch SSE → agent service (server/)
  │    └─ investigation engine (src/core.mjs) → streamed events
  │         future: Gemini loop (#29) + Grafana Cloud MCP (#30)
  └─ replay mode: deterministic investigator runs in the browser
       (static hosting fallback, e.g. GitHub Pages)

Target runtime:
Browser → agent service on Cloud Run → Gemini + Grafana Cloud MCP (read-only)
```

Deploy instructions for Cloud Run (including secret setup) live in
[`infra/README.md`](infra/README.md).

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
