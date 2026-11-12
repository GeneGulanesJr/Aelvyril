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
// Screens open from the home screen: go Home, pick the button in the row at the bottom, and wait for the screen to finish sliding in.
const mainPrompt = async (startsWith) => {
  let s = "";
  for (let i = 0; i < 60; i++) {
    s = (await (await fetch("http://127.0.0.1:18777/_stats")).json()).mainSystem;
    if (s.startsWith(startsWith)) return s;
    await page.waitForTimeout(500);
  }
  return s;
};
let homes = 0;
const openView = async (name) => {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("tab", { name }).waitFor();
  await page.waitForTimeout(500); // the home screen has finished sliding back
  await shot(`home-${++homes}`);
  await page.getByRole("tab", { name }).click();
  await page.locator(".views.shown").waitFor();
  await page.locator(".home").waitFor({ state: "hidden" }); // it has finished sliding away
};

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
assert.equal(await page.getByRole("tablist", { name: "Views" }).count(), 0, "no Stream | Tasks switcher before the first task finishes");
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

step("identity: the assistant is Aelvyril (not pi) and knows the app; pi's coding-assistant intro is gone; ponytail is on at full");
const sys0 = await mainPrompt("Your name is Aelvyril.");
assert.match(sys0, /^Your name is Aelvyril\. Use that name for yourself, always, and never call yourself pi\./);
assert.match(sys0, /start_job/, "the gateway's own instructions are still there");
assert.match(sys0, /Stream, one permanent conversation/, "it knows what the app is");
assert.doesNotMatch(sys0, /coding assistant running inside pi/, "pi's own intro must not reach the model");
const pony = (await (await fetch("http://127.0.0.1:18777/_stats")).json()).ponytail;
assert.ok(pony.some((p) => /full/i.test(p)), `ponytail at full, saw: ${JSON.stringify(pony)}`);

step("first-timer rule: no view switcher before the first finished task");
assert.equal(await page.getByRole("tablist", { name: "Views" }).count(), 0);

step("a bigger request becomes a task: card in the Stream, result flows back, switcher appears");
await box.fill("please do-job for me");
await box.press("Enter");
await stream.getByText("Test job").first().waitFor({ timeout: 60000 });
await stream.getByText(/Your job finished: job-ok/).waitFor({ timeout: 90000 });
await shot("4b-task-done");
await page.getByRole("tablist", { name: "Views", includeHidden: true }).waitFor({ state: "attached" }); // the home screen is there, behind the Stream

step("Tasks is a kanban of projects; a project opens its own kanban of tasks, and a task opens beside it");
await openView(/Tasks/);
await page.locator(".view.out").waitFor({ state: "detached" }); // the old view has finished sliding away
// the Stream stays mounted (inert, hidden) behind Tasks, so only look at what is visible
await page.getByRole("button", { name: /^General: 1 done\. Open project/ }).click(); // a task started without a board goes on General
await page.getByRole("heading", { name: "General", exact: true }).waitFor();
await page.getByRole("button", { name: /^Test job, Done\. Open task/ }).locator("visible=true").first().click();
await page.getByText("job-ok").locator("visible=true").first().waitFor();
// a task reads top-down: what you asked, then the result; the steps are folded once it's done
await page.getByRole("heading", { name: "What you asked" }).locator("visible=true").first().waitFor();
await page.getByRole("heading", { name: "Result" }).locator("visible=true").first().waitFor();
assert.equal(await page.locator(".tp-how[open]").locator("visible=true").count(), 0, "how it went is folded on a finished task");
await shot("4c-inbox");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Close task" }).waitFor({ state: "detached" });

step("Quick is the Ctrl+K pop-up: it finds a task by name (arrow down, Enter opens it) and closes with Escape");
assert.equal(await page.getByRole("tab", { name: "Quick", includeHidden: true }).count(), 0, "Quick is no longer a screen of its own");
await page.keyboard.press("Control+k");
const quick = page.getByRole("dialog", { name: "Quick" });
await quick.getByRole("textbox", { name: "Send to the Stream or find a task" }).fill("test");
await quick.getByText("Tasks with that name").waitFor();
await shot("4d-quick");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.getByRole("heading", { name: "Test job", exact: true }).locator("visible=true").first().waitFor();
assert.equal(await quick.count(), 0, "opening a task closes the pop-up");
await page.keyboard.press("Control+k");
await quick.waitFor();
await page.keyboard.press("Escape");
await quick.waitFor({ state: "detached" });

step("the Stream is one readable column: the task sits in it as a card, and the card opens the task beside it");
await openView("Stream");
await page.locator(".view.out").waitFor({ state: "detached" });
assert.equal(await page.locator(".flow, .node").count(), 0, "no flow diagram any more");
await stream.getByRole("button", { name: /^Test job, Done\. Open task/ }).click();
await page.getByRole("button", { name: "Close task" }).waitFor();
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Close task" }).waitFor({ state: "detached" });

