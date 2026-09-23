// Spec §9 + §11: /healthz probe. Returns 200 only when the gateway itself
// is healthy AND the backing services it depends on are reachable.
// Probes are TCP-only (no HTTP) to avoid coupling to upstream wire
// formats — they live or die by port-open.
//
// In dev (no compose / no sibling services), all probes are skipped
// unless the corresponding env var is set. This means a bare `pnpm start`
// still gets a clean 200 for liveness checks.

import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";

export interface BackingServiceProbes {
  /** TCP probe: hostname + port. Returns true if a TCP connection succeeds within the timeout. */
  tcp: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export function createProbes(): BackingServiceProbes {
  return {
    async tcp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return await new Promise<boolean>((resolve) => {
        const sock = createConnection({ host, port });
        const timer = setTimeout(() => {
          sock.destroy();
          resolve(false);
        }, timeoutMs);
        sock.once("connect", () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        });
        sock.once("error", () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(false);
        });
      });
    },
  };
}

/** Resolve a hostname once; on failure return the input as-is so the probe can fail loudly. */
async function safeResolve(host: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost") return host;
  try {
    const r = await lookup(host);
    return r.address;
  } catch {
    return host;
  }
}

/** Result of the full health check. */
export interface HealthCheckResult {
  gateway: { ok: boolean; uptimeMs: number };
  backing: Record<string, { ok: boolean; latencyMs: number; error?: string }>;
}

export interface HealthCheckOptions {
  /** Service name -> "host:port" to TCP-probe. Env-driven: defaults read at call time. */
  serviceProbes?: () => Record<string, string>;
  /** Probe implementation override for tests. */
  probes?: BackingServiceProbes;
}

export async function runHealthCheck(
  opts: HealthCheckOptions = {},
  startedAt: number,
): Promise<HealthCheckResult> {
  const probes = opts.probes ?? createProbes();
  const targets = opts.serviceProbes?.() ?? {};
  const backing: HealthCheckResult["backing"] = {};
  await Promise.all(
    Object.entries(targets).map(async ([name, hp]) => {
      const [host, portStr] = hp.split(":");
      const port = Number(portStr);
      if (!host || !port || Number.isNaN(port)) {
        backing[name] = { ok: false, latencyMs: 0, error: `bad target ${hp}` };
        return;
      }
      const resolved = await safeResolve(host);
      const start = Date.now();
      try {
        const ok = await probes.tcp(resolved, port);
        backing[name] = { ok, latencyMs: Date.now() - start };
      } catch (e) {
        backing[name] = { ok: false, latencyMs: Date.now() - start, error: String(e) };
      }
    }),
  );
  return {
    gateway: { ok: true, uptimeMs: Date.now() - startedAt },
    backing,
  };
}

/** Default probe targets read from env. Empty by default — opt-in via env. */
export function defaultServiceProbes(): Record<string, string> {
  const probes: Record<string, string> = {};
  if (process.env.LAPIS_URL) probes.lapis = process.env.LAPIS_URL;
  if (process.env.SANDD_URL) probes.sandd = process.env.SANDD_URL;
  if (process.env.LAYAMCP_URL) probes.layamcp = process.env.LAYAMCP_URL;
  return probes;
}
