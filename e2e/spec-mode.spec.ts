import { test, expect } from "@playwright/test";

/**
 * Spec-mode interview flow (agent spec-centric UI, Task 22). Requires Clerk
 * TEST MODE magic links (see casual-ask.spec.ts + chat.spec.ts skip notes).
 * Enable by setting CLERK_TEST_MODE_EMAIL + CLERK_TEST_MODE_OTP and
 * switching test.fixme → test.
 */
test.describe("spec mode (signed in)", () => {
  test.fixme("ambiguous ask triggers spec interview, answers produce a draft", async ({ page }) => {
    await page.goto("/thread/new");
    await page.getByTestId("thread-input").fill("add role-based access to the admin dashboard");
    await page.getByTestId("ask-button").click();
    // Heuristic: multi-feature ask enters the interview.
    await expect(page.getByTestId("spec-session")).toBeVisible();
    // Answer the first question and submit the round.
    await page.getByTestId(/^q-/).first().fill("admin, editor, viewer");
    await page.getByTestId("submit-answers").click();
    // Draft spec appears with the goal field editable.
    await expect(page.getByTestId("spec-goal")).toBeVisible();
    // Approve & run transitions to execution.
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("output-tabs")).toBeVisible();
  });
});
