# Plan: Strip the coding-agent (orchestrator) so Aelvyril is purely a PII-reduction + smart-routing gateway

## Context & goal

The repo currently interleaves **two products**:

1. **The Tauri Privacy Gateway** (the real "PII reduction + smart routing" product): `src-tauri/` Rust backend (`gateway`, `pii`, `pseudonym`, `providers`, `keychain`, `session`, `security`, `lists`, `token_usage`, `audit`, `config`, `onboarding`, `clipboard`, `bridge`, `perf`, `policy`, `llama`, `commands`, `bootstrap`) + its React frontend (`index.html`, `src/main.tsx`, `src/App.tsx`, `src/pages`, `src/components`, `src/hooks`, `src/styles`, `src/utils`, `public/`, `vite.config.ts`).
2. **A separate "7-agent coding pipeline"** that has nothing to do with PII/routing: a Node TS orchestrator (`src/index.ts`, `src/server.ts`, `src/orchestrator.ts`, `src/{agents,board,missions,supervisor,sessions,db,cli,cost,workspace,routes,audit,config,types}`), its own `ui/` frontend, the Node `tests/`, `bin/chat.js`, the root `package.json`/`tsconfig`s, **plus** a Rust coding-agent module `src-tauri/src/orchestrator/`.

**Decision (confirmed by user):** Remove **only the coding-agent/orchestrator parts** from both sides. Keep the entire gateway (incl. clipboard, bridge, perf, token_usage, audit, ML PII sidecars) and the full desktop UI. This is the most conservative trim that achieves "purely a gateway."

**Key gotcha:** `src/` is shared. The gateway frontend depends on `src/utils/{logger,formatDate}.ts`, so those stay. The frontend barrel `src/hooks/useTauri.ts` re-exports an orchestrator hook that must be unwired.

---

## Phase 1 — Delete the Node orchestrator pipeline

Delete these files/dirs entirely (none are imported by the gateway frontend — verified):

