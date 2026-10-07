# DecisionMCP ops runbook (service key: `layamcp`)

`layamcp` is the decision engine — the sibling repo **DecisionMCP** (ex-
LayaMCP, renamed 2026-10-05 at v0.2.0). Exposes **13 decision tools** over
MCP: streamable HTTP at `/mcp` (primary) and legacy SSE at `/sse`. CPU-only
torch (per spec §9 — ~4GB RAM). The compose service key and the gateway's
`LAYAMCP_URL` env keep the `layamcp` name for compatibility.

## Cold model load

Models load at process start (`DECISIONMCP_PRELOAD_MODELS=true`, the
default). The Docker healthcheck has `start_period: 120s` to cover this.
If the healthcheck fails during boot:

```sh
docker compose -f infra/compose.yaml logs layamcp
# Look for "Starting DecisionMCP" / "loaded model" or download errors
```

The HF model cache is in `/root/.cache/huggingface` (volume
`hf-models`). If empty, the model downloads on every boot — slow +
bandwidth-heavy. Pre-warm:

```sh
docker compose -f infra/compose.yaml exec layamcp python -c \
  "from decision_mcp.bridge import DecisionBridge; DecisionBridge(preload=True)"
```

## /health endpoint

`GET /health` returns `{status: "ok", tools: N}`. TCP-port-open ≈
models-resident (models loaded at startup).

If `/health` returns non-200:

```sh
docker compose -f infra/compose.yaml exec layamcp curl -sv http://127.0.0.1:8765/health
```

Common causes:
- Models still loading (wait longer; check logs)
- Port not bound (`DECISIONMCP_PORT` env)
- Process crashed (check exit logs)

## v0.2.0 rename context

The sibling repo renamed `laya_mcp` → `decision_mcp`, the console script
`layamcp` → `decisionmcp`, tools `laya_*` → `decision_*`, and env prefix
`LAYAMCP_*` → `DECISIONMCP_*` (old names are silently ignored). The engine
is now pluggable (`DecisionEngine` protocol; Laya is the default). See the
sibling's `docs/MIGRATION.md`.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `DECISIONMCP_HOST` | `127.0.0.1` (`0.0.0.0` in the Aelvyril image) | Bind host — container binds all interfaces so peers on `aelvyril-net` can reach it; no host port is published |
| `DECISIONMCP_PORT` | `8765` | Bind port |
| `DECISIONMCP_PRELOAD_MODELS` | `true` | Load model weights at startup (bool; `false` defers to first call) |
| `DECISIONMCP_LOG_LEVEL` | `INFO` | Log verbosity |
| `DECISIONMCP_USAGE_ENABLED` | `true` | SQLite usage/session log (training data) |
| `DECISIONMCP_ALLOW_UPDATES` | `false` | Opt-in for `decision_update apply` (runs pip; keep off — no auth) |

## Scaling notes

- **Stateless**: model cache is read-only after warmup. Horizontally
  scaling is fine — each instance loads its own copy of the model.
- **No auth** (relies on network isolation). Compose network keeps it
  internal; production needs network policy or auth at the gateway.
- **CPU-only inference**: spec §9 budgets 200-500ms per call. If a
  tool is timing out, check CPU contention with `docker stats`.
