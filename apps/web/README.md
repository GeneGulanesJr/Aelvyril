# @aelvyril/web

Next.js (App Router) surface for the Aelvyril agent workspace — the **dispatch desk**. Signed-in users open threads on a describer board, ask the agent for work (casually or through a forced spec interview), watch the run's route line advance, and review + merge the resulting diff. The gateway is the only identity authority; this app exchanges the Clerk session for a JWT and calls `/v1/*`.

## The UI in one paragraph

The design language is a railway dispatch panel: dark steel ground (`app/globals.css` `@theme` tokens — `bg-desk/panel/panel-raised`, hairline `border-seam`, Fira Sans voice, JetBrains Mono for every measurement), signal-aspect lamps for thread state (amber spec'ing, green running/cleared, red abandoned, dim draft; `lib/design.ts` `STATUS_META` is the single aspect map), and a Schiphol-yellow reserved **exclusively** for "Needs you" interrupts (blocked: question/dialog/capped/gated — the yellow band carries one message and exactly one action). Every thread renders a route line (SPEC → RUN → VERIFY → REVIEW → MERGE) lit from `routePosition()`; the Trace tab is a desk log (clocked narration, tool rows with durations and ok/error aspects, subagent/sandbox/verdict rows) built from the structured `timeline` in `use-thread`; the board sidebar groups threads into Needs you / In flight / Desk / Closed. Keyboard: Enter sends, Shift+Enter newlines, Cmd/Ctrl+Enter sends, ←/→ move the output tabs. Below `md` the board becomes a drawer behind the hamburger bar. **Crew mode** (the segmented Dispatch/Crew switch in the board footer, persisted per browser) inhabits the same desk with the engineer rig (`components/crew/`): the engineer stands at the route line's active station, hammers while running, waves from the yellow band when blocked, unplugs when degraded — every pose derives from real SSE state (mapping table in `DESIGN.md`). `DESIGN.md` records the full system.

## Run (dev)

    pnpm --filter @aelvyril/web dev

Open <http://localhost:3000>. Requires the gateway running on the URL in `NEXT_PUBLIC_GATEWAY_URL` (default `http://localhost:8787`). If port 3000 is held by something on your host, run `pnpm exec next dev --webpack -p 3001` instead and update `GATEWAY_ALLOWED_ORIGIN` in `apps/gateway/.env` to match.

## Env

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | _required_ | Browser-safe Clerk key (`pk_test_…` / `pk_live_…`). `NEXT_PUBLIC_` is intentional — Clerk reads it on the client. |
| `CLERK_SECRET_KEY` | _required for SSR routes_ | Server-side Clerk key. The web app doesn't verify tokens (the gateway does), but Clerk's session helpers need it. |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://localhost:8787` | Where to find the gateway. Same-origin in prod via Docker network, cross-origin in dev. |

See `apps/web/.env.example` for a copy-paste template. Placeholder values (`pk_test_placeholder` / `sk_test_placeholder`) keep `pnpm --filter @aelvyril/web build` green in CI; real keys are required to actually sign in.

## How it talks to the gateway

- `apps/web/lib/api.ts` — typed `GatewayClient`: thread create/list, prompt (with steer), abort, rename, delete, kill-all, spec lifecycle (patch/approve/abandon/retry/merge), and `openStream` for the SSE event channel (reconnect with `Last-Event-ID`, terminal-loss `onLost`). Non-2xx responses surface the gateway's JSON error body (`error`, plus `message`/`cost`/`cap` when present) in the thrown `Error`.
- `apps/web/lib/sse.ts` — incremental SSE parser feeding `openStream`.
- `apps/web/app/thread/[id]/page.tsx` — the entire signed-in surface: sidebar, header, spec session, output tabs, prompt input. `app/page.tsx` is just a server redirect to `/thread/new`; the sign-in gate is client-side — the thread page renders a sign-in prompt when `useAppAuth()` reports no user (`NEXT_PUBLIC_AUTH_DISABLED=1` swaps Clerk for a fixed dev identity instead, see `lib/auth.ts`).
- `apps/web/components/thread/*` — the desk pieces: `sidebar` (describer board with grouping, search, kill-all), `header` (title, aspect lamp, usage, actions), `route-line` (lifecycle stations), `banner` (single status band: blocked > error > degraded), `output-tabs` + `tabs` + `trace-timeline` (Plan card / desk log / diff with true new-file line numbers), `spec-session` (the interview), `input` (auto-growing composer); `components/toasts` hosts quiet confirmations. The sidebar search is an inline case-insensitive substring filter in `sidebar.tsx`.
- `apps/web/lib/design.ts` — the shared vocabulary: `STATUS_META` aspect map, `routePosition`, and the format helpers (cost, tokens, relative time, durations).

We use `fetch` + `ReadableStream` for the SSE path, **not** `EventSource` — `EventSource` cannot send an `Authorization` header, which the gateway requires.

## Checks

    pnpm --filter @aelvyril/web typecheck
    pnpm --filter @aelvyril/web lint
    pnpm --filter @aelvyril/web test:unit   # 140 tests (sse parser + api client + use-thread + thread components + thread page)
    pnpm --filter @aelvyril/web build
    pnpm test:e2e                           # Playwright (root; expects web on :3000 + gateway on :8787 already running)

## Next 16 notes

- Explicit `--webpack` flag in dev/build scripts: Turbopack (the Next 16 default) does not implement `.js` → `.ts` extension aliasing, which the workspace's `@aelvyril/shared` barrel relies on. Opt out until either Turbopack gains the alias or we migrate to extension-less imports.
- `apps/web/proxy.ts` replaces the Next 15 `middleware.ts` convention — same `clerkMiddleware()` API, new filename.
- Root layout sets `export const dynamic = "force-dynamic"` so Clerk components don't try to prerender with placeholder keys.
- `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` are auto-generated by `next dev` (Next 16's agent-rules feature). Commit them; removing from a diff just re-creates the uncommitted change.

## React testing

`apps/web/vitest.config.ts` runs `lib/**/*.test.ts` + `components/**/*.test.tsx`. Component tests use `jsdom` (auto-detected for `*.test.tsx` files via `environmentMatchGlobs`) + `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, and `@vitejs/plugin-react@^5` for the automatic JSX transform.

The 5 chat component tests mock `@clerk/nextjs` and the `GatewayClient` class, so they don't need a real Clerk session or live gateway. The 1 skipped test is a Clerk Test Helper magic-link flow — requires Clerk dashboard test mode (out of repo scope; see root README).
