// Checks that nothing on the home screen overlaps, at many window sizes, empty and with chat content.
// Usage: node e2e/home-layout.mjs [url]   (needs Google Chrome and a FRESH instance: docker run -e AELVYRIL_OPEN_SETUP=1 ...)
// SHOTS=<dir> also saves a picture per size.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3001";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: process.env.SCHEME === "dark" ? "dark" : "light" })).newPage();

await page.goto(url);
await page.getByRole("button", { name: "Create account" }).waitFor();
await page.getByPlaceholder("Your name").fill("Sam");
await page.getByPlaceholder("Email").fill("sam@example.com");
await page.getByPlaceholder(/Password/).fill("correct-horse-1");
await page.getByRole("button", { name: "Create account" }).click();
await page.getByRole("heading", { name: "Welcome to Aelvyril" }).waitFor();
// "has used the app before" lands on the home screen
await page.evaluate(() => localStorage.setItem("aelvyril.unlocked", "1"));
await page.reload();
await page.locator(".home").waitFor();

const SIZES = process.env.SIZES ? process.env.SIZES.split(",").map((x) => x.split("x").map(Number)) : [[2560, 1300], [1920, 1080], [1600, 700], [1536, 864], [1440, 900], [1440, 600], [1366, 768], [1280, 720], [1280, 600], [1280, 480], [1180, 620], [1100, 700], [1100, 560], [1024, 640], [1000, 500], [980, 560], [962, 520], [900, 700], [768, 1024], [390, 780], [360, 640], [360, 480]];
const PIECES = [".mascot-btn", ".mascot-line", ".home-tasks", ".home-recent", ".home-ask", ".dock"];

const CHAT = `<div class="home-recent"><div class="hr-log"><p class="hr-you">What is on my list today?</p><div class="hr-ai"><p>You have three things: the dentist at 10, lunch with Sam, and the report due by five. Want me to draft the report outline while you are out?</p></div><p class="hr-you">Yes please</p><div class="hr-ai"><p>Started it as a task. I will tell you when it is ready.</p></div></div><div class="hr-foot"><button class="link hr-open">Open the Stream</button></div></div>`;

let bad = 0;
for (const withChat of [false, true]) {
  await page.evaluate(([chat, html]) => {
    document.querySelector(".home-recent")?.remove();
    if (chat) document.querySelector(".mascot-line").insertAdjacentHTML("afterend", html);
  }, [withChat, CHAT]);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate((pieces) => {
      const home = document.querySelector(".home").getBoundingClientRect();
      const box = pieces.map((s) => [s, document.querySelector(s)?.getBoundingClientRect()]).filter(([, b]) => b && b.width > 0 && b.height > 0);
      const issues = [];
      // everything has to be there and visible: a screen with half its pieces missing has nothing left to overlap
      const here = new Set(box.map(([s]) => s));
      for (const need of pieces.filter((x) => x !== ".home-recent" && x !== ".home-tasks")) if (!here.has(need)) issues.push(`${need} is missing or invisible`);
      for (let i = 0; i < box.length; i++) {
        const [a, ra] = box[i];
        // the home screen scrolls up and down when the window is short; sideways nothing may stick out
        if (ra.right > home.right + 1 || ra.left < home.left - 1) issues.push(`${a} sticks out of the screen`);
        for (let j = i + 1; j < box.length; j++) {
          const [b, rb] = box[j];
          if (ra.left < rb.right - 1 && rb.left < ra.right - 1 && ra.top < rb.bottom - 1 && rb.top < ra.bottom - 1) issues.push(`${a} overlaps ${b}`);
        }
      }
      return { issues, stacked: !!document.querySelector(".home-stack"), scrolls: document.documentElement.scrollWidth > innerWidth };
    }, PIECES);
    if (r.scrolls) r.issues.push("the page scrolls sideways");
    const tag = `${w}x${h}${withChat ? " +chat" : ""}${r.stacked ? " (stacked)" : ""}`;
    console.log(r.issues.length ? `✗ ${tag}: ${r.issues.join("; ")}` : `✓ ${tag}`);
    bad += r.issues.length ? 1 : 0;
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/layout-${w}x${h}${withChat ? "-chat" : ""}.png` });
  }
}
// The chat under the orb must scroll: with many messages, the oldest one has to be reachable (a bottom-aligned grid hid it for good).
await page.setViewportSize({ width: 1366, height: 768 });
const many = Array.from({ length: 10 }, (_, i) => (i % 2 ? `<p class="hr-you">message ${i}</p>` : `<div class="hr-ai"><p>reply ${i} with a few more words so that it is a real bubble</p></div>`)).join("");
await page.evaluate((html) => {
  document.querySelector(".home-recent")?.remove();
  document.querySelector(".mascot-line").insertAdjacentHTML("afterend", `<div class="home-recent"><div class="hr-log">${html}</div></div>`);
}, many);
const scroll = await page.evaluate(() => {
  const log = document.querySelector(".hr-log");
  log.scrollTop = 0;
  const first = log.firstElementChild.getBoundingClientRect().top >= log.getBoundingClientRect().top - 1;
  log.scrollTop = log.scrollHeight;
  const last = log.lastElementChild.getBoundingClientRect().bottom <= log.getBoundingClientRect().bottom + 1;
  return { overflows: log.scrollHeight > log.clientHeight, first, last };
});
console.log(scroll.overflows && scroll.first && scroll.last ? "✓ the chat scrolls: oldest and newest messages are both reachable" : `✗ the chat does not scroll properly: ${JSON.stringify(scroll)}`);
if (!(scroll.overflows && scroll.first && scroll.last)) bad++;

await browser.close();
if (bad) {
  console.log(`\n${bad} size(s) have overlapping or cut-off pieces`);
  process.exit(1);
}
console.log("\nHOME LAYOUT PASSED");
