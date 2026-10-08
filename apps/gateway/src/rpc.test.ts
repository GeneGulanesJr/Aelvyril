import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonlDecoder, JsonlOverflowError, RpcClient, type RpcEvent } from "./rpc.js";

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

  it("treats a line over the injected cap as a fatal protocol error", () => {
    const d = new JsonlDecoder(8);
    // Complete lines are unaffected by the cap.
    expect(d.push('{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(() => d.push("0123456789")).toThrow(JsonlOverflowError);
    // Poisoned after the overflow: never accumulates again.
    expect(d.push("more of the same")).toEqual([]);
  });

  // NIT follow-up: the cap is BYTE-accurate (UTF-8 wire bytes). A code-unit
  // check under-counts multibyte chars (an emoji is 2 UTF-16 units but 4
  // bytes) and let a hostile line occupy ~2x the configured cap.
  it("the cap counts UTF-8 bytes, not UTF-16 code units", () => {
    // 3 emoji = 6 UTF-16 units (would slip past a unit check of 8) but
    // 12 UTF-8 bytes — over the cap.
    const d = new JsonlDecoder(8);
    expect(() => d.push("😀😀😀")).toThrow(JsonlOverflowError);
    // Multibyte lines under the byte cap decode normally.
    const fine = new JsonlDecoder(16);
    expect(fine.push('{"s":"😀"}\n')).toEqual([{ s: "😀" }]);
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

  // Review: a failed spawn (PI_COMMAND binary missing) emits 'error' with
  // NO 'exit' following. Unobserved, that is an uncaught exception — the
  // whole gateway died with it. Now it funnels through the exit path:
  // pending sends reject with a clear error and one terminal "exit" (null
  // code) fires.
  it("a spawn failure rejects pending sends and exits once instead of crashing", async () => {
    const child = spawn("definitely-not-a-real-gateway-binary-xyz", ["--version"]);
    const rpc = new RpcClient(child);
    const exits: unknown[] = [];
    rpc.on("exit", (code) => exits.push(code));
    await expect(rpc.send({ type: "prompt", message: "hi" }, 1_000)).rejects.toThrow(
      /failed to start/,
    );
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(exits[0]).toBeNull();
  });

  // Review: JsonlDecoder buffers per line without limit — a child writing
  // one huge unterminated line used to grow the buffer until OOM. With a
  // cap injected, the overflow rejects the pending send and kills the child.
  it("an unterminated line past the cap rejects pending sends and kills the child", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);",
    ]);
    const rpc = new RpcClient(child, { maxLineBytes: 64 });
    const exited = new Promise<unknown>((resolve) => rpc.once("exit", resolve));
    await expect(rpc.send({ type: "prompt", message: "hi" }, 1_000)).rejects.toThrow(
      /byte cap/,
    );
    // The child is torn down, not left idling on its interval.
    await expect(exited).resolves.toBeDefined();
  });
});
