import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.ts";
import { loadConfig } from "./config.ts";
import { SAVE_BEFORE_CLEAR } from "./supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "aelvyril-clear-"));
let gw: Awaited<ReturnType<typeof createGateway>>;
before(async () => {
  // the timer is off here: the tests call clearMain(0) themselves (0 = no quiet time needed)
  gw = await createGateway(loadConfig({ AELVYRIL_DATA: dir, PI_COMMAND: process.execPath, PI_ARGS: join(import.meta.dirname, "fake-pi.mjs"), AELVYRIL_WEB: join(dir, "no-web"), AELVYRIL_CLEAR_IDLE_MIN: "0" }));
});
after(() => {
  gw.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const clears = (id: string) => gw.sup.eventsAfter(id).filter((e) => e.type === "aelvyril_cleared").length;
const said = (id: string) => gw.sup.eventsAfter(id).filter((e) => e.type === "message_end" && e.data.message.role === "user").map((e) => String(e.data.message.content));

test("clear: the save turn stays out of the Stream, then a fresh session; not again until something new is said", async () => {
  const main = gw.sup.main();
  await gw.sup.prompt(main.id, "hi");
  await until(() => !gw.sup.listThreads().find((t) => t.id === main.id)?.running && said(main.id).includes("hi"));
  await gw.sup.clearMain(0);
  assert.equal(clears(main.id), 1);
  assert.ok(!said(main.id).includes(SAVE_BEFORE_CLEAR), "the person never sees the save turn");
  assert.ok(!gw.sup.eventsAfter(main.id).some((e) => e.type === "message_end" && JSON.stringify(e.data).includes("echo: [aelvyril:before-clear]")), "nor its reply");
  await gw.sup.clearMain(0);
  assert.equal(clears(main.id), 1, "an empty session isn't cleared again");
});

test("clear: not until the chat has been quiet, not mid-answer, not while a task it started is working", async () => {
  const main = gw.sup.main();
  await gw.sup.prompt(main.id, "more");
  await until(() => !gw.sup.listThreads().find((t) => t.id === main.id)?.running && said(main.id).includes("more"));
  await gw.sup.clearMain(60_000);
  assert.equal(clears(main.id), 1, "it was just talking");
  await gw.sup.prompt(main.id, "/slow");
  await gw.sup.clearMain(0);
  assert.equal(clears(main.id), 1, "mid-answer");
  await until(() => !gw.sup.listThreads().find((t) => t.id === main.id)?.running);
  const job = gw.sup.createJob(main.id, "Long one", "/stall");
  await gw.sup.clearMain(0);
  assert.equal(clears(main.id), 1, "a task is still working");
  await gw.sup.abort(job.id).catch(() => {});
  gw.sup.deleteThread(job.id); // the stalled stand-in never ends on its own
});

test("clear: a message sent during the save turn waits, then lands in the fresh session and shows", async () => {
  const main = gw.sup.main();
  const clearing = gw.sup.clearMain(0);
  await gw.sup.prompt(main.id, "during");
  await clearing;
  await until(() => said(main.id).includes("during"));
});
