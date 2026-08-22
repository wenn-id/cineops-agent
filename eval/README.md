# eval/

Scenario-based evaluation for the investigation agent. Unlike the unit tests,
these cases evaluate **outcomes**: does the pipeline identify the right root
cause, cite only tool-grounded evidence, bound runaway loops, survive model
outages, and stay inside its latency budget?

```bash
npm run eval
```

- Cases live in [`cases.mjs`](cases.mjs) as data: scripted model behavior
  (turn sequences, constant replies, throwing models) plus deterministic-engine
  cases and scenario variants.
- [`run.mjs`](run.mjs) executes each case through the real
  `investigateStream` pipeline, checks the expectations, prints a results
  table, and exits non-zero on any accuracy or latency failure — CI gates on
  it (`npm run eval` runs on every push).
- With `GEMINI_API_KEY` set, an extra `live-gemini` case runs the real model
  against the fixture-backed tools (verdict correctness, grounding, 20s
  latency budget). Without a key it is skipped with a notice.

Current status: 6/6 scripted and deterministic cases pass; budgets hold with
two orders of magnitude of headroom on CI runners.
