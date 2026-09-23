# LayaMCP ops runbook

`layamcp` is the decision engine. Exposes 11 classify tools over MCP.
CPU-only torch (per spec §9 — ~4GB RAM).

## Cold model load

Models load at module import (not lazily). The Docker healthcheck has
`start_period: 120s` to cover this. If the healthcheck fails during
boot:

```sh
docker compose -f infra/compose.yaml logs layamcp
# Look for "loading model" / "loaded model" or download errors
```

The HF model cache is in `/root/.cache/huggingface` (volume
`hf-models`). If empty, the model downloads on every boot — slow +
bandwidth-heavy. Pre-warm:

```sh
docker compose -f infra/compose.yaml exec layamcp python -c \
  "import laya_mcp.bridge; laya_mcp.bridge.LayaBridge(preload=['auto']).warmup()"
```

## /health endpoint

Phase 4 patch (commit `e08ced4`) added `GET /health` returning
`{status: "ok", tools: N}`. TCP-port-open ≈ models-resident (models
loaded at module import).

If `/health` returns non-200:

```sh
docker compose -f infra/compose.yaml exec layamcp curl -sv http://127.0.0.1:8765/health
```

Common causes:
- Models still loading (wait longer; check logs)
- Port not bound (`LAYAMCP_PORT` env)
- Process crashed (check exit logs)

## Phase 4 patch context

Before the patch, `mcp.server.fastapi.create_fastapi_app` was imported
— that API was removed in `mcp` 1.x and crashes on import. The patch
mounts `mcp.server.sse.SseServerTransport` on plain FastAPI. If you see
`ImportError: cannot import name 'create_fastapi_app'`, the patch
wasn't deployed — rebuild with the latest LayaMCP commit.

`pyproject.toml` pins `mcp[server]<2` to keep the SSE-on-FastAPI mounting
stable.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `LAYAMCP_HOST` | `127.0.0.1` | Bind host (loopback only — exposed via Docker network, not published port) |
| `LAYAMCP_PORT` | `8765` | Bind port |
| `LAYAMCP_PRELOAD_MODELS` | `auto` | Preload model IDs at import |
| `LOG_LEVEL` | `INFO` | Log verbosity |

## Scaling notes

- **Stateless**: model cache is read-only after warmup. Horizontally
  scaling is fine — each instance loads its own copy of the model.
- **No auth** (relies on network isolation). Compose network keeps it
  internal; production needs network policy or auth at the gateway.
- **CPU-only inference**: spec §9 budgets 200-500ms per call. If a
  tool is timing out, check CPU contention with `docker stats`.
