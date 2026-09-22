# Aelvyril — Agent Platform: Design

**Date:** 2026-09-22
**Status:** Approved design, pending implementation plans
**Repo:** `~/Documents/GulanesKorp/Aelvyril` (fresh start — prior "missions orchestrator" tree wiped; history preserved at `c54dbb4`)

---

## 1. Summary

Aelvyril is the web frontend for the GulanesKorp agent platform. Users chat with **Pi** (main coding agent) which can spawn **PiSubagent** sub-agents, shares **LaPis** memory, executes untrusted code via **PiSandboxed** microVMs, and uses **LayaMCP** decision tools — the whole stack running in Docker.

Product shape: **chat-first now, ops surfaces later.** v1 is a clean chat experience; the backend captures every agent/system event from day one so ops panels (subagent activity, sandbox status, memory browser, Laya verdicts) can be added without rework.

## 2. Users & Tenancy

- **Multi-user from day one** via **Clerk** (hosted auth). v1 data is realistically single-user, but nothing assumes that.
- **Per-user memory namespaces:** each Clerk user maps to a LaPis project-scope namespace (`user:<clerkUserId>`). Conversations never cross namespaces. Opt-in platform-level facts live in a shared scope (LaPis-native cross-project lookup).
- Namespace enforcement is **server-side only** — clients cannot name a namespace.

## 3. Decision Log

