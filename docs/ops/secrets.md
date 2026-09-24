# Secret rotation runbook (spec §11)

Aelvyril runs in dev with real Clerk dev keys + provider keys, so the
"production" rotation cadence is relevant even before the prod deploy.

## Clerk keys

Clerk automatically rotates secret keys per-instance from the dashboard,
but the public publishable key changes too (for new instances). For an
existing instance, **only the secret key rotates** — publishable stays.

```sh
# 1. Mint a new secret key in the Clerk dashboard
#    (https://dashboard.clerk.com/apps/.../api-keys → Reveal secret key)
# 2. Update apps/gateway/.env and apps/web/.env.local
#    CLERK_SECRET_KEY=sk_test_<new>
# 3. Restart the gateway
docker compose -f infra/compose.yaml restart gateway
# 4. Verify: `pnpm --filter @aelvyril/gateway start` (dev) or curl
#    GET /healthz on the gateway container (prod) — both should respond.
```

**Cadence:** Clerk secret keys are good for the lifetime of the instance,
but rotate immediately if:
- A developer with access leaves the project.
- A session token is leaked in a log.
- Clerk notifies you of an incident.

## LLM provider keys

Anthropic / OpenAI / Google API keys are passed to `pi --mode rpc` children
via the gateway's env. Rotate directly in the provider dashboard, then
update the gateway env + restart.

```sh
# 1. Mint a new key in the provider dashboard
# 2. Update apps/gateway/.env
#    ANTHROPIC_API_KEY=sk-ant-<new>
# 3. Restart the gateway
docker compose -f infra/compose.yaml restart gateway
# 4. New children pick up the new key on next spawn. Already-running
#    sessions keep their old env (extraEnv only applies at spawn time).
```

**Cadence:** provider-dependent. Anthropic and OpenAI have no required
rotation but recommend it annually. Google API keys have a max age of
90 days for some accounts. Document your cadence in your runbook.

## Gateway env (non-secret, but rotation-worthy)

Some env values change over time and need updates:

- `GATEWAY_RATE_LIMIT_*` — adjust if abuse patterns change
- `GATEWAY_MAX_CONVERSATIONS_PER_USER` — relax for paid users
- `GATEWAY_WORKSPACE_ALLOWLIST` — add repos as they're onboarded
- `PI_PROVIDER` / `PI_MODEL` — swap when the platform standardizes

These are picked up on gateway restart; no app code change needed.

## Sandd token

See `docs/ops/sandd.md` for the file-only token pre-seed flow. Token
rotation cadence should match Clerk secret keys (any time a developer
leaves, or quarterly as a default).

## PiSandboxed session files

The `/sessions` volume holds the pi session files for resume. If you
need to invalidate all sessions (e.g., to test recovery from a forced
restart), wipe the volume:

```sh
docker compose -f infra/compose.yaml stop gateway
docker compose -f infra/compose.yaml down -v pi-sessions
docker compose -f infra/compose.yaml up -d gateway
```

All existing threads will surface degraded state on next prompt
(session_state: degraded envelope) until the child respawns from a fresh
session file. Note: the banner UI shipped with the chat-first frontend and
is not yet ported to the thread surface — the envelope contract is intact.

## What NEVER to commit

`.env`, `.env.local`, `.env.*` files with real values — gitignored by
default. Verify with `git status` before any commit. Use `.env.example`
for templates.

## What to monitor for rotation

- `/metrics`: `aelvyril_rate_limited_total` and
  `aelvyril_conversation_limit_reached_total` rising means the limits are
  biting — either relax or communicate.
- `/healthz`: should always be 200. If 503+ for >1 minute, the gateway
  itself is in a bad state (corrupted DB? deadlock? restart needed).
