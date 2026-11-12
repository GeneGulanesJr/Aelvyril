import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.ts";
import { loadConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "aelvyril-guides-"));
let gw: Awaited<ReturnType<typeof createGateway>>;
before(async () => {
  gw = await createGateway(loadConfig({ AELVYRIL_DATA: dir, PI_COMMAND: process.execPath, PI_ARGS: join(import.meta.dirname, "fake-pi.mjs"), AELVYRIL_WEB: join(dir, "no-web") }));
});
after(() => {
  gw.close();
  rmSync(dir, { recursive: true, force: true });
});

const extDir = join(import.meta.dirname, "../pi-extension");
const guidesDir = join(import.meta.dirname, "../guides");
const guides = readdirSync(guidesDir).map((name) => ({ name, text: readFileSync(join(guidesDir, name, "SKILL.md"), "utf8") }));

test("guides: each has frontmatter pi accepts, named after its folder", () => {
  assert.ok(guides.length >= 5);
  for (const g of guides) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(g.text)?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(fm)?.[1].trim() ?? "";
    assert.equal(field("name"), g.name, `${g.name}: name matches the folder`);
    assert.match(g.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(field("description").length > 20 && field("description").length <= 1024, `${g.name}: a description that says what it covers and when to read it`);
  }
});

test("guides: every tool the bundled extensions register is described in at least one guide", () => {
  const all = guides.map((g) => g.text).join("\n");
  const tools = readdirSync(extDir).flatMap((f) => [...readFileSync(join(extDir, f), "utf8").matchAll(/name: "(\w+)"/g)].map((m) => m[1]));
  assert.ok(tools.includes("continue_job") && tools.includes("get_abilities"), "the parse finds the tools");
  for (const t of tools) assert.ok(all.includes(t), `no guide mentions ${t}`);
});

test("guides: every pi child gets them, except a coding task (its read runs inside the sandbox)", async () => {
  const skillsOf = async (id: string) => (await gw.sup.ensureHost(id).call({ type: "get_state" })).data.skills;
  const main = gw.sup.main();
  assert.deepEqual(await skillsOf(main.id), [gw.cfg.guidesDir]);
  assert.deepEqual(await skillsOf(gw.sup.createThread().id), [gw.cfg.guidesDir]);
  assert.deepEqual(await skillsOf(gw.sup.createJob(main.id, "Plain task", "hello").id), [gw.cfg.guidesDir]);
  gw.sup.projectExists = () => true;
  assert.deepEqual(await skillsOf(gw.sup.createJob(main.id, "Coding task", "hello", "", "p1").id), []);
});

test("abilities: only for our own pi children; names the task AI; never a key", async () => {
  const get = (token?: string) => gw.app.request("/internal/abilities", { headers: token ? { "x-aelvyril-token": token } : {} });
  assert.equal((await get()).status, 403);
  assert.equal((await get("wrong")).status, 403);
  assert.ok(!gw.providers.saveCustom("my-llm", { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "sk-secret-123", models: [{ id: "qwen" }] }));
  gw.providers.setDefaultModel("my-llm", "qwen");
  let text = ((await (await get(gw.sup.internalToken)).json()) as { text: string }).text;
  assert.match(text, /AI for chats: qwen \(my-llm\)/);
  assert.match(text, /AI for tasks: the same as chats/);
  assert.match(text, /Coding projects: not set up/);
  assert.match(text, /GitHub: not (set up|connected)/);
  gw.providers.setTaskModel("openrouter", "vendor/big-1");
  const res = await get(gw.sup.internalToken);
  text = ((await res.json()) as { text: string }).text;
  assert.match(text, /AI for tasks: vendor\/big-1 \(openrouter\)/);
  assert.match(text, /AI: connected \(.*my-llm/);
  assert.doesNotMatch(text, /sk-secret-123|token|stored/i);
  assert.ok(!text.includes(gw.sup.internalToken));
});
