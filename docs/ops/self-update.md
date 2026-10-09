# Self-update runbook

`scripts/self-update.mjs` ("the keeper") keeps a **host-process deployment**
of Aelvyril current with `origin/main` and safe while doing it: new code
arrives via git, the stack is health-verified before **and** after every
update, and a failed update is rolled back to the last known-good commit
automatically. It runs the same stack the Docker compose file models
(web `next dev` on :3000, gateway tsx on :8787) but as bare processes —
this machine has no Docker, and compose's `restart: unless-stopped` has no
equivalent here, so the keeper owns restarts too.

## Why a separate process

The gateway already has an admin-gated manual updater
(`apps/gateway/src/updater.ts` → `POST /v1/admin/update/apply`), but it
ends by SIGTERM-ing the gateway. In Docker something revives it; on a bare
host nothing does, and a dead gateway cannot roll itself back. The keeper
is a separate process that outlives every service restart, so rollback
always has a live brain. Keep using the admin route for "update now from
the UI"; the keeper is the unattended path.

## Quick start

```sh
# One check + apply cycle (exit 0 when up to date or updated cleanly)
pnpm self-update

# Continuous: check every SELF_UPDATE_INTERVAL_S (default 300s)
pnpm self-update:loop

# Operator commands
pnpm self-update --status    # HEAD vs origin/main, health, breaker state
pnpm self-update --restart   # bounce web + gateway now, verify health
pnpm self-update --rollback [sha]   # restore a commit (default: last good)
pnpm self-update --reset     # clear failure counter + re-arm breaker
```

Run it at login via Task Scheduler (pin the node24 absolute path — the
default `node` on this machine is v14):

```sh
schtasks /Create /TN "Aelvyril self-update" /SC ONLOGON /TR ^
  "\"C:\Users\ggulanes\Desktop\New folder\New folder\node-v24.16.0-win-x64\node.exe\" C:\Users\ggulanes\Desktop\Aelvyril\scripts\self-update.mjs --loop"
```

## The gates (checks and balances, in order)

1. **Consecutive-failure breaker** — after `SELF_UPDATE_MAX_FAILURES` (3)
   failed updates in a row the keeper writes `.self-update/disabled` and
   refuses to keep trying. A broken upstream cannot wedge the loop.
2. **Preflight health** — the stack must be healthy _before_ an update
   ("update when it's running ok"). An unhealthy stack is never made worse
   by pulling new code on top; the keeper skips and waits.
3. **CI gate** (opt-in, `SELF_UPDATE_REQUIRE_CI=1`) — origin/main must have
   green check runs on GitHub before it is deployed. Fail-open on API
   hiccups, fail-closed on red CI.
4. **Clean tree** — any local modification blocks the update, except the
   generated-file allowlist (`apps/web/next-env.d.ts`, which `next dev`
   rewrites constantly; it is auto-restored, not preserved). Operator work
   is never clobbered.
5. **Surgical restarts** — the keeper diffs `HEAD..origin/main` and
   restarts only what changed (`apps/gateway/*`, `apps/web/*`; anything
   under `packages/` bounces both). A docs-only commit touches nothing.
6. **Post-update verification** — after restart, every health URL must
   answer within `SELF_UPDATE_HEALTH_TIMEOUT_S` (120s). The gateway's
   `/healthz` counting as "alive on a 503 with `gateway.ok: true`" is
   deliberate: an optional backing service (layamcp cold load) failing its
   probe is not a bad gateway deploy.
7. **Automatic rollback** — failed verification → `git reset --hard` to the
   previous commit, reinstall if the lockfile regressed, restart, verify
   again. Restored = exit 4 (once-mode); still sick = breaker trips.

## State (all in `.self-update/`, gitignored)

| File                     | Meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `state.json`             | last known-good sha + timestamp, consecutive failure count            |
| `disabled`               | breaker marker — auto-updates refuse until you delete it or `--reset` |
| `history.log`            | one line per state change: applied / rolled-back / breaker            |
| `gateway.log`, `web.log` | stdout+stderr of relaunched services (5MB rotate)                     |
| `keeper.log`             | the keeper's own log (survives Task Scheduler runs)                   |
| `lock`                   | pid lock — a dead holder is taken over, a live one blocks             |

## Environment knobs (all optional)

| Var                                      | Default                  |                                                 |
| ---------------------------------------- | ------------------------ | ----------------------------------------------- |
| `SELF_UPDATE_INTERVAL_S`                 | `300`                    | loop tick interval                              |
| `SELF_UPDATE_STATE_DIR`                  | `.self-update`           | where state lives                               |
| `SELF_UPDATE_HEALTH_TIMEOUT_S`           | `120`                    | post-restart verify window                      |
| `SELF_UPDATE_MAX_FAILURES`               | `3`                      | consecutive failures before the breaker         |
| `SELF_UPDATE_HEALTH_URLS`                | gateway + web            | comma-separated                                 |
| `SELF_UPDATE_GATEWAY_PORT` / `_WEB_PORT` | `8787` / `3000`          | kill targets                                    |
| `SELF_UPDATE_GATEWAY_CMD` / `_WEB_CMD`   | see source               | full replacement launch command (shell)         |
| `SELF_UPDATE_REQUIRE_CI`                 | off                      | gate on green GitHub check runs                 |
| `SELF_UPDATE_WEB_BUILD`                  | off                      | run `next build` (needed only for `next start`) |
| `SELF_UPDATE_ALLOWLIST`                  | `apps/web/next-env.d.ts` | always-dirty generated files                    |
| `SELF_UPDATE_REF`                        | `origin/main`            | what to track                                   |

## Restart semantics on Windows

Service restart is a hard cut: `taskkill /F /T` on whatever listens on the
port (console node has no window to close, so there is no graceful
taskkill), then a detached relaunch that survives the keeper's exit.
Threads mid-turn are degraded by the gateway's reap path (that is exactly
the PR #93 behavior), and the DB is WAL SQLite — restarts are recoverable
by design. The keeper does not check for active streaming before cutting;
schedule the loop away from active hours if that matters.

## Not covered (deliberately)

- **Sibling repos** (`../LaPis`, `../PiSandboxed`, `../DecisionMCP`) are
  not auto-updated — they carry hand-applied patches (ADR 0002, infra
  README). Aelvyril-only by design until prebuilt images exist.
- **Prod web mode**: if you switch web to `next start`, set
  `SELF_UPDATE_WEB_BUILD=1` and `SELF_UPDATE_WEB_CMD` accordingly.
- **Crash supervision**: the keeper restarts services during updates only;
  it is not a general "restart on death" watchdog.
