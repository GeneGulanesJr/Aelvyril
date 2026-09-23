import { test, expect } from "@playwright/test";

/**
 * Sign-in flow tests are skipped by default — they require a Clerk
 * TEST INSTANCE with magic-link sign-in configured (Clerk dashboard →
 * Users & Authentication → Test mode). The skip message tells the
 * operator how to enable them.
 */
test.describe("chat (signed in)", () => {
  test.skip("signs in via Clerk test mode magic link", async () => {
    // To enable: set CLERK_TEST_MODE_EMAIL + CLERK_TEST_MODE_OTP in the
    // dev env, then unskip. The Clerk Test Helper
    // (https://clerk.com/docs/testing/test-helpers) provides the API.
  });

  test.skip("sends a prompt and receives text_delta + tool_call envelopes", async ({ page }) => {
    await page.goto("/");
    // Sign in (test mode), wait for chat UI, type, hit send.
    // Assert: text_delta envelopes appear, agent_settled transitions to idle.
  });

  test.skip("reconnects to /events with Last-Event-ID after disconnect", async ({ page }) => {
    await page.goto("/");
    // Trigger a brief SSE drop, verify reconnect resumes from last seen seq.
  });
});

test.describe("chat (no auth) — defensive UI", () => {
  test("the home page renders the sign-in gate immediately, no flash of chat", async ({ page }) => {
    await page.goto("/");
    // Even with the Clerk publishable key missing or invalid, the server-
    // side auth() should return null and show the sign-in gate, not the
    // chat UI. (Spec §11 defensive UI.)
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /send/i })).toHaveCount(0);
  });
});
