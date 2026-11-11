import { test, expect } from "@playwright/test";

test("legacy input without Workspace settings keeps baseURL unset", async ({ baseURL }) => {
  expect(baseURL).toBeUndefined();
});
