# Demo video script — 3 minutes (English)

The hackathon requires the video to show the project **functioning as built**
(not a cinematic trailer), public on YouTube or Vimeo, in English or with
English subtitles. This script is built to be recorded in segments and edited
to exactly ~3:00. Every second shows real, running software.

## Preparation checklist (before pressing record)

- [ ] `npm run stack:up` running and **warmed up for ~3 minutes** (queue depth visibly climbing, logs streaming)
- [ ] `GEMINI_API_KEY` set on the agent service (chip must read `SERVER AGENT · GEMINI`); fallback shots of `DETERMINISTIC CORE` are honest but show the weaker story
- [ ] In `infra/docker-compose.yml`, temporarily set `TICK_MS: "1500"` and `TICK_SECONDS: "20"` so the incident arc moves fast enough for camera; revert after recording
- [ ] Grafana open in a second tab: **Neon Harbor** dashboard + **Agent Self-Health** side by side (`localhost:3000`, admin / cineops)
- [ ] Incident room at `localhost:8080`, browser zoom ~110%, 1920×1080, dark theme, all other tabs/extensions hidden
- [ ] Terminal ready with two commands pre-typed: `npm test` and `npm run eval`
- [ ] OBS (or equivalent) at 1920×1080 / 30fps, cursor highlight on, mic tested
- [ ] Record each section below as a separate take; the time codes are targets for the edit, not the recording

---

## The script

### [0:00–0:15] Cold open — the incident (15s)

**Screen:** Grafana, Neon Harbor dashboard. Queue-depth panel climbing into red; encoder logs streaming `deadline exceeded`. No talking head, no intro card.

**Voiceover:**
> "It's 20:12 on premiere night. The transcode queue just hit seven times baseline — and the delivery deadline is 21:00."

### [0:15–0:30] Meet CineOps (15s)

**Screen:** Cut to the incident room (`localhost:8080`). Hold on the header two beats — `LIVE SERVICE` chip visible. Scroll once, slowly, top to bottom.

**Voiceover:**
> "CineOps Agent investigates media-pipeline incidents the way a seasoned on-call engineer would — except it takes thirty seconds. It's an agentic incident room built on Gemini and Grafana MCP, running on Google Cloud."

### [0:30–1:00] The investigation, live (30s)

**Screen:** The default operator question is already in the box. Press **Run investigation**. Stay on the **AGENT TRACE** timeline while it fills: phase → thought → tool calls with arguments → evidence cards appearing on the right. Do not cut away early — the stream *is* the demo.

**Voiceover:**
> "I ask a plain question. Gemini plans the investigation and chooses its own queries — Prometheus metrics, Loki logs, dashboard search. The trace streams in live: every tool call, every observation, nothing hidden. And the evidence is grounded — the model can only cite signal IDs the tools actually returned, and every metric value comes from the telemetry, never from the model."

### [1:00–1:15] The verdict (15s)

**Screen:** Hold on the result panel: `ROOT CAUSE IDENTIFIED`, confidence, root cause, the decision, the ordered actions, and the **WHY THIS VERDICT** block.

**Voiceover:**
> "The verdict arrives with a root cause, a calibrated confidence, and a concrete recovery decision — plus the reasoning, so I can check its work, not just trust it."

### [1:15–1:35] Interrogate the result (20s)

**Screen:** In the follow-up box, type: "What happens if we skip quality control?" — answer arrives with citation chips; hover one chip so the query tooltip shows. Then type: "Who directed this episode?" — the answer comes back with the **NOT SUPPORTED BY THE EVIDENCE** marker.

**Voiceover:**
> "I can interrogate the result. Follow-up answers cite the exact evidence they rest on — and when the context can't support an answer, CineOps says so instead of inventing one."

### [1:35–2:00] Human-approved recovery (25s)

**Screen:** Click **Approve & execute**. Split-screen or quick cuts between the incident room (pipeline stages flipping back to healthy, status line counting down healing stages, ending on `PIPELINE RECOVERED`) and Grafana (queue depth draining). This is the money shot — give it room.

**Voiceover:**
> "The agent proposes — the human decides. One approval, bound to this investigation, executes the plan against the live pipeline. Watch the queue drain and every stage come back — in the UI and in Grafana, in real time. Recovery is the ending on purpose: agents recommend, operators approve."

### [2:00–2:25] Under the hood (25s)

**Screen:** README architecture diagram (2s) → code cuts, ~4s each: `TOOL_DECLARATIONS` + the function-calling loop in `server/gemini-agent.mjs`; the read-only allowlist in `server/grafana-mcp.mjs`; grounding in `assembleResult`; `infra/docker-compose.yml` one command. End 3s on the **Agent Self-Health** dashboard in Grafana.

**Voiceover:**
> "Under the hood: a dependency-free Node service — a multi-turn Gemini loop, a read-only Grafana MCP client with a hard three-tool allowlist, and anti-hallucination assembly. One command brings up the whole living stack — Prometheus, Loki, Grafana, and an incident simulator with a full recovery arc. And the agent monitors itself in the same Grafana."

### [2:25–2:45] Proof, not promises (20s)

**Screen:** Terminal: run `npm test` (tail of green output), then `npm run eval` (results table). Cut to the README: badges + the integration table; flash `docs/JUDGE_GUIDE.md`.

**Voiceover:**
> "Everything you just saw is tested. Sixty-six tests and an outcome-based eval suite run on every push. The judge guide verifies every claim in three minutes — every integration is called in code, not named in a README. And when an engine fails, the demo degrades honestly. Replay is always labeled."

### [2:45–3:00] Close (15s)

**Screen:** Incident room hero ("Find failure. Save the premiere."), then a plain end card: repo URL + live demo URL.

**Voiceover:**
> "CineOps finds the failure — and saves the premiere. Try the live demo, read the code, verify every claim. Thank you."

---

## YouTube description template

```
CineOps Agent — agentic incident investigation for media pipelines.
Built for the Grafana track of Agentic Cinema: The Blockbuster Hackathon
(Google Cloud × Devpost).

In three minutes: a live Gemini investigation over Grafana observability
data, grounded follow-up Q&A, and a human-approved recovery executed on a
running pipeline.

Live demo: https://wenn-id.github.io/cineops-agent/
Source code: https://github.com/wenn-id/cineops-agent
Judge guide (verify every claim in 3 minutes): docs/JUDGE_GUIDE.md
```

## Edit notes

- Total voiceover ≈ 270 words ≈ 105 seconds of speech — comfortable under 3:00 with breathing room for the recovery sequence to play silently.
- If a Gemini call fails mid-take, keep recording: the honest fallback status is *on-brand* — but prefer a clean take for the submission cut.
- Subtitles: record voiceover in English; also upload the .srt (YouTube auto-captions need correcting for terms like "CineOps", "Loki", "PromQL").
- Do not speed up the recovery sequence — judges should see it heal at natural pace.
