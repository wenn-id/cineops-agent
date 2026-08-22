# infra/

Deployment and telemetry-stack configuration for the CineOps Agent service.

## Local telemetry stack (issue #31)

One command brings up the living incident — Prometheus, Loki, Grafana (with a
provisioned Neon Harbor dashboard), and the telemetry simulator:

```bash
npm run stack:up
```

- Grafana: <http://localhost:3000> (admin / cineops) — dashboard "Neon Harbor — Premiere Delivery"
- Prometheus: <http://localhost:9090>
- Agent service: <http://localhost:8080> — the incident room with live recovery:
  run an investigation, approve the recovery plan, and watch the pipeline heal
  in the UI and in Grafana
- The simulator replays the incident arc (baseline → failure → recovery) on a
  loop; `TICK_MS` / `TICK_SECONDS` in `infra/docker-compose.yml` control the pace.

`npm run stack:down` tears it down; `npm run simulate` runs the simulator
stand-alone (metrics only unless `LOKI_URL` is set).

## Deploy to Cloud Run

The service is a zero-dependency Node 20 container (`Dockerfile` at the repo
root). It listens on `HOST:PORT` (Cloud Run injects `PORT`, the image defaults
`HOST=0.0.0.0`).

### Continuous deployment (automated)

`.github/workflows/deploy.yml` builds, tests, and deploys on every push to
`main` — **skipped (green) until credentials are configured**:

1. Enable APIs and create a deployer service account with Workload Identity
   Federation (no long-lived keys in the repo):

```bash
gcloud config set project cineops-agentic-cinema-2026
gcloud services enable run.googleapis.com iamcredentials.googleapis.com cloudbuild.googleapis.com

gcloud iam service-accounts create cineops-deployer
gcloud projects add-iam-policy-binding cineops-agentic-cinema-2026 \
  --member "serviceAccount:cineops-deployer@cineops-agentic-cinema-2026.iam.gserviceaccount.com" \
  --role roles/run.admin
gcloud projects add-iam-policy-binding cineops-agentic-cinema-2026 \
  --member "serviceAccount:cineops-deployer@cineops-agentic-cinema-2026.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-cineops \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='wenn-id/cineops-agent'"
gcloud iam service-accounts add-iam-policy-binding \
  cineops-deployer@cineops-agentic-cinema-2026.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/wenn-id/cineops-agent"
```

2. In the repository settings add secrets `WIF_PROVIDER`
   (`projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-cineops`),
   `WIF_SERVICE_ACCOUNT`
   (`cineops-deployer@cineops-agentic-cinema-2026.iam.gserviceaccount.com`), and
   `GCP_PROJECT_ID`, then set the repository **variable** `CLOUD_DEPLOY=true`.

3. Push to `main`: the workflow deploys and health-checks
   `<service-url>/api/health`; the deploy badge on the README tracks it.

### First deploy by hand (optional)

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

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Listen port (set by Cloud Run) | `8000` |
| `HOST` | Bind address (image sets `0.0.0.0` for containers) | `127.0.0.1` |
| `STREAM_DELAY_MS` | Artificial per-event delay for demo pacing (deterministic engine) | `0` |
| `SIMULATOR_URL` | Telemetry simulator base URL — enables approved recovery + live incident state | unset |
| `GEMINI_API_KEY` | Enables the Gemini investigation engine (issue #29) — store in Secret Manager | unset |
| `GEMINI_MODEL` | Gemini model for the agent loop | `gemini-2.5-flash` |
| `GRAFANA_URL` | Grafana Cloud MCP endpoint, e.g. `https://mcp.grafana.com/mcp` (issue #30) | unset |
| `GRAFANA_API_KEY` | Bearer token for the MCP endpoint — store in Secret Manager | unset |
| `RATE_LIMIT_INVESTIGATE_PER_MIN` | Investigations per client per minute (protects the Gemini quota) | `10` |
| `RATE_LIMIT_FOLLOWUP_PER_MIN` | Follow-up questions per client per minute | `20` |

## Security notes

- No credential is ever read from the repo or the client; keys arrive via
  environment (locally) or Secret Manager (Cloud Run `--set-secrets`).
- The service is read-only by construction against external systems: the
  Grafana MCP client enforces a hard three-tool allowlist, and the only
  mutating endpoint (`/api/recovery`) requires an explicit approval
  referencing a server-stored investigation, rejects cross-origin browser
  requests, and drives a synthetic drill — not production infrastructure.
- Expensive endpoints are rate-limited per client; 429 responses carry
  `Retry-After`.
- Operator authentication is intentionally out of scope for the single-user
  demo deployment; the static site (GitHub Pages) never sees any credential.
- Logs are structured JSON with per-request ids — no payload data is logged.

With `GEMINI_API_KEY` unset the service runs the deterministic engine and
reports `"engine":"deterministic"` at `/api/health`; with the key set it runs
the Gemini tool loop and reports `"engine":"gemini"`. Verify a key locally:

```bash
GEMINI_API_KEY=... npm run check:gemini
```

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
docker run --rm -p 8080:8080 cineops-agent
# open http://127.0.0.1:8080 — should report LIVE SERVICE
```

## Planned

- #31 — docker-compose stack: Prometheus + Loki + Grafana + incident simulator
- #37 — CI/CD auto-deploy from `main`
