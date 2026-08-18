const VALID_STAGE_STATUSES = new Set(['healthy', 'degraded', 'failed', 'waiting']);

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
}

function validateIncident(incident) {
  if (!incident || typeof incident !== 'object') throw new TypeError('incident is required');
  requireText(incident.title, 'incident title');
  if (!Array.isArray(incident.stages) || incident.stages.length === 0) {
    throw new TypeError('incident stages are required');
  }
  if (!Array.isArray(incident.signals) || incident.signals.length === 0) {
    throw new TypeError('incident signals are required');
  }
  if (!Array.isArray(incident.toolCalls)) {
    throw new TypeError('incident toolCalls are required');
  }
  for (const stage of incident.stages) {
    requireText(stage.id, 'stage id');
    requireText(stage.label, 'stage label');
    requireText(stage.detail, 'stage detail');
    if (!VALID_STAGE_STATUSES.has(stage.status)) throw new TypeError(`invalid stage status: ${stage.status}`);
  }
}

export function summarizePipeline(stages) {
  const summary = { healthy: 0, degraded: 0, failed: 0, waiting: 0, unknown: 0, total: 0 };
  for (const stage of stages) {
    if (VALID_STAGE_STATUSES.has(stage.status)) {
      summary[stage.status] += 1;
    } else {
      summary.unknown += 1;
    }
    summary.total += 1;
  }
  return summary;
}

const PLAYBOOK = {
  transcode: {
    decision: 'Premiere is at risk. Pause non-premiere 4K jobs and drain the priority queue before 20:32 UTC.',
    actions: [
      'Pause non-premiere 4K HEVC jobs.',
      'Route priority transcodes to the recovery pool.',
      'Resume quality control when queue depth falls below 40 jobs.',
    ]
  },
  subtitles: {
    decision: 'Subtitle delivery is falling behind. Scale up subtitle workers to meet deadline.',
    actions: [
      'Scale up subtitle worker pods.',
      'Monitor lag until it recovers to baseline.'
    ]
  },
  default: {
    decision: 'An issue was detected requiring manual operator review.',
    actions: [
      'Acknowledge incident.',
      'Investigate relevant stage logs and metrics.',
      'Escalate if resolution path is unclear.'
    ]
  }
};

export function investigateIncident(incident, query = 'What is blocking this production pipeline?') {
  validateIncident(incident);
  requireText(query, 'operator query');

  const evidence = [...incident.signals].sort((a, b) => b.score - a.score).slice(0, 3);
  const failedStage = incident.stages.find((stage) => stage.status === 'failed');
  
  const MAX_EVIDENCE_SCORE = 100;
  const confidence = evidence.length
    ? Math.min(0.99, Number((evidence.reduce((sum, item) => sum + item.score, 0) / (evidence.length * MAX_EVIDENCE_SCORE)).toFixed(2)))
    : 0;
    
  const rootStageId = failedStage?.id ?? evidence[0]?.stage;
  const playbookEntry = PLAYBOOK[rootStageId] || PLAYBOOK.default;
  const finding = evidence[0]?.finding || 'No primary signal finding available.';

  return {
    incidentId: incident.id,
    query,
    status: failedStage ? 'root_cause_identified' : 'monitoring',
    severity: failedStage ? 'critical' : 'warning',
    confidence,
    rootCause: {
      stage: rootStageId,
      finding: finding,
    },
    evidence,
    pipeline: summarizePipeline(incident.stages),
    toolCalls: incident.toolCalls.map((call) => ({ ...call, server: 'grafana', readOnly: true })),
    decision: playbookEntry.decision,
    actions: playbookEntry.actions,
  };
}
