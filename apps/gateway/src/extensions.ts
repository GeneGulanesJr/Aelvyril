import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface ExtensionRow {
  /** What `pi install` was given, e.g. git:github.com/GeneGulanesJr/LaPis */
  source: string;
  /** A readable name taken from the source. */
  name: string;
  /** Part of how Aelvyril works: shown, but it can't be removed. */
  builtin: boolean;
}

export type Run = (args: string[]) => Promise<{ ok: boolean; output: string }>;

const BUILTIN: Record<string, string> = {
  "git:github.com/GeneGulanesJr/LaPis": "Memory (LaPis)",
  "git:github.com/GeneGulanesJr/PiSubagent": "Helpers that split big tasks (PiSubagent)",
  "git:github.com/DietrichGebert/ponytail": "Keeps answers short and changes small (ponytail, always at full)",
};

/**
 * Turns what a person pastes into a pi package source, or explains why not.
 * Accepts GitHub links ("https://github.com/owner/repo", "owner/repo") and npm names ("npm:name").
 * Local paths and anything with shell-ish characters are refused.
 */
export function normalizeSource(input: string): { source: string } | { error: string } {
  const raw = input.trim();
  const OWNER = "([A-Za-z0-9][A-Za-z0-9-]*)"; // GitHub user/org names: no dots, no leading dash
  const REPO = "((?!\\.{1,2}(?:$|\\/))[\\w.-]+?)";
  const gh = raw.match(new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/${OWNER}/${REPO}(?:\\.git)?/?(@[\\w./-]+)?$`, "i")) ?? raw.match(new RegExp(`^${OWNER}/${REPO}()$`));
  if (gh) return { source: `git:github.com/${gh[1]}/${gh[2]}${gh[3] ?? ""}` };
  if (/^git:github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}(?:$|@))[\w.-]+(@[\w./-]+)?$/.test(raw)) return { source: raw };
  if (/^npm:(@[\w.-]+\/)?[\w.-]+(@[\w.-]+)?$/.test(raw)) return { source: raw };
  return { error: "Paste a GitHub link (https://github.com/owner/name) or an npm name (npm:package)." };
}

const nameOf = (source: string) => BUILTIN[source] ?? source.replace(/^(git:github\.com\/|npm:)/, "");

export class Extensions {
  private cfg: Config;
  private onChange: () => void;
  private run: Run;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config, onChange: () => void, run?: Run) {
    this.cfg = cfg;
    this.onChange = onChange;
    this.run = run ?? ((args) => this.pi(args));
  }

  private pi(args: string[]): ReturnType<Run> {
    return new Promise((resolve) => {
      execFile(this.cfg.piCommand, [...this.cfg.piArgs, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: this.cfg.piHome, GIT_TERMINAL_PROMPT: "0" }, timeout: 180_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stdout + stderr).trim().split("\n").slice(-6).join("\n") });
      });
    });
  }

  list(): ExtensionRow[] {
    const file = join(this.cfg.piHome, "settings.json");
    let pkgs: unknown[] = [];
    try {
      if (existsSync(file)) pkgs = JSON.parse(readFileSync(file, "utf8")).packages ?? [];
    } catch {}
    return pkgs
      .map((p) => (typeof p === "string" ? p : (p as { source?: string })?.source))
      .filter((s): s is string => !!s)
      .map((source) => ({ source, name: BUILTIN[source] ?? nameOf(source), builtin: source in BUILTIN }));
  }

  /** One install/remove at a time: pi edits settings.json and the package folder. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => {});
    return next;
  }

  add(source: string) {
    return this.serial(async () => {
      const r = await this.run(["install", source]);
      if (r.ok) this.onChange();
      return r;
    });
  }

  /**
   * Updates every installed extension (pi update --extensions). The assistant's processes restart only when something
   * actually changed. pi says "Packages are already up to date" when nothing did.
   */
  update() {
    return this.serial(async () => {
      const r = await this.run(["update", "--extensions"]);
      const changed = r.ok && !/already up to date/i.test(r.output);
      if (changed) this.onChange();
      return { ...r, changed };
    });
  }

  remove(source: string) {
    return this.serial(async () => {
      if (!this.list().some((e) => e.source === source)) return { ok: false, output: "That extension is not installed." };
      if (source in BUILTIN) return { ok: false, output: "That extension is part of how Aelvyril works and can't be removed." };
      const r = await this.run(["remove", source]);
      if (r.ok) this.onChange();
      return r;
    });
  }
}
