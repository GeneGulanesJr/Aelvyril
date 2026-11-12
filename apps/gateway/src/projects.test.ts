import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { GitHub } from "./github.ts";
import { Projects, type Git } from "./projects.ts";

/** A stand-in for sandboxd: records what it was asked, runs nothing. */
const fakeSandboxd = () => {
  const calls: { method: string; path: string; body?: any }[] = [];
  const files = new Map<string, Buffer>([["/tmp/out.bundle", Buffer.from("bundle-out")]]);
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const method = init.method ?? "GET";
    const raw = init.body instanceof Uint8Array ? Buffer.from(init.body) : typeof init.body === "string" ? init.body : undefined;
    const body = url.pathname.endsWith("/exec") && raw ? JSON.parse(String(raw)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    assert.equal((init.headers as any).authorization, "Bearer t0ken-t0ken-t0ken!", "always with the token");
    if (url.pathname.endsWith("/file")) {
      const p = url.searchParams.get("path")!;
      if (method === "PUT") return files.set(p, Buffer.from(raw as any)), new Response("{}");
      return new Response(new Uint8Array(files.get(p) ?? Buffer.alloc(0)));
    }
    if (url.pathname.endsWith("/exec")) return new Response(JSON.stringify({ exitCode: 0, out: "", stdout: "" }));
    return new Response(JSON.stringify({ state: "running", cpu: 1 }));
  }) as unknown as typeof fetch;
  return { f, calls, files };
};

test("projects: a GitHub repo is copied in as a bundle, the app runs with its preview base, and publishing pushes from the gateway, never the sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aelv-proj-"));
  const sb = fakeSandboxd();
  const gitCalls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const git: Git = async (args, opts) => {
    gitCalls.push({ args, env: opts?.env });
    const i = args.indexOf("bundle");
    if (i >= 0) writeFileSync(args[i + 2], "bundle-in");
    return "";
  };
  const gh = {
    repo: async () => ({ full_name: "octo/site", default_branch: "main" }),
    gitEnv: async () => ({ GIT_CONFIG_VALUE_0: "Authorization: Basic secret" }),
    openPr: async (_r: string, pr: { head: string; base: string }) => `https://github.com/octo/site/pull/1?${pr.head}->${pr.base}`,
  } as unknown as GitHub;
  const projects = new Projects({ dataDir: dir } as Config, gh, { url: "http://sbx:7400", token: "t0ken-t0ken-t0ken!", fetch: sb.f, git });

  const p = await projects.create({ name: "My Site!", repo: "https://github.com/octo/site.git" });
  assert.equal(p.id, "my-site");
  assert.equal(p.branch, "aelvyril/my-site");
  assert.equal(sb.files.get("/tmp/in.bundle")?.toString(), "bundle-in", "the sandbox gets a bundle, not a URL with a token");
  const clone = sb.calls.find((c) => c.body?.cmd?.[2]?.includes("git clone"))!.body.cmd[2];
  assert.match(clone, /remote set-url origin https:\/\/github\.com\/octo\/site\.git/);
  assert.ok(!JSON.stringify(sb.calls).includes("secret"), "the token never goes to the sandbox");
  assert.equal(gitCalls[0].env?.GIT_CONFIG_VALUE_0, "Authorization: Basic secret", "the gateway's own clone carries it, as a header");

  await projects.runApp(p.id, { command: "npm run dev", port: 5173 });
  const start = sb.calls.findLast((c) => c.body?.env?.APP_COMMAND)!.body.env;
  assert.deepEqual([start.APP_COMMAND, start.PORT, start.PREVIEW_BASE], ["npm run dev", "5173", `/preview/${p.previewKey}/`]);
  await assert.rejects(projects.runApp(p.id, { command: "x", port: 80 }), /1024/);

  projects.requestPush(p.id, "Add a footer", "It has a footer now");
  const pr = await projects.push(p.id);
  assert.equal(pr, "https://github.com/octo/site/pull/1?aelvyril/my-site->main");
  const push = gitCalls.find((c) => c.args.includes("push"))!;
  assert.ok(push.args.includes("+refs/heads/aelvyril/my-site:refs/heads/aelvyril/my-site"), "only its own branch");
  assert.equal(projects.get(p.id)!.push, undefined);
  assert.equal(new Projects({ dataDir: dir } as Config, gh, { url: "x", token: "y" }).get("my-site")?.pr, pr, "kept across a restart");

  const empty = await projects.create({ name: "Scratch" });
  assert.throws(() => projects.requestPush(empty.id, "t", "b"), /isn't from GitHub/);
  await projects.remove(empty.id);
  assert.equal(projects.get(empty.id), undefined);
});
