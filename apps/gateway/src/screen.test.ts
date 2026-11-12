import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenStore } from "./screen.ts";
import { createGateway } from "./server.ts";
import { loadConfig } from "./config.ts";

const report = (over: Record<string, unknown> = {}) => ({
  kind: "desktop",
  viewport: { w: 1915, h: 948 },
  screen: { w: 1920, h: 1080 },
  dpr: 1,
  scheme: "dark",
  touch: false,
  orientation: "landscape",
  reducedMotion: false,
  browser: "Edge",
  installed: false,
  visible: true,
  ...over,
});

test("screen: reports are checked, the page on screen is current, old and surplus devices drop out", () => {
  const s = new ScreenStore();
  const t0 = 1_000_000_000;
  s.report("desk-aaaaaa", report(), t0);
  s.report("phone-bbbbbb", report({ kind: "phone", viewport: { w: 390, h: 780 }, touch: true, orientation: "portrait", visible: false }), t0 + 1000);
  const list = s.list(t0 + 2000);
  assert.deepEqual(list.map((d) => [d.id, d.current]), [["phone-bbbbbb", false], ["desk-aaaaaa", true]], "the visible page is current even though the phone reported last");
  assert.equal(list[1].viewport.w, 1915);

  assert.deepEqual(s.list(t0 + 13 * 3600_000), [], "nothing seen in the last 12 hours");
  assert.throws(() => s.report("x", report()), /bad screen report/, "a bad id is refused");
  assert.throws(() => s.report("desk-aaaaaa", report({ viewport: { w: 0, h: 5 } })), /bad screen report/);
  assert.throws(() => s.report("desk-aaaaaa", report({ kind: "fridge" })), /bad screen report/);
  assert.throws(() => s.report("desk-aaaaaa", report({ dpr: 99 })), /bad screen report/);
  assert.equal(s.list(t0 + 2000).length, 2, "a refused report changes nothing");

  for (let i = 0; i < 12; i++) s.report(`dev-${String(i).padStart(6, "0")}`, report(), t0 + 10_000 + i);
  assert.equal(s.list(t0 + 20_000).length, 8, "only the most recent few are kept");
});

test("screen: the get_screen tool's endpoint answers only our own pi processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-screen-"));
  const gw = await createGateway(loadConfig({ AELVYRIL_DATA: dir, PI_COMMAND: process.execPath, PI_ARGS: join(import.meta.dirname, "fake-pi.mjs"), AELVYRIL_WEB: join(dir, "no-web"), AELVYRIL_COMPACT_HOURS: "0" }));
  try {
    gw.screens.report("desk-aaaaaa", report());
    assert.equal((await gw.app.request("http://localhost/internal/screen")).status, 403);
    assert.equal((await gw.app.request("http://localhost/internal/screen", { headers: { "x-aelvyril-token": "wrong" } })).status, 403);
    const ok = await gw.app.request("http://localhost/internal/screen", { headers: { "x-aelvyril-token": gw.sup.internalToken } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { devices: { viewport: { w: number } }[] }).devices[0].viewport.w, 1915);
    assert.equal((await gw.app.request("http://localhost/api/screen", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "desk-aaaaaa", ...report() }) })).status, 401, "reports need a signed-in session");
  } finally {
    gw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
