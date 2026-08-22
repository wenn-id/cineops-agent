const VALID_STAGE_STATUSES = new Set(['healthy', 'degraded', 'failed', 'waiting']);

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
}

function requireNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
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
  for (const signal of incident.signals) {
    requireText(signal.id, 'signal id');
    requireText(signal.stage, 'signal stage');
    requireText(signal.source, 'signal source');
    requireText(signal.label, 'signal label');
    requireText(signal.finding, 'signal finding');
    requireText(signal.unit, 'signal unit');
    requireText(signal.query, 'signal query');
    requireNumber(signal.score, 'signal score');
    requireNumber(signal.value, 'signal value');
  }
  if (incident.playbooks !== undefined) {
    if (typeof incident.playbooks !== 'object' || incident.playbooks === null || Array.isArray(incident.playbooks)) {
      throw new TypeError('incident playbooks must be an object');
    }
    for (const [stage, playbook] of Object.entries(incident.playbooks)) {
      requireText(stage, 'playbook stage');
      if (!playbook || typeof playbook !== 'object') throw new TypeError(`playbook for ${stage} is required`);
      requireText(playbook.decision, `playbook decision for ${stage}`);
      if (!Array.isArray(playbook.actions) || playbook.actions.length === 0) {
        throw new TypeError(`playbook actions for ${stage} are required`);
      }
      for (const action of playbook.actions) requireText(action, `playbook action for ${stage}`);
    }
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

export function investigateIncident(incident, query = 'What is blocking this production pipeline?') {
  validateIncident(incident);
  requireText(query, 'operator query');

  const evidence = [...incident.signals].sort((a, b) => b.score - a.score).slice(0, 3);
  const failedStage = incident.stages.find((stage) => stage.status === 'failed');
  
  const MAX_EVIDENCE_SCORE = 100;
  const totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
  const confidence = evidence.length
    ? Math.min(0.99, Number((totalScore / (evidence.length * MAX_EVIDENCE_SCORE)).toFixed(2)))
    : 0;

  const topSignal = evidence[0] || { stage: 'unknown', finding: 'Unknown finding' };
  const targetStage = topSignal.stage;

  const playbook = incident.playbooks?.[targetStage] ?? {
    decision: 'Unknown failure detected. Escalate to human operator immediately.',
    actions: ['Escalate to human operator.']
  };

  return {
    incidentId: incident.id,
    query,
    status: failedStage ? 'root_cause_identified' : 'monitoring',
    severity: failedStage ? 'critical' : 'warning',
    confidence,
    rootCause: {
      stage: targetStage,
      finding: topSignal.finding,
    },
    evidence,
    pipeline: summarizePipeline(incident.stages),
    toolCalls: incident.toolCalls.map((call) => ({ ...call, server: 'grafana', readOnly: true })),
    decision: playbook.decision,
    actions: playbook.actions,
  };
}
