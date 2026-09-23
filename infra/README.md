# infra/

Docker stack + smoke verification for the Aelvyril agent platform (spec §4/§5/§9).

## Layout

```
infra/
├── README.md           ← this file
├── compose.yaml        ← 5 services (web, gateway, caddy, lapis, sandd, layamcp)
├── docker/
│   ├── Caddyfile       ← TLS termination (Let's Encrypt via ACME)
│   ├── Dockerfile.web       ← Next.js standalone, Node 22 slim, non-root
│   ├── Dockerfile.gateway   ← Node 22 + @mariozechner/pi, env-file-if-exists
│   ├── Dockerfile.lapis     ← built from ../LaPis
│   ├── Dockerfile.sandd     ← built from ../PiSandboxed, /dev/kvm + SYS_ADMIN
│   └── Dockerfile.layamcp   ← built from ../LayaMCP, CPU-only torch
└── smoke.sh            ← boots compose dev profile + verifies healthchecks
```

## Quick start

Requires Docker + docker compose v2 + sibling repos cloned at `../LaPis`, `../PiSandboxed`, `../LayaMCP`. Operator must pre-seed the sandd auth token file (see comment in compose.yaml).

```sh
# Dev profile (port 3000 only — gateway + backing services stay internal)
docker compose -f infra/compose.yaml --profile dev up -d --build

# Tail logs
docker compose -f infra/compose.yaml logs -f gateway

# Smoke: boots + verifies, then tears down
./infra/smoke.sh --down
```

The `prod` profile additionally starts Caddy for TLS termination:

```sh
AELVYRIL_DOMAIN=aelvyril.example.com \
  docker compose -f infra/compose.yaml --profile prod up -d --build
```

## Two upstream patches (already shipped)

These patches live in the sibling repos — not in `infra/`:

- **LaPis @ `c49aeb3`** (`docs/decision-engine-plan` branch) — `LAPIS_PROJECT_KEY` env override at the top of `resolveProjectKey()` and `detectProject()` in LaPis. Without this, multi-user access to the same repo would collide on `basename(cwd)` and silently leak memory across users. See ADR 0002.
- **LayaMCP @ `e08ced4`** (`main`) — drops broken `mcp.server.fastapi.create_fastapi_app` (crashes on every released SDK today), mounts `mcp.server.sse.SseServerTransport` on plain FastAPI, pins `mcp[server]<2`, adds `GET /health`. Without this, `layamcp` would not start at all.

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
└── LayaMCP/          ← FastAPI patch lives here
```

Prebuilt images replace the sibling-checkout builds once each backing service has a release.

## Verification

`infra/smoke.sh`:
1. Boots `docker compose --profile dev up -d --build`.
2. Polls `http://127.0.0.1:8787/healthz` until the gateway responds 200.
3. Probes `http://layamcp:8765/health` from a one-off container (layamcp is internal-only).
4. Polls `http://127.0.0.1:3000/` until the web responds 200.
5. Exits 0 on success, exits 3 on healthcheck failure.
6. With `--down`, also tears down compose.

The smoke is intentionally minimal — it proves the stack is up + Clerk routing works. Full sign-in → prompt → SSE round-trip is covered by the live browser smoke + the e2e Playwright tests (see `e2e/` at repo root).
