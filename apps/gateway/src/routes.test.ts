import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "./app.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

function makeApp() {
  return buildApp({
    dbPath: ":memory:",
    childCommand: process.execPath,
    childArgs: [fakePi],
    idleMs: 60_000,
  });
}

describe("v1 routes", () => {
  let app: App | undefined;
  afterEach(async () => app && (await app.close()));

  it("creates, lists, gets conversations", async () => {
    app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { title: "t", workspace: "LaPis" },
    });
    expect(created.statusCode).toBe(201);
    const conv = created.json();
    expect(conv.id).toMatch(/^conv_/);

    const list = await app.inject({ method: "GET", url: "/v1/conversations" });
    expect(list.json().conversations).toHaveLength(1);

    const one = await app.inject({ method: "GET", url: `/v1/conversations/${conv.id}` });
    expect(one.json().title).toBe("t");

    const missing = await app.inject({ method: "GET", url: "/v1/conversations/conv_x" });
    expect(missing.statusCode).toBe(404);
  });

  it("validates prompt body", async () => {
    app = makeApp();
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })
    ).json();
    const bad = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conv.id}/prompt`,
      payload: { message: "" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/conversations/conv_x/prompt",
      payload: { message: "hi" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("accepts a prompt and returns 202 immediately", async () => {
    app = makeApp();
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conv.id}/prompt`,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => {
      const one = await app!.inject({ method: "GET", url: `/v1/conversations/${conv.id}` });
      expect(one.json().state).toBe("idle");
    });
  });

  it("abort on unknown conversation 404s", async () => {
    app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/conversations/conv_x/abort" });
    expect(res.statusCode).toBe(404);
  });
});
