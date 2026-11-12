import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { fill, isPrivate, paths, WidgetStore } from "./widgets.ts";

const cfg = () => ({ dataDir: mkdtempSync(join(tmpdir(), "aelv-widgets-")) }) as Config;
/** A stand-in for the web: answers with `body` (JSON unless a string), and counts calls. */
const web = (body: unknown, status = 200) => {
  const calls: string[] = [];
  const f = (async (u: URL) => {
    calls.push(String(u));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const PUBLIC = "http://93.184.216.34/forecast"; // a public IP literal: no DNS needed in the test

test("placeholders: paths, list items, filters; nothing found shows a dash and is reported", () => {
  const data = { current: { temperature_2m: 27.6, weather_code: 1, time: "2026-11-12T14:00" }, tags: ["a", "b"], hourly: { t: [20, 21] } };
  const missing = new Set<string>();
  const out = fill(
    { kind: "stat", value: "{{current.temperature_2m|round}}°C", label: "{{ current.weather_code | weather }} at {{current.time|time}}", detail: "{{hourly.t.1}} · {{tags|join}} · {{nope.x}} · {{tags|bogus}}" },
    data,
    missing,
  );
  assert.deepEqual(out, { kind: "stat", value: "28°C", label: "🌤️ Mainly clear at 14:00", detail: '21 · a, b · – · ["a","b"]' });
  assert.deepEqual([...missing], ["nope.x", "tags|bogus (no such filter)"]);
  assert.deepEqual(paths(data, 4), ["current.temperature_2m = 27.6", "current.weather_code = 1", "current.time = \"2026-11-12T14:00\"", "tags.0 = \"a\""]);
});

test("only public addresses: loopback, private ranges and link-local are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivate(ip), true, ip);
  for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivate(ip), false, ip);
});

test("a chat widget: the card as given, kept across a restart, replaced by id, removed", async () => {
  const c = cfg();
  const s = new WidgetStore(c);
  const r = await s.upsert({ title: "Reading list", card: { kind: "list", items: ["Dune"] } });
  assert.equal(r.widget.id, "reading-list");
  assert.deepEqual(r.widget.panel, { v: 1, id: "reading-list", title: "Reading list", kind: "list", items: ["Dune"] });
  await s.upsert({ id: "reading-list", title: "Reading list", card: { kind: "list", items: ["Dune", "Emma"] } });
  assert.equal(s.list().length, 1, "same id replaces, never duplicates");
  assert.deepEqual(new WidgetStore(c).list()[0].panel, { v: 1, id: "reading-list", title: "Reading list", kind: "list", items: ["Dune", "Emma"] }, "survives a restart");
  assert.equal(s.remove("reading-list"), true);
  assert.equal(s.remove("reading-list"), false);
  assert.deepEqual(new WidgetStore(c).list(), []);
});

test("bad widgets are explained, not saved", async () => {
  const s = new WidgetStore(cfg());
  await assert.rejects(s.upsert({ title: "", card: { kind: "stat", value: "1" } }), /needs a title/);
  await assert.rejects(s.upsert({ title: "X", card: { kind: "form", fields: [] } }), /kind must be one of: stat, markdown, list, table, status/);
  await assert.rejects(s.upsert({ title: "X", card: { kind: "stat" } }), /The card is not valid: value/);
  await assert.rejects(s.upsert({ title: "X", card: { kind: "stat", value: "1" }, fetch: { url: "http://127.0.0.1:3000/api", every: 10 } }), /private network/);
  await assert.rejects(s.upsert({ title: "X", card: { kind: "stat", value: "1" }, fetch: { url: "file:///etc/passwd", every: 10 } }), /only http and https/);
  await assert.rejects(s.upsert({ title: "X", card: { kind: "stat", value: "1" }, fetch: { url: PUBLIC, every: 1 } }), /every is in minutes, from 5/);
  assert.deepEqual(s.list(), []);
});

test("a fetched widget: read right away, filled, refreshed when due; a failed read keeps the last good card", async () => {
  const w = web({ current: { temperature_2m: 30.2, weather_code: 3 } });
  const s = new WidgetStore(cfg(), { fetch: w.f });
  const r = await s.upsert({ title: "Weather", card: { kind: "stat", value: "{{current.temperature_2m|round}}°C", label: "{{current.weather_code|weather}}", detail: "{{current.wind}}" }, fetch: { url: PUBLIC, every: 30 } });
  assert.equal(w.calls.length, 1, "read once right away");
  assert.deepEqual(r.widget.panel, { v: 1, id: "weather", title: "Weather", kind: "stat", value: "30°C", label: "☁️ Overcast", detail: "–" });
  assert.deepEqual(r.missing, ["current.wind"], "the assistant hears what its template could not find");
  assert.ok(r.paths.includes("current.temperature_2m = 30.2"));

  await s.tick(Date.now() + 10 * 60_000);
  assert.equal(w.calls.length, 1, "not due yet after 10 minutes");
  await s.tick(Date.now() + 31 * 60_000);
  assert.equal(w.calls.length, 2, "due after 30 minutes");

  const down = new WidgetStore(cfg(), { fetch: web("oops", 503).f });
  const ok = await new WidgetStore(cfg(), { fetch: w.f }).upsert({ title: "T", card: { kind: "stat", value: "{{current.temperature_2m}}" }, fetch: { url: PUBLIC, every: 5 } });
  assert.equal(ok.error, undefined);
  const bad = await down.upsert({ title: "T", card: { kind: "stat", value: "{{current.temperature_2m}}" }, fetch: { url: PUBLIC, every: 5 } });
  assert.match(bad.error ?? "", /answered 503/);
  assert.equal(bad.widget.panel.kind, "stat", "still shows a card (the empty fill) with the error beside it");
});

test("plain-text answers are readable as {{text}}; answers over the size limit are refused", async () => {
  const s = new WidgetStore(cfg(), { fetch: web("all systems go").f });
  assert.equal(((await s.upsert({ title: "Status", card: { kind: "status", text: "{{text}}" }, fetch: { url: PUBLIC, every: 5 } })).widget.panel as { text: string }).text, "all systems go");
  const big = new WidgetStore(cfg(), { fetch: web("x".repeat(600 * 1024)).f });
  assert.match((await big.upsert({ title: "Big", card: { kind: "status", text: "{{text}}" }, fetch: { url: PUBLIC, every: 5 } })).error ?? "", /bigger than 512 KB/);
});

