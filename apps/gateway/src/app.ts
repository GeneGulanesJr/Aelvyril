import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { normalizeSource, type Extensions } from "./extensions.ts";
import type { Providers } from "./providers.ts";
import type { StoredEvent, Supervisor } from "./supervisor.ts";

const MAX_PROMPT = 100_000;

export function createApp(deps: { cfg: Config; auth: Auth; sup: Supervisor; providers: Providers; extensions: Extensions }) {
  const { cfg, auth, sup, providers, extensions } = deps;
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/setup", (c) => c.json({ needsSetup: !auth.hasUsers(), needsCode: !auth.hasUsers() && !cfg.openSetup }));

  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    if (c.req.method === "POST" && c.req.path.endsWith("/sign-up/email")) {
      const code = auth.setupCode();
      if (!code) return c.json({ error: "sign-up is closed" }, 403);
      if (!cfg.openSetup && c.req.header("x-setup-code") !== code) return c.json({ error: "wrong setup code" }, 403);
    }
    return auth.handler(c.req.raw);
  });

  // Called by our own pi children (the start_job tool), never by browsers: needs the per-start secret.
  app.post("/internal/jobs", async (c) => {
    const sent = Buffer.from(c.req.header("x-aelvyril-token") ?? "");
    const want = Buffer.from(sup.internalToken);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      const job = sup.createJob(String(b.threadId ?? ""), String(b.title ?? ""), String(b.task ?? ""));
      return c.json({ jobId: job.id }, 201);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
  });

  // Everything else under /api needs a session.
  app.use("/api/*", async (c, next) => {
    if (!(await auth.verify(c.req.raw.headers))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const thread = (id: string) => sup.getThread(id);
  const body = async (c: { req: { json(): Promise<any> } }) => (await c.req.json().catch(() => ({}))) as Record<string, any>;

  app.get("/api/main", (c) => c.json(sup.main()));
  app.get("/api/board", (c) => c.json(sup.board()));
  app.get("/api/threads", (c) => c.json(sup.listThreads()));
  app.post("/api/threads", async (c) => c.json(sup.createThread(String((await body(c)).title ?? "").trim() || undefined), 201));
  app.patch("/api/threads/:id", async (c) => {
    const title = String((await body(c)).title ?? "").trim();
    if (!thread(c.req.param("id")) || !title) return c.json({ error: "bad request" }, 400);
    sup.renameThread(c.req.param("id"), title);
    return c.json({ ok: true });
  });
  app.delete("/api/threads/:id", (c) => {
    const t = thread(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (t.kind === "main") return c.json({ error: "the Stream cannot be deleted" }, 400);
    sup.deleteThread(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/threads/:id/prompt", async (c) => {
    const id = c.req.param("id");
    const message = String((await body(c)).message ?? "");
    if (!thread(id)) return c.json({ error: "not found" }, 404);
    if (!message.trim() || message.length > MAX_PROMPT) return c.json({ error: "bad message" }, 400);
    try {
      return c.json({ ok: true, ...(await sup.prompt(id, message)) });
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 502);
    }
  });

  app.post("/api/threads/:id/retry", async (c) => {
    try {
      await sup.retry(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
  });

  app.post("/api/threads/:id/abort", async (c) => {
    if (!thread(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    await sup.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/threads/:id/ui-response", async (c) => {
    const b = await body(c);
    if (!thread(c.req.param("id")) || typeof b.id !== "string") return c.json({ error: "bad request" }, 400);
    const ok = sup.resolveUi(c.req.param("id"), { id: b.id, value: b.value, confirmed: b.confirmed, cancelled: b.cancelled });
    return ok ? c.json({ ok: true }) : c.json({ error: "no such pending request" }, 404);
  });

  app.post("/api/threads/:id/model", async (c) => {
    const b = await body(c);
    if (!thread(c.req.param("id")) || typeof b.provider !== "string" || typeof b.modelId !== "string") return c.json({ error: "bad request" }, 400);
    try {
      return c.json({ ok: true, model: await sup.setModel(c.req.param("id"), b.provider, b.modelId) });
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 502);
    }
  });

  app.get("/api/models", async (c) => {
    try {
      const connected = (await providers.list()).providers.some((p) => p.configured);
      return c.json(await sup.models(connected));
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 502);
    }
  });


  // ---- providers, custom endpoints, default model, interactive login ------
  const fail = (c: any, e: unknown, status = 400) => c.json({ error: String((e as Error)?.message ?? e) }, status);

  app.get("/api/providers", async (c) => c.json(await providers.list()));

  app.put("/api/custom-providers/:id", async (c) => {
    const err = providers.saveCustom(c.req.param("id"), await body(c));
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });
  app.delete("/api/custom-providers/:id", (c) => (providers.deleteCustom(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  app.put("/api/default-model", async (c) => {
    const b = await body(c);
    if (typeof b.provider !== "string" || typeof b.modelId !== "string") return c.json({ error: "bad request" }, 400);
    providers.setDefaultModel(b.provider, b.modelId);
    return c.json({ ok: true });
  });

  app.post("/api/providers/:id/logout", async (c) => {
    try {
      await providers.logout(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/providers/:id/login", async (c) => {
    const type = (await body(c)).type;
    if (type !== "api_key" && type !== "oauth") return c.json({ error: "type must be api_key or oauth" }, 400);
    try {
      return c.json({ sessionId: (await providers.startLogin(c.req.param("id"), type)).id });
    } catch (e) {
      return fail(c, e);
    }
  });

  // The browser polls this; `after` is the last event number it has seen.
  app.get("/api/login/:sid", (c) => {
    const s = providers.session(c.req.param("sid"));
    if (!s) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0) || 0;
    return c.json({ events: s.events.filter((e) => e.n > after), finished: s.finished });
  });
  app.post("/api/login/:sid/answer", async (c) => {
    const b = await body(c);
    const ok = providers.session(c.req.param("sid"))?.answer(String(b.promptId), String(b.value ?? ""));
    return ok ? c.json({ ok: true }) : c.json({ error: "no such pending prompt" }, 404);
  });
  app.delete("/api/login/:sid", (c) => {
    providers.session(c.req.param("sid"))?.cancel();
    return c.json({ ok: true });
  });


  // ---- extensions (pi packages), managed from the UI ----------------------
  app.get("/api/extensions", (c) => c.json(extensions.list()));
  app.post("/api/extensions", async (c) => {
    const n = normalizeSource(String((await body(c)).source ?? ""));
    if ("error" in n) return c.json({ error: n.error }, 400);
    const r = await extensions.add(n.source);
    return r.ok ? c.json({ ok: true, source: n.source }) : c.json({ error: "The install failed.", detail: r.output }, 502);
  });
  app.post("/api/extensions/remove", async (c) => {
    const r = await extensions.remove(String((await body(c)).source ?? ""));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.output || "Could not remove it." }, 502);
  });

  // Server-sent events: replay from the log after Last-Event-ID, then live.
  app.get("/api/threads/:id/events", (c) => {
    const id = c.req.param("id");
    if (!thread(id)) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    const tail = Math.min(Number(c.req.query("tail") ?? 0) || 0, 5000); // the Stream is endless: load only the newest events
    return streamSSE(c, async (stream) => {
      let last = after;
      let replaying = true;
      const buffered: StoredEvent[] = [];
      let chain: Promise<unknown> = Promise.resolve();
      const send = (ev: StoredEvent) => {
        if (ev.seq && ev.seq <= last) return;
        if (ev.seq) last = ev.seq;
        chain = chain.then(() => stream.writeSSE({ id: ev.seq ? String(ev.seq) : undefined, data: JSON.stringify({ seq: ev.seq, ...ev.data }) })).catch(() => {});
      };
      const onEvent = (ev: StoredEvent) => (replaying ? buffered.push(ev) : send(ev));
      sup.bus.on(id, onEvent);
      for (const ev of after || !tail ? sup.eventsAfter(id, after) : sup.eventsTail(id, tail)) send(ev);
      replaying = false;
      buffered.forEach(send);
      const ping = setInterval(() => (chain = chain.then(() => stream.writeSSE({ event: "ping", data: "" })).catch(() => {})), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      sup.bus.off(id, onEvent);
    });
  });

  // The built web app, with SPA fallback.
  if (existsSync(cfg.webDir)) {
    const root = relative(process.cwd(), cfg.webDir) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
