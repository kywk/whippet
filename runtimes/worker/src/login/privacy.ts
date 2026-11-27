import type {Browser,Page} from '@playwright/test';
import type {LiveObserver} from '../live/observer.js';
import {KnownSecrets} from './client.js';
import {LOGIN_HOOK,type LoginHooks,type LoginHook} from './helper.js';

// The page receives only matching element indexes. Keep credential and cookie
// values in the Worker, including after redirects to a different origin.
// Use a Chromium isolated world so application JavaScript cannot replace DOM
// methods or observe the trusted protocol session.
const masks = new WeakMap<Page, Promise<{
  update(values: string[]): Promise<void>
}>>();

async function createMask(page: Page) {
  const session = await page.context().newCDPSession(page);
  const known = new Set<string>();
  let running: Promise<void> | undefined;
  let changed = false;
  let closed = false;

  async function scan() {
    const {frameTree} = await session.send('Page.getFrameTree');
    const {executionContextId} = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'whippet-redaction'
    });
    const {result} = await session.send('Runtime.evaluate', {
      contextId:executionContextId,
      expression: `(() => {
        if (!globalThis.watchInstalled) {
          globalThis.watchInstalled = true;
          const style=document.createElement('style');
          style.textContent='input[type=password],[data-whippet-private]{color:transparent!important;text-shadow:none!important;background:#333!important;-webkit-text-fill-color:transparent!important}';
          (document.head || document.documentElement).appendChild(style);
          new MutationObserver(()=>globalThis.whippetMaskChanged('changed')).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
          document.addEventListener('input',()=>globalThis.whippetMaskChanged('changed'),true);
        }
        const rows=[];
        for (const el of document.querySelectorAll('input,textarea')) {
          if (el.type === 'password') el.setAttribute('data-whippet-private','');
          else if (el.value) rows.push([el,el.value]);
        }
        const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);
        for(let n=walker.nextNode();n;n=walker.nextNode()){
          const el=n.parentElement;
          if(el&&!['SCRIPT','STYLE'].includes(el.tagName)&&n.textContent.trim())rows.push([el,n.textContent]);
        }
        return rows;
      })()`
    });
    if (!result.objectId) return;
    const objectId = result.objectId;
    try {
      const {result: strings} = await session.send('Runtime.callFunctionOn',{
        objectId, functionDeclaration:'function(){return this.map(row=>row[1])}',returnByValue:true
      });
      const indexes: number[] = [];
      for (const [index,value] of (strings.value as string[]).entries()) {
        for (const secret of known) if (value.includes(secret)) { indexes.push(index); break; }
      }
      if (indexes.length) await session.send('Runtime.callFunctionOn',{
        objectId, functionDeclaration:"function(ids){for(const i of ids)this[i][0].setAttribute('data-whippet-private','')}",
        arguments:[{value:indexes}]
      });
    } finally { await session.send('Runtime.releaseObject',{objectId}).catch(()=>undefined); }
  }
  function refresh(): Promise<void> {
    changed = true;
    if (!running) running = (async()=>{
      while (changed && !closed) {
        changed = false;
        await scan();
      }
    })().finally(()=>{running=undefined;});
    return running;
  }
  await session.send('Runtime.enable');
  await session.send('Runtime.addBinding',{name:'whippetMaskChanged',executionContextName:'whippet-redaction'});
  session.on('Runtime.bindingCalled',event=>{
    if(event.name==='whippetMaskChanged') void refresh().catch(()=>undefined);
  });
  page.once('close',()=>{closed=true; known.clear();});
  return {async update(values:string[]) {
    for (const v of values) if (v) known.add(v);
    await refresh();
  }};
}

export async function maskKnownInputs(page:Page,values:string[]):Promise<void>{
  let mask=masks.get(page);
  if(!mask){mask=createMask(page);masks.set(page,mask);mask.catch(()=>masks.delete(page));}
  await (await mask).update(values);
}

export function installLoginPrivacy(browser:Browser,live?:LiveObserver):{close():void;secrets:KnownSecrets}{
  const secrets=new KnownSecrets();
  const original=browser.newContext;
  browser.newContext=async(...args)=>{const context=await original.apply(browser,args);context.on('page',(page)=>{page.on('domcontentloaded',()=>{if(secrets.list().length)void maskKnownInputs(page,secrets.list()).catch(()=>undefined);});});return context;};
  const hooks:LoginHook={
    async pause(){await live?.pauseSensitive();},resume(){return live?.resumeSensitive();},
    remember(values, credentials){if(credentials)secrets.addCredentials(...values);else for(const value of values)secrets.add(value);for(const context of browser.contexts())for(const page of context.pages())void maskKnownInputs(page,secrets.list()).catch(()=>undefined);},
  };
  (globalThis as LoginHooks)[LOGIN_HOOK]=hooks;
  return {secrets,close(){browser.newContext=original;if((globalThis as LoginHooks)[LOGIN_HOOK]===hooks)delete (globalThis as LoginHooks)[LOGIN_HOOK];secrets.clear();}};
}
