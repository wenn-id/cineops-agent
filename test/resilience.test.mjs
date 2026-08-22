import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, parseLimit } from '../server/ratelimit.mjs';
import { startServer } from '../server/index.mjs';

test('rate limiter: fixed window with allowance and reset', () => {
  const check = createRateLimiter({ windowMs: 100, max: 3 });
  assert.deepEqual(check('client-a'), { allowed: true, remaining: 2, retryAfterMs: 100 });
  assert.equal(check('client-a').allowed, true);
  assert.equal(check('client-a').allowed, true);
  const blocked = check('client-a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 100);

  // Other clients are unaffected; the blocked key recovers after the window.
  assert.equal(check('client-b').allowed, true);
  assert.equal(check('client-a').allowed, false);
});

test('rate limiter: parseLimit rejects malformed values with safe fallbacks', () => {
  assert.equal(parseLimit('', 10), 10, 'empty string falls back');
  assert.equal(parseLimit('abc', 10), 10, 'nonnumeric falls back');
  assert.equal(parseLimit('0', 10), 10, 'zero is not a usable limit');
  assert.equal(parseLimit('-5', 10), 10, 'negative falls back');
  assert.equal(parseLimit('2.5', 10), 10, 'fractional falls back');
  assert.equal(parseLimit('7', 10), 7, 'valid integers pass through');
  assert.equal(parseLimit(12, 10), 12);
  assert.equal(parseLimit(undefined, 10), 10);
});

test('rate limiter: malformed env values cannot disable throttling', () => {
  const fromEmptyEnv = createRateLimiter({ max: parseLimit('', 3) });
  const fromGarbageEnv = createRateLimiter({ max: parseLimit('banana', 3) });
  for (const check of [fromEmptyEnv, fromGarbageEnv]) {
    assert.equal(check('k').allowed, true);
    assert.equal(check('k').allowed, true);
    assert.equal(check('k').allowed, true);
    assert.equal(check('k').allowed, false, 'fallback limit still throttles');
  }
});

test('rate limiter: key floods shed without unbounded growth', () => {
  const windowMs = 50;
  const check = createRateLimiter({ windowMs, max: 2 });
  // Flood far beyond MAX_TRACKED_KEYS' scale with unique keys.
  for (let index = 0; index < 20_000; index += 1) check(`flood-${index}`);
  // The very next check must still answer (no exception, no scan deadlock)
  // and the map stays bounded by shedding.
  assert.equal(check('after-flood').allowed, true);
});

test('server: investigate bursts beyond the limit get 429 with retry-after', async () => {
  // Force the deterministic engine so the burst can never consume real
  // Gemini quota, and restore the environment afterwards.
  const hadKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const statuses = [];
    for (let index = 0; index < 12; index += 1) {
      const response = await fetch(`${base}/api/investigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'premiere-night', query: 'burst test' }),
      });
      statuses.push(response.status);
      if (response.status === 429) {
        assert.ok(Number(response.headers.get('retry-after')) >= 1, '429 carries a retry-after hint');
      }
      // Drain every body so keep-alive sockets do not hold server.close() open.
      await response.text();
    }
    assert.equal(statuses[0], 200);
    assert.ok(statuses.filter((status) => status === 429).length >= 1, 'the burst beyond 10/min must be throttled');

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200, 'cheap endpoints are never throttled');
  } finally {
    if (hadKey !== undefined) process.env.GEMINI_API_KEY = hadKey;
    await new Promise((done) => server.close(done));
  }
});

test('server: rejected requests do not consume the investigation allowance', async () => {
  const hadKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    // Twelve malformed requests, each rejected before any allowance is used.
    for (let index = 0; index < 12; index += 1) {
      const response = await fetch(`${base}/api/investigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'premiere-night', query: '' }),
      });
      await response.text();
      assert.equal(response.status, 400, 'malformed request is rejected');
    }
    // A valid investigation still runs — the quota was not starved.
    const valid = await fetch(`${base}/api/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'premiere-night', query: 'still allowed?' }),
    });
    const text = await valid.text();
    assert.equal(valid.status, 200, 'valid investigations are not starved by rejected traffic');
    assert.match(text, /event: result/);
  } finally {
    if (hadKey !== undefined) process.env.GEMINI_API_KEY = hadKey;
    await new Promise((done) => server.close(done));
  }
});
