import { summarizePipeline } from '../src/core.mjs';
import { callGemini, DEFAULT_MODEL } from './gemini.mjs';
import { attachDashboardUrls, createLiveToolExecutor } from './grafana-live.mjs';

const MAX_TOOL_TURNS = 8;

const SYSTEM_INSTRUCTION = `You are CineOps, an incident investigator for media production pipelines.
You investigate incidents through read-only observability tools: Prometheus metrics, Loki logs, and Grafana dashboards.

Rules:
- ALWAYS gather evidence with the provided tools before drawing conclusions.
- Tool responses are the ground truth for this incident; never invent metrics or ids.
- Cite evidence only by the signal ids that tools actually returned.
- status must be "root_cause_identified" only when a failed stage has supporting evidence; otherwise use "monitoring".
- confidence is a 0-1 calibration of your certainty, not a score you maximize.
- decision: one clear sentence an operator can act on immediately.
- actions: short, concrete, ordered recovery steps.
- When you have enough evidence, respond with ONLY the JSON object matching the required schema.`;

// Tool names intentionally match the Grafana MCP tools so the live client (#30)
// can replace the fixture-backed executors behind the same declarations.
const TOOL_DECLARATIONS = [
  {
    name: 'query_prometheus',
    description: 'Query current Prometheus metric anomalies for pipeline stages. Returns metric signals with value, unit, baseline, finding, and PromQL query.',
    parameters: {
      type: 'OBJECT',
      properties: { stage: { type: 'STRING', description: 'Stage id to query; omit for all stages' } },
    },
  },
  {
    name: 'query_loki_logs',
    description: 'Query current Loki log-derived anomalies for pipeline stages. Returns log signals with their LogQL queries.',
    parameters: {
      type: 'OBJECT',
      properties: { stage: { type: 'STRING', description: 'Stage id to query; omit for all stages' } },
    },
  },
  {
    name: 'search_dashboards',
    description: 'Search Grafana dashboards by term for production context and runbook pointers.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'Search term' } },
      required: ['query'],
    },
  },
];

const RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['root_cause_identified', 'monitoring'] },
    severity: { type: 'STRING', enum: ['critical', 'warning'] },
    confidence: { type: 'NUMBER' },
    rootCause: {
      type: 'OBJECT',
      properties: { stage: { type: 'STRING' }, finding: { type: 'STRING' } },
      required: ['stage', 'finding'],
    },
    decision: { type: 'STRING' },
    actions: { type: 'ARRAY', items: { type: 'STRING' } },
    evidence: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          finding: { type: 'STRING', description: 'Why this signal matters for the root cause' },
        },
        required: ['id'],
      },
    },
    reasoning: { type: 'STRING', description: 'Two or three sentences on how the evidence leads to the verdict' },
  },
  required: ['status', 'severity', 'confidence', 'rootCause', 'decision', 'actions', 'evidence'],
};

export function executeTool(scenario, name, args = {}) {
  if (name === 'query_prometheus' || name === 'query_loki_logs') {
    const source = name === 'query_prometheus' ? 'Prometheus' : 'Loki';
    const signals = scenario.signals.filter(
      (signal) => signal.source === source && (!args.stage || signal.stage === args.stage),
    );
    return { stage: args.stage ?? 'all', signals };
  }
  if (name === 'search_dashboards') {
    const term = String(args.query ?? '').toLowerCase();
    const matches = scenario.signals.filter(
      (signal) => !term
        || signal.label.toLowerCase().includes(term)
        || signal.query.toLowerCase().includes(term)
        || signal.stage.toLowerCase().includes(term),
    );
    return { dashboards: matches.map((signal) => ({ title: `${signal.stage} — ${signal.label}`, query: signal.query })) };
  }
  return { error: `unknown tool: ${name}` };
}

