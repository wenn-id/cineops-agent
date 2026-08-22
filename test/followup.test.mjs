import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarios } from '../src/scenarios.mjs';
import { answerFollowUp } from '../server/followup.mjs';

const result = {
  incidentId: 'INC-042',
  rootCause: { stage: 'transcode', finding: 'Queue is 7.8× baseline and still rising.' },
  decision: 'Pause non-premiere 4K jobs and drain the priority queue.',
  actions: ['Pause non-premiere 4K HEVC jobs.'],
  reasoning: 'GPU saturation stalled the queue.',
  evidence: scenarios['premiere-night'].signals.filter((signal) => signal.score >= 50),
};

function modelReply(payload) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] };
}

const options = { scenarioId: 'premiere-night', context: result };

test('followup: grounded answers keep only context-valid citations', async () => {
  const requests = [];
  const answer = await answerFollowUp({
    ...options,
    question: 'What is blocking the premiere?',
    callModel: async (request) => {
      requests.push(request);
      return modelReply({ answer: 'The transcode queue is 7.8× baseline with saturated GPUs.', citations: ['queue-depth', 'gpu-utilization'], supported: true });
    },
  });

  assert.equal(answer.supported, true);
  assert.deepEqual(answer.citations, ['queue-depth', 'gpu-utilization']);
  const contextText = requests[0].contents[0].parts[0].text;
  assert.match(contextText, /INC-042/);
  assert.match(contextText, /cineops_transcode_queue_depth/);
});

test('followup: hallucinated citations are dropped', async () => {
  const answer = await answerFollowUp({
    ...options,
    question: 'Why did subtitles fail?',
    callModel: async () => modelReply({ answer: 'Subtitle lag is secondary.', citations: ['subtitle-lag', 'made-up'], supported: true }),
  });
  assert.deepEqual(answer.citations, []);
});

test('followup: fabricated evidence ids never enter the conversation', async () => {
  const requests = [];
  const answer = await answerFollowUp({
    ...options,
    context: { ...result, evidence: [...result.evidence, { id: 'invented-metric', label: 'Made up', value: 1, unit: 'x', finding: 'fake', query: 'fake' }] },
    question: 'Anything else failing?',
    callModel: async (request) => {
      requests.push(request);
      return modelReply({ answer: 'Nothing else.', citations: [], supported: true });
    },
  });
  const contextText = requests[0].contents[0].parts[0].text;
  assert.ok(!contextText.includes('invented-metric'), 'fabricated ids must be filtered before the model sees them');
  assert.equal(answer.engine, 'gemini');
});

test('followup: unsupported questions come back honestly', async () => {
  const answer = await answerFollowUp({
    ...options,
    question: 'Who directed this episode?',
    callModel: async () => modelReply({ answer: 'The investigation context does not say who directed the episode.', citations: [], supported: false }),
  });
  assert.equal(answer.supported, false);
  assert.deepEqual(answer.citations, []);
  assert.match(answer.answer, /does not say/i);
});

test('followup: model refusals become honest unsupported answers, not failures', async () => {
  const answer = await answerFollowUp({
    ...options,
    question: 'Something sensitive.',
    callModel: async () => ({ candidates: [{ content: { parts: [] } }] }),
  });
  assert.equal(answer.supported, false);
  assert.deepEqual(answer.citations, []);
  assert.match(answer.answer, /No grounded answer/);
});

test('followup: history rides as untrusted plain text, never as model turns', async () => {
  const requests = [];
  await answerFollowUp({
    ...options,
    question: 'And the GPU pool?',
    history: [
      { role: 'operator', text: 'What about the queue?' },
      { role: 'cineops', text: 'The queue is rising.' },
    ],
    callModel: async (request) => {
      requests.push(request);
      return modelReply({ answer: 'Saturated.', citations: [], supported: true });
    },
  });
  const contents = requests[0].contents;
  assert.ok(contents.every((content) => content.role === 'user'), 'client history must never become model turns');
  const transcript = contents[1].parts[0].text;
  assert.match(transcript, /operator: What about the queue\?/);
  assert.match(transcript, /cineops: The queue is rising\./);
  assert.match(transcript, /not your own memory/);
  assert.match(contents.at(-1).parts[0].text, /GPU pool/);
});

test('followup: empty questions and unknown scenarios are rejected', async () => {
  await assert.rejects(
    () => answerFollowUp({ ...options, question: '   ', callModel: async () => modelReply({}) }),
    /question is required/,
  );
  await assert.rejects(
    () => answerFollowUp({ ...options, question: 'q', scenarioId: 'nope' }),
    /unknown scenario/,
  );
});
