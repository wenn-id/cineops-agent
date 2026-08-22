import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { investigateIncident } from '../src/core.mjs';
import { buildReportMarkdown } from '../src/report.mjs';

const result = investigateIncident(scenarios['premiere-night'], 'Can we still make the premiere?');

test('report: faithfully reproduces the investigation', () => {
  const markdown = buildReportMarkdown(result, {
    trace: [{ time: '+0.2s', kind: 'tool', text: 'query_prometheus (stage=transcode)' }],
    mode: 'replay',
    generatedAt: '2026-08-22T20:30:00.000Z',
  });

  assert.match(markdown, /^# CineOps investigation report — INC-042/);
  assert.match(markdown, /Generated.*2026-08-22T20:30:00\.000Z.*replay mode/);
  assert.match(markdown, /\*\*Operator query:\*\* Can we still make the premiere\?/);
  assert.match(markdown, /\*\*Verdict:\*\* root_cause_identified · severity \*\*critical\*\*/);
  assert.match(markdown, /## Root cause/);
  assert.match(markdown, /\*\*transcode\*\* — Queue is 7\.8× baseline/);
  assert.match(markdown, /## Recovery decision/);
  assert.match(markdown, /Pause non-premiere 4K jobs/);
  assert.match(markdown, /## Evidence/);
  assert.match(markdown, /Transcode queue depth \| transcode \| Prometheus \| 186 jobs/);
  assert.match(markdown, /max\(cineops_transcode_queue_depth\)/);
  assert.match(markdown, /## Tool trace/);
  assert.match(markdown, /`query_prometheus` — Rank queue.*\*\(replay\)\*/);
  assert.match(markdown, /## Agent timeline/);
  assert.match(markdown, /`\+0\.2s` \*\*tool\*\* query_prometheus/);
  assert.match(markdown, /Pipeline at investigation time: 3 healthy · 1 degraded · 1 failed · 1 waiting/);
});

test('report: live evidence links survive into the markdown table', () => {
  const withUrl = {
    ...result,
    evidence: result.evidence.map((item, index) => (index === 0 ? { ...item, url: 'https://grafana.example/d/transcode' } : item)),
  };
  const markdown = buildReportMarkdown(withUrl, { mode: 'live' });
  assert.match(markdown, /\[max\(cineops_transcode_queue_depth\)\]\(https:\/\/grafana\.example\/d\/transcode\)/);
  assert.match(markdown, /live mode/);
});

test('report: minimal results do not crash the builder', () => {
  const markdown = buildReportMarkdown({ incidentId: 'INC-X', query: 'q' }, {});
  assert.match(markdown, /INC-X/);
  assert.match(markdown, /\*\*Verdict:\*\* unknown · severity \*\*unknown\*\* · confidence \*\*0%\*\*/);
});

test('report: Loki queries with pipes do not break the evidence table', () => {
  const withLoki = {
    ...result,
    evidence: [{ id: 'error-rate', stage: 'transcode', source: 'Loki', label: 'Encoder timeout rate', value: 37.4, unit: '%', query: '{service="transcoder"} |= "deadline exceeded"' }],
  };
  const markdown = buildReportMarkdown(withLoki, {});
  const tableRow = markdown.split('\n').find((line) => line.includes('Encoder timeout rate'));
  assert.ok(tableRow, 'evidence row exists');
  const cells = tableRow.split(/(?<!\\)\|/).filter((cell) => cell.trim() !== '');
  assert.equal(cells.length, 6, 'the row must keep exactly six columns');
  assert.match(tableRow, /\\\|=.*deadline exceeded/);
});
