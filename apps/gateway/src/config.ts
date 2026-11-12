import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

export interface Config {
  /** Everything persistent lives here (SQLite, auth secret, pi home, workspaces). */
  dataDir: string;
  /** Aelvyril's own pi home (PI_CODING_AGENT_DIR). */
  piHome: string;
  workspacesDir: string;
  /** The pi executable and its leading args; tests point this at a fake. */
  piCommand: string;
  piArgs: string[];
  port: number;
  host: string;
  /** Built web app to serve; skipped when the directory is absent. */
  webDir: string;
  authSecret: string;
  /** Bundled pi extension that gives the main conversation its start_job tool. */
  jobsExtension: string;
  /** Bundled pi extension that lets the main conversation see the person's screen. */
  screenExtension: string;
  /** Bundled pi extension that lets the main conversation change the app's colours. */
  designExtension: string;
  /** Bundled pi extension that lets the assistant put widgets on the home screen. */
  widgetsExtension: string;
  /** Bundled pi extension that tells every thread its name and what the app is. */
  identityExtension: string;
  /** Bundled pi extensions: coding projects for the main conversation, and the sandboxed tools a project's task gets. */
  projectsExtension: string;
  sandboxExtension: string;
  /** Bundled pi extension that makes a task's "finished" mean finished. */
  taskGuardExtension: string;
  /** Bundled guides (pi skills): what the assistant can and cannot do, read by the model when it needs them. */
  guidesDir: string;
  /** A working task silent for this long is stopped and marked failed. */
  taskStallMs: number;
  /** A task running longer than this in total is stopped and marked failed. */
  taskMaxMs: number;
  /** How often the gateway checks for stalled or runaway tasks. */
  watchdogMs: number;
  /** After the main conversation has been quiet this long, it saves what matters to memory and starts fresh
      (AELVYRIL_CLEAR_IDLE_MIN, default 30; 0 turns it off). */
  clearIdleMs: number;
  /** First sign-up needs no setup code (for installs bound to localhost only). */
  openSetup: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.AELVYRIL_DATA ?? "./data");
  const piHome = env.PI_CODING_AGENT_DIR ?? join(dataDir, "pi");
  const workspacesDir = join(dataDir, "workspaces");
  for (const d of [dataDir, piHome, workspacesDir]) mkdirSync(d, { recursive: true });
  return {
    dataDir,
    piHome,
    workspacesDir,
    piCommand: env.PI_COMMAND ?? "pi",
    piArgs: env.PI_ARGS ? env.PI_ARGS.split(" ") : [],
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    webDir: resolve(env.AELVYRIL_WEB ?? join(import.meta.dirname, "../../web/dist")),
    jobsExtension: resolve(import.meta.dirname, "../pi-extension/jobs.ts"),
    screenExtension: resolve(import.meta.dirname, "../pi-extension/screen.ts"),
    designExtension: resolve(import.meta.dirname, "../pi-extension/design.ts"),
    widgetsExtension: resolve(import.meta.dirname, "../pi-extension/widgets.ts"),
    identityExtension: resolve(import.meta.dirname, "../pi-extension/identity.ts"),
    taskGuardExtension: resolve(import.meta.dirname, "../pi-extension/task-guard.ts"),
    projectsExtension: resolve(import.meta.dirname, "../pi-extension/projects.ts"),
    sandboxExtension: resolve(import.meta.dirname, "../pi-extension/sandbox.ts"),
    guidesDir: resolve(import.meta.dirname, "../guides"),
    taskStallMs: Number(env.AELVYRIL_TASK_STALL_MS ?? 10 * 60_000),
    taskMaxMs: Number(env.AELVYRIL_TASK_MAX_MS ?? 60 * 60_000),
    watchdogMs: Number(env.AELVYRIL_WATCHDOG_MS ?? 30_000),
    clearIdleMs: Number(env.AELVYRIL_CLEAR_IDLE_MIN ?? 30) * 60_000,
    openSetup: env.AELVYRIL_OPEN_SETUP === "1",
    authSecret: env.BETTER_AUTH_SECRET ?? persistedSecret(join(dataDir, "auth-secret")),
  };
}

function persistedSecret(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(32).toString("hex");
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}
