import { test, expect } from "@playwright/test";

/**
 * Casual ask flow (agent spec-centric UI, Task 21). The full signed-in flow
 * requires Clerk TEST MODE magic links (see chat.spec.ts skip note + README
 * "Optional polish"). Enable by setting CLERK_TEST_MODE_EMAIL +
 * CLERK_TEST_MODE_OTP and switching test.fixme → test.
 */
test.describe("casual ask (signed in)", () => {
  test.fixme("casual ask produces plan + diff without spec interview", async ({ page }) => {
    await page.goto("/thread/new");
    await page.getByTestId("thread-input").fill("rename getUserById to findUserById");
    await page.getByTestId("ask-button").click();
    // Lands on /thread/<id>; heuristic: trivial rename must NOT open the interview.
    await expect(page.getByTestId("spec-session")).toHaveCount(0);
    await expect(page.getByTestId("output-tabs")).toBeVisible();
  });
});

test.describe("thread surface (signed out)", () => {
  test("/ redirects to /thread/new and shows the sign-in gate", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/thread\/new$/);
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
    // No chat UI flash (spec §11 defensive UI).
    await expect(page.getByTestId("thread-input")).toHaveCount(0);
  });
});
