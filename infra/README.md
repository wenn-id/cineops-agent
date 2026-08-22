# infra/

Deployment and telemetry-stack configuration for the CineOps Agent service.

## Deploy to Cloud Run

The service is a zero-dependency Node 20 container (`Dockerfile` at the repo
root). It listens on `HOST:PORT` (Cloud Run injects `PORT`, the image defaults
`HOST=0.0.0.0`).

```bash
gcloud auth login
gcloud config set project cineops-agentic-cinema-2026

gcloud run deploy cineops-agent \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

The deployment URL serves the incident room (live mode: the investigation runs
server-side and streams over SSE).

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Listen port (set by Cloud Run) | `8000` |
| `HOST` | Bind address (image sets `0.0.0.0` for containers) | `127.0.0.1` |
| `STREAM_DELAY_MS` | Artificial per-event delay for demo pacing | `0` |
| `GEMINI_API_KEY` | Gemini adapter (issue #29) — store in Secret Manager | unset |
| `GRAFANA_URL` | Grafana Cloud MCP target (issue #30) | unset |

## Secrets (for #29 / #30)

Never commit credentials. Create secrets once and attach them at deploy time:

```bash
echo -n "YOUR_KEY" | gcloud secrets create gemini-api-key --data-file=-

gcloud run deploy cineops-agent \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest
```

## Local container check

```bash
docker build -t cineops-agent .
docker run --rm -p 8000:8000 cineops-agent
# open http://127.0.0.1:8000 — should report LIVE SERVICE
```

## Planned

- #31 — docker-compose stack: Prometheus + Loki + Grafana + incident simulator
- #37 — CI/CD auto-deploy from `main`