function extractJson(text) {
  const withoutFences = text.replace(/```json\s*|```/g, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Gemini response contained no JSON object');
  return JSON.parse(withoutFences.slice(start, end + 1));
}

// The model may only cite evidence that the executed tools actually returned:
// fixture values override anything the model produced, so numbers can never be
// invented, and ids outside the tool-grounded set are rejected even when they
// exist in the scenario. Live MCP signals (when configured) overlay the fixture
// registry and keep their live values and provenance flags.
function assembleResult(scenario, query, parsed, executedToolCalls, liveRegistry = new Map(), liveDashboards = [], groundedIds = new Set()) {
  const fixtureById = new Map(scenario.signals.map((signal) => [signal.id, signal]));
  const signalsById = new Map([...fixtureById, ...liveRegistry]);
  const evidence = [];
  const seen = new Set();
  for (const item of Array.isArray(parsed.evidence) ? parsed.evidence : []) {
    const signal = signalsById.get(item?.id);
    if (!signal || seen.has(signal.id) || !groundedIds.has(signal.id)) continue;
    seen.add(signal.id);
    const finding = typeof item.finding === 'string' && item.finding.trim() ? item.finding : signal.finding;
    evidence.push({ ...signal, finding });
  }
  const numberOrZero = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(0.99, Math.max(0, value)) : 0);
  const declaredPurpose = new Map(scenario.toolCalls.map((call) => [call.tool, call.purpose]));
  const assembled = {
    engine: 'gemini',
    model: DEFAULT_MODEL,
    incidentId: scenario.id,
    query,
    status: parsed.status === 'root_cause_identified' ? 'root_cause_identified' : 'monitoring',
    severity: parsed.severity === 'critical' ? 'critical' : 'warning',
    confidence: numberOrZero(parsed.confidence),
    rootCause: {
      stage: typeof parsed.rootCause?.stage === 'string' ? parsed.rootCause.stage : 'unknown',
      finding: typeof parsed.rootCause?.finding === 'string' && parsed.rootCause.finding.trim()
        ? parsed.rootCause.finding
        : 'Unknown finding',
    },
    evidence,
    pipeline: summarizePipeline(scenario.stages),
    toolCalls: executedToolCalls.map(({ name, args, live }) => ({
      tool: name,
      purpose: declaredPurpose.get(name) ?? `Inspect ${args?.stage ?? 'pipeline'}`,
      server: 'grafana',
      readOnly: true,
      replay: !live,
    })),
    decision: typeof parsed.decision === 'string' && parsed.decision.trim() ? parsed.decision : 'Escalate to human operator.',
    actions: Array.isArray(parsed.actions) && parsed.actions.length
      ? parsed.actions.filter((action) => typeof action === 'string' && action.trim()).map(String)
      : ['Escalate to human operator.'],
    ...(typeof parsed.reasoning === 'string' && parsed.reasoning.trim() ? { reasoning: parsed.reasoning } : {}),
  };
  return { ...assembled, evidence: attachDashboardUrls(assembled.evidence, liveDashboards) };
}

// Trace narration is display-only: fenced/inline code spans are stripped
// (they usually quote tool payloads or the schema back), whitespace is
// collapsed, and the text is capped.
function sanitizeThought(text) {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return withoutCode.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Multi-turn investigation loop: Gemini selects tools, we execute them against
// the incident data, until the model returns a structured verdict. The callModel
// injection point keeps the loop fully testable without network access.
export async function* geminiInvestigation({ scenario, query, signal, model, callModel = callGemini, mcp, maxToolTurns = MAX_TOOL_TURNS }) {
  yield { event: 'status', data: { phase: 'planning', engine: 'gemini', label: `Gemini (${model ?? DEFAULT_MODEL}) planning investigation…` } };

  const stageSummary = scenario.stages.map((stage) => `${stage.id}=${stage.status}`).join(', ');
  const contents = [{
    role: 'user',
    parts: [{
      text: `Incident ${scenario.id}: ${scenario.title} (production: ${scenario.production}).\nPipeline stages: ${stageSummary}.\nOperator question: ${query}\nInvestigate with the available tools, then answer with the final JSON only.`,
    }],
  }];

  const executed = [];
  const groundedIds = new Set();
  const liveExecutor = mcp ? createLiveToolExecutor({ scenario, mcp }) : null;
  const liveRegistry = new Map();
  const liveDashboards = [];
  for (let turn = 0; turn < maxToolTurns; turn++) {
    const response = await callModel({
      model,
      systemInstruction: SYSTEM_INSTRUCTION,
      contents,
      tools: TOOL_DECLARATIONS,
      generationConfig: { responseMimeType: 'application/json', responseSchema: RESULT_SCHEMA, temperature: 0.2 },
      signal,
    });
    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);

    if (functionCalls.length) {
      // The model sometimes explains what it is about to query — surface that
      // thinking as trace events; it is the agent's voice during the loop.
      const thought = sanitizeThought(parts.map((part) => part.text ?? '').join(''));
      if (thought) {
        yield { event: 'thought', data: { text: thought } };
      }
      contents.push({ role: 'model', parts });
      // Parallel calls in one model turn must come back as a single content
      // holding every functionResponse, per the Gemini contract.
      const responses = [];
      for (const call of functionCalls) {
        let toolResult;
        if (liveExecutor) {
          toolResult = await liveExecutor(call.name, call.args);
          for (const signal of toolResult.signals ?? []) {
            liveRegistry.set(signal.id, signal);
            groundedIds.add(signal.id);
          }
          for (const dashboard of toolResult.dashboards ?? []) liveDashboards.push(dashboard);
        } else {
          toolResult = executeTool(scenario, call.name, call.args);
          for (const signal of toolResult.signals ?? []) groundedIds.add(signal.id);
        }
        executed.push({ name: call.name, args: call.args ?? {}, live: Boolean(liveExecutor) });
        yield {
          event: 'tool_call',
          data: { tool: call.name, args: call.args ?? {}, server: 'grafana', readOnly: true, replay: !liveExecutor },
        };
        responses.push({ functionResponse: { name: call.name, response: toolResult } });
      }
      contents.push({ role: 'user', parts: responses });
      continue;
    }

    const parsed = extractJson(parts.map((part) => part.text ?? '').join(''));
    yield { event: 'status', data: { phase: 'concluding', engine: 'gemini', label: 'Correlating evidence into a verdict…' } };
    const result = assembleResult(scenario, query, parsed, executed, liveRegistry, liveDashboards, groundedIds);
    for (const item of result.evidence) {
      yield { event: 'observation', data: item };
    }
    yield { event: 'result', data: result };
    return;
  }
  throw new Error(`investigation exceeded ${maxToolTurns} tool turns`);
}
