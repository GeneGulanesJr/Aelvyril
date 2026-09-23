import { test, expect } from "@playwright/test";

test.describe("home page (no auth)", () => {
  test("renders the AELVYRIL title + sign-in prompt when signed out", async ({ page }) => {
    await page.goto("/");
    // Sign-in gate (server-side auth() returns null when signed out).
    await expect(page.getByRole("heading", { name: /AELVYRIL/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });
});
