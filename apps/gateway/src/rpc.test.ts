import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonlDecoder, RpcClient, type RpcEvent } from "./rpc.js";

describe("JsonlDecoder", () => {
  it("decodes complete lines across chunk boundaries", () => {
    const d = new JsonlDecoder();
    const a = d.push('{"a":1}\n{"b');
    const b = d.push('":2}\n');
    expect(a).toEqual([{ a: 1 }]);
    expect(b).toEqual([{ b: 2 }]);
  });

  it("strips a single trailing \\r", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\r\n')).toEqual([{ a: 1 }]);
  });

  it("does not split on U+2028 inside strings (readline would)", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"s":"a\u2028b"}\n')).toEqual([{ s: "a\u2028b" }]);
  });

  it("holds partial multibyte sequences via StringDecoder", () => {
    const d = new JsonlDecoder();
    const bytes = Buffer.from('{"e":"?"}\n', "utf8");
    const split = 7; // inside the multibyte char
    const a = d.push(bytes.subarray(0, split));
    const b = d.push(bytes.subarray(split));
    expect(a).toEqual([]);
    expect(b).toEqual([{ e: "?" }]);
  });
});

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

describe("RpcClient over fake child", () => {
  it("correlates the response and streams protocol events", async () => {
    const child = spawn(process.execPath, [fakePi]);
    const rpc = new RpcClient(child);
    const events: RpcEvent[] = [];
    rpc.on("event", (e: RpcEvent) => events.push(e));
    const res = await rpc.send({ type: "prompt", message: "hi" });
    expect(res.success).toBe(true);
    await vi.waitFor(() => {
      expect(events.map((e) => e.type)).toContain("agent_settled");
    });
    expect(events.some((e) => e.type === "message_update")).toBe(true);
    child.kill();
  });

  // #77: a prompt in flight while the child dies (e.g. a concurrent
  // abandon) writes to a dead stdin. Without the constructor's stdin
  // 'error' listener that surfaces as an UNHANDLED 'error' event and takes
  // the whole gateway down (authenticated DoS); with it, send() rejects
  // through the normal timeout/exit path instead.
  it("a write racing child death rejects instead of crashing the process (#77)", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const rpc = new RpcClient(child);
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(rpc.send({ type: "prompt", message: "hi" }, 500)).rejects.toThrow();
  });
});
