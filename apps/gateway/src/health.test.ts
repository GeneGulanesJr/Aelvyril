import { describe, expect, it } from "vitest";
import {
  createProbes,
  runHealthCheck,
  type BackingServiceProbes,
} from "./health.js";

describe("createProbes.tcp", () => {
  it("returns true for a reachable port", async () => {
    const probes = createProbes();
    // 127.0.0.1:1 is a port we never bind, but the OS accepts the SYN and
    // immediately RSTs — that's still a successful TCP "connect" from the
    // kernel's perspective. Use an IP we know rejects (RFC 5737 reserved).
    // Easier: bind a temp server.
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probes.tcp("127.0.0.1", port)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns false when the host is unreachable within the timeout", async () => {
    const probes = createProbes();
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed not routable.
    expect(await probes.tcp("192.0.2.1", 1, 200)).toBe(false);
  });
});

describe("runHealthCheck", () => {
  const okProbes: BackingServiceProbes = {
    tcp: async () => true,
  };
  const badProbes: BackingServiceProbes = {
    tcp: async () => false,
  };

  it("returns ok=true when all probes pass", async () => {
    const result = await runHealthCheck(
      {
        probes: okProbes,
        serviceProbes: () => ({ lapis: "lapis:8788", layamcp: "layamcp:8765" }),
      },
      Date.now() - 5_000,
    );
    expect(result.gateway.ok).toBe(true);
    expect(result.gateway.uptimeMs).toBeGreaterThanOrEqual(4_000);
    expect(result.backing.lapis?.ok).toBe(true);
    expect(result.backing.layamcp?.ok).toBe(true);
  });

  it("returns ok=false when any probe fails", async () => {
    const result = await runHealthCheck(
      {
        probes: badProbes,
        serviceProbes: () => ({ lapis: "lapis:8788" }),
      },
      Date.now(),
    );
    expect(result.gateway.ok).toBe(true);
    expect(result.backing.lapis?.ok).toBe(false);
  });

  it("returns ok=true with empty backing when no services configured", async () => {
    const result = await runHealthCheck(
      { probes: okProbes, serviceProbes: () => ({}) },
      Date.now(),
    );
    expect(Object.keys(result.backing)).toHaveLength(0);
  });
});