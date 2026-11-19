// Generated outside the saved spec: path mapping intercepts only its import.
// The bridge uses playwright/test to avoid recursively resolving its own alias.
export function fixtureBridge(observerURL: string,options?:{scopeURL:string;scope:unknown;privacyURL:string;navigationObservationPath?:string;jpegOnly?:boolean}): string {
  const scope=options?.scope;
  const navigationPath=options?.navigationObservationPath;
  return `const api = require('playwright/test');
const test = api.test.extend({browser: [async ({browser}, use) => {
  let live;
  try { const {LiveObserver} = await import(${JSON.stringify(observerURL)}); live = new LiveObserver(undefined,{jpegOnly:${options?.jpegOnly === true}}); live.observeBrowser(browser); } catch {}
  let privacy,restore,observedPage=false,navigated=false;
  ${options?`if(live){const {installLoginPrivacy}=await import(${JSON.stringify(options.privacyURL)});privacy=installLoginPrivacy(browser,live);}
  ${scope?`const {AIOriginGate,installAIOriginGate}=await import(${JSON.stringify(options.scopeURL)});`:''}`:''}
  ${scope||navigationPath?`const original=browser.newContext;
  browser.newContext=async(...args)=>{
    const context=await original.call(browser,${scope?`{...args[0],serviceWorkers:'block'}`:`...args`});
    ${scope?`await installAIOriginGate(context,new AIOriginGate(${JSON.stringify(scope)}));`:''}
    ${navigationPath?`context.on('page',page=>{observedPage=true;page.on('framenavigated',frame=>{try{if(frame===page.mainFrame())navigated=true;}catch{}});});`:''}
    return context;
  };
  restore=()=>{browser.newContext=original;};`:''}
  try { await use(browser); } finally {
    ${navigationPath?`if(observedPage){try{require('node:fs').writeFileSync(${JSON.stringify(navigationPath)},JSON.stringify({mainFrameNavigation:navigated?'OBSERVED':'NOT_OBSERVED'}),{flag:'wx',mode:0o600});}catch{}}`:''}
    if(restore)restore();if(privacy)privacy.close();if (live) await live.close().catch(() => {});
  }
}, {scope: 'worker'}]});
for (const [key, value] of Object.entries(api)) if (!(key in test)) test[key] = value;
test.test = test; test.default = test;
module.exports = test;\n`;
}
