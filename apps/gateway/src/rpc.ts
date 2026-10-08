import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";

/**
 * Strict JSONL framing per pi RPC spec: LF is the ONLY delimiter; strip one
 * trailing \r; never use readline (it also splits on U+2028/U+2029 which are
 * valid inside JSON strings); StringDecoder handles multibyte straddling.
 * A single unterminated line may never exceed maxLineBytes — a hostile or
 * buggy child streaming one huge line must not be able to OOM the gateway.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Fatal protocol fault: one framed line grew past the decoder cap. */
export class JsonlOverflowError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`jsonl line exceeds ${maxLineBytes}-byte cap`);
    this.name = "JsonlOverflowError";
  }
}

export class JsonlDecoder {
  private buffer = "";
  /** Byte-accurate size of `buffer` on the wire (UTF-8). String .length
   *  counts UTF-16 code units, which under-counts multibyte chars (an emoji
   *  is 2 units but 4 bytes) and would let a hostile line occupy ~2x the
   *  configured cap in real memory. */
  private bufferBytes = 0;
  private decoder = new StringDecoder("utf8");
  private poisoned = false;

  constructor(readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer | string): unknown[] {
    if (this.poisoned) return [];
    this.buffer += this.decoder.write(chunk);
    this.bufferBytes += Buffer.byteLength(chunk);
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      // Bookkeeping is byte-accurate: the consumed slice (line + its LF, CR
      // included when present) leaves the buffer.
      this.bufferBytes -= Buffer.byteLength(this.buffer.slice(0, idx)) + 1;
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) out.push(JSON.parse(line));
    }
    if (this.bufferBytes > this.maxLineBytes) {
      // Stop accumulating and stay inert: the framing is broken or hostile,
      // so the caller tears the connection down instead of feeding more.
      this.poisoned = true;
      this.buffer = "";
      this.bufferBytes = 0;
      throw new JsonlOverflowError(this.maxLineBytes);
    }
    return out;
  }
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export type RpcMessage = RpcResponse | RpcEvent;

let nextId = 0;

export interface RpcClientOptions {
  /** Max bytes buffered for one unterminated line before the connection is
   *  treated as a fatal protocol fault. Default MAX_LINE_BYTES (16 MiB). */
  maxLineBytes?: number;
}

/**
 * Client over a ChildProcess stdio pair. Commands get id-correlated response
 * promises; protocol events are emitted on "event". The child's stderr is
 * surfaced on "stderr" (never parsed).
 */
export class RpcClient extends EventEmitter {
  private decoder: JsonlDecoder;
  private pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor(private child: ChildProcess, opts: RpcClientOptions = {}) {
    super();
    this.decoder = new JsonlDecoder(opts.maxLineBytes);
    // Writes race child death (dialog auto-responder, prompts at the moment
    // of a crash): a write on the destroyed stdin would otherwise surface as
    // an UNHANDLED 'error' event and take the gateway down. Failures that
    // matter surface through send()'s timeout/exit rejection instead.
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => {
      let msgs: unknown[];
      try {
        msgs = this.decoder.push(chunk);
      } catch (err) {
        this.failFatal(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const msg of msgs) this.handle(msg as RpcMessage);
    });
    child.stderr!.on("data", (chunk: Buffer) => this.emit("stderr", String(chunk)));
    // Terminal events ('exit' after a lived child, 'error' after a failed
    // spawn) must be observed exactly once — a spawn failure emits 'error'
    // with NO 'exit' following, and an unobserved 'error' is an uncaught
    // exception that kills the whole gateway. Both paths funnel through
    // terminate(): reject every pending send, then surface on "exit" (null
    // code for a failed spawn) so consumers need only the one listener.
    let terminated = false;
    const terminate = (emitCode: number | null, message: string) => {
      if (terminated) return;
      terminated = true;
      for (const [, p] of this.pending) p.reject(new Error(message));
      this.pending.clear();
      this.emit("exit", emitCode);
    };
    child.once("exit", (code) => terminate(code, `child exited (${code})`));
    child.once("error", (err) => terminate(null, `child failed to start: ${err.message}`));
  }

  /** Fatal protocol fault (decoder overflow): fail every pending send and
   *  tear the child down; the exit listener performs the final cleanup. */
  private failFatal(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.child.kill();
  }

  private handle(msg: RpcMessage): void {
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        // RpcEvent.type is `string`, so `=== "response"` can't exclude it;
        // per spec §14 a {type:"response", id} message IS a response.
        p.resolve(msg as RpcResponse);
      }
      return;
    }
    this.emit("event", msg);
  }

  send(command: Record<string, unknown>, timeoutMs = 10_000): Promise<RpcResponse> {
    const id = `gw_${nextId++}`;
    // A command may carry its OWN id that must reach the child verbatim —
    // extension_ui_response (#84) must echo the request's id, not a
    // correlation id. Those messages are extension-protocol writes, not
    // commands: pi sends no RpcResponse for them, so resolve immediately
    // after the write instead of parking a pending entry until timeout.
    if (typeof command.id === "string") {
      this.child.stdin!.write(JSON.stringify(command) + "\n");
      return Promise.resolve({ type: "response", command: String(command.type), success: true });
    }
    const wire = JSON.stringify({ id, ...command }) + "\n";
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(wire);
    });
  }
}
