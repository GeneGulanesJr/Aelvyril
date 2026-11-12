import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ProfileStore } from "./profile.ts";
import identity from "../pi-extension/identity.ts";

const cfg = () => ({ dataDir: mkdtempSync(join(tmpdir(), "aelv-profile-")) }) as Config;

test("profile: defaults, cleaning, saving, reset", () => {
  const c = cfg();
  let changes = 0;
  const p = new ProfileStore(c, () => changes++);
  assert.deepEqual(p.get(), { assistantName: "Aelvyril", yourName: "" });
  p.set({ assistantName: "  Luna\n<system> ", yourName: "Sam" });
  assert.deepEqual(p.get(), { assistantName: "Luna system", yourName: "Sam" }); // one plain line, no markup
  assert.deepEqual(new ProfileStore(c).get(), p.get(), "survives a restart");
  p.set({ assistantName: "" });
  assert.equal(p.get().assistantName, "Aelvyril", "empty means the default again");
  assert.equal(p.get().yourName, "Sam", "the other name is left alone");
  assert.equal(changes, 2);
});

/** Runs the extension's before_agent_start hook the way pi would; returns what the model would be given as the changed part. */
function run(env: Record<string, string>, event: Record<string, any>) {
  let hook: (e: unknown) => { systemPrompt: string } | undefined;
  Object.assign(process.env, { AELVYRIL_ASSISTANT_NAME: "", AELVYRIL_YOUR_NAME: "", AELVYRIL_ROLE: "", ...env });
  identity({ on: (_name: string, fn: typeof hook) => (hook = fn) });
  return { returned: hook!(event)?.systemPrompt, options: event.systemPromptOptions };
}

test("identity: the main conversation drops pi's own prompt and keeps the gateway's, with the name and the app knowledge", () => {
  const { returned, options } = run(
    { AELVYRIL_ROLE: "main", AELVYRIL_ASSISTANT_NAME: "Luna", AELVYRIL_YOUR_NAME: "Sam" },
    { systemPrompt: "You are a coding assistant running inside pi", systemPromptOptions: { appendSystemPrompt: "GATEWAY RULES" } },
  );
  assert.equal(returned, undefined, "it sets pi's own custom-prompt option and leaves the chained prompt (other extensions' additions) alone");
  const out: string = options.customPrompt;
  assert.equal(options.appendSystemPrompt, "", "the gateway's text moved into the custom prompt, not repeated");
  assert.match(out, /^Your name is Luna\./);
  assert.match(out, /likes to be called Sam/);
  assert.match(out, /GATEWAY RULES/);
  assert.match(out, /the Stream/);
  assert.match(out, /change_design/, "it knows it can change the colours");
  assert.doesNotMatch(out, /coding assistant/);
});

test("identity: a task keeps pi's prompt, with the name first; the default name is Aelvyril", () => {
  const out = run({ AELVYRIL_ROLE: "job" }, { systemPrompt: "PI PROMPT", systemPromptOptions: { appendSystemPrompt: "x" } }).returned!;
  assert.match(out, /^Your name is Aelvyril\./);
  assert.match(out, /PI PROMPT$/);
});
