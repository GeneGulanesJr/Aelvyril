# Aelvyril

A general-purpose, local-first AI tool with a web UI, extensible the way [pi](https://github.com/earendil-works/pi-coding-agent) is. Pi is the engine (one `pi --mode rpc` child per thread); extensions are plain pi extensions. Design and decisions: [`docs/spec.md`](docs/spec.md).

## Install and run (no coding needed)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and open it.
2. Download this folder, open a terminal in it, and run: `docker compose up -d`
3. Open <http://localhost:3000> in your browser.

Everything after that happens in the browser: create your account, click **Connect an AI** (sign in with Claude or ChatGPT, paste an API key, or point to a local server like LM Studio), pick the AI your chats use, and start chatting. **Settings → Extensions** adds or removes extensions by pasting a GitHub link.

- Only this computer can reach it (`127.0.0.1`). That is why the first account needs no setup code. If you expose it to a network, remove `AELVYRIL_OPEN_SETUP` from `docker-compose.yml`: the first sign-up then needs a one-time code printed in the container log (Docker Desktop → Containers → aelvyril → Logs).
- Your chats, accounts, keys and settings live in the `aelvyril-data` volume. `docker compose down` keeps them; `docker compose down -v` erases them.
- A program on this computer (LM Studio, Ollama) is reached at `host.docker.internal` instead of `127.0.0.1`.
- Included extensions: LaPis (memory), PiSubagent (helpers) and Ponytail (small, simple changes; level `full`, kept in `/data/config/ponytail/config.json`). A failed install is retried on the next start. `AELVYRIL_EXTENSIONS` overrides the list.
- Pi's tools (bash, edit, write) run **inside the container** as the unprivileged `node` user; the container is the sandbox.
- Other options: `AELVYRIL_ORIGINS` (extra allowed origins when served from another hostname), `AELVYRIL_SETUP_CODE` (fixed setup code).

## Develop

Node 24+ (26 recommended) and pnpm 10. The gateway runs TypeScript directly (no build step).

```sh
pnpm install
pnpm dev:gateway     # http://localhost:3000   (needs `pi` on PATH, or PI_COMMAND)
pnpm dev:web         # http://localhost:5173, proxies /api
pnpm typecheck && pnpm test
node e2e/mock-model.mjs   # scripted stand-in for an AI (no cost), used by the tests below
node e2e/task-guard.mjs   # real gateway + real pi: the finish contract (nudges, need_input, watchdog)
node e2e/ui-smoke.mjs     # real UI in Chrome against a running instance (see the header of that file)
```

How tasks work: the Stream answers directly and starts background tasks for real work; a task only counts as finished when it declares an outcome, and stalled or interrupted tasks are stopped or resumed. Details: `docs/spec.md` §12.

Layout: `apps/gateway` (Hono, Better Auth, SQLite, pi supervisor), `apps/web` (Preact + Vite), `packages/ui-schema` (the panel contract extensions emit; zod).
