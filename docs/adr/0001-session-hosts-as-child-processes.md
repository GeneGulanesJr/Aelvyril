# Session hosts run as child processes (`pi --mode rpc`), not in-process SDK sessions

Each Aelvyril conversation is served by its own `pi --mode rpc` child process, spawned and supervised by the gateway, with per-child env (`LAPIS_PROJECT_KEY`) and cwd. We decided this because agent extensions — LaPis in particular — read `process.cwd()` directly (process-global state) and key memory namespaces from `basename(cwd)`; running multiple `AgentSession`s in one gateway process would make conversations trample each other's cwd and collide on memory namespaces. Child processes give each conversation a real cwd, a real environment, and crash isolation, at the cost of ~200–500ms lazy spawn per conversation and a supervisor.

**Considered options:**
- *In-process SDK sessions + upstream LaPis refactor* — rejected: requires threading `ctx.cwd` through every `process.cwd()` call site in LaPis forever, and any future extension assuming process-global state reintroduces the bug silently.
- *Synthetic per-session directories* (symlink dir named `u<userId>--<repo>` to encode the namespace into `basename(cwd)`) — rejected: zero upstream change but leaks synthetic cwd into git discovery, session naming, and AGENTS.md walking.

**Consequences:**
- Never "optimize" session hosts back into the gateway process.
- Per-user memory namespaces depend on the small upstream LaPis knob `LAPIS_PROJECT_KEY` (checked first in `projectFromCwd()`, falling back to `basename(cwd)`); LaPis must keep that override.
- Any new agent-side extension must work under a child process with a per-conversation cwd and env — process-global assumptions are a design error in this platform.

Status: accepted 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md`, decision D6/D7).
