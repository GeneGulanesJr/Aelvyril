# LaPis memory: SQLite on a shared volume with WAL, gateway and `lapis` container both readers

`apps/gateway` and the `lapis` container open the same `memory.db` file on a shared Docker volume. The Pi extension (gateway side) opens it directly via `better-sqlite3` (`LAPIS_HOME`-based) for the hot chat path; the `lapis` container runs the HTTP/MCP server over the same file for future memory-browser panels and external MCP clients.

**Why one file with WAL (and not separate DBs, or a network DB):**
- **One user's memory must be visible to both the chat path and any external API.** Splitting per-container DBs means `lapis` reads stale data after the gateway writes (or vice versa). Replicating adds ops surface we don't need at v1 scale.
- **Multi-process SQLite on one host volume is safe with WAL.** SQLite documents concurrent readers + one writer across processes on the same host as a supported pattern. The `lapis` container runs on the same Docker host as the gateway (single-node dev and prod at v1), so they share the host filesystem through the volume — not separate containers on separate machines.
- **Hot path stays in-process.** The Pi extension opens `better-sqlite3` directly, not over HTTP. Tool-guardrail hooks in LaPis run in the agent's child process and need sub-millisecond reads; an HTTP hop per check would dominate.
- **`lapis` is the API for the future, not a required chat dependency.** If the `lapis` container is down, the chat path is unaffected — the Pi extension reads the DB directly. Only future panels and external MCP clients depend on `lapis`. That is the decoupling.

**The pattern:**
- `lapis-data` named volume, mounted read-write into both `gateway` (Pi extension reads/writes) and `lapis` (HTTP server reads).
- `journal_mode = WAL` set by the Pi extension at startup (`Store` constructor mirrors this for the gateway's own event log too — see `apps/gateway/src/store.ts`).
- `LAPIS_HOME=/data/lapis` set on every `pi --mode rpc` child (`extraEnv` in `apps/gateway/src/app.ts`); the path resolves inside both containers.

**Considered alternatives (rejected):**
- *Postgres / MySQL* — premature. The chat path is one writer per user (`user:<clerkUserId>` namespace), a few hundred writes per minute at peak. SQLite WAL handles that trivially; an external DB is a multi-day ops project for zero functional benefit at v1.
- *Per-user SQLite files* — solves the "all users share one file" anxiety, but `lapis` would have to open every user's file on every request to do a cross-project lookup (the "opt-in platform-level facts" scope in spec §2). One file with namespace scoping is the right shape.
- *Stateless LaPis (HTTP-only)* — adds a network hop per tool guardrail; chat latency budget can't afford it.

**Migration path when we outgrow this:**
- The Pi extension's DB access is one module (`extensions/memory-layer`); swapping `better-sqlite3` for a network driver is a contained change. The gateway event log stays on its own SQLite file (it is platform-internal state, not user memory).
- Multi-node scale-out would push us to a hosted Postgres with the same zod envelope shapes — code that consumes `EventEnvelope` doesn't change.

**Consequences:**
- `data/` (gateway's own SQLite for conversations/events) is gitignored — `memory.db` lives on the Docker volume in prod, in `lapis-data` (also gitignored).
- `lapis` being down does not break chat. The reverse is also true: gateway being down breaks the chat path AND `lapis`. That is the correct asymmetry — chat is the only required surface.
- `LAPIS_HOME` is a contract. If the LaPis upstream ever changes its DB location heuristic, every Aelvyril child must be updated.

Status: accepted 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md`, decision D8). Phase 1 ships the gateway's own SQLite; Phase 4 wires `lapis` container + shared volume + upstream `LAPIS_PROJECT_KEY` patch.