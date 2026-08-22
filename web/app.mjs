import { investigateIncident } from '../src/core.mjs';
import { scenarios } from '../src/scenarios.mjs';

const scenario = scenarios['premiere-night'];
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

let liveMode = false;
let liveEngine = 'deterministic';
let lastResult = null;
let followupGeneration = 0;
const followupHistory = [];

function setModeIndicator(text) {
  $('#system-state').innerHTML = `<i></i> ${escapeHtml(text ?? (liveMode ? 'LIVE SERVICE' : 'LOCAL REPLAY'))}`;
  $('#engine-chip').textContent = liveMode
    ? (liveEngine === 'gemini' ? 'SERVER AGENT · GEMINI' : 'SERVER AGENT · DETERMINISTIC CORE')
    : 'LOCAL MVP · GEMINI ADAPTER NEXT';
}

async function detectLiveMode() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) return;
    const health = await response.json();
    if (health?.ok) {
      liveMode = true;
      liveEngine = health.engine === 'gemini' ? 'gemini' : 'deterministic';
      setModeIndicator();
    }
  } catch {
    // Static hosting (e.g. GitHub Pages) — stay in local replay mode.
  }
}

function renderPipeline() {
  $('#pipeline-stages').innerHTML = scenario.stages.map((stage, index) => `
    <li class="stage" data-status="${escapeHtml(stage.status)}">
      <span class="stage-number">${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeHtml(stage.label)}</h3>
      <p>${escapeHtml(stage.detail)}</p>
      <span class="stage-status">${escapeHtml(stage.status)}</span>
    </li>
  `).join('');
}

function evidenceCard(item) {
  const query = `<code>${escapeHtml(item.query)}</code>`;
  const linkedQuery = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" title="Open in Grafana">${query}</a>`
    : query;
  return `
    <article class="evidence-card"${item.liveValue ? ' data-live-value="true"' : ''}>
      <header><span>${escapeHtml(item.source)} · ${escapeHtml(item.stage)}</span><strong>${escapeHtml(item.value)}${item.unit === '%' ? '%' : ` ${escapeHtml(item.unit)}`}</strong></header>
      <h3>${escapeHtml(item.label)}</h3>
      <p>${escapeHtml(item.finding)}</p>
      ${linkedQuery}
    </article>
  `;
}

function appendToolCall(call) {
  const index = $('#tool-calls').children.length + 1;
  const item = document.createElement('li');
  item.innerHTML = `<span>${String(index).padStart(2, '0')}</span><span>${escapeHtml(call.tool)}</span><em>${call.readOnly === false ? 'WRITE' : 'READ'}</em>`;
  $('#tool-calls').appendChild(item);
}

function showEvidencePanel() {
  $('#evidence-empty').hidden = true;
  $('#evidence-results').hidden = false;
}

function renderEvidence(result) {
  showEvidencePanel();
  $('#evidence-list').innerHTML = result.evidence.map(evidenceCard).join('');
  result.toolCalls.forEach(appendToolCall);
}

function renderResult(result, { skipEvidence = false } = {}) {
  lastResult = result;
  followupGeneration += 1;
  followupHistory.length = 0;
  $('#followup-thread').innerHTML = '';
  $('#followup').hidden = !liveMode;
  $('#result-status').textContent = result.status === 'root_cause_identified' ? 'ROOT CAUSE IDENTIFIED' : 'MONITORING';
  $('#confidence').textContent = `${Math.round(result.confidence * 100)}% confidence`;
  $('#root-cause').textContent = result.rootCause.finding;
  $('#decision').textContent = result.decision;
  const reasoning = typeof result.reasoning === 'string' && result.reasoning.trim() ? result.reasoning.trim() : '';
  $('#result-reasoning').hidden = !reasoning;
  $('#reasoning-text').textContent = reasoning;
  $('#actions').innerHTML = result.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join('');
  $('#agent-result').hidden = false;
  if (!skipEvidence) renderEvidence(result);
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

let traceStart = 0;

function addTrace(kind, text) {
  const elapsed = traceStart ? `+${((performance.now() - traceStart) / 1000).toFixed(1)}s` : '';
  const item = document.createElement('li');
  item.dataset.kind = kind;
  item.innerHTML = `<time>${escapeHtml(elapsed)}</time><em>${escapeHtml(kind)}</em><span>${escapeHtml(text)}</span>`;
  $('#trace-list').appendChild(item);
  $('#agent-trace').hidden = false;
}

function resetTrace() {
  $('#trace-list').innerHTML = '';
  $('#agent-trace').hidden = false;
  traceStart = performance.now();
}

async function runReplay(query, label) {
  // A failed live stream may have left partial tool calls and evidence behind.
  $('#evidence-list').innerHTML = '';
  $('#tool-calls').innerHTML = '';
  for (const step of [
    'Loading replayed Grafana capture…',
    'Replaying pipeline metrics…',
    'Replaying encoder log correlation…',
    'Ranking recovery options…'
  ]) {
    label.textContent = step;
    addTrace('replay', step);
    await wait(330);
  }
  renderResult(investigateIncident(scenario, query));
}

function dispatchStreamEvent(name, data, state) {
  if (name === 'status') {
    if (data.phase === 'fallback' && data.engine) {
      liveEngine = data.engine === 'gemini' ? 'gemini' : 'deterministic';
      setModeIndicator('DETERMINISTIC FALLBACK');
    }
    addTrace('phase', data.label);
    $('#progress-label').textContent = data.label;
    return;
  }
  if (name === 'thought') {
    addTrace('thought', data.text);
    return;
  }
  if (name === 'reset') {
    $('#evidence-list').innerHTML = '';
    $('#tool-calls').innerHTML = '';
    $('#trace-list').innerHTML = '';
    $('#evidence-results').hidden = true;
    $('#evidence-empty').hidden = false;
    return;
  }
  if (name === 'tool_call') {
    showEvidencePanel();
    if (data.replay === false) $('#tool-trace-label').textContent = 'MCP TOOL TRACE · LIVE';
    const args = Object.entries(data.args ?? {}).map(([key, value]) => `${key}=${value}`).join(' ');
    addTrace('tool', `${data.tool}${args ? ` (${args})` : ''}`);
    appendToolCall(data);
    return;
  }
  if (name === 'observation') {
    showEvidencePanel();
    $('#evidence-list').insertAdjacentHTML('beforeend', evidenceCard(data));
    return;
  }
  if (name === 'result') {
    state.result = data;
  }
}

async function streamInvestigation(query) {
  const response = await fetch('/api/investigate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'premiere-night', query }),
  });
  if (!response.ok || !response.body) throw new Error(`service unavailable (${response.status})`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { result: null };
  let buffer = '';

  const dispatchBlock = (block) => {
    let name = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) dispatchStreamEvent(name, JSON.parse(dataLines.join('\n')), state);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      dispatchBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) dispatchBlock(buffer);

  if (!state.result) throw new Error('stream ended without a result');
  renderResult(state.result, { skipEvidence: true });
}

