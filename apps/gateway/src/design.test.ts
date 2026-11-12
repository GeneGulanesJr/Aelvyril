import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { DesignStore } from "./design.ts";

const cfg = () => ({ dataDir: mkdtempSync(join(tmpdir(), "aelv-design-")) }) as Config;

test("design: colours are normalised, saved, kept across a restart, and reset", () => {
  const c = cfg();
  const d = new DesignStore(c);
  assert.deepEqual(d.get(), {});
  assert.deepEqual(d.set({ accent: "#1F8A5B", orb: "#0fa" }), { accent: "#1f8a5b", orb: "#00ffaa" });
  assert.deepEqual(d.set({ frame: "#101828" }), { accent: "#1f8a5b", orb: "#00ffaa", frame: "#101828" }, "a change keeps the rest");
  assert.deepEqual(new DesignStore(c).get(), d.get(), "survives a restart");
  assert.deepEqual(d.set({ reset: true }), {});
  assert.deepEqual(d.set({ reset: true, accent: "#ff6600" }), { accent: "#ff6600" }, "reset can come with a new colour");
});

test("design: layout choices are checked against their limits", () => {
  const d = new DesignStore(cfg());
  assert.deepEqual(d.set({ home: "grid", mascot: "large", width: "wide", scale: 110 }), { home: "grid", mascot: "large", width: "wide", scale: 110 });
  assert.deepEqual(d.set({ scale: "95" as unknown as number }).scale, 95, "a number written as text is fine");
  assert.throws(() => d.set({ home: "left" as "edges" }), /home must be one of: edges, grid/);
  assert.throws(() => d.set({ mascot: "huge" as "large" }), /mascot must be one of/);
  assert.throws(() => d.set({ scale: 200 }), /scale must be a number from 90 to 120/);
  assert.throws(() => d.set({ scale: 50 }), /scale must be a number from 90 to 120/);
  assert.throws(() => d.set({ scale: Number.NaN }), /scale/);
  assert.equal(d.get().scale, 95, "refused changes leave the rest alone");
});

test("design: a colour that would make things unreadable is refused with a reason, and nothing changes", () => {
  const d = new DesignStore(cfg());
  d.set({ accent: "#1f8a5b" });
  assert.throws(() => d.set({ frame: "#ffffff" }), /frame colour.*darker/);
  assert.throws(() => d.set({ accent: "#ffffff" }), /accent colour.*darker/);
  assert.throws(() => d.set({ accent: "#000000" }), /accent colour.*lighter/);
  assert.throws(() => d.set({ accent: "green" }), /hex colour/);
  assert.throws(() => d.set({ accent: "#ff6600", frame: "#ffffff" }), /frame/);
  assert.deepEqual(d.get(), { accent: "#1f8a5b" }, "a refused change saves none of its parts");
});

test("design: the assistant's own css is kept, but nothing that loads from the web or runs code", () => {
  const d = new DesignStore(cfg());
  const css = ".widget { border-radius: 4px; background: url(data:image/png;base64,AAAA) }";
  assert.equal(d.set({ css }).css, css);
  for (const bad of ["@import 'x.css';", ".a{background:url(https://evil.example/?q)}", ".a{background:url( 'http://x')}", ".a{width:expression(alert(1))}", "</style><script>"])
    assert.throws(() => d.set({ css: bad }), /can't use/, bad);
  assert.throws(() => d.set({ css: "a{}".repeat(8000) }), /too long/);
  assert.equal(d.get().css, css, "a refused change keeps the last good css");
  assert.equal("css" in d.set({ css: "" }), false, "empty removes it");
});

test("design: the home layout is kept when it fits the grid, refused when it doesn't", () => {
  const d = new DesignStore(cfg());
  const layout = { assistant: { x: 3, y: 0, w: 6, h: 8 }, "w:weather": { x: 0, y: 0, w: 3, h: 4 } };
  assert.deepEqual(d.set({ layout }).layout, layout);
  for (const bad of [{ a: { x: 10, y: 0, w: 4, h: 2 } }, { a: { x: 0, y: 0, w: 1.5, h: 2 } }, { "bad id!": { x: 0, y: 0, w: 1, h: 1 } }, []])
    assert.throws(() => d.set({ layout: bad as never }), /layout/);
  assert.deepEqual(d.set({ accent: "#1f8a5b" }).layout, layout, "other changes keep it");
});
