# Aelvyril (next) — spec draft

Status: draft, 2026-11-04. Not built. Supersedes `Aelvyril/docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` for the new project.

## 1. What it is

A general-purpose, local-first AI tool with a web UI. It is **extensible the way pi is**: you add capabilities by dropping in extensions, not by changing the core. It is no longer coding-focused; coding becomes one extension among others.

## 2. Decisions (settled in conversation, 2026-11-04)

| Question | Decision |
|---|---|
| Direction | General AI tool, not coding-first. Coding is an optional extension. |
| Engine | **pi** stays the agent loop (`pi --mode rpc`, one child per thread, JSONL over stdio). Aelvyril does not write its own loop. |
| Language / runtime | **TypeScript** core and web on the **latest Node** (image `node:26-slim`, currently 26.13.0; pin the minor in the Dockerfile). A Rust port is possible later; not now. Verified on 26: pi 1.5.0, LaPis, PiSubagent, `better-sqlite3` and `better-auth` all install and run. |
| Extensions | Plain **pi extensions** (TypeScript, pi's `ExtensionAPI`). Aelvyril has no second extension system. |
| Extension UI | **Declarative panels**: an extension emits data, the web app renders it from a fixed component set. |
| Audience | Personal, local-first, single user. Loopback by default. |
| Login | Simple open-source login (lean: **Better Auth**, TS, SQLite) behind a `TokenVerifier` interface. **Clerk is dropped for now** and can return later as a second verifier; no other code changes. |
| Memory | **LaPis** (`pi install git:github.com/GeneGulanesJr/LaPis`) is the default memory, installed into Aelvyril's pi home on first run. It is a pi extension, so it needs no gateway code. |
| Pi home | Aelvyril uses **its own pi home** via `PI_CODING_AGENT_DIR` (e.g. `~/.aelvyril/pi`), separate from your CLI's `~/.pi/agent`. |
| Login library | **Better Auth** (confirmed). Verify against current docs in phase 1. |
| Packaging | **One Docker image / one container.** One Node process serves API + built web files and spawns pi children. State in one `/data` volume: SQLite, auth DB, pi home (`/data/pi`). Replaces the old four-service compose file. |
| First start | Entrypoint seeds `/data/pi` once (marker file): writes `settings.json` and runs `pi install` for the **default extensions: LaPis (memory) and PiSubagent (`subagent` tool + scout/planner/reviewer… agents and prompts)**. Needs internet once; optional pinned refs. Later starts skip it. |
| Providers / models | Managed **in the web UI**. Gateway writes `models.json` / `auth.json` atomically in the pi home (keys never sent back to the browser) and restarts that thread's pi child, since pi has no RPC reload. Model choice uses RPC `get_available_models` / `set_model`. |
| Subscription (OAuth) providers | Seamless in the UI: gateway imports the pi SDK's `ModelRuntime` and runs the login itself; `onAuth({url})` becomes an "Open this link" button, `onPrompt` / `onManualCodeInput` become a paste box. **Not yet spiked.** |
| Frontend | A plain **SPA built with Vite** (no Next.js, no SSR), served by the gateway. Framework: Svelte 5 proposed, Preact as runner-up. |
| Default tools | The seeded pi home's `settings.json` sets `"defaultTools": ["+codemode", "+tool_search"]` so **codemode** (pi's QuickJS script tool) is on by default. Verified: both reach the model. |
| Name / UI | Name stays **Aelvyril**. The UI is new and designed for the general tool (no dispatch-desk / spec-centric layout). |
| Code | **New project**, reusing selected generic parts of the old Aelvyril; coding code is left behind. |
| Compatibility | None needed (no old threads). |
| Contract safety | Shared schema package + validation at both ends. Payload carries `v: 1`. No `.v1` customType suffix until something outside our control depends on it. |

## 3. Architecture

```
web (browser)  <--SSE/HTTP-->  gateway (Node/TS)  <--JSONL stdio-->  pi --mode rpc (per thread)
                                  |                                       |
                               SQLite store                       pi extensions (tools, commands,
                               (threads, events, queue)            entries, UI requests)
```