| # | Decision | Choice | Rationale (short) |
|---|----------|--------|-------------------|
| D1 | Product shape | Chat-first, ops-later (C) | Event streams captured now; panels later cost nothing |
| D2 | Audience | Multi-user, Clerk auth | Real accounts from day one; hardening later is config |
| D3 | Agent workload | Workspace-optional (C) | Some chats are platform-level, some project-scoped coding sessions |
| D4 | Memory tenancy | Per-user namespaces via LaPis project scope (B) | Cheap now (one upstream env knob), airtight later |
| D5 | Architecture | Split `web` + `gateway` services (Approach 2) | Session lifecycle owns one home; UI redeploys never kill agents; gateway is the reusable API |
| D6 | Session host | **Child process per conversation** (`pi --mode rpc`) | `process.cwd()` is process-global — in-process multi-session breaks cwd-derived extensions (LaPis reads it in tool-guardrails, code-tools, doc-tools). Child processes give real cwd, real env, crash isolation |
| D7 | Namespace mechanism | `LAPIS_PROJECT_KEY` env override in LaPis `projectFromCwd()` | 3-line upstream change in LaPis (our repo); backward compatible; per-child env makes it per-session safe |
| D8 | Memory access | SQLite on shared volume, WAL; `lapis` container = HTTP/MCP API surface | LaPis extension opens better-sqlite3 directly (doesn't call HTTP); multi-process SQLite on one host volume is safe with WAL; HTTP surface reserved for future memory browser / external clients |

## 4. Topology

Visual: [`docs/design/stack-topology.html`](../design/stack-topology.html)

One Docker network (`aelvyril-net`), five services:

```
Browser ── Clerk (cloud, outside Docker)
   │ HTTPS + Clerk JWT
   ▼
web (Next.js) ── SSE events / POST prompts ──▶ gateway (Fastify)
                                                  │ per-conversation: pi --mode rpc child
                                                  │ (LaPis + PiSubagent extensions, LayaMCP MCP config)
                    ┌─────────────────────────────┼──────────────────────────┐
                    ▼ bearer HTTP                 ▼ bearer + /dev/kvm        ▼ MCP over HTTP
                 lapis                         sandd (PiSandboxed)        layamcp (Laya)
                 (HTTP/MCP over               smolvm microVMs            11 classify tools
                  shared memory.db)            promote-only escape        CPU, ~33ms
   volumes: lapis-data · gateway-data · pi-sessions · sandbox-images · hf-models · workspaces/ (bind, rw)
```

- **"All agents share LaPis" is structural:** main Pi session and all spawned subagents live in one child process tree per conversation, all opening the same `memory.db`.
- **Hardware:** `sandd` needs `/dev/kvm` passthrough (libkrun/KVM). `layamcp` is CPU-only; HF checkpoints (~800MB) cached on a volume so rebuilds don't re-download.

## 5. Monorepo Layout

```
Aelvyril/
├── apps/
│   ├── web/            # Next.js (App Router) + Clerk — pure UI
│   └── gateway/        # Fastify — supervisor, RPC clients, auth, event log, SSE
├── packages/
│   └── shared/         # zod API contracts + event envelope types + thin service clients
├── infra/
│   ├── docker/         # per-service Dockerfiles (web, gateway, lapis, sandd, layamcp)
│   ├── compose.yaml    # full stack; dev + prod profiles
│   └── smoke.sh        # boot compose, run one real conversation end-to-end
├── docs/
│   ├── design/         # topology diagram
│   └── superpowers/specs/
└── pnpm-workspace.yaml
```

Backing-service build contexts point at sibling checkouts (`../LaPis`, `../PiSandboxed`, `../LayaMCP`) — documented clone-layout requirement for dev; prebuilt images later.

## 6. Session Lifecycle & Data Flow

1. `POST /v1/conversations` `{title?, workspace?}` → index DB row. No process spawned.
2. First prompt lazily spawns a **session host**: `pi --mode rpc` child process with:
   - `cwd` = `/workspaces/<repo>` (workspace-scoped) or `/home/agent` (fixed scratch dir for platform-level chats)
   - env: provider keys, `LAPIS_PROJECT_KEY=user:<clerkUserId>`, `LAPIS_HOME=/data/lapis`
   - `~/.pi/agent` baked into the gateway image: LaPis + PiSubagent extensions, agents (`scout`/`planner`/`reviewer`/`worker`), `settings.json` with `layamcp` MCP server at `http://layamcp:8765`
3. Gateway returns `202`; client opens `GET /v1/conversations/:id/events` (SSE).
4. Prompts: `POST …/prompt` (`steer` / `followUp` semantics while streaming, per RPC protocol); `POST …/abort`.
5. Idle children disposed after timeout; conversation history lives in pi session files (volume). Gateway restart or crash → conversation resumes from disk on next prompt.

**Event envelope** — everything the browser sees:

```
{ seq, conversationId, ts, kind, payload }
kinds: text_delta · tool_call · tool_result · subagent_spawn
     · sandbox_exec · sandbox_promote · laya_verdict · session_state · error
```

- Appended to gateway SQLite event log **before** SSE push; reconnect replays from `Last-Event-ID`.
- Subagent activity appears as `subagent_spawn`/`tool_call` in v1; deep subagent-internal streams are a later extension of the same envelope, not a protocol change.
- Sandbox flow: tool call → gateway → `sandd` bearer HTTP → microVM → promote-only results back as `tool_result` + `sandbox_exec`. Laya verdicts surface as `laya_verdict` events.

## 7. LaPis Integration & Namespaces

**Ground truth from code:** `projectFromCwd()` (`src/hooks-engine/project.js:34`) keys memory by `basename(cwd).toLowerCase()`. The Pi extension opens the SQLite DB directly (`better-sqlite3`, `LAPIS_HOME`-based); several extension modules read `process.cwd()` directly.

Consequences (why D6/D7 exist):
- In-process multi-session in the gateway would share/trample `process.cwd()` → rejected.
- Multi-user on the same repo would collide on `basename(cwd)` → namespace must be injectable.
- **Upstream LaPis change (D7):** `projectFromCwd()` returns `process.env.LAPIS_PROJECT_KEY || basename(cwd)`. ~3 lines, backward compatible (host CLI unaffected). Gateway injects per child.
- `lapis` container runs the HTTP/MCP server over the same `memory.db` volume (WAL). It is the API for a future memory-browser panel and external MCP clients — not a required dependency of the chat path.

## 8. Auth & Secrets

- Web: Clerk publishable key + Clerk components. Gateway: JWT verification via JWKS (`@clerk/fastify` or `jose`).
- Gateway is the **only** identity authority; backing services are network-internal and take static bearer tokens from `.env` (LaPis key, sandd token). Only `web` publishes a host port (3000); dev overrides may expose gateway for curl.
- LLM provider keys exist only in gateway env → passed to children. Never sent to the browser.
- Secrets via gitignored `.env` + compose `env_file`; bootstrap token files (e.g., sandd's) shared by read-only volume mount where env override isn't supported (verify at implementation).

## 9. Docker Packaging

| Service | Image basis | Notable |
|---|---|---|
| `web` | Next.js standalone, Node 22 slim, non-root | only published port |
| `gateway` | Node 22 + pi CLI + baked `~/.pi/agent` | workspaces bind mount, sessions volume, supervisor |
| `lapis` | built from `../LaPis` | mounts lapis-data volume (same volume gateway mounts) |
| `sandd` | built from `../PiSandboxed` | `/dev/kvm` device, sandbox-images volume, port 7391 internal |
| `layamcp` | Python slim + `pip install ../LayaMCP` | hf-models cache volume, ~2GB RAM limit, CPU |

Healthchecks + `depends_on: service_healthy` everywhere; `restart: unless-stopped`; dev profile bind-mounts `apps/*` for hot reload.

## 10. Error Handling

- **Child crash:** supervisor marks conversation `degraded`; next prompt resumes a fresh child from the pi session file; user sees a `session_state` event ("agent restarted, context restored").
- **Stall detection:** no events for 90s (configurable) → `abort()` → 10s grace → hard kill + restart.
- **Backing service failures fail soft:** tool errors flow back to the model (it can react); UI gets `error` events + banner (e.g., "memory degraded — chat continues"). `layamcp` cold model load gated by a model-loaded healthcheck.
- **Abuse caps:** per-user rate limit, 1MB max message size, concurrent-conversation cap (v1: 3/user), **workspace allowlist** (only curated repos mountable — no arbitrary host paths via chat). Exact rate-limit numbers pinned in the Phase 5 plan.

## 11. Testing

- **Unit (vitest):** supervisor lifecycle vs scripted fake child; namespace mapping; envelope normalization; JWT middleware (mocked JWKS).
- **Contract:** thin clients for LaPis/sandd/layamcp — offline fixtures + `@live`-tagged smokes.
- **Integration:** gateway + fake child → full prompt→SSE→persist path; `infra/smoke.sh` = all 5 services healthy + one real conversation.
- **E2E (Playwright + Clerk test mode):** sign-in gate, send/stream/receive, reconnect replay.
- Real-pi RPC behavior stays in `@live` tests, never permanently mocked.

## 12. Build Phases

Each phase = one implementation plan cycle.

0. **Scaffold** — pnpm workspaces, zod contracts package, CI (typecheck/lint/unit)
1. **Gateway core** — supervisor + RPC bridge + event log + SSE (fake child, no auth)
2. **Web chat** — Next.js + Clerk → gateway; first streaming conversation
3. **Real pi** — RPC client vs real binary, session resume, workspace attach, conversation list
4. **The stack** — compose for lapis/layamcp/sandd, `LAPIS_PROJECT_KEY` upstream change, namespace wiring, sandbox flow
5. **Hardening** — rate limits, caps, banners, smoke script, ops docs

## 13. Glossary

| Term | Meaning |
|---|---|
| **Conversation** | A chat thread; index DB row + associated pi session file(s). Survives restarts |
| **Session host** | The per-conversation `pi --mode rpc` child process |
| **Supervisor** | Gateway component spawning/watching/reaping session hosts |
| **Workspace** | A host repo under `workspaces/` (allowlisted) attachable to a conversation |
| **Namespace** | LaPis project-scope key; format `user:<clerkUserId>` (shared scope: `platform`) |
| **Envelope** | Normalized event `{seq, conversationId, ts, kind, payload}` — the only browser-facing shape |
| **Shared scope** | Opt-in cross-user platform facts in LaPis |

## 14. Open Items (verify during implementation)

1. sandd: does it accept a static token via env, or only the bootstrap file? (affects secret wiring)
2. LaPis extension: confirm no other process-global state breaks under child-process model (expected fine — that's why children were chosen)
3. Pi RPC client details: exact event types for images/steer/followUp — follow `docs/rpc.md` and reference `rpc-client.ts`
4. layamcp: confirm auth posture (token support) or rely on network isolation
5. PiSubagent: confirm `subagent` events are visible over RPC as tool events (v1 assumption)

## 15. Prior Art

The prior Aelvyril tree ("missions orchestrator" — mission lifecycle, cost tracker, WebSocket UI) was removed from the working tree without a commit; recoverable at git history `c54dbb4`. No design elements from it carry into this spec; the wipe was a deliberate fresh start.
