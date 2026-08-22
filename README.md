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
- Gemini-powered investigation loop (`server/gemini-agent.mjs`): the model
  selects read-only observability tools itself across multiple turns, then
  returns a structured verdict (root cause, confidence, recovery actions) via
  response schema. Runs with `GEMINI_API_KEY` set; verify wiring with
  `npm run check:gemini`. Any Gemini failure streams an honest fallback status
  and continues on the deterministic engine.
- Deterministic investigation engine that ranks metrics and logs, identifies a
  root cause, and produces a recovery decision.
- Anti-hallucination assembly: the model can only cite evidence ids returned
  by the tools; metric values and queries always come from the incident data,
  never from the model.
- Read-only Grafana MCP tool trace for `query_prometheus`, `query_loki_logs`,
  and `search_dashboards` — tool names match the Grafana MCP contract that the
  live client (#30) will back with real telemetry.
- Responsive, accessible, zero-dependency UI with automatic live/replay mode:
  served by the agent service it streams server-side investigations; served
  statically (e.g. GitHub Pages) it falls back to in-browser replay.
- Node test suite covering evidence ranking, pipeline summaries, validation,
  operator queries, and the service API (SSE, errors, static safety).

The public Pages demo runs in replay mode so it works without credentials or
cloud billing. Served by the agent service, the same UI runs investigations
server-side: with `GEMINI_API_KEY` set the reasoning is live Gemini over the
tool loop; without it (or on any API failure) the deterministic engine takes
over, and the UI names the active engine. Tool data still comes from the
incident fixture until the live Grafana telemetry lands (#30). Cloud Run
deployment instructions are in `infra/README.md`.

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
  │    ├─ Gemini engine: model-selected tool calls → structured verdict
  │    │    (server/gemini-agent.mjs; falls back on any failure)
  │    └─ deterministic engine (src/core.mjs)
  │    future: live Grafana Cloud MCP telemetry (#30)
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
