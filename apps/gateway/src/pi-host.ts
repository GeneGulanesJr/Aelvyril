import { spawn, type ChildProcess } from "node:child_process";

type Json = Record<string, any>;

export interface PiHostOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onEvent(event: Json): void;
  onExit(code: number | null): void;
}

/** One `pi --mode rpc` child. JSONL over stdio, split on LF only (U+2028 is legal inside JSON strings). */
export class PiHost {
  private child: ChildProcess;
  private buf = "";
  private n = 0;
  private waiters = new Map<string, { resolve(r: Json): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  stderr = "";
  exited = false;

  private opts: PiHostOptions;

  constructor(opts: PiHostOptions) {
    this.opts = opts;
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onData(d));
    this.child.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (e) => (this.stderr += String(e)));
    this.child.on("close", (code) => {
      this.exited = true;
      for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("pi exited"));
      }
      this.waiters.clear();
      opts.onExit(code);
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: Json;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const w = m.type === "response" && typeof m.id === "string" ? this.waiters.get(m.id) : undefined;
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(m.id);
        w.resolve(m);
      } else {
        this.opts.onEvent(m);
      }
    }
  }

  /** Fire-and-forget write (extension_ui_response, etc.). */
  send(obj: Json) {
    if (!this.exited) this.child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  call(cmd: Json, timeoutMs = 30_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error("pi exited"));
      const id = `g${++this.n}`;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`pi did not answer ${cmd.type}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.send({ id, ...cmd });
    });
  }

  kill() {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}