- **gateway**: threads, durable prompt queue, SSE with `Last-Event-ID` replay, pi session hosts, per-user memory namespace, health/metrics.
- **web**: chat/thread surface, panel renderer, extensions page, settings.
- **packages/ui-schema**: zod schemas for panel payloads. Imported by the web app and by `@aelvyril/ui`.
- **packages/ui** (`@aelvyril/ui`): helper for extension authors, e.g. `panel.table({...})`, which validates and calls `pi.appendEntry`.

## 4. Extension model

An extension is a pi extension. What it can do, per pi 1.5.0 RPC docs (read from docs only, **not yet verified at runtime**):

- Register tools and commands (`pi.registerTool`, commands listed via `get_commands` with `source: "extension"`; run as `prompt /name`).
- Emit data: `pi.appendEntry()` surfaces as `entry_appended`; `pi.sendMessage({ customType })` flows through `message_start/end`.
- Use dialogs (`select`, `confirm`, `input`, `editor`) and fire-and-forget `notify`, `setStatus`, `setWidget` (text lines only).
- Cannot use TUI components (`custom()`, renderers, themes): no-ops in RPC mode.

### Panel contract

```
customType: "aelvyril.panel"
data: { v: 1, id, kind, title?, ...kind-specific }
```

v1 kinds: `markdown`, `table`, `list`, `form`, `diff`, `actions`, `status`.
Actions in a panel go back to the extension as `prompt /command args` or a tool call.
Panel state is rebuilt from stored entries on reload. Unknown kind or version renders a "can't display this" fallback. Both ends validate against `packages/ui-schema`.

### Extension dialogs (allow / deny in the web UI)

Any extension dialog (`confirm`, `select`, `input`, `editor`) reaches the browser and is answered there. First case: PiSubagent's `ctx.ui.confirm("Run project-local agents?", ...)` (`src/security.ts:63-68`), which has **no timeout** and, on denial, cancels the dispatch ("Canceled: project-local agents not approved.").

