import { test } from "node:test";
import assert from "node:assert/strict";
import { emitPanel, parsePanel, PANEL_TYPE } from "./index.ts";

test("accepts a valid table", () => {
  const r = parsePanel({ v: 1, id: "p", kind: "table", columns: ["a"], rows: [[1], ["x"]] });
  assert.equal(r.ok, true);
});

test("rejects wrong version, unknown kind and bad shape", () => {
  assert.equal(parsePanel({ v: 2, id: "p", kind: "markdown", body: "x" }).ok, false);
  assert.equal(parsePanel({ v: 1, id: "p", kind: "nope" }).ok, false);
  assert.equal(parsePanel({ v: 1, id: "p", kind: "table", columns: ["a"] }).ok, false);
});

test("actions must be slash commands", () => {
  assert.equal(parsePanel({ v: 1, id: "p", kind: "actions", actions: [{ label: "Go", command: "go" }] }).ok, false);
});

test("emitPanel validates then appends", () => {
  const seen: unknown[] = [];
  emitPanel({ appendEntry: (t, d) => seen.push([t, d]) }, { v: 1, id: "p", kind: "markdown", body: "hi" });
  assert.equal((seen[0] as unknown[])[0], PANEL_TYPE);
  assert.throws(() => emitPanel({ appendEntry() {} }, { v: 1, id: "p", kind: "markdown" }));
});

test("a stat card: a value, optionally a label and a line under it", () => {
  assert.equal(parsePanel({ v: 1, id: "w", kind: "stat", value: "28°C", label: "Angeles City", detail: "Mainly clear" }).ok, true);
  assert.equal(parsePanel({ v: 1, id: "w", kind: "stat", value: 28 }).ok, false, "the value is text, so units and words fit");
});
