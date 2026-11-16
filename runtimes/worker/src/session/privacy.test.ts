import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { explorationBrowser } from "../author/tools.js";
import { unconfirmedBrowserScope } from "../author/scope.js";

test("session browser snapshot redacts discovered page secrets and still rejects password fill", async () => {
  const cookie = "synthetic-cookie-sentinel";
  const hidden = "synthetic-hidden-sentinel";
  const password = "synthetic-password-sentinel";
  const server = createServer((_request, response) => {
    response.setHeader("Set-Cookie", `session=${cookie}; Path=/`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<main><p>${cookie} ${hidden} ${password}</p><input type="hidden" value="${hidden}"><input type="password" value="${password}"></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const scope = unconfirmedBrowserScope();
  scope.targets = [{ name: "synthetic", purpose: "", origin }];
  const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = existsSync(chromium.executablePath()) ? undefined : existsSync(localChrome) ? localChrome : undefined;
  const browser = explorationBrowser({}, { scope, executablePath });
  try {
    const snapshot = JSON.stringify(await browser.navigate(origin));
    assert.ok(!snapshot.includes(cookie), "cookie echoed by the page");
    assert.ok(!snapshot.includes(hidden), "hidden input echoed by the page");
    assert.ok(!snapshot.includes(password), "password input echoed by the page");
    assert.match(snapshot, /\[redacted\]/);
    await assert.rejects(browser.fill("input[type=password]", "synthetic-new-value"));
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