- Gateway: on a dialog `extension_ui_request`, store it as *pending* (SQLite: thread, request id, method, title, message, options, created) and emit an SSE `ui_request` event. Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`) become plain SSE events.
- Web: render the pending request as a card/modal in the thread with the right controls (Allow / Deny for `confirm`, buttons for `select`, text box for `input`/`editor`), and a badge on the thread list while something is waiting.
- Answer: `POST /threads/:id/ui-response { id, confirmed | value | cancelled }`; the gateway writes `extension_ui_response` to the pi child and clears the pending row.
- A page reload or SSE reconnect re-shows pending requests (they live in the store, not in the browser). Deleting a thread, stopping the turn or killing the child resolves its pending requests as `cancelled`. If the request has its own `timeout`, pi auto-resolves it; the UI just removes the card when the thread's event says so.
- "Always allow" is a later addition: it needs the project-trust path (`ctx.isProjectTrusted()` / pi's trust file) checked first. Not verified.
- In a general tool the working dir is Aelvyril's own workspace, so this specific prompt should be rare.

## 5. Security

- Local mode binds loopback; no auth by default. Hosted mode (later) keeps Clerk.
- Installing an extension runs arbitrary code, so it is admin-gated and never exposed beyond loopback.
- Boundaries that must hold regardless of extensions (workspace allowlist, risk gating if the coding extension is used) are enforced in the **gateway**, not inside an extension.
- `extension_ui_request` dialogs are surfaced to the user, no longer auto-answered.

## 6. Reuse from old Aelvyril / leave behind

Reuse (copy, then trim): `store.ts`, `bus.ts`, `sse.ts`, `rpc.ts`, `child-env.ts`, `namespace.ts`, `envelope.ts`, `rate-limit.ts`, `metrics.ts`, `health.ts`, `compression.ts`, optional `auth.ts`. ADRs 0001–0005 mostly carry over.

Leave behind (rebuild later as the coding extension): `spec-heuristic.ts`, `agent-contract.ts`, `verify.ts`, `risk.ts`, `workspace-*`, `sandd`, git-diff code, Plan/Trace/Diff tabs, approve/abandon/merge lifecycle, `updater.ts`.

## 7. Phases

0. Repo scaffold, this spec, ADR set (carry over 0001–0005, add: pi as engine, panel contract).
1. Gateway core: threads, queue, SSE, pi host, local mode.
2. Web: thread chat, streaming, stop/steer, search/rename/delete.
3. Panels: `ui-schema`, `@aelvyril/ui`, renderer, `extension_ui_request` handling.
4. Extension management: list/install/enable/remove (`pi install`), reload hosts.
5. First extensions to prove the model: a notes/research one, then the coding extension (the stress test).

## 8. Open questions

- Project name and location (this folder `Aelvyril-next` is a placeholder).
- Web stack: keep Next.js + the dispatch-desk design tokens, or start the UI fresh?
- Does installing from the UI share `~/.pi/agent` with the user's CLI or use its own pi home?
- Which extensions ship in the box besides the first two?
- Whether pi's RPC mode really delivers entries/UI requests as documented (spike first, before phase 3).

## 9. RPC spike result (2026-11-04, pi 1.5.0)

Ran `pi --mode rpc --no-session` with `PI_CODING_AGENT_DIR` pointing at a throwaway home that held one extension and no credentials. Sent `get_commands`, then `{"type":"prompt","message":"/panel"}`.

| Extension call | What the RPC client received |
|---|---|
| `registerCommand("panel")` | Listed by `get_commands` with `source: "extension"`. |
| `prompt "/panel"` | Ran at once; response `{"disposition":"handled"}`. No model call, no credentials needed. |
| `pi.appendEntry("aelvyril.panel", data)` | `{"type":"entry_appended","entry":{"type":"custom","customType":"aelvyril.panel","data":{...},"id","parentId","timestamp"}}` |
| `pi.sendMessage({customType,details,display:false})` | `message_start` / `message_end` with `role:"custom"`, `customType`, `details`. |
| `ctx.ui.setWidget / setStatus / notify` | `extension_ui_request` with `method` `setWidget` (`widgetLines`), `setStatus` (`statusText`), `notify`. |
| `ctx.ui.confirm` | `extension_ui_request` `method: "confirm"`; the extension waited until the client sent `extension_ui_response` with `confirmed: true`, then continued. |

Conclusion: the panel contract in section 4 works as designed. `appendEntry` carries panel data; dialogs round-trip. Not tested: reload from a persisted session file, `--no-session` vs saved sessions for panel rebuild, and multiple concurrent hosts. Spike files: session scratchpad `rpc-spike/`.

## 10. Full spike results (2026-11-04)

All run in a scratch dir against pi 1.5.0. Nothing is in this repo yet.

| Spike | Result |
|---|---|
| LaPis into a fresh pi home | `PI_CODING_AGENT_DIR=<home> pi install git:github.com/GeneGulanesJr/LaPis` works (clones, `npm` postinstall, writes `settings.json` packages). Its commands (`memory-*`, `dashboard`) and ~14 memory/code tools load in RPC mode. |
| Default tools | `defaultTools: ["+codemode","+tool_search"]` in the home's `settings.json` put `codemode` and `tool_search` in the tool list sent to the model (seen at a mock model server). |
| Panels survive a restart | With a mock OpenAI-compatible server (so a real assistant turn was written), restarting with `--session <file>` and calling RPC `get_entries` returned the `aelvyril.panel` entries (type `custom`) and the `custom_message` copies. **A session with no model turn writes no session file**, so the gateway must keep its own event log (SQLite) and not rely on pi's file alone. |
| Concurrent hosts | 3 `pi --mode rpc` children on one home, different cwd: all ran `/panel`, 2 entries each, no errors or lock conflicts. |
| Add a provider | Writing `models.json` while a host runs does **not** show up (0 models); after restarting the host it does (1), and `set_model` succeeds. Restart-on-save is required, as planned. |
| OAuth from the gateway | Importing `ModelRuntime` from the pi package and calling `login("anthropic", "oauth", interaction)` with a fake UI produced: `prompt select` (login method), then `notify auth_url <https://claude.ai/oauth/authorize?...>`, then `prompt manual_code` (paste box). `interaction.prompt` / `notify` map directly to web UI elements. 9 providers are OAuth-capable (anthropic, github-copilot, kimi-coding, meta, openai, openai-codex, openrouter, radius, xai); 41 have an API-key login. Not tested: finishing a real login. |
| Better Auth 1.7.16 | With `better-sqlite3`, email+password and the `bearer()` plugin: sign-up, sign-in (bearer token in the `set-auth-token` header), and `auth.api.getSession` with `Authorization: Bearer` returns `{ userId }` (null for a bad token; wrong password is rejected). This is exactly a `TokenVerifier`. Schema is created with `getMigrations(auth.options)`. |
| Svelte 5 + Vite 8 | A small page with a panel list builds in 250 ms to 43 KB (16.7 KB gzip). |
| Docker | **Works.** `node:22-slim` + git + `npm i -g @earendil-works/pi-coding-agent@1.5.0`; entrypoint seeds `/data/pi` on first start (settings with codemode + tool_search, `pi install` LaPis and PiSubagent); second start with the same volume printed "already seeded" and loaded both. In the container, `get_commands` showed LaPis (`memory-*`, `dashboard`) and PiSubagent (`implement`, `scout-and-plan`, `pisubagent-doctor`, `implement-and-review`) in RPC mode. PiSubagent asks a one-time confirmation before running untrusted project agents; that arrives as an `extension_ui_request` the web UI must answer. Spike files: scratchpad `docker/`. |

