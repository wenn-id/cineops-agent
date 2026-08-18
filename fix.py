import re
import os

cwd = '/home/acer/cineops-agent'
def read_file(name):
    with open(os.path.join(cwd, name), 'r') as f:
        return f.read()

def write_file(name, content):
    with open(os.path.join(cwd, name), 'w') as f:
        f.write(content)

# 1. core.mjs
core = read_file('src/core.mjs')
core = core.replace(
"""function validateIncident(incident) {
  if (!incident || typeof incident !== 'object') throw new TypeError('incident is required');
  requireText(incident.title, 'incident title');
  if (!Array.isArray(incident.stages) || incident.stages.length === 0) {
    throw new TypeError('incident stages are required');
  }
  if (!Array.isArray(incident.signals) || incident.signals.length === 0) {
    throw new TypeError('incident signals are required');
  }
  for (const stage of incident.stages) {
    requireText(stage.id, 'stage id');
    if (!VALID_STAGE_STATUSES.has(stage.status)) throw new TypeError(`invalid stage status: ${stage.status}`);
  }
}""",
"""function validateIncident(incident) {
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
}"""
)

core = core.replace(
"""export function summarizePipeline(stages) {
  const summary = { healthy: 0, degraded: 0, failed: 0, waiting: 0, total: 0 };
  for (const stage of stages) {
    if (!VALID_STAGE_STATUSES.has(stage.status)) continue;
    summary[stage.status] += 1;
    summary.total += 1;
  }
  return summary;
}""",
"""export function summarizePipeline(stages) {
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
}"""
)

core = core.replace(
"""  const evidence = [...incident.signals].sort((a, b) => b.score - a.score).slice(0, 3);
  const failedStage = incident.stages.find((stage) => stage.status === 'failed');
  const confidence = Math.min(0.99, Number((evidence.reduce((sum, item) => sum + item.score, 0) / 300).toFixed(2)));

  return {
    incidentId: incident.id,
    query,
    status: failedStage ? 'root_cause_identified' : 'monitoring',
    severity: failedStage ? 'critical' : 'warning',
    confidence,
    rootCause: {
      stage: failedStage?.id ?? evidence[0].stage,
      finding: 'GPU worker pool saturation caused the transcode queue to spike and encoder jobs to time out.',
    },
    evidence,
    pipeline: summarizePipeline(incident.stages),
    toolCalls: incident.toolCalls.map((call) => ({ ...call, server: 'grafana', readOnly: true })),
    decision: 'Premiere is at risk. Pause non-premiere 4K jobs and drain the priority queue before 20:32 UTC.',
    actions: [
      'Pause non-premiere 4K HEVC jobs.',
      'Route priority transcodes to the recovery pool.',
      'Resume quality control when queue depth falls below 40 jobs.',
    ],
  };""",
"""  const evidence = [...incident.signals].sort((a, b) => b.score - a.score).slice(0, 3);
  const failedStage = incident.stages.find((stage) => stage.status === 'failed');
  
  const MAX_EVIDENCE_SCORE = 100;
  const totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
  const confidence = evidence.length
    ? Math.min(0.99, Number((totalScore / (evidence.length * MAX_EVIDENCE_SCORE)).toFixed(2)))
    : 0;

  const topSignal = evidence[0] || { stage: 'unknown', finding: 'Unknown finding' };
  const targetStage = failedStage?.id ?? topSignal.stage;

  const playbooks = {
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
  };

  const playbook = playbooks[targetStage] ?? {
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
  };"""
)
write_file('src/core.mjs', core)

# 2. app.mjs
app = read_file('app.mjs')
app = app.replace('data-status="${stage.status}"', 'data-status="${escapeHtml(stage.status)}"')
app = app.replace('<code title="${escapeHtml(item.query)}">${escapeHtml(item.query)}</code>', '<code>${escapeHtml(item.query)}</code>')

