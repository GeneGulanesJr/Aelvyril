// Spec §10: per-user rate limit on /v1/conversations/:id/prompt.
// Simple in-memory token bucket — one bucket per userId, refilled at
// `refillPerSecond` tokens up to `capacity`. No external dep. Sufficient
// for v1 single-process; replace with @fastify/rate-limit + Redis when
// the gateway scales horizontally.

export interface RateLimiter {
  /** Returns the remaining tokens, or -1 if the request would exceed capacity. */
  consume(userId: string): number;
  /** Test helper: drop a bucket. */
  reset(userId: string): void;
  /** Review P3: live bucket count (bounded-memory observability + tests). */
  size(): number;
}

export interface RateLimiterOptions {
  /** Max tokens per user (burst size). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond } = opts;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  // Review P3: attacker-chosen userIds must not grow the Map unbounded.
  // A bucket that has been idle for 3 full refill periods can only be full
  // (or the limiter never refills); drop it lazily — it is recreated with
  // full tokens on the next consume, which is semantically identical.
  const refillPeriodMs = refillPerSecond > 0 ? (capacity / refillPerSecond) * 1_000 : 0;
  const idleEvictMs = refillPeriodMs * 3;
  let lastSweep = now();

  function refill(b: Bucket): void {
    const elapsedSec = (now() - b.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSecond);
    b.lastRefill = now();
  }

  /** Lazy eviction: at most one O(n) sweep per refill period. */
  function sweep(t: number): void {
    if (refillPeriodMs <= 0 || t - lastSweep < refillPeriodMs) return;
    lastSweep = t;
    for (const [key, b] of buckets) {
      if (t - b.lastRefill > idleEvictMs) buckets.delete(key);
    }
  }

  return {
    consume(userId) {
      // Review P3: no authenticated identity — no bucket, no service.
      // Fail closed rather than crediting a shared empty-id bucket.
      if (!userId) return -1;
      const t = now();
      sweep(t);
      let b = buckets.get(userId);
      if (!b) {
        b = { tokens: capacity, lastRefill: t };
        buckets.set(userId, b);
      } else {
        refill(b);
      }
      if (b.tokens < 1) return -1;
      b.tokens -= 1;
      return Math.floor(b.tokens);
    },
    reset(userId) {
      buckets.delete(userId);
    },
    size() {
      return buckets.size;
    },
  };
}