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

  function refill(b: Bucket): void {
    const elapsedSec = (now() - b.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSecond);
    b.lastRefill = now();
  }

  return {
    consume(userId) {
      let b = buckets.get(userId);
      if (!b) {
        b = { tokens: capacity, lastRefill: now() };
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
  };
}