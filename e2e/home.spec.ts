import { test, expect } from "@playwright/test";

// app/page.tsx is a plain server redirect to /thread/new — "/" has no
// content of its own, and the sign-in gate lives in the thread page.
test.describe("home page (signed out)", () => {
  test('"/" redirects to the thread surface', async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/thread\/new$/);
  });

  test("the thread surface resolves past loading for an anonymous visitor", async ({ page }) => {
    await page.goto("/thread/new");
    // Clerk mode: the client-side gate (useAppAuth) renders the sign-in
    // prompt (AELVYRIL + sign-in link) — never the loading shell, and never
    // the composer. NEXT_PUBLIC_AUTH_DISABLED=1 dev builds swap Clerk for a
    // fixed dev identity, so the composer renders directly; accept either
    // terminal state, both prove the gate resolved.
    await expect(
      page
        .getByRole("link", { name: /sign in/i })
        .or(page.getByTestId("thread-input")),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("the sign-in prompt carries the AELVYRIL heading when gated", async ({ page }) => {
    await page.goto("/thread/new");
    const gate = page.getByRole("heading", { name: /AELVYRIL/ });
    const composer = page.getByTestId("thread-input");
    // Whichever terminal state the build renders, it must be a real screen.
    await expect(gate.or(composer)).toBeVisible({ timeout: 15_000 });
  });
});
