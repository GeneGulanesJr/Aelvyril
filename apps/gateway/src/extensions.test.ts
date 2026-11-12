import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { Extensions, type Run } from "./extensions.ts";

const setup = (output: string, ok = true) => {
  const piHome = mkdtempSync(join(tmpdir(), "aelv-ext-"));
  writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: ["git:github.com/GeneGulanesJr/LaPis", "git:github.com/DietrichGebert/ponytail", "git:github.com/someone/mine"] }));
  const calls: string[][] = [];
  let changed = 0;
  const run: Run = async (args) => (calls.push(args), { ok, output });
  return { ext: new Extensions({ piHome } as Config, () => changed++, run), calls, changes: () => changed };
};

test("extensions: all show; the ones Aelvyril is built on can't be removed", async () => {
  const { ext, calls } = setup("");
  assert.deepEqual(ext.list().map((e) => [e.name.split(" (")[0], e.builtin]), [["Memory", true], ["Keeps answers short and changes small", true], ["someone/mine", false]]);
  const r = await ext.remove("git:github.com/DietrichGebert/ponytail");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0, "pi is never asked to remove it");
});

test("extensions: update restarts the assistant only when something changed", async () => {
  const same = setup("Updating git:github.com/GeneGulanesJr/LaPis...\nPackages are already up to date");
  assert.deepEqual(await same.ext.update(), { ok: true, output: "Updating git:github.com/GeneGulanesJr/LaPis...\nPackages are already up to date", changed: false });
  assert.deepEqual(same.calls, [["update", "--extensions"]]);
  assert.equal(same.changes(), 0);

  const newer = setup("Updating git:github.com/GeneGulanesJr/LaPis...\nUpdated git:github.com/GeneGulanesJr/LaPis");
  assert.equal((await newer.ext.update()).changed, true);
  assert.equal(newer.changes(), 1);

  const failed = setup("could not reach github.com", false);
  const r = await failed.ext.update();
  assert.deepEqual([r.ok, r.changed], [false, false], "a failed update changes nothing and restarts nothing");
  assert.equal(failed.changes(), 0);
});
