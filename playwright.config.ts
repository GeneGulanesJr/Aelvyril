import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (spec §11: E2E — sign-in gate, send/stream/receive,
 * reconnect replay).
 *
 * Boots the gateway + web in a single shell before tests start. Both
 * processes use real Clerk dev keys (from apps/web/.env.local + apps/gateway/.env).
 * Tests run against http://localhost:3001 (web) + http://localhost:8787
 * (gateway), which is what the dev scripts already expose.
 *
 * To run: pnpm --filter @aelvyril/web exec playwright test
 * Browsers live in ~/.cache/ms-playwright/ (installed via `playwright install`).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // No webServer here — the gateway + web run as long-lived background
  // processes during dev. E2E tests assume they're already up (the
  // user starts them manually). For CI, set up the same way in the
  // workflow.
});
