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

test('followup: grounded answers keep only context-valid citations', async () => {
  const requests = [];
  const answer = await answerFollowUp({
    question: 'What is blocking the premiere?',
    context: result,
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
    question: 'Why did subtitles fail?',
    context: result,
    callModel: async () => modelReply({ answer: 'Subtitle lag is secondary.', citations: ['subtitle-lag', 'made-up'], supported: true }),
  });
  assert.deepEqual(answer.citations, []);
});

test('followup: unsupported questions come back honestly', async () => {
  const answer = await answerFollowUp({
    question: 'Who directed this episode?',
    context: result,
    callModel: async () => modelReply({ answer: 'The investigation context does not say who directed the episode.', citations: [], supported: false }),
  });
  assert.equal(answer.supported, false);
  assert.deepEqual(answer.citations, []);
  assert.match(answer.answer, /does not say/i);
});

test('followup: history and question ride along in order', async () => {
  const requests = [];
  await answerFollowUp({
    question: 'And the GPU pool?',
    context: result,
    history: [
      { role: 'operator', text: 'What about the queue?' },
      { role: 'cineops', text: 'The queue is rising.' },
    ],
    callModel: async (request) => {
      requests.push(request);
      return modelReply({ answer: 'Saturated.', citations: [], supported: true });
    },
  });
  const roles = requests[0].contents.map((content) => content.role);
  assert.deepEqual(roles, ['user', 'user', 'model', 'user']);
  assert.match(requests[0].contents.at(-1).parts[0].text, /GPU pool/);
});

test('followup: empty questions are rejected', async () => {
  await assert.rejects(
    () => answerFollowUp({ question: '   ', context: result, callModel: async () => modelReply({}) }),
    /question is required/,
  );
});
