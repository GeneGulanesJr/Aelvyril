import Fastify, { type FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { CreateConversationBody, PromptBody, type EventEnvelope } from "@aelvyril/shared";
import { Store } from "./store.js";
import { EventBus } from "./bus.js";
import { Supervisor } from "./supervisor.js";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
}

export type App = FastifyInstance;

export function buildApp(opts: AppOptions): App {
  const app = Fastify({ logger: false });
  const store = new Store(opts.dbPath);
  const bus = new EventBus(store);
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: () => spawn(opts.childCommand, opts.childArgs),
    idleMs: opts.idleMs ?? 300_000,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Error && err.name === "ZodError") {
      return reply.code(400).send({ error: "bad_request" });
    }
    throw err;
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/conversations", async (req, reply) => {
    const body = CreateConversationBody.parse(req.body ?? {});
    const conv = store.createConversation(body);
    return reply.code(201).send(conv);
  });

  app.get("/v1/conversations", async () => ({ conversations: store.listConversations() }));

  app.get("/v1/conversations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id);
    return conv ? conv : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/conversations/:id/prompt", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });
    const body = PromptBody.parse(req.body ?? {});
    const ok = await supervisor.prompt(id, body.message, body.streamingBehavior);
    if (!ok) return reply.code(502).send({ error: "agent_rejected" });
    return reply.code(202).send({ accepted: true });
  });

  app.post("/v1/conversations/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });
    await supervisor.abort(id);
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/conversations/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
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
