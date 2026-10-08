import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { readNonNegativeInt, readPositiveInt, readPositiveNumber } from "./env.js";
import { createClerkVerifier, isLoopbackHost, type TokenVerifier } from "./auth.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const useFakeChild = process.env.PI_FAKE === "1";
const configuredHost = process.env.GATEWAY_HOST;
// The fake verifier is in play only when there is no real Clerk secret AND
// PI_FAKE=1 (with a secret, PI_FAKE only swaps the pi child for the fixture).
const fakeVerifier = !process.env.CLERK_SECRET_KEY && useFakeChild;

// Review P3: strict parsing for every numeric cap. Bad values throw here at
// boot — the gateway refuses to run with silently-disabled caps.
const idleMs = readPositiveInt("GATEWAY_IDLE_MS");
const sseHeartbeatMs = readPositiveInt("SSE_HEARTBEAT_MS");
const maxSseStreamsPerUser = readPositiveInt("GATEWAY_MAX_SSE_STREAMS");
const sseReplayPageSize = readPositiveInt("GATEWAY_SSE_REPLAY_PAGE");
const eventRetentionPerThread = readNonNegativeInt("GATEWAY_EVENT_RETENTION"); // 0 disables
const maxCostPerThreadUsd = readPositiveNumber("GATEWAY_MAX_THREAD_COST_USD");
const maxConversationsPerUser = readPositiveInt("GATEWAY_MAX_THREADS");
const maxRunningHostsPerUser = readPositiveInt("GATEWAY_MAX_RUNNING_HOSTS");
const maxSessionHosts = readPositiveInt("GATEWAY_MAX_SESSION_HOSTS");
const queueIntervalMs = readPositiveInt("GATEWAY_QUEUE_INTERVAL_MS");
const rateLimitPerMin = readPositiveInt("GATEWAY_RATE_LIMIT_PER_MIN");
const specMaxRounds = readPositiveInt("GATEWAY_SPEC_MAX_ROUNDS");
const trustThreshold = readNonNegativeInt("GATEWAY_TRUST_THRESHOLD"); // 0 disables
const verifyTimeoutMs = readPositiveInt("GATEWAY_VERIFY_TIMEOUT_MS");
const verifyRetries = readNonNegativeInt("GATEWAY_VERIFY_RETRIES");

// Review P3: the effective caps are logged once at startup so operators can
// verify what the process is actually enforcing (env vs defaults).
console.log(
  "[gateway] effective caps:",
  JSON.stringify({
    idleMs: idleMs ?? 300_000,
    sseHeartbeatMs: sseHeartbeatMs ?? 15_000,
    maxSseStreamsPerUser: maxSseStreamsPerUser ?? 10,
    sseReplayPageSize: sseReplayPageSize ?? 500,
    eventRetentionPerThread: eventRetentionPerThread ?? 10_000,
    maxCostPerThreadUsd: maxCostPerThreadUsd ?? null,
    maxConversationsPerUser: maxConversationsPerUser ?? 30,
    maxRunningHostsPerUser: maxRunningHostsPerUser ?? 2,
    maxSessionHosts: maxSessionHosts ?? 100,
    queueIntervalMs: queueIntervalMs ?? 2_000,
    rateLimitPerMin: rateLimitPerMin ?? 20,
    specMaxRounds: specMaxRounds ?? 3,
    trustThreshold: trustThreshold ?? 5,
    verifyTimeoutMs: verifyTimeoutMs ?? null,
    verifyRetries: verifyRetries ?? null,
    metricsPublic: process.env.GATEWAY_METRICS_PUBLIC === "1",
    metricsSecretConfigured: Boolean(process.env.GATEWAY_METRICS_SECRET),
  }),
);

// #78: the fake verifier accepts ANY bearer token and derives the identity
// from the token itself — full cross-tenant access for anyone who can
// reach the socket. That is tolerable on loopback only: refuse to boot it
// pointed at a non-loopback interface — UNLESS the operator explicitly
// acknowledges the container case (PI_FAKE_ALLOW_NON_LOOPBACK=1): inside a
// container the process-level bind says nothing about exposure; Docker's
// port mapping is loopback-only (#79), so a non-loopback in-container bind
// is how the dev stack stays reachable from peer containers.
if (
  fakeVerifier &&
  configuredHost !== undefined &&
  !isLoopbackHost(configuredHost) &&
  process.env.PI_FAKE_ALLOW_NON_LOOPBACK !== "1"
) {
  throw new Error(
    `PI_FAKE=1 enables a dev verifier that accepts any bearer token; ` +
      `refusing to bind non-loopback GATEWAY_HOST=${configuredHost}. ` +
      `Set GATEWAY_HOST=127.0.0.1 for dev, configure CLERK_SECRET_KEY for real auth, ` +
      `or set PI_FAKE_ALLOW_NON_LOOPBACK=1 when running inside a container whose ` +
      `published ports are loopback-only (Docker).`,
  );
}

