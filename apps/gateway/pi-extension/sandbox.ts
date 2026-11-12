// Bundled pi extension for a coding task (loaded only when the task belongs to a project; see Supervisor.ensureHost):
// read, write, edit and bash run inside the project's sandbox through the gateway, never on this machine.
// Paths under this process's own folder map to /workspace/repo; any other path is a path inside the sandbox.
// Not part of the gateway's typecheck: pi supplies these imports when it loads this file.
import { Type } from "typebox";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

const REPO = "/workspace/repo";
const project = process.env.AELVYRIL_PROJECT_ID ?? "";
const local = process.cwd();
const inSandbox = (p: string) => (p === local ? REPO : p.startsWith(local + "/") ? REPO + p.slice(local.length) : p);

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${process.env.AELVYRIL_INTERNAL_URL}/internal/projects/${project}${path}`, {
    ...init,
    headers: { "x-aelvyril-token": process.env.AELVYRIL_INTERNAL_TOKEN ?? "", "x-aelvyril-thread": process.env.AELVYRIL_THREAD_ID ?? "", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `sandbox call failed (${res.status})`);
  return res;
}
async function run(cmd: string[], opts: { cwd?: string; timeoutSec?: number } = {}) {
  const d: any = await (await call("/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, ...opts }) })).json();
  return { exitCode: d.exitCode as number, out: Buffer.from(d.out, "base64") };
}
const readFile = async (p: string) => Buffer.from(await (await call(`/file?path=${encodeURIComponent(inSandbox(p))}`)).arrayBuffer());
const writeFile = async (p: string, content: string) => void (await call(`/file?path=${encodeURIComponent(inSandbox(p))}`, { method: "PUT", body: content }));
const access = async (p: string) => {
  if ((await run(["test", "-r", inSandbox(p)])).exitCode !== 0) throw new Error(`no such file: ${p}`);
};

const ops = {
  read: { readFile, access },
  write: { writeFile, mkdir: async (d: string) => void (await run(["mkdir", "-p", inSandbox(d)])) },
  edit: { readFile, writeFile, access },
  bash: {
    exec: async (command: string, cwd: string, o: { onData(b: Buffer): void; timeout?: number }) => {
      // shortcut: output arrives when the command ends (no streaming) and an abort waits for it; fine for build/test commands
      const r = await run(["bash", "-lc", command], { cwd: inSandbox(cwd), timeoutSec: o.timeout ?? 600 });
      o.onData(r.out);
      return { exitCode: r.exitCode };
    },
  },
};

export default function (pi: any) {
  if (!project) return;
  const make = { read: createReadTool, write: createWriteTool, edit: createEditTool, bash: createBashTool } as const;
  for (const name of ["read", "write", "edit", "bash"] as const) {
    const base = make[name](local);
    pi.registerTool({
      ...base,
      description: `${base.description} (Runs inside this project's isolated sandbox; the code is in ${REPO}.)`,
      async execute(id: string, params: any, signal: any, onUpdate: any) {
        return make[name](local, { operations: (ops as any)[name] }).execute(id, params, signal, onUpdate);
      },
    });
  }

  pi.registerTool({
    name: "run_app",
    label: "Run the app for the preview",
    description:
      "Start (or restart) the project's app so the person can see it in a preview window. command starts the dev server from /workspace/repo; " +
      "it must listen on 0.0.0.0 and $PORT and serve under the base path in $PREVIEW_BASE. Leave both out to restart with the last ones. Returns whether it is up and the start of its log.",
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: "e.g. 'cd /workspace/repo && npm run dev -- --host 0.0.0.0 --port $PORT --base $PREVIEW_BASE'" })),
      port: Type.Optional(Type.Number({ description: "The port it listens on, 1024–65535 (it is also given as $PORT)" })),
    }),
    async execute(_id: string, params: { command?: string; port?: number }) {
      try {
        const d: any = await (await call("/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...params, waitMs: 6000 }) })).json();
        return { content: [{ type: "text", text: `${d.status?.app ? "The app is running." : "The app is not running (yet)."}\n--- log ---\n${d.log || "(empty)"}` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not run the app: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "request_push",
    label: "Ask to publish",
    description: "When the work is committed and checked: ask the person to push this branch to GitHub and open a pull request. They see a button; you can't push yourself.",
    parameters: Type.Object({
      title: Type.String({ description: "Pull request title" }),
      body: Type.String({ description: "Pull request description: what changed and how it was checked" }),
    }),
    async execute(_id: string, params: { title: string; body: string }) {
      try {
        await call("/push-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
        return { content: [{ type: "text", text: "Asked. The person sees a 'Push and open PR' button on the project." }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not ask: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });
}
