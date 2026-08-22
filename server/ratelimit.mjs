// Fixed-window rate limiter, deliberately dependency-free. Protects the
// expensive endpoints (and their Gemini quota) from bursts; the window map
// is swept lazily so long-running processes do not accumulate stale keys.

export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [storedKey, entry] of hits) {
        if (now >= entry.resetAt) hits.delete(storedKey);
      }
    }
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: max - 1, retryAfterMs: windowMs };
    }
    entry.count += 1;
    if (entry.count > max) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
    }
    return { allowed: true, remaining: max - entry.count, retryAfterMs: entry.resetAt - now };
  };
}
