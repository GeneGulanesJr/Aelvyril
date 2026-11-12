import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.ts";
import { loadConfig } from "./config.ts";

test("static files: the page is never kept after an update, hashed assets are kept for good", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-static-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(web, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(web, "manifest.webmanifest"), "{}");
  const gw = await createGateway(loadConfig({ AELVYRIL_DATA: dir, PI_COMMAND: process.execPath, PI_ARGS: join(import.meta.dirname, "fake-pi.mjs"), AELVYRIL_WEB: web, AELVYRIL_COMPACT_HOURS: "0" }));
  try {
    const cache = async (path: string) => (await gw.app.request(`http://localhost${path}`)).headers.get("cache-control");
    assert.equal(await cache("/"), "no-cache");
    assert.equal(await cache("/some/page"), "no-cache", "any app address serves the page");
    assert.equal(await cache("/manifest.webmanifest"), "no-cache");
    assert.equal(await cache("/assets/index-abc123.js"), "public, max-age=31536000, immutable");
  } finally {
    gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
