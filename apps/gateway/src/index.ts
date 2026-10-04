import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createClerkVerifier, type TokenVerifier } from "./auth.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const useFakeChild = process.env.PI_FAKE === "1";

/**
 * Verifier policy (spec §8): CLERK_SECRET_KEY -> real Clerk verification.
 * Without it, PI_FAKE=1 enables a dev verifier that accepts ANY bearer token
 * and derives the user id from the token itself. Otherwise: refuse to start.
 */
function resolveVerifier(): TokenVerifier {
  const secretKey = process.env.CLERK_SECRET_KEY;
  // #85: pin the token azp to the expected origins when configured
  // (comma-separated, e.g. "http://localhost:3000,https://app.example.com").
  const authorizedParties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secretKey) return createClerkVerifier(secretKey, authorizedParties);
  if (useFakeChild) {
    // Dev-only: any bearer token is accepted; the token IS the user id.
    return async (token) => ({ userId: token });
  }
  throw new Error(
    "gateway requires CLERK_SECRET_KEY, or PI_FAKE=1 for the dev verifier (any bearer token, userId = token)",
  );
}

const app = await buildApp({
  dbPath: process.env.GATEWAY_DB ?? "./data/gateway.db",
  childCommand: useFakeChild ? process.execPath : (process.env.PI_COMMAND ?? "pi"),
  childArgs: useFakeChild
    ? [fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url))]
    : // Windows: node's spawn cannot exec .cmd/.ps1 shims, so point PI_COMMAND
      // at node.exe and put the cli.js path into PI_COMMAND_ARGS (JSON array).
      process.env.PI_COMMAND_ARGS
      ? (JSON.parse(process.env.PI_COMMAND_ARGS) as string[])
      : [
          "--mode",
          "rpc",
          // Spec §14: pi's default provider is google — always pass
          // --provider/--model explicitly so provider drift between sessions
          // can't silently change behavior.
          ...(process.env.PI_PROVIDER ? ["--provider", process.env.PI_PROVIDER] : []),
          ...(process.env.PI_MODEL ? ["--model", process.env.PI_MODEL] : []),
        ],
  idleMs: Number(process.env.GATEWAY_IDLE_MS ?? 300_000),
  verifyToken: resolveVerifier(),
  allowedOrigins: process.env.GATEWAY_ALLOWED_ORIGIN?.split(",").map((o) => o.trim()),
  // Spec §11: structured JSON logs in prod (Fastify pino). Default on;
  // opt out with GATEWAY_LOG=silent for dev when stdout noise is annoying.
  logger: process.env.GATEWAY_LOG !== "silent",
  // SSE keepalive — operators may want to tune for proxy timeouts.
  sseHeartbeatMs: process.env.SSE_HEARTBEAT_MS ? Number(process.env.SSE_HEARTBEAT_MS) : undefined,
  // Security review #85 caps: SSE streams per user, replay page size,
  // event-log retention per thread.
  maxSseStreamsPerUser: process.env.GATEWAY_MAX_SSE_STREAMS
    ? Number(process.env.GATEWAY_MAX_SSE_STREAMS)
    : undefined,
  sseReplayPageSize: process.env.GATEWAY_SSE_REPLAY_PAGE
    ? Number(process.env.GATEWAY_SSE_REPLAY_PAGE)
    : undefined,
  eventRetentionPerThread: process.env.GATEWAY_EVENT_RETENTION
    ? Number(process.env.GATEWAY_EVENT_RETENTION)
    : undefined,
  // #85: optional bearer secret gating /metrics for direct exposure.
  metricsSecret: process.env.GATEWAY_METRICS_SECRET,
});

// Default to dual-stack ("::" accepts IPv4-mapped too) so `localhost` resolves
// over either ::1 or 127.0.0.1; fall back to IPv4-only when IPv6 is unavailable.
// GATEWAY_HOST overrides both.
try {
  await app.listen({ port, host: process.env.GATEWAY_HOST ?? "::" });
} catch {
  await app.listen({ port, host: process.env.GATEWAY_HOST ?? "127.0.0.1" });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
