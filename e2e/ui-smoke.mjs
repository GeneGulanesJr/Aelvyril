// Drives the real UI in system Chrome, the way a non-technical person would.
// Usage: node e2e/ui-smoke.mjs [url]   (needs Google Chrome and a running instance, e.g. `docker compose up -d`)
// Start the scripted model first: node e2e/mock-model.mjs   (the instance reaches it at host.docker.internal:18777)
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const url = process.argv[2] ?? "http://localhost:3000";
const MODEL_ADDRESS = process.env.MODEL_ADDRESS ?? "http://host.docker.internal:18777/v1";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
const step = (s) => console.log("•", s);
if (process.env.TRACE) {
  page.on("requestfinished", async (r) => { if (r.url().includes("/api/models")) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s models ${(await r.response())?.status()} ${(await r.sizes()).responseBodySize}B`); });
  page.on("requestfailed", (r) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s FAILED ${r.url()} ${r.failure()?.errorText}`));
}
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS ?? "."}/${n}.png` });

try {
step("first run: create account, no setup code asked");
await page.goto(url);
await page.getByRole("button", { name: "Create account" }).waitFor();
assert.equal(await page.getByPlaceholder("Setup code").count(), 0);
await page.getByPlaceholder("Your name").fill("Sam");
await page.getByPlaceholder("Email").fill("sam@example.com");
await page.getByPlaceholder(/Password/).fill("correct-horse-1");
await page.getByRole("button", { name: "Create account" }).click();

step("welcome screen points to connecting an AI; a first-timer sees only the Stream (no view switcher yet)");
await page.getByRole("heading", { name: "Welcome to Aelvyril" }).waitFor();
assert.equal(await page.getByRole("tablist", { name: "Views" }).count(), 0, "no Stream | Inbox | Quick switcher before the first task finishes");
assert.equal(await page.getByRole("button", { name: "+ New chat" }).count(), 0, "the Stream replaces new chats");
await shot("1-welcome");
await page.getByRole("button", { name: "Connect an AI", exact: true }).click();

step("connect OpenRouter with an API key");
const row = page.locator(".provider-line", { hasText: "OpenRouter" });
await row.getByRole("button", { name: "Use an API key" }).click();
await page.getByRole("dialog").locator("input").first().fill("sk-or-test-1234");
await shot("2-key-dialog");
await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
await page.getByText("Connected ✓").waitFor();
await page.locator(".card", { hasText: "Connected" }).getByText("OpenRouter").first().waitFor();

step("add your own AI server, then make it the default");
await page.getByRole("button", { name: "Add a server" }).click();
await page.getByPlaceholder("my-server").fill("mock");
await page.getByPlaceholder("http://127.0.0.1:1234/v1").fill(MODEL_ADDRESS);
await page.getByPlaceholder("qwen2.5-7b-instruct").fill("spike-1");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.locator(".card", { hasText: "Connected" }).getByText("Your own server").waitFor();
await page.reload();
await page.getByRole("button", { name: "Settings", exact: true }).click();
const sel = page.locator(".card", { hasText: "The AI your new chats use" }).locator("select");
await sel.waitFor();
await sel.selectOption({ label: "mock · spike-1" });
await page.getByText("Saved. New chats will use it.").waitFor();
await shot("3-settings");

step("the Stream works: send a message and the answer shows");
await page.getByRole("button", { name: "Back", exact: true }).click();
const box = page.getByRole("textbox", { name: "Message", exact: true });
await box.fill("hello there");
await box.press("Enter");
const stream = page.getByRole("region", { name: "Stream", exact: true });
await stream.getByText("Hello from mock").waitFor({ timeout: 60000 });
await stream.getByText("hello there").first().waitFor();
await shot("4-stream");

step("first-timer rule: no view switcher before the first finished task");
assert.equal(await page.getByRole("tablist", { name: "Views" }).count(), 0);

step("a bigger request becomes a task: card in the Stream, result flows back, switcher appears");
await box.fill("please do-job for me");
await box.press("Enter");
await stream.getByText("Test job").first().waitFor({ timeout: 60000 });
await stream.getByText(/Your job finished: job-ok/).waitFor({ timeout: 90000 });
await shot("4b-task-done");
await page.getByRole("tablist", { name: "Views" }).waitFor();

step("Inbox lists the finished task, and its own conversation opens");
await page.getByRole("tab", { name: /Inbox/ }).click();
await page.locator(".view.out").waitFor({ state: "detached" }); // the old view has finished sliding away
// the Stream stays mounted (inert, hidden) behind the Inbox, so only look at what is visible
await page.getByText("Test job").locator("visible=true").first().click();
await page.getByText("job-ok").locator("visible=true").first().waitFor();
await shot("4c-inbox");

step("Quick opens with Ctrl+K and closes with Escape");
await page.keyboard.press("Control+k");
await page.getByPlaceholder("What do you need?").locator("visible=true").first().waitFor(); // the hidden Quick view has the same box
await shot("4d-quick");
await page.keyboard.press("Escape");

step("Board shows the Stream and the task as cards; fold, arrange with the keyboard, open the task");
await page.getByRole("tab", { name: "Board" }).click();
await page.locator(".view.out").waitFor({ state: "detached" });
// the other views stay mounted but hidden; getByRole only sees the visible Board panel
const board = page.getByRole("tabpanel", { name: "Board" });
const streamCard = board.getByRole("article", { name: "Stream" });
const taskCard = board.getByRole("article", { name: "Test job" });
await streamCard.waitFor();
await taskCard.waitFor({ timeout: 15000 });
await streamCard.getByText(/do-job/).first().waitFor(); // your last message in the Stream
await streamCard.getByRole("button", { name: "Open the Stream", exact: true }).waitFor();
await streamCard.getByRole("textbox", { name: "Write to the Stream", exact: true }).waitFor();
await taskCard.getByText("Done", { exact: true }).waitFor(); // the status chip
await taskCard.getByText(/job-ok/).first().waitFor(); // the one-line preview
await shot("4e-board");
const cardOrder = () => board.getByRole("article").evaluateAll((els) => els.map((e) => document.getElementById(e.getAttribute("aria-labelledby"))?.textContent));
assert.deepEqual(await cardOrder(), ["Stream", "Test job"], "the Stream card first by default");
await taskCard.getByRole("button", { name: "Collapse", exact: true }).click();
await taskCard.getByText(/job-ok/).first().waitFor({ state: "hidden" });
await taskCard.getByRole("button", { name: "Expand", exact: true }).click();
await taskCard.getByText(/job-ok/).first().waitFor();
await streamCard.getByRole("button", { name: "Move later", exact: true }).press("Enter");
await page.getByText("Stream moved to position 2 of 2").waitFor(); // the polite announcement
assert.deepEqual(await cardOrder(), ["Test job", "Stream"]);
await streamCard.getByRole("button", { name: "Move earlier", exact: true }).press("Enter");
await page.getByText("Stream moved to position 1 of 2").waitFor();
assert.deepEqual(await cardOrder(), ["Stream", "Test job"]);
await taskCard.getByRole("button", { name: "Open", exact: true }).click();
await page.getByRole("button", { name: "Close task" }).waitFor();
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Close task" }).waitFor({ state: "detached" });

await page.getByRole("tab", { name: "Stream" }).click();
await page.locator(".view.out").waitFor({ state: "detached" });

step("extensions: the defaults are listed, a bad link is explained");
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("tab", { name: "Extensions" }).click();
await page.getByText("Memory (LaPis)").waitFor();
await page.getByText(/PiSubagent/).first().waitFor();
await page.getByPlaceholder(/Paste a GitHub link/).fill("not a link");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.getByText(/Paste a GitHub link \(https/).waitFor();
await shot("5-extensions");

step("phone-sized screen");
await page.setViewportSize({ width: 390, height: 780 });
await page.getByRole("button", { name: "Back", exact: true }).click();
await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
await stream.getByText("Hello from mock").waitFor();
await shot("6-mobile");
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll on a phone");
await page.setViewportSize({ width: 360, height: 740 });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 360px");

step("the Board on a phone: one column, no sideways scroll");
await page.getByRole("tab", { name: "Board" }).click();
await page.locator(".view.out").waitFor({ state: "detached" });
await page.getByRole("tabpanel", { name: "Board" }).getByRole("article", { name: "Test job" }).waitFor();
await shot("7-board-mobile");
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll on the Board at 360px");

step("a task that cannot finish says so honestly, and Try again works");
await page.setViewportSize({ width: 1200, height: 800 });
await page.getByRole("tab", { name: "Stream" }).click();
await page.locator(".view.out").waitFor({ state: "detached" });
const box2 = page.getByRole("textbox", { name: "Message", exact: true });
await box2.fill("please do-job:cannot for me");
await box2.press("Enter");
await stream.getByText(/Couldn.t finish: there is no network/).first().waitFor({ timeout: 90000 });
await shot("7-failed-task");
await stream.getByRole("button", { name: /Couldn.t finish/ }).last().click();
await page.getByRole("button", { name: "Try again", exact: true }).click();
await page.getByText("Trying again.").locator("visible=true").first().waitFor({ timeout: 30000 });
await shot("8-retry");

assert.deepEqual(errors, [], "no uncaught page errors");
} catch (e) {
  await shot("failure").catch(() => {});
  console.log("FAILED at page:", page.url());
  await browser.close();
  throw e;
}
console.log("UI SMOKE PASSED");
await browser.close();
