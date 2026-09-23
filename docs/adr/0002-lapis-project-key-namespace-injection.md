# Per-conversation LaPis namespace via `LAPIS_PROJECT_KEY` env injection

The Aelvyril gateway spawns a `pi --mode rpc` child per conversation and passes `LAPIS_PROJECT_KEY=user:<clerkUserId>` (lowercased) so multi-user access to the same repo doesn't collide on `basename(cwd)`. We decided this because agent extensions — LaPis in particular — read `process.cwd()` directly (process-global state) and key memory namespaces from `basename(cwd)`; running multiple `AgentSession`s in one gateway process would make conversations trample each other's cwd and collide on memory namespaces. The two-site upstream patch (in `LaPis/`) makes this work without changing LaPis's public surface.

**Considered options:**
- *In-process SDK sessions + upstream LaPis refactor* — rejected: requires threading `ctx.cwd` through every `process.cwd()` call site in LaPis forever, and any future extension assuming process-global state reintroduces the bug silently.
- *Synthetic per-session directories* (symlink dir named `u<userId>--<repo>` to encode the namespace into `basename(cwd)`) — rejected: zero upstream change but leaks synthetic cwd into git discovery, session naming, and AGENTS.md walking.
- *Per-user LaPis instances per namespace* — rejected: each LaPis opens a separate SQLite file; we lose the cross-project lookup the future memory-browser panel wants (spec §8).

**The patch (upstream — landed in LaPis @ `c49aeb3` on `docs/decision-engine-plan`):** the env override lives at the TOP of two functions:

- `src/hooks-engine/project.js resolveProjectKey()` — the canonical resolver; repo-name matching preempts `projectFromCwd()` so the env check must come first.
- `extensions/memory-layer/host/project-detector.ts detectProject()` — the Pi extension never calls `projectFromCwd()`, so the override MUST live here too. Without this site the chat path is uncoupled from the env override and every user's memory collapses into one namespace.

Both sites: read `LAPIS_PROJECT_KEY` from env, lowercase, return it if non-empty. No schema impact. Backward compatible — unset env falls through to existing resolution. `LAPIS_HOME` is read at module load (safe per child). Zero `process.chdir` anywhere in the codebase; per-request client-side key resolution confirmed.

**Consequences:**
- Never "optimize" session hosts back into the gateway process (see ADR 0001).
- The gateway injects `LAPIS_PROJECT_KEY` per spawn via `Supervisor.prompt(..., { LAPIS_PROJECT_KEY: namespace })`. A reused session keeps its env across calls.
- Workspace plumbing (Phase 3) preserves the cwd across kill + re-prompt so pi's session file is found on the next spawn.
- If LaPis ever removes `LAPIS_PROJECT_KEY`, Aelvyril breaks server-side with no client-visible warning — the patch needs to stay as a load-bearing contract.
- For PiSandboxed: same pattern would need a per-conversation env override there too. Tracked as Phase 4 deferred work.

Status: accepted 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md`, decision D6/D7).