async function runInvestigation(event) {
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
  $('#evidence-list').innerHTML = '';
  $('#tool-calls').innerHTML = '';
  $('#evidence-empty').hidden = false;
  progress.hidden = false;
  label.textContent = 'Connecting…';
  resetTrace();
  await liveModeReady;

  try {
    if (liveMode) await streamInvestigation(query);
    else await runReplay(query, label);
    progress.hidden = true;
  } catch (error) {
    if (liveMode) {
      liveMode = false;
      setModeIndicator('REPLAY FALLBACK');
      try {
        await runReplay(query, label);
        progress.hidden = true;
        return;
      } catch (replayError) {
        label.textContent = `Investigation failed: ${replayError.message}`;
        return;
      }
    }
    label.textContent = `Investigation failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Run again ↗';
  }
}

const evidenceById = () => new Map((lastResult?.evidence ?? []).map((item) => [item.id, item]));

function appendFollowUp(role, text, citations = [], supported = true) {
  const item = document.createElement('li');
  item.dataset.role = role;
  const chips = role === 'cineops' && citations.length
    ? `<span class="followup-citations">${citations.map((id) => {
        const evidence = evidenceById().get(id);
        return `<em title="${escapeHtml(evidence?.query ?? id)}">${escapeHtml(evidence?.label ?? id)}</em>`;
      }).join('')}</span>`
    : '';
  const unsupportedNote = role === 'cineops' && !supported ? '<span class="followup-unsupported">NOT SUPPORTED BY THE EVIDENCE</span>' : '';
  item.innerHTML = `<p>${escapeHtml(text)}</p>${chips}${unsupportedNote}`;
  $('#followup-thread').appendChild(item);
}

async function runFollowUp(event) {
  event.preventDefault();
  const input = $('#followup-input');
  const question = input.value.trim();
  if (!question || !lastResult) return;
  const generation = followupGeneration;
  const context = {
    incidentId: lastResult.incidentId,
    rootCause: lastResult.rootCause,
    decision: lastResult.decision,
    actions: lastResult.actions,
    pipeline: lastResult.pipeline,
    reasoning: lastResult.reasoning,
    evidence: lastResult.evidence,
  };
  appendFollowUp('operator', question);
  input.value = '';
  addTrace('followup', question);

  const button = $('#followup-button');
  button.disabled = true;
  try {
    const response = await fetch('/api/followup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, scenarioId: 'premiere-night', context, history: followupHistory.slice(-6) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error ?? `service unavailable (${response.status})`);
    // A new investigation may have started while the answer was in flight.
    if (generation !== followupGeneration) return;
    appendFollowUp('cineops', payload.answer, payload.citations, payload.supported);
    followupHistory.push({ role: 'operator', text: question }, { role: 'cineops', text: payload.answer });
  } catch (error) {
    if (generation === followupGeneration) appendFollowUp('error', error.message);
  } finally {
    button.disabled = false;
    input.focus();
  }
}

function startCountdown() {
  // Synthetic replay clock: starts from the scenario's window on each load by design.
  let seconds = scenario.replayWindowSec;
  const interval = window.setInterval(() => {
    seconds = Math.max(0, seconds - 1);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const remainingSeconds = String(seconds % 60).padStart(2, '0');
    $('#countdown').textContent = `${hours}:${minutes}:${remainingSeconds}`;
    if (seconds <= 0) clearInterval(interval);
  }, 1000);
}

const liveModeReady = detectLiveMode();

renderPipeline();
setModeIndicator();
startCountdown();
$('#investigation-form').addEventListener('submit', runInvestigation);
$('#followup-form').addEventListener('submit', runFollowUp);
if (new URLSearchParams(window.location.search).has('autorun')) {
  $('#investigation-form').requestSubmit();
}