app = app.replace(
"""async function runInvestigation(event) {
  event.preventDefault();
  const query = $('#operator-query').value.trim();
  if (!query) {
    $('#operator-query').focus();
    return;
  }

  const button = $('#run-button');
  const progress = $('#agent-progress');
  const label = $('#progress-label');
  button.disabled = true;
  $('#agent-result').hidden = true;
  $('#evidence-results').hidden = true;
  $('#evidence-empty').hidden = false;
  progress.hidden = false;

  for (const step of [
    'Loading replayed Grafana capture…',
    'Replaying pipeline metrics…',
    'Replaying encoder log correlation…',
    'Ranking recovery options…'
  ]) {
    label.textContent = step;
    await wait(330);
  }

  const result = investigateIncident(scenario, query);
  progress.hidden = true;
  renderResult(result);
  button.disabled = false;
  button.textContent = 'Run again ↗';
}""",
"""async function runInvestigation(event) {
  event.preventDefault();
  const query = $('#operator-query').value.trim();
  if (!query) {
    $('#operator-query').focus();
    return;
  }

  const button = $('#run-button');
  const progress = $('#agent-progress');
  const label = $('#progress-label');
  button.disabled = true;
  $('#agent-result').hidden = true;
  $('#evidence-results').hidden = true;
  $('#evidence-empty').hidden = false;
  progress.hidden = false;

  try {
    for (const step of [
      'Loading replayed Grafana capture…',
      'Replaying pipeline metrics…',
      'Replaying encoder log correlation…',
      'Ranking recovery options…'
    ]) {
      label.textContent = step;
      await wait(330);
    }
    const result = investigateIncident(scenario, query);
    progress.hidden = true;
    renderResult(result);
  } catch (error) {
    label.textContent = `Investigation failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Run again ↗';
  }
}"""
)

app = app.replace(
"""function startCountdown() {
  let seconds = 48 * 60;
  window.setInterval(() => {
    seconds = Math.max(0, seconds - 1);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const remainingSeconds = String(seconds % 60).padStart(2, '0');
    $('#countdown').textContent = `${hours}:${minutes}:${remainingSeconds}`;
  }, 1000);
}""",
"""function parseTime(timeStr) {
  const [hh, mm] = timeStr.split(' ')[0].split(':').map(Number);
  return (hh * 3600 + mm * 60);
}

function startCountdown() {
  const startSec = parseTime(scenario.startedAt);
  const endSec = parseTime(scenario.deadline);
  let seconds = endSec - startSec;
  if (seconds < 0) seconds += 24 * 3600;
  const interval = window.setInterval(() => {
    seconds = Math.max(0, seconds - 1);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const remainingSeconds = String(seconds % 60).padStart(2, '0');
    $('#countdown').textContent = `${hours}:${minutes}:${remainingSeconds}`;
    if (seconds <= 0) clearInterval(interval);
  }, 1000);
}"""
)
write_file('app.mjs', app)

# 3. index.html
html = read_file('index.html')
html = html.replace('<textarea id="operator-query" rows="3" maxlength="220">Can we still make the 21:00 premiere? Find the root cause and safest recovery path.</textarea>',
'<select id="operator-query" class="operator-query" style="width:100%; background:transparent; color:var(--paper); border:none; outline:none; padding:14px 18px; font: 400 clamp(1.05rem, 1.6vw, 1.4rem)/1.45 Georgia, serif;"><option>Can we still make the 21:00 premiere? Find the root cause and safest recovery path.</option></select>')
html = html.replace('<strong id="confidence">96% confidence</strong>', '<strong id="confidence"></strong>')
html = html.replace('<a class="brand" href="#">', '<a class="brand" href="/">')
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'">')
write_file('index.html', html)

# 4. styles.css
css = read_file('styles.css')
css = css.replace('font-family: Inter, system-ui, sans-serif;', 'font-family: system-ui, sans-serif;')
css = css.replace('.eyebrow { font-size: 9px; }', '.eyebrow { font-size: 10px; }')
css = css.replace('.stage p { font-size: 9px; }', '.stage p { font-size: 10px; }')
css = css.replace('.hero-copy dt { font-size: 8px; }', '.hero-copy dt { font-size: 10px; }')
write_file('styles.css', css)

# 5. .agents/mcp_config.json
mcp = read_file('.agents/mcp_config.json')
mcp = mcp.replace('https://breezycurlew2764.grafana.net', '${GRAFANA_URL}')
write_file('.agents/mcp_config.json', mcp)

# 6. package.json
pkg = read_file('package.json')
pkg = re.sub(r'\s*"build": "node scripts/build.mjs",\n', '\n', pkg)
write_file('package.json', pkg)

