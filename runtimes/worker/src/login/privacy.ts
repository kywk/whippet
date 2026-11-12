import type {Browser,Page} from '@playwright/test';
import type {LiveObserver} from '../live/observer.js';
import {KnownSecrets} from './client.js';
import {LOGIN_HOOK,type LoginHooks,type LoginHook} from './helper.js';

// Fixed DOM masking, not a model eval tool. Values stay in trusted process/page
// memory; hiding visual fields does not grant or change test assertions.
export async function maskKnownInputs(page:Page,values:string[]):Promise<void>{
  await page.evaluate((secrets)=>{
    const key='__whippetPrivacy';
    const global=window as unknown as Record<string,any>;
    const state=global[key]??={values:[],installed:false};state.values=[...new Set([...state.values,...secrets])];
    const apply=()=>{
      for(const element of document.querySelectorAll('input,textarea')){
        const field=element as HTMLInputElement;
        if(field.type==='password'||state.values.some((v:string)=>field.value?.includes(v)))element.setAttribute('data-whippet-private','');
      }
      const walker=document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        const parent=node.parentElement;if(parent&&!['SCRIPT','STYLE'].includes(parent.tagName)&&state.values.some((v:string)=>node!.textContent?.includes(v)))parent.setAttribute('data-whippet-private','');
      }
    };
    if(!state.installed){
      state.installed=true;const style=document.createElement('style');style.textContent='[data-whippet-private]{color:transparent!important;text-shadow:none!important;background:#333!important;-webkit-text-fill-color:transparent!important}';document.head.appendChild(style);
      new MutationObserver(apply).observe(document.documentElement,{subtree:true,childList:true,characterData:true});document.addEventListener('input',apply,true);
    }
    apply();
  },values);
}

export function installLoginPrivacy(browser:Browser,live:LiveObserver):{close():void;secrets:KnownSecrets}{
  const secrets=new KnownSecrets();
  const original=browser.newContext;
  browser.newContext=async(...args)=>{const context=await original.apply(browser,args);context.on('page',(page)=>{page.on('domcontentloaded',()=>{if(secrets.list().length)void maskKnownInputs(page,secrets.list()).catch(()=>undefined);});});return context;};
  const hooks:LoginHook={
    async pause(){await live.pauseSensitive();},resume(){return live.resumeSensitive();},
    remember(values){for(const value of values)secrets.add(value);for(const context of browser.contexts())for(const page of context.pages())void maskKnownInputs(page,secrets.list()).catch(()=>undefined);},
  };
  (globalThis as LoginHooks)[LOGIN_HOOK]=hooks;
  return {secrets,close(){browser.newContext=original;if((globalThis as LoginHooks)[LOGIN_HOOK]===hooks)delete (globalThis as LoginHooks)[LOGIN_HOOK];secrets.clear();}};
}
