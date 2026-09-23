import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "./app.js";
import { toUserNamespace, type EventEnvelope } from "@aelvyril/shared";
import type { TokenVerifier } from "./auth.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

const testVerifier: TokenVerifier = async (token) =>
  token === "good"
    ? { userId: "user_test1" }
    : token === "good2"
      ? { userId: "user_test2" }
      : null;

const authHeaders = { authorization: "Bearer good" };

describe("SSE end-to-end", () => {
  let app: App;
  let baseUrl = "";

  beforeAll(async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  function makeReader(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      cancel: () => reader.cancel(),
      async nextEnvelope(): Promise<EventEnvelope> {
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue; // comment/retry block -- not an event
            return JSON.parse(dataLine.slice(6)) as EventEnvelope;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buffer += decoder.decode(value, { stream: true });
        }
      },
    };
  }

  it("streams envelopes for a prompt, in order, then settles", async () => {
    const conv = (await (
      await fetch(`${baseUrl}/v1/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const stream = await fetch(`${baseUrl}/v1/conversations/${conv.id}/events`, {
      headers: authHeaders,
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const sse = makeReader(stream);

    const promptPromise = fetch(`${baseUrl}/v1/conversations/${conv.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ message: "hi" }),
    });

    const seen: EventEnvelope[] = [];
    for (;;) {
      const env = await sse.nextEnvelope();
      seen.push(env);
      if (env.kind === "session_state" && env.payload.state === "idle") break;
    }
    await promptPromise;

    expect(seen[0]!.kind).toBe("session_state");
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    const text = seen
      .filter((e) => e.kind === "text_delta")
      .map((e) => e.payload.delta)
      .join("");
    expect(text).toBe("Hello, world!");

    // D7 contract end-to-end: the user's namespace reached the session host's
    // environment (fake-pi echoes LAPIS_PROJECT_KEY back before the tool_call).
    const echoIdx = seen.findIndex((e) => (e.kind as string) === "custom_env_echo");
    const toolCallIdx = seen.findIndex((e) => e.kind === "tool_call");
    expect(echoIdx).toBeGreaterThan(-1);
    expect(toolCallIdx).toBeGreaterThan(echoIdx);
    const echo = seen[echoIdx]!.payload as unknown as { LAPIS_PROJECT_KEY: string | null };
    expect(echo.LAPIS_PROJECT_KEY).toBe(toUserNamespace("user_test1"));
    expect(echo.LAPIS_PROJECT_KEY).toBe("user:user_test1"); // the actual value
    await sse.cancel();
  });

  it("rejects unauthenticated event streams", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations`);
    expect(res.status).toBe(401);
  });

  it("replays from Last-Event-ID on reconnect", async () => {
    const conv = (await (
      await fetch(`${baseUrl}/v1/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    await fetch(`${baseUrl}/v1/conversations/${conv.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ message: "hi" }),
    });
    await vi.waitFor(async () => {
      const one = await fetch(`${baseUrl}/v1/conversations/${conv.id}`, { headers: authHeaders });
      expect(((await one.json()) as { state: string }).state).toBe("idle");
    });

    // The env echo shifts seqs by one: 0 streaming, 1 echo, 2-5 deltas,
    // 6 tool_call, 7 tool_result, 8 idle. Last-Event-ID 6 skips echo+deltas.
    const replay = await fetch(`${baseUrl}/v1/conversations/${conv.id}/events`, {
      headers: { "last-event-id": "6", ...authHeaders },
    });
    // The stream stays open (heartbeat), so read bounded chunks until the
    // expected replayed event arrives, then cancel instead of draining.
    const reader = replay.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      for (;;) {
        if (body.includes("event: session_state")) break;
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    expect(body).toContain("event: session_state"); // the final idle event
    expect(body).not.toContain("event: text_delta"); // skipped with the echo
  });
});
