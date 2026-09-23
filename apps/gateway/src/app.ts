import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { spawn } from "node:child_process";
import {
  CreateConversationBody,
  PromptBody,
  toUserNamespace,
  type EventEnvelope,
} from "@aelvyril/shared";
import { Store } from "./store.js";
import { EventBus } from "./bus.js";
import { Supervisor } from "./supervisor.js";
import type { TokenVerifier } from "./auth.js";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
  verifyToken: TokenVerifier;
  allowedOrigins?: string[];
}

export type App = FastifyInstance;

export async function buildApp(opts: AppOptions): Promise<App> {
  // Spec §10: 1MB max message. Fastify defaults to 1MB anyway, but we set it
  // explicitly so the value lives in the code (not in the runtime default) and
  // so the test asserts the contract instead of an implementation accident.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const store = new Store(opts.dbPath);
  const bus = new EventBus(store);
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: (conversationId, extraEnv) =>
      spawn(opts.childCommand, opts.childArgs, {
        env: { ...process.env, ...extraEnv },
      }),
    idleMs: opts.idleMs ?? 300_000,
  });

  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });
  async function user(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return void unauthorized(reply);
    const user = await opts.verifyToken(header.slice(7));
    if (!user) return void unauthorized(reply);
    return user.userId;
  }

  // CORS before routes so preflight/headers apply to every /v1 handler.
  await app.register(import("@fastify/cors"), {
    origin: opts.allowedOrigins ?? false,
    credentials: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Error && err.name === "ZodError") {
      return reply.code(400).send({ error: "bad_request" });
    }
    throw err;
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/conversations", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const body = CreateConversationBody.parse(req.body ?? {});
    const conv = store.createConversation({ ...body, namespace });
    return reply.code(201).send(conv);
  });

  app.get("/v1/conversations", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    return { conversations: store.listConversations(namespace) };
  });

  app.get("/v1/conversations/:id", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id, namespace);
    return conv ? conv : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/conversations/:id/prompt", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    const body = PromptBody.parse(req.body ?? {});
    const ok = await supervisor.prompt(id, body.message, body.streamingBehavior, {
      LAPIS_PROJECT_KEY: namespace,
    });
    if (!ok) return reply.code(502).send({ error: "agent_rejected" });
    // Auto-title from the first prompt — the picker shows words, not uuids.
    const conv = store.getConversation(id, namespace);
    if (conv?.title === null) store.renameConversation(id, namespace, body.message.slice(0, 80));
    // Persist the user's prompt as an envelope so SSE replay reconstructs the
    // full conversation (assistant-only history was the "my chats are gone" bug).
    bus.publish({
      conversationId: id,
      ts: new Date().toISOString(),
      kind: "user_message",
      payload: { text: body.message },
    });
    return reply.code(202).send({ accepted: true });
  });

  app.post("/v1/conversations/:id/abort", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    await supervisor.abort(id);
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/conversations/:id/events", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });

    reply.hijack();
    // Hijacking the reply bypasses @fastify/cors reply hooks, so the streamed
    // response would go out with no Access-Control-Allow-Origin and the browser
    // would drop it (200 but unreadable). Mirror the plugin's allow-list logic.
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (origin && opts.allowedOrigins?.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers["vary"] = "Origin";
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write("retry: 2000\n\n");

    const raw = req.headers["last-event-id"];
    const parsed = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
    let lastSeq = Number.isFinite(parsed) ? parsed : -1;

    const writeEnvelope = (env: EventEnvelope) => {
      if (env.seq <= lastSeq) return;
      lastSeq = env.seq;
      reply.raw.write(
        `id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`,
      );
    };

    for (const env of bus.replay(id, lastSeq)) writeEnvelope(env);

    const unsubscribe = bus.subscribe(id, (env) => writeEnvelope(env));
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.addHook("onClose", async () => {
    supervisor.disposeAll();
    store.close();
  });

  return app;
}
