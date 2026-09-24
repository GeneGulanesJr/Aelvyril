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
    // Deterministic unreachable target: bind a socket to grab a free port,
    // then close it — the OS now refuses connections there (ECONNREFUSED on
    // Windows/Linux; a firewall that silently drops still hits the 200ms
    // timeout). Either path resolves false without touching real networks.
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probes.tcp("127.0.0.1", port, 200)).toBe(false);
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
        // IPv4 literals: safeResolve skips DNS for IPs — unit tests must
        // not depend on the host resolver (a lookalike answer for "lapis"
        // or a slow resolver would make this test slow/flaky).
        serviceProbes: () => ({ lapis: "192.0.2.10:8788", layamcp: "192.0.2.10:8765" }),
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
        serviceProbes: () => ({ lapis: "192.0.2.10:8788" }),
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