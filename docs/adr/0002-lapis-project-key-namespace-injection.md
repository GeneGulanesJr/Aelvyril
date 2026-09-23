# Per-conversation LaPis namespace via `LAPIS_PROJECT_KEY` env injection

We tag every conversation in its `pi --mode rpc` child process with `LAPIS_PROJECT_KEY=user:<clerkUserId>` (lowercased) so LaPis namespaces memory per Clerk user — and we do it via the small upstream knob `projectFromCwd()` already checks before `basename(cwd)` matching.

**Why this mechanism (and not the alternatives):**
- `basename(cwd)` is the upstream default — but it collides on multi-user access to the same repo (`user_a` and `user_b` both open `LaPis/`, both get namespace `lapis`).
- Synthetic per-session directories (symlink `u<userId>--<repo>` to encode the user into `basename(cwd)`) were considered and rejected: zero upstream change, but the synthetic cwd leaks into git discovery, session naming, AGENTS.md walking, and any future tool that assumes `process.cwd()` is a real repo.
- "Just rewrite every `process.cwd()` call in LaPis" is the right long-term answer for LaPis proper, but is out of scope for Aelvyril and would never catch a future extension that assumes cwd is real.

**The patch (Phase 4 work, owned there):** at the top of **both** functions:
- `src/hooks-engine/project.js:135` — `resolveProjectKey()` (must preempt repo-name matching, which returns `repo.name` first)
- `extensions/memory-layer/host/project-detector.ts:95` — `detectProject()` (the Pi extension never calls `projectFromCwd`)

Read `LAPIS_PROJECT_KEY` from env, lowercase it, return it if non-empty. No schema impact. `LAPIS_HOME` is read at module load (safe per child). Zero `process.chdir` in the codebase. Backward compatible — the host CLI is unaffected.

**Gateway wiring (already shipped, Phase 2):**
- `apps/gateway/src/auth.ts` → `toUserNamespace(userId)` returns `user:<userId.toLowerCase()>`.
- `apps/gateway/src/supervisor.ts` → `prompt(..., extraEnv)` passes `{ LAPIS_PROJECT_KEY: namespace }` through to the spawned child at spawn time only (a reused session keeps its env).
- `apps/gateway/src/app.ts` → every prompt route injects `extraEnv = { LAPIS_PROJECT_KEY: namespace }`.
- The fake child (`fixtures/fake-pi.mjs`) echoes `process.env.LAPIS_PROJECT_KEY` back as a `custom_env_echo` protocol event; `apps/gateway/src/sse.test.ts` asserts the echo carries `user:user_test1` end-to-end — that test is the regression guard for this contract.

**Consequences:**
- Any future per-child env value (e.g. `LAPIS_HOME` overrides, per-conversation provider keys) flows through the same `extraEnv` channel.
- If LaPis ever removes `LAPIS_PROJECT_KEY`, Aelvyril breaks server-side with no client-visible warning — we own the upstream patch as part of Phase 4.
- "Fixing this with cwd-rewriting in LaPis" is a perpetual goal — not a substitute.

Status: accepted 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md`, decision D7). Gateway wiring shipped in Phase 2; upstream patch is Phase 4.