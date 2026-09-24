import { test, expect } from "@playwright/test";

test.describe("home page (no auth)", () => {
  test("renders the AELVYRIL title + sign-in prompt when signed out", async ({ page }) => {
    await page.goto("/");
    // "/" redirects to /thread/new; signed-out users get the sign-in gate
    // (client-side useAuth — useAuth() reports signed-out without a session).
    await expect(page).toHaveURL(/\/thread\/new$/);
    await expect(page.getByRole("heading", { name: /AELVYRIL/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });
});
