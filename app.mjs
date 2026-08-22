import { investigateIncident } from './src/core.mjs';
import { scenarios } from './src/scenarios.mjs';

const scenario = scenarios['premiere-night'];
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

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

function renderEvidence(result) {
  $('#evidence-empty').hidden = true;
  $('#evidence-results').hidden = false;
  $('#evidence-list').innerHTML = result.evidence.map((item) => `
    <article class="evidence-card">
      <header><span>${escapeHtml(item.source)} · ${escapeHtml(item.stage)}</span><strong>${escapeHtml(item.value)}${item.unit === '%' ? '%' : ` ${escapeHtml(item.unit)}`}</strong></header>
      <h3>${escapeHtml(item.label)}</h3>
      <p>${escapeHtml(item.finding)}</p>
      <code>${escapeHtml(item.query)}</code>
    </article>
  `).join('');
  $('#tool-calls').innerHTML = result.toolCalls.map((call, index) => `
    <li><span>${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(call.tool)}</span><em>READ</em></li>
  `).join('');
}

function renderResult(result) {
  $('#confidence').textContent = `${Math.round(result.confidence * 100)}% confidence`;
  $('#root-cause').textContent = result.rootCause.finding;
  $('#decision').textContent = result.decision;
  $('#actions').innerHTML = result.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join('');
  $('#agent-result').hidden = false;
  renderEvidence(result);
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

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

renderPipeline();
startCountdown();
$('#investigation-form').addEventListener('submit', runInvestigation);
if (new URLSearchParams(window.location.search).has('autorun')) {
  $('#investigation-form').requestSubmit();
}
