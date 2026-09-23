# infra/

Placeholder. Phase 4 of the implementation plan (see `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §5, §9) owns this directory.

## What lands here in Phase 4

- `docker/Dockerfile.web` — Next.js standalone, Node 22 slim, non-root user. Only published port.
- `docker/Dockerfile.gateway` — Node 22 + `pi` CLI + baked `~/.pi/agent` (LaPis + PiSubagent extensions, project agents, `settings.json` with `layamcp` MCP). workspaces bind mount, sessions volume, supervisor.
- `docker/Dockerfile.lapis` — built from `../LaPis`; mounts `lapis-data` volume.
- `docker/Dockerfile.sandd` — built from `../PiSandboxed`; `/dev/kvm` passthrough, `sandbox-images` volume, port 7391. Auth via pre-seeded token **file** (no env var), `0600`. Bind host hardcoded `127.0.0.1` until upstream adds `SANDD_HOST`.
- `docker/Dockerfile.layamcp` — Python slim + `pip install ../LayaMCP`; CPU-only torch; HF-models cache volume; 4GB+ RAM; TCP healthcheck (port-open ≈ models-resident). Mounts MCP transport on plain FastAPI (current `mcp.server.fastapi` import crashes on released SDKs — upstream fix owned here), pins `mcp<2`, adds `/health`.
- `compose.yaml` — full stack, dev + prod profiles, healthchecks + `depends_on: service_healthy`, `restart: unless-stopped`. Dev profile bind-mounts `apps/*` for hot reload.
- `smoke.sh` — boot compose, run one real conversation end-to-end (sign in via Clerk test mode, send a prompt, assert SSE envelopes arrive, assert child process exits on idle reap).

## Sibling-checkout layout

Backing-service Dockerfiles build from sibling repos (`../LaPis`, `../PiSandboxed`, `../LayaMCP`). Devs clone Aelvyril alongside them:

    ~/Documents/GulanesKorp/
    ├── Aelvyril/         ← this repo
    ├── LaPis/
    ├── PiSandboxed/
    └── LayaMCP/

Prebuilt images replace the sibling-checkout builds once each backing service has a release.

## Two upstream patches owned here

- **LaPis**: `LAPIS_PROJECT_KEY` env override at the top of `src/hooks-engine/project.js:135` (`resolveProjectKey`) and `extensions/memory-layer/host/project-detector.ts:95` (`detectProject`). Lowercase on read. No schema impact; backward compatible. See `docs/adr/0002-lapis-project-key-namespace-injection.md`.
- **LayaMCP**: drop the `mcp.server.fastapi` import (crashes on any released SDK today); mount the MCP transport on plain FastAPI; pin `mcp<2`; add `/health`. ~20 lines.

`SANDD_HOST` is a nice-to-have upstream addition (currently hardcoded `127.0.0.1` in `src/server/main.ts:59`); tracked but not blocking.

## Why this is empty in main today

Phase 1 (gateway core) and Phase 2 (web chat) ship without Docker — `pnpm --filter @aelvyril/gateway start` and `pnpm --filter @aelvyril/web dev` work natively on a dev machine with Node 22. Docker lands in Phase 4 when the gateway is ready to wire into LaPis/sandd/layamcp.