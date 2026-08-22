// Grounded follow-up Q&A over a completed investigation. The client sends the
// investigation context and the conversation history with each question, so
// the server stays stateless. Answers must come only from the provided
// evidence; citations are filtered against the context ids so the model can
// never invent support, and unsupported questions get an honest "no".

import { callGemini } from './gemini.mjs';
import { extractJson } from './gemini-agent.mjs';

const MAX_HISTORY_TURNS = 6;

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

export async function answerFollowUp({ question, context = {}, history = [], callModel = callGemini, model }) {
  if (typeof question !== 'string' || !question.trim()) {
    const error = new Error('question is required');
    error.statusCode = 400;
    throw error;
  }
  const validIds = new Set(contextDigest(context).evidence.map((item) => item.id).filter(Boolean));

  const contents = [{
    role: 'user',
    parts: [{ text: `Investigation context (the only source of truth for your answers):\n${JSON.stringify(contextDigest(context))}\n\nAnswer the operator's follow-up questions using only this context.` }],
  }];
  for (const turn of Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : []) {
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    contents.push({ role: turn.role === 'cineops' ? 'model' : 'user', parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: question.trim() }] });

  const response = await callModel({
    model,
    systemInstruction: SYSTEM_INSTRUCTION,
    contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: ANSWER_SCHEMA, temperature: 0.2 },
  });
  const text = response?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  const parsed = extractJson(text);
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
