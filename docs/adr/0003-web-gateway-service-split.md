# Web and gateway are separate processes (Approach 2 from the spec)

`apps/web` (Next.js) and `apps/gateway` (Fastify) run as two services that talk over HTTP/SSE on a private Docker network — never in-process. `web` is the only service that publishes a host port (3000).

**Why split (and not embed the gateway inside Next, or vice versa):**
- **Session lifecycle owns one home.** A `pi --mode rpc` child can run for minutes; the supervisor's job is to keep it alive across requests and reap only after idle. That is a long-running concern, not a request/response handler — it belongs in a process the UI redeploys cannot kill.
- **UI redeploys never kill agents.** A `next build && next start` cycle on `web` does not touch the gateway, so existing sessions keep streaming.
- **The gateway is the reusable API surface.** Future ops panels, mobile clients, and external MCP clients hit `/v1/*` directly — they don't need to import `@clerk/nextjs` or any React.
- **Identity boundary is one way.** `web` holds the Clerk publishable key (browser-safe) and exchanges the session for a Clerk JWT; `gateway` is the **only** place that verifies JWTs and the **only** identity authority. Backing services (LaPis, sandd, layamcp) are network-internal and take static bearer tokens — they never see Clerk.

**Topology (spec §4):**
```
Browser → Clerk (cloud)
   │ HTTPS + Clerk JWT
   ▼
web (Next.js) ── SSE / POST prompts ──▶ gateway (Fastify)
                                       │ per-conversation: pi --mode rpc child
                                       ▼
                                   lapis · sandd · layamcp
```

**Considered alternatives (rejected):**
- *Embed gateway inside Next.js* — couples the SSE/RPC supervisor to the UI runtime, kills sessions on every `next dev` HMR or production redeploy, and forces ops surfaces to ship `@clerk/nextjs`.
- *Embed web inside the gateway* — Next has its own dev server, build pipeline, and prerender story; grafting it onto Fastify adds nothing and loses Next's static optimization for landing/sign-in pages.
- *Single combined service in production, split in dev* — diverges the two environments; bug class is "works in dev, dies in prod at restart."

**Consequences:**
- CORS is real. `apps/gateway/src/app.ts` registers `@fastify/cors` for normal routes and manually mirrors the allow-list on hijacked SSE streams (`reply.hijack()` bypasses plugin hooks — see `apps/gateway/src/app.ts` and the regression test in `apps/gateway/src/sse.test.ts`).
- `web` must send `Authorization: Bearer <token>` on every `/v1/*` call. `apps/web/lib/api.ts` does this in a shared `authed()` helper; the SSE parser (`apps/web/lib/sse.ts`) reads `Last-Event-ID` and reconnects.
- Only `web` gets a public port. The gateway is loopback-only in dev (`127.0.0.1`) and behind the Docker network in prod; `compose.yaml` reflects this.
- LLM provider keys live in gateway env → passed to children at spawn time, never sent to the browser.
- TLS termination lives in the Caddy reverse proxy (`infra/docker/Caddyfile`), not in either app — the apps stay HTTP-only, the proxy handles certs + HSTS.

Status: accepted 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md`, decision D5).
