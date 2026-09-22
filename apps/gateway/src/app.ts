import Fastify, { type FastifyInstance } from "fastify";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
}

export function buildApp(_opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
