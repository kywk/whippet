import {createConnection} from 'node:net';
import type {Page} from '@playwright/test';
import {origin} from '../workspace-context.js';
import {CredentialError,MAX_CREDENTIAL_FRAME,type Credentials} from './client.js';
import {maskKnownInputs} from './privacy.js';

export const LOGIN_HOOK=Symbol.for('whippet.login.hook');
export interface LoginHook {pause():Promise<void>;resume():Promise<void>|void;remember(values:string[]):void;}
export type LoginHooks=typeof globalThis&{[LOGIN_HOOK]?:LoginHook};

export async function submitLogin(page:Page,values:Credentials,usernameSelector:string,passwordSelector:string,submitSelector:string):Promise<{submitted:true}> {
  if([usernameSelector,passwordSelector,submitSelector].some((s)=>!s||s.length>1000)||origin(new URL(page.url()).origin)!==origin(values.loginOrigin))throw new CredentialError();
  // Check form.action and any submit button override before giving it values.
  const target=await page.locator(submitSelector).evaluate((node)=>{
    const button=node as HTMLButtonElement;return button.getAttribute('formaction')?button.formAction:button.form?.action??location.href;
  });
  if(origin(new URL(target).origin)!==origin(values.loginOrigin))throw new CredentialError();
  const hooks=(globalThis as LoginHooks)[LOGIN_HOOK];await hooks?.pause();
  try{
    hooks?.remember([values.username,values.password]);
    await maskKnownInputs(page,[values.username,values.password]);
    // Fixed code, not model eval. No password literal in source or fill title.
    for(const [selector,value]of [[usernameSelector,values.username],[passwordSelector,values.password]] as const){
      await page.locator(selector).evaluate((node,text)=>{
        if(!(node instanceof HTMLInputElement))throw new Error('unsupported_login_input');
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        setter?.call(node,text);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
      },value);
    }
    await page.locator(submitSelector).click();
    // Password input remains hidden after failed login too; do not expose value.
    return {submitted:true};
  }catch{throw new CredentialError();}finally{
    await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>undefined);
    const cookies=await page.context().cookies().catch(()=>[]);hooks?.remember(cookies.map((c)=>c.value));
    await maskKnownInputs(page,[values.username,values.password,...cookies.map((c)=>c.value)]).catch(()=>undefined);
    await hooks?.resume();
  }
}

// The parent runner owns Manager stdin. Only this local attempt socket is used
// by the full Playwright worker; neither credentials nor tokens are in env.
export async function loginAs(page:Page,roleId:string,usernameSelector:string,passwordSelector:string,submitSelector:string):Promise<{submitted:true}> {
  const socketPath=process.env.WHIPPET_LOGIN_SOCKET;
  if(!socketPath)throw new CredentialError();
  const values=await new Promise<Credentials>((resolve,reject)=>{
    const socket=createConnection(socketPath);let buffer=Buffer.alloc(0);let done=false;
    const fail=()=>{if(!done){done=true;reject(new CredentialError());}socket.destroy();};
    socket.setTimeout(15000,fail);socket.on('error',fail);socket.on('end',()=>{if(!done)fail();});
    socket.on('connect',()=>socket.write(JSON.stringify({roleId})+'\n'));
    socket.on('data',(data)=>{buffer=Buffer.concat([buffer,data]);if(buffer.length>MAX_CREDENTIAL_FRAME)return fail();const n=buffer.indexOf(10);if(n<0)return;
      try{const reply=JSON.parse(buffer.subarray(0,n).toString('utf8'));if(reply.error)throw new CredentialError();done=true;resolve(reply.credentials);socket.destroy();}catch{fail();}});
  });
  try{return await submitLogin(page,values,usernameSelector,passwordSelector,submitSelector);}finally{
    const cookies=await page.context().cookies().catch(()=>[]);
    await new Promise<void>((resolve)=>{
      const socket=createConnection(socketPath);socket.on('error',()=>{socket.destroy();resolve();});socket.setTimeout(2000,()=>{socket.destroy();resolve();});
      socket.on('connect',()=>socket.write(JSON.stringify({secrets:cookies.slice(0,50).map((c)=>c.value).filter((v)=>Buffer.byteLength(v)<=4096)})+'\n'));
      socket.on('data',()=>{socket.destroy();resolve();});
    });values.username='';values.password='';
  }
}
