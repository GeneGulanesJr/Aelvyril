import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  let now = 1_000_000;
  afterEach(() => vi.useRealTimers());

  function make(capacity: number, refillPerSecond: number) {
    return createRateLimiter({ capacity, refillPerSecond, now: () => now });
  }

  it("allows up to capacity requests in a burst", () => {
    const rl = make(5, 1);
    expect(rl.consume("u1")).toBe(4);
    expect(rl.consume("u1")).toBe(3);
    expect(rl.consume("u1")).toBe(2);
    expect(rl.consume("u1")).toBe(1);
    expect(rl.consume("u1")).toBe(0);
    expect(rl.consume("u1")).toBe(-1); // 6th call: rate-limited
  });

  it("refills at the configured rate", () => {
    const rl = make(5, 2); // 2 tokens/sec
    for (let i = 0; i < 5; i++) rl.consume("u1");
    expect(rl.consume("u1")).toBe(-1);
    now += 1_000; // 1 second passes → 2 tokens added
    expect(rl.consume("u1")).toBe(1);
    expect(rl.consume("u1")).toBe(0);
    expect(rl.consume("u1")).toBe(-1);
  });

  it("caps refill at capacity (no over-accumulation)", () => {
    const rl = make(3, 100); // 100 tokens/sec refill, capacity 3
    for (let i = 0; i < 3; i++) rl.consume("u1");
    now += 60_000; // would add 6000 tokens, but capped at 3
    expect(rl.consume("u1")).toBe(2);
    expect(rl.consume("u1")).toBe(1);
    expect(rl.consume("u1")).toBe(0);
    expect(rl.consume("u1")).toBe(-1);
  });

  it("isolates buckets per user (one user being throttled doesn't affect another)", () => {
    const rl = make(2, 0.001); // capacity 2, near-zero refill
    rl.consume("alice");
    rl.consume("alice");
    expect(rl.consume("alice")).toBe(-1);
    expect(rl.consume("bob")).toBe(1); // bob has his own bucket
    expect(rl.consume("bob")).toBe(0);
  });

  it("reset clears a user's bucket", () => {
    const rl = make(2, 0.001);
    rl.consume("u1");
    rl.consume("u1");
    expect(rl.consume("u1")).toBe(-1);
    rl.reset("u1");
    expect(rl.consume("u1")).toBe(1);
  });

  // Review P3: attacker-chosen userIds must not grow the bucket Map without
  // bound — buckets idle for >3 refill periods are lazily evicted.
  it("evicts buckets idle longer than ~3 refill periods (lazy, bounded memory)", () => {
    const rl = make(2, 1); // refill period 2s → evict after 6s idle
    for (let i = 0; i < 50; i++) rl.consume(`attacker-${i}`);
    expect(rl.size()).toBe(50);
    now += 7_000; // past the eviction horizon
    // The sweep runs lazily on the next consume...
    expect(rl.consume("fresh-user")).toBe(1);
    expect(rl.size()).toBe(1); // only the fresh bucket survives
  });

  it("does not evict recently-active buckets", () => {
    const rl = make(2, 1); // refill period 2s → evict after 6s idle
    rl.consume("active");
    now += 4_000; // idle 4s < 6s horizon (and inside one sweep period)
    rl.consume("other");
    expect(rl.size()).toBe(2);
  });

  // Review P3: an empty identity must not create (or credit) a shared
  // empty-id bucket — fail closed, touch nothing.
  it("consume no-ops safely for an empty userId", () => {
    const rl = make(5, 1);
    expect(rl.consume("")).toBe(-1);
    expect(rl.size()).toBe(0);
    // And it did not dent anyone else's capacity.
    expect(rl.consume("real")).toBe(4);
  });
});