## 11. Built so far (2026-11-04) and the non-coder rule

**Rule (user, 2026-11-04): everything that can be done in the UI is done in the UI; the audience is non-coders.** No JSON, terminal commands or log-reading in normal use. Plain wording ("chats", "Connect an AI", "Extensions").

Built and verified (gateway: 15 tests; web: transcript tests; real UI smoke test `e2e/ui-smoke.mjs` in Chrome against the compose container; unit tests for the panel schema):

- Single container (`docker compose up -d`), Node 26, pi from the gateway's pinned dependency, first-start install of LaPis + PiSubagent, state in one volume.
- Owner account (Better Auth). First sign-up needs no code when `AELVYRIL_OPEN_SETUP=1` (compose binds to 127.0.0.1); otherwise a one-time code in the log.
- Chat with streaming, tool calls, panels, extension dialogs (Allow/Deny), extension status chips (LaPis shows its session chip).
- Settings → AI models: connect by API key or subscription sign-in through one guided dialog (`ModelRuntime.login` driven by prompts/notifications), disconnect, own OpenAI-compatible server (no key needed), default model. Keys are never sent back to the browser; files are written atomically with mode 600. Config changes restart idle pi children immediately and busy ones after their turn.
- Settings → Extensions: add by GitHub link / npm name, remove, with a trust warning; input is validated and installs run without a shell.
- Welcome screen and "Connect an AI to start" prompts when nothing is connected; responsive down to phone width.

Found by testing, fixed: keyless custom servers were treated as unusable (now a placeholder key); a model-list request could hit a pi child that had just been killed (children are forgotten at once, one retry); `./local` passed the GitHub-source check.

Not built: idle pi shutdown, rename chat, search chats, update-Aelvyril flow, the first-party extensions that use panels, a "test connection" button, a published image (users still build from the folder), full OAuth completion (the sign-in link and paste step were exercised, a real provider login was not).

## 12. The Stream, tasks and the finish contract (2026-11-04)

**Model.** One permanent conversation (the Stream, `kind=main`) answers questions directly and has no file or shell tools; its only extra tool is `start_job` (bundled extension `apps/gateway/pi-extension/jobs.ts`). Real work becomes a background **task** (`kind=job`): its own pi session with full tools, shown as a card in the Stream and listed in Inbox and Board. Older plain chats (`kind=chat`) remain. Views: Stream, Inbox, Quick, Board (a fourth view is built on `/api/board`). In the UI the word is always "task".

**Finish contract (so a task really finishes).** Two layers, because an extension cannot see what happens when its own process dies:

- *In the session, a pi extension* (`apps/gateway/pi-extension/task-guard.ts`, tasks only):
  - `finish_task({outcome, summary})` is how the AI declares the end: `done` (summary), `need_input` (the one question), `cannot_finish` (the honest reason). The outcome travels as a session entry `aelvyril.task_outcome`.
  - The first `done` returns a self-check prompt ("list each thing asked and confirm it is done"); only the second `done` counts.
  - `agent_before_settle` is pi's last checkpoint: if no outcome was declared the guard appends a hidden reminder and continues (max 3 nudges), then records `incomplete`.
  - A new instruction from the person (`before_agent_start`) starts a fresh round.