- `src/index.ts`, `src/server.ts`, `src/orchestrator.ts`
- `src/agents/`, `src/board/`, `src/missions/`, `src/supervisor/`, `src/sessions/`, `src/db/`, `src/cli/`, `src/cost/`, `src/workspace/`, `src/routes/`, `src/audit/`, `src/config/`, `src/types/`
- `bin/chat.js`
- `ui/` (the orchestrator's Kanban/chat/cost frontend)
- `tests/` (the Node suite: `agents/`, `board/`, `missions/`, `supervisor/`, `sessions/`, `db/`, `cli/`, `cost/`, `workspace/`, `integration/`, etc.)
- `vitest.config.ts` (orchestrator's; the gateway frontend has no JS tests)
- `tsconfig.build.json`, `tsconfig.tsbuildinfo`

**Keep in `src/`:** `main.tsx`, `App.tsx`, `App.module.css`, `vite-env.d.ts`, `pages/`, `components/`, `hooks/`, `styles/`, `utils/`, plus root `index.html`, `public/`, `vite.config.ts`.

---

## Phase 2 — Rebuild root frontend tooling (so `pnpm dev` / `pnpm tauri dev` work)

The current root `package.json` is the orchestrator's (`better-sqlite3`, `ws`, `tsx`, scripts `dev: tsx watch src/index.ts`). `tauri.conf.json` runs `pnpm dev`/`pnpm build` and expects `../dist`. Replace it with a gateway-frontend package.

### 2a. Replace `package.json` (root)

```json
{
  "name": "aelvyril",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "lucide-react": "^0.460.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

> Deps were derived from actual imports: `@tauri-apps/api/core` (`src/hooks/tauri/invoke.ts:1`), `react-router-dom` (`App.tsx`, `Sidebar.tsx`), `lucide-react` (`Sidebar.tsx`), `react`/`react-dom` (`main.tsx`). Pin/adjust versions to whatever `pnpm` resolves; react 18 matches `ui/`'s former versions.

### 2b. Replace root `tsconfig.json` with project references

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

Keep `tsconfig.app.json` (includes `src`) and `tsconfig.node.json` (includes `vite.config.ts`) as-is.

### 2c. `eslint.config.js`

Review only — keep if it generically lints `src/`; ensure it does not reference deleted dirs. If it was scoped to the orchestrator, replace/keep a minimal React-TS config.

### 2d. `package-lock.json`

Delete it and regenerate with `pnpm install` (lockfile will be recreated).

---

## Phase 3 — Remove the Rust orchestrator module + unwire

### 3a. Delete
- `src-tauri/src/orchestrator/` (all files: `mod.rs`, `context.rs`, `contracts.rs`, `errors.rs`, `executor.rs`, `planner.rs`, `state_store.rs`, `types.rs`, `validator.rs`)
- `src-tauri/src/commands/orchestrator.rs`

### 3b. Unwire registrations
- `src-tauri/src/lib.rs`: delete `pub mod orchestrator;` (line 21) and `.manage(crate::orchestrator::SharedOrchState::default())` (line 37).
- `src-tauri/src/commands/mod.rs`: delete `pub mod orchestrator;` (line 5), `pub use orchestrator::*;` (line 19), and the entire `// ── Orchestrator ──` block in `invoke_handler` (lines 92–102): `start_orchestrator_task`, `get_orchestrator_state`, `get_orchestrator_task_list`, `get_orchestrator_plan`, `cancel_orchestrator_task`, `respond_to_blocked`, `get_orchestrator_settings`, `update_orchestrator_settings`, `get_execution_result`, `get_validation_result`.
  - Note: clipboard's command is `respond_to_clipboard` (distinct) — do **not** remove that.
- `src-tauri/src/config/mod.rs`: delete the `orchestrator` field — the doc comment + `pub orchestrator: crate::orchestrator::types::OrchestratorSettings,` (lines 50–52) and its default `orchestrator: crate::orchestrator::types::OrchestratorSettings::default(),` (line 105).

### 3c. Optional dead-code cleanup (low risk, recommended)
Now that nothing produces these tool names, remove the orchestrator-specific token-usage categorization:
- `src-tauri/src/token_usage/mod.rs`: drop `ToolName::OrchestratorPlan` / `OrchestratorExecute` variants and their `as_str()` arms (≈ lines 36–49).
- `src-tauri/src/token_usage/aggregator.rs`: drop the `"orchestrator_plan" | "orchestrator_execute" => "agent"` arm (≈ lines 307–308).

---

## Phase 4 — Remove the frontend orchestrator UI + unwire

### 4a. Delete
- `src/components/orchestrator/` (entire dir)
- `src/pages/Orchestrator.tsx`, `src/pages/Orchestrator.module.css`
- `src/components/settings/OrchestratorSection.tsx`
- `src/hooks/tauri/orchestrator.ts`

### 4b. Unwire
- `src/hooks/useTauri.ts`: delete `export * from "./tauri/orchestrator";` (line 5).
- `src/components/Sidebar.tsx`: delete the `{ to: "/orchestrator", icon: Bot, label: "Orchestrator" }` nav item (line 23) and the now-unused `Bot,` import (line 9).
- `src/App.tsx`: delete the `<Route path="/orchestrator" … />` (line 26). (`App.tsx` renders `ComingSoon` there, so no other component breaks.)
- `src/pages/Settings.tsx`: grep for `OrchestratorSection`/`orchestrator`; if a tab/section renders it, remove the tab from the `SettingsTab` union and its render branch. (The `Settings.tsx.backup` showed tabs `providers|gateway|lists|detection|behavior`, so confirm whether an orchestrator tab exists in the live file before editing.)

---

## Phase 5 — Docs

- `README.md`: remove the **Orchestrator — Plan & Execute Coding Agent** section, the **Orchestrator Pipeline** mermaid diagram, the **Orchestrator** config table, and `orchestrator/` from the Backend Modules tree. Also reconcile the description mismatch (the tail currently says "Aelvyril Cloud Platform — 7-agent coding pipeline" and includes an aspirational minimal-**Go** gateway sketch) — delete the "7-agent pipeline" framing; the Go sketch can be kept as a clearly-marked future-vision note or removed per preference.
- `docs/README.md`: no orchestrator references — leave as-is.

---

## Validation

1. **Rust** (in `src-tauri/`):
   - `cargo check` → fix any dangling `orchestrator` references (likely candidates: `bootstrap/setup.rs`, any gateway request path). Re-run until clean.
   - `cargo test` → `recognizer_tests.rs`, `integration_tests.rs`, `e2e_providers.rs` still pass (these are gateway tests; verified to contain no orchestrator references).
2. **Frontend** (repo root): `pnpm install && pnpm build` (`tsc -b && vite build`) → compiles with no missing exports/modules.
3. **Smoke (optional):** `pnpm tauri dev` → app boots, sidebar has no Orchestrator entry, Dashboard/Audit/Sessions/Security/Settings render, gateway still proxies a request end-to-end.
4. After deletion, `rg -n orchestrator src src-tauri/src` should return nothing except the optional `token_usage` cleanup (if deferred).

---

## Risks & notes

- **Dangling references:** the orchestrator is referenced in `lib.rs`, `commands/mod.rs`, `config/mod.rs`, and the frontend barrel/sidebar/app/settings. `cargo check` + `pnpm build` will catch any missed call sites; treat compile errors as the source of truth and fix iteratively.
- **Persisted settings:** existing `~/.aelvyril/settings.json` may contain an `orchestrator` key. With the struct field removed and serde defaults, the stale key is simply ignored (harmless). Optional: add a one-time migration to drop the key — not required.
- **`respond_to_blocked` vs `respond_to_clipboard`:** distinct names; only remove the orchestrator's `respond_to_blocked`.
- **Reversibility:** all removals are git-tracked; recovery is a revert away.
- **Out of scope (explicitly kept):** clipboard monitoring, browser-extension bridge, perf/benchmarking, token-usage/cost tracking, audit log, Presidio/Liquid/llama ML PII sidecars, and the full Tauri desktop UI.
