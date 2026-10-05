import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createClerkVerifier, isLoopbackHost, type TokenVerifier } from "./auth.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const useFakeChild = process.env.PI_FAKE === "1";
const configuredHost = process.env.GATEWAY_HOST;
// The fake verifier is in play only when there is no real Clerk secret AND
// PI_FAKE=1 (with a secret, PI_FAKE only swaps the pi child for the fixture).
const fakeVerifier = !process.env.CLERK_SECRET_KEY && useFakeChild;

// #78: the fake verifier accepts ANY bearer token and derives the identity
// from the token itself — full cross-tenant access for anyone who can
// reach the socket. That is tolerable on loopback only: refuse to boot it
// pointed at a non-loopback interface.
if (fakeVerifier && configuredHost !== undefined && !isLoopbackHost(configuredHost)) {
  throw new Error(
    `PI_FAKE=1 enables a dev verifier that accepts any bearer token; ` +
      `refusing to bind non-loopback GATEWAY_HOST=${configuredHost}. ` +
      `Set GATEWAY_HOST=127.0.0.1 for dev, or configure CLERK_SECRET_KEY for real auth.`,
  );
}

if (fakeVerifier) {
  // #78: make the dev-only auth mode impossible to miss in the logs.
  console.warn(
    "[PI_FAKE] DEV AUTH VERIFIER ACTIVE: any bearer token is accepted and the " +
      "token itself becomes the userId. Local development ONLY — the gateway is " +
      "bound to loopback unless you know what you are doing.",
  );
}

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
  // #84: per-thread budget in USD (cost cap → blocked + refused prompts).
  maxCostPerThreadUsd: process.env.GATEWAY_MAX_THREAD_COST_USD
    ? Number(process.env.GATEWAY_MAX_THREAD_COST_USD)
    : undefined,
  // #84: extension_ui_request handling — "auto-responder" (default) or
  // "blocked" (escalate blocking dialogs to the needs-you state).
  dialogMode:
    process.env.GATEWAY_DIALOG_MODE === "blocked" ? ("blocked" as const) : ("auto-responder" as const),
  // #83: long-horizon execution caps — cheap threads vs scarce hosts.
  maxConversationsPerUser: process.env.GATEWAY_MAX_THREADS
    ? Number(process.env.GATEWAY_MAX_THREADS)
    : undefined,
  maxRunningHostsPerUser: process.env.GATEWAY_MAX_RUNNING_HOSTS
    ? Number(process.env.GATEWAY_MAX_RUNNING_HOSTS)
    : undefined,
  maxSessionHosts: process.env.GATEWAY_MAX_SESSION_HOSTS
    ? Number(process.env.GATEWAY_MAX_SESSION_HOSTS)
    : undefined,
  queueIntervalMs: process.env.GATEWAY_QUEUE_INTERVAL_MS
    ? Number(process.env.GATEWAY_QUEUE_INTERVAL_MS)
    : undefined,
  // #76: who may call /v1/admin/* (update status/apply). Empty/unset = deny all.
  adminUserIds: process.env.GATEWAY_ADMIN_USER_IDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // #80/#81/#82: spec/autonomy/auto-verify wiring.
  // GATEWAY_SPEC_MAX_ROUNDS: bounded question budget per interview (default 3).
  specMaxRounds: process.env.GATEWAY_SPEC_MAX_ROUNDS
    ? Number(process.env.GATEWAY_SPEC_MAX_ROUNDS)
    : undefined,
  // GATEWAY_TRUST_THRESHOLD: merges-without-revision at which a namespace's
  // autonomy escalates (default 5; 0 disables escalation).
  trustThreshold: process.env.GATEWAY_TRUST_THRESHOLD
    ? Number(process.env.GATEWAY_TRUST_THRESHOLD)
    : undefined,
  // GATEWAY_VERIFY=0 disables the auto-verify loop entirely; otherwise
  // tests/lint/typecheck auto-detect from the workspace package.json.
  verify:
    process.env.GATEWAY_VERIFY === "0"
      ? null
      : {
          commandsOverride: process.env.GATEWAY_VERIFY_COMMANDS,
          timeoutMs: process.env.GATEWAY_VERIFY_TIMEOUT_MS
            ? Number(process.env.GATEWAY_VERIFY_TIMEOUT_MS)
            : undefined,
          retries: process.env.GATEWAY_VERIFY_RETRIES
            ? Number(process.env.GATEWAY_VERIFY_RETRIES)
            : undefined,
        },
});

// Default to dual-stack ("::" accepts IPv4-mapped too) so `localhost` resolves
// over either ::1 or 127.0.0.1; fall back to IPv4-only when IPv6 is unavailable.
// GATEWAY_HOST overrides both. #78: with the fake dev verifier, default to
// IPv4 loopback instead — an unconfigured dev box must not come up listening
// on every interface while accepting any bearer token.
const bindHost = configuredHost ?? (fakeVerifier ? "127.0.0.1" : "::");
try {
  await app.listen({ port, host: bindHost });
} catch {
  await app.listen({ port, host: configuredHost ?? "127.0.0.1" });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