- *In the gateway:*
  - Outcome decides the state: done / `needs_input` (shown as "needs you", with the question) / failed ("Couldn't finish: reason") / `incomplete` (failed, "It stopped before it was finished."). No declaration at all (extension missing) keeps the old behaviour: done.
  - Every outcome reaches the Stream as a card update and a short assistant message; answering a `need_input` task starts a new round and its final result is reported again.
  - **Stall watchdog:** a working task with no events for `AELVYRIL_TASK_STALL_MS` (default 10 min) is stopped and failed ("it stopped responding"). Tasks waiting for the person's yes/answer are never stopped for silence.
  - **Total limit:** `AELVYRIL_TASK_MAX_MS` (default 60 min) stops a runaway task.
  - **Restart:** a task that was working when the gateway stopped is resumed from its saved session ("continue, then call finish_task"), at most twice, otherwise failed. Checks run every `AELVYRIL_WATCHDOG_MS` (default 30 s).

**Send-back (the Stream judges the result).** The result message to the Stream carries the task id and what was originally asked (stored as `threads.task`, trimmed to 3,000 characters), because the Stream may have been cleared since it started the task. The Stream compares the two; if something asked for is clearly missing it calls `continue_job({id, missing})` (same extension as `start_job`). The gateway (`POST /internal/jobs/:id/continue`) accepts it only from a pi child whose thread is the Stream and the task's parent, and only for a `done` task: it writes `[aelvyril:send-back]` + what is missing into the task (a new round with `finish_task`), the card goes back to working ("Sent back: …"), and the new outcome is reported again. At most 2 send-backs per task (`threads.sendbacks`); a third is refused and the Stream tells the person. A failed or stopped task stays the person's "Try again"; a `needs_input` task stays the person's question.

Verified: gateway unit tests (fake pi, every outcome, both watchdogs, resume, send-back and its limits), and `e2e/task-guard.mjs` with real pi against the scripted mock model (`e2e/mock-model.mjs`): done after self-check, silent (exactly 3 nudges, then failed), nudged, cannot, need_input then answer, retry, send-back (done, sent back, done again), hang (watchdog).

Not built: a separate "verifier" model that judges the result (the self-check prompt and the Stream's send-back are the cheaper versions), per-task budget/cost limits.

## 13. Guides: what the assistant knows about itself (2026-11-12)

**Guides.** The assistant's knowledge of the app is five bundled pi skills in `apps/gateway/guides/` (one folder each with a `SKILL.md`): `aelvyril-app` (home screen, Stream, Tasks, Quick, Settings), `aelvyril-tasks` (when to start one, the finish contract, send-back and its limit of 2, time limits, Try again, needs-you), `aelvyril-coding` (projects, the sandbox, the preview, asking to publish), `aelvyril-look` (colours and layout within limits, widgets, checking the screen first) and `aelvyril-limits` (what it cannot do). pi lists each by name and description in the system prompt and the model reads one with `read` when it needs it. Every pi child gets them with `--skill apps/gateway/guides`, except a coding task: its `read` runs inside the project's sandbox, which cannot see the gateway's files, and it does not need them. The Stream keeps `read`, so its skills listing survives the identity extension's prompt swap (pi keeps the skills section under a custom prompt as long as a reader tool is declared). `identity.ts`'s `ABOUT` is now two sentences plus "read the matching guide before explaining, call get_abilities, don't recite it".

**get_abilities.** A tool the identity extension registers for the Stream only, backed by `GET /internal/abilities` (internal token): whether an AI is connected (provider names), the AI for chats and for tasks, installed extensions (names only; the commands and tools they add would need a running pi), whether coding projects are set up on this computer, and whether GitHub is connected. Plain text, never keys or tokens.

**Drift test.** `apps/gateway/src/guides.test.ts`: every tool name registered by the bundled extensions (`name: "…"` in `pi-extension/*.ts`) appears in at least one guide; each guide's frontmatter has a `name` matching its folder and a description; hosts get the `--skill` flag (a coding task does not); the abilities route is forbidden without the token, names the task AI, and leaks no key. `e2e/task-guard.mjs` checks with real pi that both the Stream's and a task's model receive the guides listing, that the Stream's `read` opens a guide, and that `get_abilities` answers. A guide must only describe what is built: change the guide in the same change as the behaviour.
