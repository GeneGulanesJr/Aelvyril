import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";

/**
 * Strict JSONL framing per pi RPC spec: LF is the ONLY delimiter; strip one
 * trailing \r; never use readline (it also splits on U+2028/U+2029 which are
 * valid inside JSON strings); StringDecoder handles multibyte straddling.
 */
export class JsonlDecoder {
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): unknown[] {
    this.buffer += this.decoder.write(chunk);
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) out.push(JSON.parse(line));
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

/**
 * Client over a ChildProcess stdio pair. Commands get id-correlated response
 * promises; protocol events are emitted on "event". The child's stderr is
 * surfaced on "stderr" (never parsed).
 */
export class RpcClient extends EventEmitter {
  private decoder = new JsonlDecoder();
  private pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor(private child: ChildProcess) {
    super();
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const msg of this.decoder.push(chunk)) this.handle(msg as RpcMessage);
    });
    child.stderr!.on("data", (chunk: Buffer) => this.emit("stderr", String(chunk)));
    child.once("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`child exited (${code})`));
      this.pending.clear();
      this.emit("exit", code);
    });
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
    const wire = JSON.stringify({ ...command, id }) + "\n";
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
