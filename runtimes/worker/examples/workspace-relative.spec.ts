import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";

// Isolated Worker fixture, no shared Server/DB/model dependency.
let server: Server;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(request.url === "/base/probe" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><h1>Workspace snapshot baseURL</h1>");
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(18765, "127.0.0.1", done); });
});
test.afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

test("relative navigation uses this task's Workspace defaultTestUrl", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBe("http://127.0.0.1:18765/base/");
  const response = await page.goto("probe");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL("http://127.0.0.1:18765/base/probe");
  await expect(page.getByRole("heading", { name: "Workspace snapshot baseURL", exact: true })).toBeVisible();
  await testInfo.attach("snapshot-base-url", { body: await page.screenshot({ type: "png" }), contentType: "image/png" });
});