step("extensions: the built-in three are listed and locked, a bad link is explained");
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("tab", { name: "Extensions" }).click();
await page.getByText("Memory (LaPis)").waitFor();
await page.getByText(/PiSubagent/).first().waitFor();
await page.getByPlaceholder(/Paste a GitHub link/).fill("not a link");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.getByText(/Paste a GitHub link \(https/).waitFor();
await shot("5-extensions");
await page.getByRole("button", { name: "Check for updates" }).click();
await page.getByText(/Everything is up to date|Updated\. Your assistant/).waitFor({ timeout: 120000 });
await page.getByText(/ponytail, always at full/).waitFor();
assert.equal(await page.locator("button.btn[disabled]", { hasText: "Remove" }).count(), 3, "LaPis, PiSubagent and ponytail are shown but can't be removed");

step("Your assistant: set a name for it and for yourself");
await page.getByRole("tab", { name: "Your assistant" }).click();
await page.getByLabel("What should your assistant be called?").fill("Luna");
await page.getByLabel("What should it call you?").fill("Sam");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.getByText(/Saved\. It uses the new names/).waitFor();
await shot("5b-assistant");

step("phone-sized screen");
await page.setViewportSize({ width: 390, height: 780 });
await page.getByRole("button", { name: "Back", exact: true }).click();
await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
await stream.getByText("Hello from mock").waitFor();
await shot("6-mobile");
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll on a phone");
await page.setViewportSize({ width: 360, height: 740 });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 360px");

step("Tasks on a phone: the list, no sideways scroll");
await openView(/Tasks/);
await page.locator(".view.out").waitFor({ state: "detached" });
await page.getByText("Test job").locator("visible=true").first().waitFor();
await shot("7-tasks-mobile");
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll in Tasks at 360px");

step("a task that cannot finish says so honestly, and Try again works");
await page.setViewportSize({ width: 1200, height: 800 });

step("the home screen has a chat box under the assistant: the answer shows right there, without leaving home");
await page.getByRole("button", { name: "Home", exact: true }).click();
const ask = page.getByRole("textbox", { name: "Ask Aelvyril" });
await ask.fill("home hello");
await ask.press("Enter");
const recent = page.locator(".home-recent");
await recent.getByText("home hello").waitFor();
await recent.getByText("Hello from mock").waitFor({ timeout: 60000 });
assert.equal(await page.getByRole("button", { name: "Home", exact: true }).count(), 0, "still on the home screen");
await shot("home-chat");
await page.waitForTimeout(1500);
assert.equal(await recent.count(), 1, "the exchange stays until it is replaced or hidden");
await page.getByRole("button", { name: "Hide this exchange" }).click();
await recent.waitFor({ state: "detached" });

step("landing on the home screen with an existing Stream must not slide the page sideways (the Stream's flow sits off-screen behind it)");
await page.reload();
await page.locator(".home").waitFor();
await page.waitForTimeout(3000); // the Stream loads and its flow moves to the newest step
const slid = await page.evaluate(() => {
  const left = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left);
  return { shell: document.querySelector(".shell").scrollLeft, beam: left(".beam"), home: left(".home"), dock: left(".dock") > 0 };
});
assert.deepEqual(slid, { shell: 0, beam: 0, home: 8, dock: true }, `the home screen slid sideways: ${JSON.stringify(slid)}`);
await shot("home-after-reload");
assert.equal(await page.locator(".home-recent").count(), 0, "old messages are not shown under the orb after a reload (they live in the Stream)");
const sys1 = await mainPrompt("Your name is Luna.");
assert.match(sys1, /^Your name is Luna\./, "the new name is used from the next answer");
assert.match(sys1, /likes to be called Sam/);

step("design by chat: the assistant changes the colours, the app picks them up, and Settings puts the original look back");
await page.getByRole("tab", { name: "Stream" }).click(); // from the home screen
await page.locator(".home").waitFor({ state: "hidden" });
const box3 = page.getByRole("textbox", { name: "Message", exact: true });
await box3.fill("please do-design make it green");
await box3.press("Enter");
await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--accent") === "#1f8a5b", null, { timeout: 60000 });
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--orb-b-user")), "#ff8800");
// the layout part: wider reading column, larger orb, 110% size, tiles in a grid
const layout = () => page.evaluate(() => ({ col: document.documentElement.style.getPropertyValue("--col"), mascot: document.documentElement.style.getPropertyValue("--mascot-k"), zoom: document.documentElement.style.zoom, grid: !!document.querySelector(".shell.home-stack") }));
assert.deepEqual(await layout(), { col: "920px", mascot: "1.25", zoom: "1.1", grid: true });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at 110%");
await shot("9-design-green");
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("tab", { name: "Your assistant" }).click();
await page.getByRole("button", { name: "Back to the original look" }).click();
await page.getByText("The original look is back.").waitFor();
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--accent")), "", "the original look is back");
await page.waitForFunction(() => !document.querySelector(".shell.home-stack"));
assert.deepEqual(await layout(), { col: "", mascot: "", zoom: "", grid: false }, "the layout is back too");
await page.getByRole("button", { name: "Back", exact: true }).click();

step("the assistant can see the screen: the app reports it, and get_screen tells the model the window size and the layout facts");
await page.setViewportSize({ width: 1234, height: 777 }); // a size nothing else uses, so the answer can only come from this report
await page.waitForTimeout(1500); // a resize is reported after a short pause
const box4 = page.getByRole("textbox", { name: "Message", exact: true });
await box4.fill("please do-screen");
await box4.press("Enter");
let screenSaid = "";
for (let i = 0; i < 60 && !screenSaid.includes("1234×777"); i++) {
  await page.waitForTimeout(500);
  screenSaid = (await (await fetch("http://127.0.0.1:18777/_stats")).json()).lastToolResult;
}
assert.match(screenSaid, /desktop · window 1234×777/, `the model was told the window size: ${screenSaid}`);
assert.match(screenSaid, /\(on screen now\)/);
assert.match(screenSaid, /under 1180px wide/, "and the layout facts it needs to choose well");
await page.setViewportSize({ width: 1200, height: 800 });
await openView("Stream");
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
