import { test, expect } from "@playwright/test";

test("Whippet local HTML smoke", async ({ page }) => {
  await page.setContent('<main><h1>Whippet</h1><button>執行測試</button></main>');
  await expect(page.getByRole("heading", { name: "Whippet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "執行測試" })).toBeEnabled();
});
