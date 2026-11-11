// Generated outside the saved spec: path mapping intercepts only its import.
// The bridge uses playwright/test to avoid recursively resolving its own alias.
export function fixtureBridge(observerURL: string,options?:{scopeURL:string;scope:unknown;privacyURL:string}): string {
  return `const api = require('playwright/test');
const test = api.test.extend({browser: [async ({browser}, use) => {
  let live;
  try { const {LiveObserver} = await import(${JSON.stringify(observerURL)}); live = new LiveObserver(); live.observeBrowser(browser); } catch {}
  let privacy,restore;
  ${options?`if(live){const {installLoginPrivacy}=await import(${JSON.stringify(options.privacyURL)});privacy=installLoginPrivacy(browser,live);}
  ${options.scope?`const {AIOriginGate,installAIOriginGate}=await import(${JSON.stringify(options.scopeURL)});
  const original=browser.newContext;browser.newContext=async(...args)=>{const context=await original.call(browser,{...args[0],serviceWorkers:'block'});await installAIOriginGate(context,new AIOriginGate(${JSON.stringify(options.scope)}));return context;};restore=()=>{browser.newContext=original;};`:''}`:''}
  try { await use(browser); } finally {if(restore)restore();if(privacy)privacy.close();if (live) await live.close().catch(() => {}); }
}, {scope: 'worker'}]});
for (const [key, value] of Object.entries(api)) if (!(key in test)) test[key] = value;
test.test = test; test.default = test;
module.exports = test;\n`;
}
