import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { GitHub } from "./github.ts";
import type { Projects } from "./projects.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { normalizeSource, type Extensions } from "./extensions.ts";
import type { DesignStore } from "./design.ts";
import type { ScreenStore } from "./screen.ts";
import type { WidgetStore } from "./widgets.ts";
import type { ProfileStore } from "./profile.ts";
import type { Providers } from "./providers.ts";
import type { StoredEvent, Supervisor } from "./supervisor.ts";

const MAX_PROMPT = 100_000;

export function createApp(deps: { cfg: Config; auth: Auth; sup: Supervisor; providers: Providers; extensions: Extensions; profile: ProfileStore; design: DesignStore; widgets: WidgetStore; screens: ScreenStore; github?: GitHub; projects?: Projects }) {
  const { cfg, auth, sup, providers, extensions, profile, design, screens, widgets, github, projects } = deps;
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
  const fromPi = (c: { req: { header(n: string): string | undefined } }) => {
    const sent = Buffer.from(c.req.header("x-aelvyril-token") ?? "");
    const want = Buffer.from(sup.internalToken);
    return sent.length === want.length && timingSafeEqual(sent, want);
  };
  app.post("/internal/jobs", async (c) => {
    if (!fromPi(c)) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      const job = sup.createJob(String(b.threadId ?? ""), String(b.title ?? ""), String(b.task ?? ""), String(b.board ?? ""), String(b.project ?? ""));
      return c.json({ jobId: job.id, board: job.board, boards: sup.boards() }, 201);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
  });
  // The continue_job tool: only the Stream, only for a task it started.
  app.post("/internal/jobs/:id/continue", async (c) => {
    const caller = sup.getThread(c.req.header("x-aelvyril-thread") ?? "");
    if (!fromPi(c) || caller?.kind !== "main" || sup.getThread(c.req.param("id"))?.parent_id !== caller.id) return c.json({ error: "forbidden" }, 403);
    try {
      await sup.sendBack(c.req.param("id"), String(((await c.req.json().catch(() => ({}))) as Record<string, any>).instruction ?? ""));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
  });

  // The change_design tool: colours only, validated, never code.
  app.get("/internal/design", (c) => (fromPi(c) ? c.json(design.get()) : c.json({ error: "forbidden" }, 403)));
  app.post("/internal/design", async (c) => {
    if (!fromPi(c)) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json({ design: design.set((await c.req.json().catch(() => ({}))) as Record<string, unknown>) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // The widget tools: a card and, optionally, a public address to fill it from. Never code.
  app.get("/internal/widgets", (c) => (fromPi(c) ? c.json({ widgets: widgets.definitions() }) : c.json({ error: "forbidden" }, 403)));
  app.post("/internal/widgets", async (c) => {
    if (!fromPi(c)) return c.json({ error: "forbidden" }, 403);
    try {
      return c.json(await widgets.upsert((await c.req.json().catch(() => ({}))) as never));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.delete("/internal/widgets/:id", (c) => (!fromPi(c) ? c.json({ error: "forbidden" }, 403) : widgets.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "no widget with that id" }, 404)));

  // The get_screen tool: what screens the person has been using.
  app.get("/internal/screen", (c) => (fromPi(c) ? c.json({ devices: screens.list() }) : c.json({ error: "forbidden" }, 403)));

  // ---- coding projects, for our own pi children: the main conversation makes them; a task may only touch its own.
  const asCaller = (c: { req: { header(n: string): string | undefined } }) => sup.getThread(c.req.header("x-aelvyril-thread") ?? "");
  const mayTouch = (c: { req: { header(n: string): string | undefined; param(n: string): string } }) => {
    const t = asCaller(c);
    return fromPi(c) && !!projects?.get(c.req.param("id")) && (t?.kind === "main" || t?.project === c.req.param("id"));
  };
  const oops = (c: { json(b: unknown, s: 400): Response }, e: unknown) => c.json({ error: (e as Error).message }, 400);
  app.get("/internal/projects", (c) => (fromPi(c) ? c.json({ enabled: !!projects?.enabled(), projects: projects?.list() ?? [] }) : c.json({ error: "forbidden" }, 403)));
  app.post("/internal/projects", async (c) => {
    if (!fromPi(c) || asCaller(c)?.kind !== "main" || !projects) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      return c.json(await projects.create({ name: String(b.name ?? ""), repo: b.repo ? String(b.repo) : undefined }), 201);
    } catch (e) {
      return oops(c, e);
    }
  });
  app.post("/internal/projects/:id/exec", async (c) => {
    if (!mayTouch(c)) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      const r = await projects!.exec(c.req.param("id"), b.cmd, { cwd: b.cwd, timeoutSec: b.timeoutSec });
      return c.json({ exitCode: r.exitCode, out: r.out.toString("base64") });
    } catch (e) {
      return oops(c, e);
    }
  });
  app.get("/internal/projects/:id/file", async (c) => {
    if (!mayTouch(c)) return c.json({ error: "forbidden" }, 403);
    try {
      return c.body(new Uint8Array(await projects!.readFile(c.req.param("id"), c.req.query("path") ?? "")));
    } catch (e) {
      return oops(c, e);
    }
  });
  app.put("/internal/projects/:id/file", async (c) => {
    if (!mayTouch(c)) return c.json({ error: "forbidden" }, 403);
    try {
      await projects!.writeFile(c.req.param("id"), c.req.query("path") ?? "", Buffer.from(await c.req.arrayBuffer()));
      return c.json({ ok: true });
    } catch (e) {
      return oops(c, e);
    }
  });
  app.post("/internal/projects/:id/app", async (c) => {
    if (!mayTouch(c)) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      await projects!.runApp(c.req.param("id"), b.command ? { command: String(b.command), port: Number(b.port) } : undefined);
      await new Promise((r) => setTimeout(r, Math.min(Number(b.waitMs) || 4000, 20_000))); // give it a moment to start or fail
      return c.json({ status: await projects!.status(c.req.param("id")), log: await projects!.appLog(c.req.param("id")) });
    } catch (e) {
      return oops(c, e);
    }
  });
  app.post("/internal/projects/:id/push-request", async (c) => {
    if (!mayTouch(c)) return c.json({ error: "forbidden" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      projects!.requestPush(c.req.param("id"), String(b.title ?? ""), String(b.body ?? ""));
      return c.json({ ok: true });
    } catch (e) {
      return oops(c, e);
    }
  });

  // ---- a project's app, in the preview window. Not under /api and not logged in: the address carries the project's
  // own random key instead. Every answer is marked as a sandboxed page (CSP sandbox), so even opened on its own it runs
  // without Aelvyril's origin and can't use the person's session; cookies go neither way.
  app.all("/preview/:key/*", async (c) => {
    const p = projects?.byPreviewKey(c.req.param("key"));
    if (!p || !p.run) return c.text("No app is running for this preview.", 404);
    const rest = c.req.path.slice(`/preview/${p.previewKey}`.length) || "/";
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    for (const h of ["cookie", "authorization", "host"]) headers.delete(h);
    try {
      const res = await fetch(`${process.env.AELVYRIL_SANDBOXD_URL}/sandboxes/${p.id}/preview/${p.run.port}${projects!.previewBase(p).slice(0, -1)}${rest}${url.search}`, {
        method: c.req.method,
        headers: { ...Object.fromEntries(headers), authorization: `Bearer ${process.env.AELVYRIL_SANDBOXD_TOKEN}` },
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.arrayBuffer(),
        redirect: "manual",
      });
      const out = new Headers(res.headers);
      for (const h of ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
      out.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
      out.set("x-content-type-options", "nosniff");
      return new Response(res.body, { status: res.status, headers: out });
    } catch {
      return c.text("The sandbox isn't answering.", 502);
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
  app.get("/api/threads", (c) => c.json(sup.listThreads()));
  app.post("/api/threads", async (c) => c.json(sup.createThread(String((await body(c)).title ?? "").trim() || undefined), 201));
  // Rename a thread, or move a task to another board.
  app.patch("/api/threads/:id", async (c) => {
    const b = await body(c);
    const title = String(b.title ?? "").trim();
    const board = typeof b.board === "string" ? b.board : null;
    if (!thread(c.req.param("id")) || (!title && board === null)) return c.json({ error: "bad request" }, 400);
    if (title) sup.renameThread(c.req.param("id"), title);
    return c.json({ ok: true, board: board === null ? undefined : sup.setBoard(c.req.param("id"), board) });
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

  // The two names: what the assistant calls itself, and what it calls the person.
  app.get("/api/profile", (c) => c.json(profile.get()));
  app.put("/api/profile", async (c) => c.json(profile.set(await body(c))));

  // Each open page says how big its screen is (on load, on resize, and every few minutes).
  app.put("/api/screen", async (c) => {
    const b = await body(c);
    try {
      screens.report(b.id, b);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // The look: the web app reads it every few seconds; PUT lets the person put the original look back.
  // GitHub: connect through the GitHub App. The callback has to be one the app lists, so it's built from the page's own
  // address, and only for addresses this Aelvyril answers on.
  app.get("/api/github", async (c) => c.json(github ? await github.status() : { configured: false, connected: false }));
  app.get("/api/github/connect", (c) => {
    const origin = c.req.query("origin") ?? "";
    const allowed = [...(process.env.AELVYRIL_ORIGINS ?? "").split(",").map((s) => s.trim()), `http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`];
    if (!github || !allowed.includes(origin)) return c.json({ error: "GitHub can't be connected from this address." }, 400);
    try {
      return c.json({ url: github.authorizeUrl(`${origin}/api/github/callback`) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/github/callback", async (c) => {
    let result = "connected";
    try {
      await github!.finish(c.req.query("code") ?? "", c.req.query("state") ?? "");
    } catch (e) {
      result = (e as Error).message;
    }
    return c.redirect(`/?github=${encodeURIComponent(result)}`);
  });
  app.delete("/api/github", (c) => (github?.disconnect(), c.json({ ok: true })));

  // ---- coding projects, for the person: the project cards on the home screen
  app.get("/api/projects", async (c) => {
    if (!projects) return c.json({ enabled: false, projects: [] });
    const list = projects.list();
    const st = await Promise.all(list.map((p) => projects.status(p.id)));
    return c.json({ enabled: projects.enabled(), projects: list.map((p, i) => ({ ...p, previewKey: undefined, preview: p.run ? projects.previewBase(p) : undefined, status: st[i] })) });
  });
  app.post("/api/projects/:id/:action", async (c) => {
    const id = c.req.param("id");
    if (!projects?.get(id)) return c.json({ error: "not found" }, 404);
    try {
      const a = c.req.param("action");
      if (a === "start") await projects.start(id);
      else if (a === "stop") await projects.stop(id);
      else if (a === "run") await projects.runApp(id);
      else if (a === "halt") await projects.stopApp(id);
      else if (a === "push") return c.json({ pr: await projects.push(id) });
      else return c.json({ error: "unknown action" }, 400);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/projects/:id/log", async (c) => (projects?.get(c.req.param("id")) ? c.json({ log: await projects.appLog(c.req.param("id")).catch((e) => String(e.message)) }) : c.json({ error: "not found" }, 404)));
  app.delete("/api/projects/:id", async (c) => {
    if (!projects?.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    try {
      await projects.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/api/design", (c) => c.json(design.get()));
  app.get("/api/widgets", (c) => c.json(widgets.list()));
  app.delete("/api/widgets/:id", (c) => (widgets.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));
  app.put("/api/design", async (c) => {
    try {
      return c.json(design.set(await body(c)));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

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
  app.post("/api/extensions/update", async (c) => c.json(await extensions.update()));
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
    // A browser (or Cloudflare in front) must never keep an old index.html after an update; the files under /assets have a hash
    // in their name and never change, so those may be kept for good.
    app.use("/*", async (c, next) => {
      await next();
      if (c.req.method === "GET" && c.res.ok && !c.res.headers.has("cache-control")) c.res.headers.set("cache-control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    });
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
