// Coding projects: each one is a sandbox (a locked-down container made by sandboxd) holding a git checkout, a task
// working on it, and optionally the project's app running for a preview. GitHub's token stays here: Aelvyril clones
// into its own copy and hands the sandbox a git bundle; to publish, it takes a bundle back out and pushes it itself, so
// nothing running inside a sandbox (hooks included) ever sees the token.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { GitHub } from "./github.ts";

export interface Project {
  id: string;
  name: string;
  /** owner/name on GitHub, when it came from one. */
  repo?: string;
  /** The branch it was made from, and the one the work goes on. */
  base?: string;
  branch: string;
  /** How to run its app for the preview. */
  run?: { command: string; port: number };
  /** The task asked to publish: waiting for the person's tap. */
  push?: { title: string; body: string; at: number };
  pr?: string;
  /** In the preview's address instead of a login: the preview must not carry Aelvyril's session (see app.ts). */
  previewKey: string;
  created_at: number;
}
export interface ProjectStatus {
  state: "running" | "stopped" | "missing" | "unknown";
  cpu?: number;
  cpus?: number;
  memUsed?: number;
  memLimit?: number;
  disk?: number | null;
  app?: boolean;
  error?: string;
}
export type Git = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;

const REPO_DIR = "/workspace/repo";
const realGit: Git = (args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env }, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) =>
      e ? reject(new Error(String(err || e.message).trim().split("\n").slice(-3).join(" "))) : resolve(out),
    ),
  );
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Projects {
  private file: string;
  private reposDir: string;
  private items: Project[] = [];
  private url: string;
  private token: string;
  private doFetch: typeof fetch;
  private git: Git;
  /** Being set up: its sandbox exists, it isn't listed until the copy is in. */
  private pending = new Set<string>();

  private github: GitHub | undefined;

  constructor(cfg: Config, github: GitHub | undefined, opts: { url?: string; token?: string; fetch?: typeof fetch; git?: Git } = {}) {
    this.github = github;
    this.file = join(cfg.dataDir, "projects.json");
    this.reposDir = join(cfg.dataDir, "repos");
    this.url = (opts.url ?? process.env.AELVYRIL_SANDBOXD_URL ?? "").replace(/\/$/, "");
    this.token = opts.token ?? process.env.AELVYRIL_SANDBOXD_TOKEN ?? "";
    this.doFetch = opts.fetch ?? fetch;
    this.git = opts.git ?? realGit;
    try {
      if (existsSync(this.file)) this.items = JSON.parse(readFileSync(this.file, "utf8")).filter((p: Project) => p?.id && p.previewKey);
    } catch {
      // a damaged file just means no projects listed (their sandboxes are still in Docker)
    }
  }

  enabled() {
    return !!(this.url && this.token);
  }
  list() {
    return this.items.map((p) => ({ ...p }));
  }
  get(id: string) {
    return this.items.find((p) => p.id === id);
  }
  byPreviewKey(key: string) {
    return this.items.find((p) => p.previewKey === key);
  }

  // ---------------------------------------------------------------- sandboxd
  private async sbx(path: string, init: RequestInit = {}) {
    if (!this.enabled()) throw new Error("Coding projects aren't set up on this Aelvyril (no sandbox service).");
    const res = await this.doFetch(`${this.url}/sandboxes/${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the sandbox service answered ${res.status}`);
    return res;
  }
  /** Runs a command in the project's sandbox. `out` is stdout and stderr in the order they came. */
  async exec(id: string, cmd: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}) {
    this.must(id);
    const d = (await (await this.sbx(`${id}/exec`, { method: "POST", body: JSON.stringify({ cmd, ...opts }) })).json()) as { exitCode: number; out: string; stdout: string };
    return { exitCode: d.exitCode, out: Buffer.from(d.out, "base64"), stdout: Buffer.from(d.stdout, "base64") };
  }
  async sh(id: string, script: string, opts: { env?: Record<string, string>; timeoutSec?: number } = {}) {
    const r = await this.exec(id, ["bash", "-lc", script], { cwd: REPO_DIR, ...opts });
    if (r.exitCode !== 0) throw new Error(r.out.toString().trim().split("\n").slice(-4).join(" ") || `exit ${r.exitCode}`);
    return r.stdout.toString();
  }
  async readFile(id: string, path: string) {
    this.must(id);
    return Buffer.from(await (await this.sbx(`${id}/file?path=${encodeURIComponent(path)}`)).arrayBuffer());
  }
  async writeFile(id: string, path: string, data: Buffer | string) {
    this.must(id);
    await this.sbx(`${id}/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: typeof data === "string" ? data : new Uint8Array(data) });
  }
  async status(id: string): Promise<ProjectStatus> {
    const p = this.must(id);
    try {
      const s = (await (await this.sbx(id)).json()) as ProjectStatus;
      if (s.state === "running" && p.run) s.app = (await this.exec(id, ["bash", "-c", "kill -0 $(cat /tmp/app.pid 2>/dev/null) 2>/dev/null"])).exitCode === 0;
      return s;
    } catch (e) {
      return { state: "unknown", error: (e as Error).message };
    }
  }
  async start(id: string) {
    this.must(id);
    await this.sbx(`${id}/start`, { method: "POST" });
  }
  async stop(id: string) {
    this.must(id);
    await this.sbx(`${id}/stop`, { method: "POST" });
  }
  async remove(id: string) {
    this.must(id);
    await this.sbx(id, { method: "DELETE" });
    rmSync(join(this.reposDir, `${id}.git`), { recursive: true, force: true });
    this.items = this.items.filter((p) => p.id !== id);
    this.save();
  }

  // ---------------------------------------------------------------- making one
  /** A new project: an empty git repo, or a copy of a GitHub repo on a fresh `aelvyril/…` branch. */
  async create(input: { name: string; repo?: string }): Promise<Project> {
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("A project needs a name.");
    const repo = input.repo?.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") || undefined;
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must look like owner/name.");
    let id = slug(name);
    for (let n = 2; this.get(id) || this.pending.has(id); n++) id = `${slug(name).slice(0, 20)}-${n}`;
    const p: Project = { id, name, branch: `aelvyril/${id}`, previewKey: randomBytes(18).toString("hex"), created_at: Date.now() };
    await this.sbx(id, { method: "POST" });
    this.pending.add(id);
    try {
      if (repo) {
        if (!this.github) throw new Error("GitHub isn't connected.");
        const info = await this.github.repo(repo);
        p.repo = info.full_name;
        p.base = info.default_branch;
        const bare = join(this.reposDir, `${id}.git`);
        mkdirSync(this.reposDir, { recursive: true });
        rmSync(bare, { recursive: true, force: true });
        await this.git(["clone", "--mirror", "--quiet", `https://github.com/${p.repo}.git`, bare], { env: await this.github.gitEnv() });
        const bundle = `${bare}.in.bundle`;
        await this.git(["-C", bare, "bundle", "create", bundle, "--all"]);
        await this.writeFile(id, "/tmp/in.bundle", readFileSync(bundle));
        rmSync(bundle, { force: true });
        await this.exec(id, ["bash", "-lc", `git clone -q /tmp/in.bundle ${REPO_DIR} && rm /tmp/in.bundle && cd ${REPO_DIR} && git remote set-url origin https://github.com/${p.repo}.git && git checkout -q -B ${q(p.branch)} ${q("origin/" + p.base)}`]).then((r) => {
          if (r.exitCode !== 0) throw new Error(`copying the repo into the sandbox failed: ${r.out.toString().trim()}`);
        });
      } else {
        await this.exec(id, ["bash", "-lc", `mkdir -p ${REPO_DIR} && cd ${REPO_DIR} && git init -q -b ${q(p.branch)}`]);
      }
      await this.exec(id, ["bash", "-lc", `cd ${REPO_DIR} && git config user.name Aelvyril && git config user.email aelvyril@users.noreply.github.com`]);
    } catch (e) {
      await this.sbx(id, { method: "DELETE" }).catch(() => {});
      throw e;
    } finally {
      this.pending.delete(id);
    }
    this.items.push(p);
    this.save();
    return p;
  }

  // ---------------------------------------------------------------- its app, for the preview
  previewBase(p: Project) {
    return `/preview/${p.previewKey}/`;
  }
  /** Sets how the app runs and (re)starts it, in the background, with its output in /tmp/app.log. */
  async runApp(id: string, run?: { command: string; port: number }) {
    const p = this.must(id);
    if (run) {
      const port = Math.round(Number(run.port));
      if (!run.command?.trim() || !(port >= 1024 && port <= 65535)) throw new Error("The app needs a command and a port from 1024 to 65535.");
      p.run = { command: run.command.trim().slice(0, 500), port };
      this.save();
    }
    if (!p.run) throw new Error("This project has no app to run yet.");
    await this.stopApp(id);
    await this.sh(id, `setsid bash -lc "$APP_COMMAND" > /tmp/app.log 2>&1 < /dev/null & echo $! > /tmp/app.pid`, {
      env: { APP_COMMAND: p.run.command, PORT: String(p.run.port), HOST: "0.0.0.0", PREVIEW_BASE: this.previewBase(p) },
    });
  }
  async stopApp(id: string) {
    this.must(id);
    await this.exec(id, ["bash", "-c", "p=$(cat /tmp/app.pid 2>/dev/null) && kill -TERM -- -$p 2>/dev/null; rm -f /tmp/app.pid; true"]);
  }
  async appLog(id: string) {
    return (await this.exec(id, ["bash", "-c", "tail -c 6000 /tmp/app.log 2>/dev/null"])).stdout.toString();
  }

  // ---------------------------------------------------------------- publishing
  /** The task's request to publish; the person decides. */
  requestPush(id: string, title: string, body: string) {
    const p = this.must(id);
    if (!p.repo) throw new Error("This project isn't from GitHub, so there's nowhere to push it.");
    p.push = { title: String(title).trim().slice(0, 200) || "Changes from Aelvyril", body: String(body ?? "").slice(0, 20_000), at: Date.now() };
    this.save();
  }
  /** The person tapped "Push and open PR": commit what's left, take the branch out as a bundle, push it from here, open the pull request. */
  async push(id: string) {
    const p = this.must(id);
    if (!p.repo || !p.base || !this.github) throw new Error("This project isn't from GitHub.");
    const title = p.push?.title ?? "Changes from Aelvyril";
    await this.sh(id, `git add -A && (git diff --cached --quiet || git commit -q --no-verify -m "$TITLE") && git bundle create /tmp/out.bundle ${q(p.branch)}`, { env: { TITLE: title }, timeoutSec: 120 });
    const bare = join(this.reposDir, `${id}.git`);
    const bundle = `${bare}.out.bundle`;
    writeFileSync(bundle, await this.readFile(id, "/tmp/out.bundle"));
    try {
      await this.git(["-C", bare, "fetch", "--quiet", bundle, `+refs/heads/${p.branch}:refs/heads/${p.branch}`]);
      await this.git(["-C", bare, "push", "--quiet", `https://github.com/${p.repo}.git`, `+refs/heads/${p.branch}:refs/heads/${p.branch}`], { env: await this.github.gitEnv() });
    } finally {
      rmSync(bundle, { force: true });
    }
    p.pr = await this.github.openPr(p.repo, { title, body: p.push?.body ?? "", head: p.branch, base: p.base });
    p.push = undefined;
    this.save();
    return p.pr;
  }

  private must(id: string) {
    const p = this.get(id) ?? (this.pending.has(id) ? ({ id } as Project) : undefined);
    if (!p) throw new Error("no such project");
    return p;
  }
  private save() {
    writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
}
