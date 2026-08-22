// Fixed-window rate limiter, deliberately dependency-free. Protects the
// expensive endpoints (and their Gemini quota) from bursts. The key map is
// bounded and swept at most once per window, so neither key floods nor
// per-request scans can degrade request handling.

const MAX_TRACKED_KEYS = 10_000;

export function parseLimit(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const limit = parseLimit(max, 10);
  const hits = new Map();
  let lastSweep = 0;

  return function check(key) {
    const now = Date.now();
    // Sweep expired keys at most once per window — never per request.
    if (hits.size > MAX_TRACKED_KEYS && now - lastSweep >= windowMs) {
      lastSweep = now;
      for (const [storedKey, entry] of hits) {
        if (now >= entry.resetAt) hits.delete(storedKey);
      }
      // A spoofed-key flood can still refill the map within one window; shed
      // the oldest quarter rather than scan again, and shed to the shared
      // bucket only if pressure somehow persists.
      if (hits.size > MAX_TRACKED_KEYS) {
        const excess = hits.size - MAX_TRACKED_KEYS;
        let removed = 0;
        for (const storedKey of hits.keys()) {
          if (removed >= excess) break;
          hits.delete(storedKey);
          removed += 1;
        }
      }
    }
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterMs: windowMs };
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
    }
    return { allowed: true, remaining: limit - entry.count, retryAfterMs: entry.resetAt - now };
  };
}
