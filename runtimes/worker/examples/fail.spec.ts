import { test, expect } from "@playwright/test";

test("Whippet intentional assertion failure", async ({ page }) => {
  await page.setContent('<main><h1>Whippet</h1></main>');
  await expect(page.getByRole("heading")).toHaveText("This assertion must fail", { timeout: 1000 });
});
