export const scenarios = {
  'premiere-night': {
    id: 'INC-042',
    title: 'Premiere delivery blocked',
    production: 'Neon Harbor — Episode 06',
    startedAt: '20:12 UTC',
    replayAt: '20:24 UTC',
    deadline: '21:00 UTC',
    replayWindowSec: 36 * 60,
    stages: [
      { id: 'upload', label: 'Upload', status: 'healthy', detail: 'Master received · 412\u00a0GB' },
      { id: 'ingest', label: 'Ingest', status: 'healthy', detail: 'Checksums verified' },
      { id: 'transcode', label: 'Transcode', status: 'failed', detail: 'H.265 jobs timing out' },
      { id: 'subtitles', label: 'Subtitles', status: 'degraded', detail: '2.4 min behind video' },
      { id: 'quality-control', label: 'Quality control', status: 'waiting', detail: 'Blocked by transcode' },
      { id: 'publish', label: 'Publish', status: 'healthy', detail: 'Release window reserved' },
    ],
    signals: [
      {
        id: 'queue-depth',
        stage: 'transcode',
        source: 'Prometheus',
        label: 'Transcode queue depth',
        value: 186,
        unit: 'jobs',
        baseline: 24,
        score: 100,
        finding: 'Queue is 7.8× baseline and still rising.',
        query: 'max(cineops_transcode_queue_depth)',
      },
      {
        id: 'gpu-utilization',
        stage: 'transcode',
        source: 'Prometheus',
        label: 'GPU worker utilization',
        value: 99.1,
        unit: '%',
        baseline: 72,
        score: 96,
        finding: 'Every GPU worker is saturated; no spare capacity remains.',
        query: 'avg(cineops_gpu_utilization_percent)',
      },
      {
        id: 'error-rate',
        stage: 'transcode',
        source: 'Loki',
        label: 'Encoder timeout rate',
        value: 37.4,
        unit: '%',
        baseline: 1.2,
        score: 92,
        finding: 'Timeout burst began after the 4K HEVC job batch entered the queue.',
        query: '{service="transcoder"} |= "deadline exceeded"',
      },
      {
        id: 'subtitle-lag',
        stage: 'subtitles',
        source: 'Prometheus',
        label: 'Subtitle processing lag',
        value: 2.4,
        unit: 'min',
        baseline: 1,
        score: 38,
        finding: 'Subtitle lag is secondary and does not block recovery.',
        query: 'max(cineops_subtitle_lag_minutes)',
      },
    ],
    toolCalls: [
      { tool: 'query_prometheus', purpose: 'Rank queue, GPU, and lag anomalies' },
      { tool: 'query_loki_logs', purpose: 'Correlate encoder timeout burst' },
      { tool: 'search_dashboards', purpose: 'Locate production runbook context' },
    ],
    playbooks: {
      transcode: {
        decision: 'Premiere is at risk. Pause non-premiere 4K jobs and drain the priority queue before 20:32 UTC.',
        actions: [
          'Pause non-premiere 4K HEVC jobs.',
          'Route priority transcodes to the recovery pool.',
          'Resume quality control when queue depth falls below 40 jobs.',
        ]
      },
      subtitles: {
        decision: 'Subtitle delay detected. Escalate rendering and notify ingest team.',
        actions: [
          'Scale subtitle worker nodes.',
          'Restart hanging subtitle pods.'
        ]
      }
    },
  },
};
