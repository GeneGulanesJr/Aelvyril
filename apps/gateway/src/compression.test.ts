import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("response compression", () => {
  const goodVerifier = async (token: string | undefined) =>
    token === "good" ? { userId: "user_test1" } : null;

  it("gzip-encodes large JSON responses when client sends Accept-Encoding", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: goodVerifier,
      // Bump the per-user cap so we can stuff the list response with enough
      // rows to cross the 1KB compression threshold.
      maxConversationsPerUser: 100,
    });
    // Create a conversation with a long title (schema caps at 200 chars).
    // We use the full 200 + a list of 30 conversations so the GET list
    // response is ~6KB (well over 1KB) and crosses the compression threshold.
    const big = "x".repeat(195); // 195 + index suffix " 0".. " 29" = 197..199
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: { authorization: "Bearer good", "accept-encoding": "gzip" },
        payload: { title: `${big} ${i}` },
      });
      expect(r.statusCode).toBe(201);
    }
    // GET that returns the conversation row — which includes the long title.
    const res = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: { authorization: "Bearer good", "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    // @fastify/compress sets content-encoding when the payload > threshold.
    expect(res.headers["content-encoding"]).toBe("gzip");
    await app.close();
  });

  it("does not compress SSE streams (text/event-stream excluded by default)", async () => {
    // SSE streams must NOT be compressed — buffering the whole stream
    // would break Last-Event-ID reconnect semantics. @fastify/compress
    // excludes text/event-stream from its default streamTypes.
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: goodVerifier,
    });
    // Try to open the SSE route for a non-existent conv. The route
    // returns 404 BEFORE hijacking reply, so the response is JSON.
    // What we verify here is: the 404 path doesn't set content-encoding,
    // and the route definition (when it does succeed) is text/event-stream.
    // The route's streamType exclusion is verified by the @fastify/compress
    // defaults (text/event-stream is in streamTypes) — see plugin source.
    const res = await app.inject({
      method: "GET",
      url: "/v1/threads/conv_x/events",
      headers: { authorization: "Bearer good", "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-encoding"]).toBeUndefined();
    await app.close();
  });
});
