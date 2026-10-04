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
      await fetch(`${baseUrl}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const stream = await fetch(`${baseUrl}/v1/threads/${conv.id}/events`, {
      headers: authHeaders,
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const sse = makeReader(stream);

    const promptPromise = fetch(`${baseUrl}/v1/threads/${conv.id}/prompt`, {
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
    // The user's prompt is part of the persisted history (replayed on switch).
    const userMsg = seen.find((e) => e.kind === "user_message");
    expect(userMsg?.payload).toMatchObject({ text: "hi" });
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
    const res = await fetch(`${baseUrl}/v1/threads`);
    expect(res.status).toBe(401);
  });

  it("replays from Last-Event-ID on reconnect", async () => {
    const conv = (await (
      await fetch(`${baseUrl}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    await fetch(`${baseUrl}/v1/threads/${conv.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ message: "hi" }),
    });
    await vi.waitFor(async () => {
      const one = await fetch(`${baseUrl}/v1/threads/${conv.id}`, { headers: authHeaders });
      expect(((await one.json()) as { state: string }).state).toBe("idle");
    });

    // user_message (1) shifts everything: 0 streaming, 1 user_message, 2 echo,
    // 3-6 deltas, 7 tool_call, 8 tool_result, 9 idle. Last-Event-ID 7 skips
    // the echo and deltas.
    const replay = await fetch(`${baseUrl}/v1/threads/${conv.id}/events`, {
      headers: { "last-event-id": "7", ...authHeaders },
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

describe("SSE per-user stream cap (#85)", () => {
  it("429s beyond the cap and releases the slot on close", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxSseStreamsPerUser: 1,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = app.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;
      const conv = (await (
        await fetch(`${base}/v1/threads`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({}),
        })
      ).json()) as { id: string };

      const first = await fetch(`${base}/v1/threads/${conv.id}/events`, { headers: authHeaders });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/v1/threads/${conv.id}/events`, { headers: authHeaders });
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: string }).error).toBe("too_many_streams");

      // Closing the first stream releases the slot for a new connection.
      await first.body!.cancel();
      await vi.waitFor(async () => {
        const third = await fetch(`${base}/v1/threads/${conv.id}/events`, { headers: authHeaders });
        expect(third.status).toBe(200);
        await third.body!.cancel();
      });
    } finally {
      await app.close();
    }
  });
});

describe("SSE replay pagination (#85)", () => {
  it("pages the backlog with a clean EOF so Last-Event-ID resumes", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      sseReplayPageSize: 2,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = app.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;
      const conv = (await (
        await fetch(`${base}/v1/threads`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({}),
        })
      ).json()) as { id: string };
      await fetch(`${base}/v1/threads/${conv.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ message: "hi" }),
      });
      await vi.waitFor(async () => {
        const one = await fetch(`${base}/v1/threads/${conv.id}`, { headers: authHeaders });
        expect(((await one.json()) as { state: string }).state).toBe("idle");
      });

      // Full backlog: seq 0 streaming, 1 user_message, 2 custom echo,
      // 3-6 deltas, 7 tool_call, 8 tool_result, 9 idle. Page size 2 →
      // every full page ends the stream; the client reconnects to continue.
      async function readPage(lastEventId?: string): Promise<EventEnvelope[]> {
        const res = await fetch(`${base}/v1/threads/${conv.id}/events`, {
          headers: lastEventId === undefined ? authHeaders : { "last-event-id": lastEventId, ...authHeaders },
        });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break; // clean EOF = the page boundary
          buffer += decoder.decode(value, { stream: true });
        }
        return buffer
          .split("\n\n")
          .filter((b) => b.startsWith("id: "))
          .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as EventEnvelope);
      }

      const p1 = await readPage();
      expect(p1.map((e) => e.seq)).toEqual([0, 1]);
      const p2 = await readPage("1");
      expect(p2.map((e) => e.seq)).toEqual([2, 3]);
      const p3 = await readPage("3");
      expect(p3.map((e) => e.seq)).toEqual([4, 5]);
      const p4 = await readPage("5");
      expect(p4.map((e) => e.seq)).toEqual([6, 7]);
      const p5 = await readPage("7");
      expect(p5.map((e) => e.seq)).toEqual([8, 9]);

      // Fully caught up: the stream stays open (heartbeat) instead of EOF.
      const open = await fetch(`${base}/v1/threads/${conv.id}/events`, {
        headers: { "last-event-id": "9", ...authHeaders },
      });
      const openReader = open.body!.getReader();
      const { value } = await openReader.read();
      expect(decoderText(value)).toContain("retry:");
      await openReader.cancel();
    } finally {
      await app.close();
    }
  });

  function decoderText(value: Uint8Array | undefined): string {
    return value === undefined ? "" : new TextDecoder().decode(value);
  }
});

describe("SSE CORS on hijacked streams", () => {
  // Regression: reply.hijack() bypasses @fastify/cors reply hooks, so the
  // streamed 200 went out with no Access-Control-Allow-Origin and browsers
  // dropped it despite the successful preflight.
  it("echoes the allow-listed origin + credentials on the raw stream", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      allowedOrigins: ["http://localhost:3000"],
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = app.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;
      const originHeaders = { ...authHeaders, origin: "http://localhost:3000" };
      const conv = await (
        await fetch(`${base}/v1/threads`, {
          method: "POST",
          headers: originHeaders,
        })
      ).json();
      const res = await fetch(`${base}/v1/threads/${(conv as { id: string }).id}/events`, {
        headers: originHeaders,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      await res.body!.cancel(); // release the hijacked socket or close() hangs
      // Non-allow-listed origin gets no ACAO on the stream.
      const denied = await fetch(`${base}/v1/threads/${(conv as { id: string }).id}/events`, {
        headers: { ...authHeaders, origin: "http://evil.example" },
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      await denied.body!.cancel();
    } finally {
      await app.close();
    }
  });
});
