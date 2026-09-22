import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("health", () => {
  it("responds ok", async () => {
    const app = buildApp({ dbPath: ":memory:", childCommand: "node", childArgs: [] });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
