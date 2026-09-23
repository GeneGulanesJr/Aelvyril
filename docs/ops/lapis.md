# LaPis ops runbook

LaPis is the memory layer. Gateway and `lapis` container share the same
`memory.db` file on the `lapis-data` volume (spec §5/§8).

## Per-conversation namespaces

Phase 4 patch (commit `c49aeb3` in the LaPis repo) added the
`LAPIS_PROJECT_KEY` env override at the top of two functions:

- `src/hooks-engine/project.js resolveProjectKey()`
- `extensions/memory-layer/host/project-detector.ts detectProject()`

The gateway sets this per spawn via `extraEnv` in `Supervisor.prompt`:

```js
supervisor.prompt(id, msg, undefined, { LAPIS_PROJECT_KEY: namespace });
```

The namespace is derived from the Clerk user ID (`user:<id>.toLowerCase()`,
see `packages/shared/src/namespace.ts`). Without this override, multiple
users accessing the same repo would collide on `basename(cwd)` and
share memory — silent data leak.

## Common errors

### "Resource not found" for a project that exists

The CLI session doesn't have admin on the Clerk app. The runtime auth
uses the env keys directly and works regardless of CLI link state.

### DB locked

SQLite WAL with multiple processes. The `lapis` container opens the DB
read-only via WAL while the gateway writes through `Store`. If you see
`database is locked`, the most likely cause is a long-running transaction
in the `lapis` container — check its logs for stalled queries.

### Namespace leak across users

Means `LAPIS_PROJECT_KEY` is NOT being set on the spawn. Verify:

```sh
# Dev: check the gateway's spawnChild mock captures the env
grep -A3 'LAPIS_PROJECT_KEY' apps/gateway/src/supervisor.test.ts

# Prod: docker exec into the gateway, check the env of a recent child
docker compose -f infra/compose.yaml exec gateway ps -ef
# The pi child should have LAPIS_PROJECT_KEY=user:...
```

If absent, the patch isn't deployed — rebuild the gateway image with
the latest commit.

## Resetting memory (DESTRUCTIVE)

```sh
# Stop both gateway and lapis containers
docker compose -f infra/compose.yaml stop gateway lapis

# Wipe the volume
docker compose -f infra/compose.yaml down -v lapis-data

# Restart — the LaPis container recreates the schema
docker compose -f infra/compose.yaml up -d lapis gateway
```

## Schema migrations

LaPis handles its own migrations internally. The gateway only reads
events from SQLite — no schema coupling. If you see gateway errors
about `events` table missing after a LaPis upgrade, the gateway's
WAL hasn't picked up the new schema. Restart the gateway.
