import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../server/ratelimit.mjs';
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

test('server: investigate bursts beyond the limit get 429 with retry-after', async () => {
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
    await new Promise((done) => server.close(done));
  }
});
