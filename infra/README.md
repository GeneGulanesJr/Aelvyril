# infra/

Docker stack + smoke verification for the Aelvyril agent platform (spec §4/§5/§9).

## Layout

```
infra/
├── README.md           ← this file
├── compose.yaml        ← 5 services: web, gateway, layamcp (dev + prod
│                          profiles) + caddy, sandd (prod profile only).
│                          LaPis is NOT a service — it runs in-process
│                          inside the gateway (LAPIS_HOME on gateway-data).
├── .env.example        ← template for every var compose interpolates
│                          (copy to infra/.env)
├── docker/
│   ├── Caddyfile       ← TLS termination (Let's Encrypt via ACME)
│   ├── Dockerfile.web       ← Next.js standalone, Node 22 slim, non-root
│   ├── Dockerfile.gateway   ← Node 22 + @earendil-works/pi-coding-agent
│   │                          (bin: `pi`), env-file-if-exists
│   ├── Dockerfile.sandd     ← built from ../PiSandboxed, /dev/kvm + SYS_ADMIN
│   └── Dockerfile.layamcp   ← built from ../../DecisionMCP via the
│                              `decisionmcp_src` named context, CPU-only torch
└── smoke.sh            ← boots compose dev profile + verifies healthchecks
```

## Quick start

Requires Docker + docker compose v2 + sibling repos cloned at `../LaPis`, `../PiSandboxed`, `../DecisionMCP` (ex-LayaMCP, renamed 2026-10-05). Operator must pre-seed the sandd auth token file (see comment in compose.yaml).

```sh
# Dev profile: web 3000 + gateway 8787 published LOOPBACK-ONLY (#79);
# layamcp stays internal (sandd is prod-profile only).
docker compose -f infra/compose.yaml --profile dev up -d --build

# Tail logs
docker compose -f infra/compose.yaml logs -f gateway

# Smoke: boots + verifies, then tears down
./infra/smoke.sh --down
```

The `prod` profile additionally starts Caddy for TLS termination. The
browser reaches the gateway **same-origin through Caddy** (`/v1/*` route,
#79) — set `NEXT_PUBLIC_GATEWAY_URL` to the empty string so the client
bundle is built for same-origin calls, and add your Clerk Frontend API
origins so the CSP allows sign-in:

```sh
AELVYRIL_DOMAIN=aelvyril.example.com \
NEXT_PUBLIC_GATEWAY_URL= \
CSP_CLERK_ORIGINS="https://clerk.acmeinc.com wss://clerk.acmeinc.com" \
  docker compose -f infra/compose.yaml --profile prod up -d --build
```

### Network exposure (#79)

- **Public (all interfaces):** only caddy (80/443).
- **Loopback-only:** web `3000` and gateway `8787` — dev/smoke
  convenience; plaintext never leaves the host. To drop them entirely,
  add an override file with `ports: !override []` under both services and
  start with `-f infra/compose.yaml -f <override>`.
- **Internal-only:** layamcp (and sandd via host networking).
- The gateway is never exposed unauthenticated: `/metrics` is gated by
  `GATEWAY_METRICS_SECRET`, and everything under `/v1/*` requires a Clerk
  JWT; in prod those paths are only reachable through the Caddy route.

## Two upstream patches (already shipped)

These patches live in the sibling repos — not in `infra/`:

- **LaPis @ `c49aeb3`** (`docs/decision-engine-plan` branch) — `LAPIS_PROJECT_KEY` env override at the top of `resolveProjectKey()` and `detectProject()` in LaPis. Without this, multi-user access to the same repo would collide on `basename(cwd)` and silently leak memory across users. See ADR 0002.
- **DecisionMCP (ex-LayaMCP) @ `e08ced4`** (`main`) — drops broken `mcp.server.fastapi.create_fastapi_app` (crashes on every released SDK today), mounts `mcp.server.sse.SseServerTransport` on plain FastAPI, pins `mcp[server]<2`, adds `GET /health`. Without this, `layamcp` would not start at all.

## Notable constraints

- **Sandd uses `network_mode: host`** — its bind host is hardcoded to `127.0.0.1` upstream (`src/server/main.ts:59`); no `SANDD_HOST` env exists. Until upstream adds it, sandd can't be reached from another container over the bridge network. Tracked as Phase 4 deferred work.
- **Sandd auth is file-only** (`~/.pisandboxed/token`, `0600`). The `sandd-token` volume is pre-seeded by the operator; the Dockerfile mounts it at `/token/token`.
- **Layamcp healthcheck `start_period: 120s`** — cold model load is ~120s on first boot. Without that grace period, docker kills the container before models are resident.
- **Caddy persists certs in `caddy-data` + `caddy-config` volumes** — restarts don't re-request Let's Encrypt.

## Sibling-checkout layout

Backing-service Dockerfiles build from sibling repos:

```
~/Documents/GulanesKorp/
├── Aelvyril/         ← this repo
├── LaPis/            ← LAPIS_PROJECT_KEY patch lives here
├── PiSandboxed/
└── DecisionMCP/      ← FastAPI patch lives here (ex-LayaMCP, renamed 2026-10-05)
```

Prebuilt images replace the sibling-checkout builds once each backing service has a release.

## Verification

`infra/smoke.sh`:

1. Preflight (before anything boots): requires `NEXT_PUBLIC_AUTH_DISABLED=1`
   + `PI_FAKE=1` in `infra/.env` (or real Clerk keys in the env); with
   `PI_FAKE=1` and no Clerk key it also requires
   `PI_FAKE_ALLOW_NON_LOOPBACK=1`. Preflight failures exit 2.
2. Boots `docker compose --profile dev up -d --build`.
3. Polls `http://127.0.0.1:8787/healthz` until the gateway responds 200
   (30 × 1s attempts).
4. Polls `http://127.0.0.1:3000/` until the web responds 200 (30 × 1s
   attempts). It does NOT probe layamcp from a one-off container — a 200
   from gateway `/healthz` already implies layamcp answered its TCP probe,
   because compose sets `LAYAMCP_URL` on the gateway.
5. Exit codes: 0 = pass; 2 = preflight failure (or unknown argument);
   3 = a health poll never went healthy.
6. With `--down`, compose is torn down on EVERY exit path (the argument is
   parsed up front and the teardown is wired through the script's EXIT
   trap, which preserves the original rc).

The smoke is intentionally minimal — it proves the stack is up + Clerk routing works. Full sign-in → prompt → SSE round-trip is covered by the live browser smoke + the e2e Playwright tests (see `e2e/` at repo root).