if (fakeVerifier && configuredHost !== undefined && !isLoopbackHost(configuredHost)) {
  console.warn(
    "[PI_FAKE] non-loopback GATEWAY_HOST with the dev verifier — allowed by " +
      "PI_FAKE_ALLOW_NON_LOOPBACK=1; exposure is the operator's responsibility.",
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
  // Review P1: children no longer inherit the full process.env. In the dev
  // fixture mode the fake-pi knobs are explicitly allowlisted (gateway-
  // controlled keys — operator secrets stay blocked).
  childEnvAllowlist: useFakeChild
    ? [
        "FAKE_SPEC_QUESTIONS",
        "FAKE_PLAN_JSON",
        "FAKE_GATED_TOOL",
        "FAKE_EDIT_FILE",
        "FAKE_DELAY_MS",
        "FAKE_UI_DIALOG",
      ]
    : undefined,
  idleMs,
  verifyToken: resolveVerifier(),
  allowedOrigins: process.env.GATEWAY_ALLOWED_ORIGIN?.split(",").map((o) => o.trim()),
  // Spec §11: structured JSON logs in prod (Fastify pino). Default on;
  // opt out with GATEWAY_LOG=silent for dev when stdout noise is annoying.
  logger: process.env.GATEWAY_LOG !== "silent",
  // SSE keepalive — operators may want to tune for proxy timeouts.
  sseHeartbeatMs,
  // Security review #85 caps: SSE streams per user, replay page size,
  // event-log retention per thread.
  maxSseStreamsPerUser,
  sseReplayPageSize,
  eventRetentionPerThread,
  // #85: optional bearer secret gating /metrics. Review P3: /metrics is
  // fail-closed — served without a secret only when GATEWAY_METRICS_PUBLIC=1.
  metricsSecret: process.env.GATEWAY_METRICS_SECRET,
  metricsPublic: process.env.GATEWAY_METRICS_PUBLIC === "1",
  // #84: per-thread budget in USD (cost cap → blocked + refused prompts).
  maxCostPerThreadUsd,
  // #84: extension_ui_request handling — "auto-responder" (default) or
  // "blocked" (escalate blocking dialogs to the needs-you state).
  dialogMode:
    process.env.GATEWAY_DIALOG_MODE === "blocked" ? ("blocked" as const) : ("auto-responder" as const),
  // #83: long-horizon execution caps — cheap threads vs scarce hosts.
  maxConversationsPerUser,
  maxRunningHostsPerUser,
  maxSessionHosts,
  queueIntervalMs,
  // Review P3: per-user prompt rate limit (requests/minute).
  rateLimitPerMin,
  // #76: who may call /v1/admin/* (update status/apply). Empty/unset = deny all.
  adminUserIds: process.env.GATEWAY_ADMIN_USER_IDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // #80/#81/#82: spec/autonomy/auto-verify wiring.
  // GATEWAY_SPEC_MAX_ROUNDS: bounded question budget per interview (default 3).
  specMaxRounds,
  // GATEWAY_TRUST_THRESHOLD: merges-without-revision at which a namespace's
  // autonomy escalates (default 5; 0 disables escalation).
  trustThreshold,
  // GATEWAY_VERIFY=0 disables the auto-verify loop entirely; otherwise
  // tests/lint/typecheck auto-detect from the workspace package.json.
  verify:
    process.env.GATEWAY_VERIFY === "0"
      ? null
      : {
          commandsOverride: process.env.GATEWAY_VERIFY_COMMANDS,
          timeoutMs: verifyTimeoutMs,
          retries: verifyRetries,
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
} catch (err) {
  // Only the DEFAULT bind ("::" dual-stack) has a fallback: an IPv6-less
  // box retries on IPv4 loopback. An explicitly configured GATEWAY_HOST
  // must surface its original error — retrying the identical host just
  // guarantees a second failure that masks the first.
  if (bindHost !== "::") throw err;
  await app.listen({ port, host: "127.0.0.1" });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Review P3: graceful shutdown cannot hang past the container grace —
    // app.close() failures are swallowed and a hard-exit backstop fires at
    // 8s even if a handle refuses to close.
    const backstop = setTimeout(() => process.exit(0), 8_000);
    backstop.unref();
    app
      .close()
      .catch(() => {})
      .then(() => process.exit(0));
  });
}
