// Generated outside the saved spec: path mapping intercepts only its import.
// The bridge uses playwright/test to avoid recursively resolving its own alias.
export function fixtureBridge(observerURL: string): string {
  return `const api = require('playwright/test');
const test = api.test.extend({browser: [async ({browser}, use) => {
  let live;
  try { const {LiveObserver} = await import(${JSON.stringify(observerURL)}); live = new LiveObserver(); live.observeBrowser(browser); } catch {}
  try { await use(browser); } finally { if (live) await live.close().catch(() => {}); }
}, {scope: 'worker'}]});
for (const [key, value] of Object.entries(api)) if (!(key in test)) test[key] = value;
test.test = test; test.default = test;
module.exports = test;\n`;
}
