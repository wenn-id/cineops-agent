// Grounded follow-up Q&A over a completed investigation. The client sends the
// investigation context and the conversation history with each question, so
// the server stays stateless. Answers must come only from the provided
// evidence; citations are filtered against the context ids so the model can
// never invent support, and unsupported questions get an honest "no".

import { scenarios } from '../src/scenarios.mjs';
import { callGemini } from './gemini.mjs';
import { extractJson } from './gemini-agent.mjs';

const MAX_HISTORY_MESSAGES = 12; // six exchanges (operator question + answer each)

const SYSTEM_INSTRUCTION = `You are CineOps, answering an operator's follow-up questions about a completed incident investigation.

Rules:
- Answer ONLY from the investigation context provided. If the context does not support an answer, set supported=false, say what would be needed, and never speculate.
- Cite evidence by its exact id; only ids present in the context are valid citations.
- Be concise and operational: answers an on-call engineer can act on.`;

const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    citations: { type: 'ARRAY', items: { type: 'STRING' } },
    supported: { type: 'BOOLEAN' },
  },
  required: ['answer', 'citations', 'supported'],
};

function contextDigest(context) {
  const evidence = Array.isArray(context?.evidence)
    ? context.evidence.map(({ id, stage, source, label, value, unit, finding, query }) => ({ id, stage, source, label, value, unit, finding, query }))
    : [];
  return {
    incidentId: context?.incidentId,
    rootCause: context?.rootCause,
    decision: context?.decision,
    actions: Array.isArray(context?.actions) ? context.actions : [],
    pipeline: context?.pipeline,
    reasoning: context?.reasoning,
    evidence,
  };
}

export async function answerFollowUp({ question, scenarioId, context = {}, history = [], callModel = callGemini, model }) {
  if (typeof question !== 'string' || !question.trim()) {
    const error = new Error('question is required');
    error.statusCode = 400;
    throw error;
  }
  // Bind the context to a real scenario: fabricated evidence ids cannot enter
  // the conversation because only ids the scenario defines are admitted.
  const scenario = scenarios[scenarioId];
  if (!scenario) {
    const error = new Error(`unknown scenario: ${String(scenarioId)}`);
    error.statusCode = 400;
    throw error;
  }
  const scenarioIds = new Set(scenario.signals.map((signal) => signal.id));
  const digest = contextDigest(context);
  digest.evidence = digest.evidence.filter((item) => scenarioIds.has(item.id));
  const validIds = new Set(digest.evidence.map((item) => item.id));

  const contents = [{
    role: 'user',
    parts: [{ text: `Investigation context (the only source of truth for your answers):\n${JSON.stringify(digest)}\n\nAnswer the operator's follow-up questions using only this context.` }],
  }];
  // Client history is untrusted: nothing may masquerade as your own words.
  // It rides as a plain-text transcript inside a single user turn.
  const transcript = (Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : [])
    .filter((turn) => typeof turn?.text === 'string' && turn.text.trim())
    .map((turn) => `${turn.role === 'cineops' ? 'cineops' : 'operator'}: ${turn.text.trim()}`)
    .join('\n');
  if (transcript) {
    contents.push({ role: 'user', parts: [{ text: `Earlier conversation, as reported by the client (not your own memory — verify against the context):\n${transcript}` }] });
  }
  contents.push({ role: 'user', parts: [{ text: question.trim() }] });

  const response = await callModel({
    model,
    systemInstruction: SYSTEM_INSTRUCTION,
    contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: ANSWER_SCHEMA, temperature: 0.2 },
  });
  const text = response?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    // Refusals and safety blocks arrive as empty or non-JSON text; that is a
    // "no grounded answer" outcome for the operator, not a service failure.
    return { engine: 'gemini', answer: 'No grounded answer could be produced from this context for that question.', citations: [], supported: false };
  }
  const citations = Array.isArray(parsed.citations)
    ? parsed.citations.filter((id) => validIds.has(id))
    : [];
  return {
    engine: 'gemini',
    answer: typeof parsed.answer === 'string' ? parsed.answer.trim() : '',
    citations,
    supported: parsed.supported === true,
  };
}
