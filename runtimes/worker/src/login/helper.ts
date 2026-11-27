import {createConnection} from 'node:net';
import type {Page} from '@playwright/test';
import {origin, type LoginBinding} from '../workspace-context.js';
import {CredentialError,MAX_CREDENTIAL_FRAME,validCredentialText,type Credentials,type LoginValues} from './client.js';
import {maskKnownInputs} from './privacy.js';
import {browserScope} from '../author/scope.js';
import {parseUniqueJSON} from '../strict-json.js';

export const LOGIN_HOOK=Symbol.for('whippet.login.hook');
export interface LoginHook {pause():Promise<void>;resume():Promise<void>|void;remember(values:string[], credentials?: boolean):void;}
export type LoginHooks=typeof globalThis&{[LOGIN_HOOK]?:LoginHook};

export async function submitLogin(page:Page,values:LoginValues,usernameSelector:string,passwordSelector:string,submitSelector:string):Promise<{submitted:true}> {
  if([usernameSelector,passwordSelector,submitSelector].some((s)=>!s||s.length>1000)||origin(new URL(page.url()).origin)!==origin(values.loginOrigin))throw new CredentialError();
  // Check form.action and any submit button override before giving it values.
  const submit = page.locator(submitSelector);
  const formOrigin = async () => origin(new URL(await submit.evaluate((node) => {
    const button=node as HTMLButtonElement;return button.getAttribute('formaction')?button.formAction:button.form?.action??location.href;
  })).origin);
  if(await formOrigin()!==origin(values.loginOrigin))throw new CredentialError();
  const hooks=(globalThis as LoginHooks)[LOGIN_HOOK];await hooks?.pause();
  try{
    hooks?.remember([values.username,values.password], true);
    await maskKnownInputs(page,[values.username,values.password]);
    // Fixed code, not model eval. No password literal in source or fill title.
    for(const [selector,value]of [[usernameSelector,values.username],[passwordSelector,values.password]] as const){
      await page.locator(selector).evaluate((node,{text, credentialOrigin})=>{
        if(location.origin !== credentialOrigin || !(node instanceof HTMLInputElement))throw new Error('unsupported_login_input');
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        setter?.call(node,text);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
      },{text:value, credentialOrigin:values.loginOrigin});
    }
    if (await formOrigin() !== origin(values.loginOrigin)) throw new CredentialError();
    await submit.click();
    // Password input remains hidden after failed login too; do not expose value.
    return {submitted:true};
  }catch{throw new CredentialError();}finally{
    await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>undefined);
    const cookies=await page.context().cookies().catch(()=>[]);hooks?.remember(cookies.map((c)=>c.value));
    await maskKnownInputs(page,[values.username,values.password,...cookies.map((c)=>c.value)]).catch(()=>undefined);
    await hooks?.resume();
  }
}

type AccountForm = Pick<LoginBinding, "accountId" | "targetOrigin" | "entryUrl" | "form">;

export async function submitAccountForm(page: Page, binding: AccountForm, values: LoginValues): Promise<{ submitted: true }> {
  const entry = new URL(binding.entryUrl);
  if (origin(values.loginOrigin) !== origin(entry.origin)) throw new CredentialError();
  const response = await page.goto(entry.href, { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new CredentialError();
  const form = binding.form;
  return submitLogin(page, values, form.usernameSelector, form.passwordSelector, form.submitSelector);
}

export async function loginWithAccountBinding(page: Page, binding: AccountForm, authorize: () => Promise<LoginValues>): Promise<{ submitted: true }> {
  const gate = browserScope(page.context());
  if (!gate) throw new CredentialError();
  return gate.duringAccountLogin(page, binding.targetOrigin, binding.entryUrl, async () => {
    const checkpoint = gate.checkpoint();
    const hooks = (globalThis as LoginHooks)[LOGIN_HOOK];
    await hooks?.pause();
    let values: LoginValues | undefined;
    try {
      values = await authorize();
      const result = await submitAccountForm(page, binding, values);
      gate.throwNavigationSince(checkpoint);
      return result;
    } finally {
      if (values) { values.username = ""; values.password = ""; }
      await hooks?.resume();
    }
  });
}

function requestLoginSocket<T>(socketPath: string, request: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const fail = () => { reject(new CredentialError()); socket.destroy(); };
    socket.setTimeout(15000, fail);
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_CREDENTIAL_FRAME) return fail();
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const reply = parseUniqueJSON(buffer.subarray(0, newline).toString("utf8")) as { error?: string; credentials?: T };
        if (reply.error || !reply.credentials) return fail();
        resolve(reply.credentials);
        socket.destroy();
      } catch { fail(); }
    });
  });
}

async function rememberCookies(page: Page, socketPath: string): Promise<void> {
  const cookies = await page.context().cookies().catch(() => []);
  await new Promise<void>(resolve => {
    const socket = createConnection(socketPath);
    const close = () => { socket.destroy(); resolve(); };
    socket.on("error", close);
    socket.on("end", close);
    socket.setTimeout(2000, close);
    socket.on("connect", () => socket.write(JSON.stringify({ secrets: cookies.slice(0, 50).map(cookie => cookie.value)
      .filter(value => Buffer.byteLength(value) <= 4096) }) + "\n"));
    socket.on("data", close);
  });
}

export async function loginAsAccount(page: Page, accountId: string, targetOrigin: string): Promise<{ submitted: true }> {
  const socketPath = process.env.WHIPPET_LOGIN_SOCKET;
  let values: (LoginValues & AccountForm) | undefined;
  try {
    const gate = browserScope(page.context());
    if (!socketPath || !gate) throw new CredentialError();
    const target = origin(targetOrigin);
    gate.require(target, "navigation");
    const received = await requestLoginSocket<LoginValues & AccountForm>(socketPath, { accountId, targetOrigin: target });
    values = received;
    if (typeof accountId !== "string" || received.accountId.toLowerCase() !== accountId.toLowerCase() ||
        origin(received.targetOrigin) !== target || !validCredentialText(received.username) || !validCredentialText(received.password)) throw new CredentialError();
    return await loginWithAccountBinding(page, received, async () => received);
  } catch { throw new Error("credential_unavailable"); }
  finally {
    if (values) {
      values.username = "";
      values.password = "";
      await rememberCookies(page, socketPath!);
    }
  }
}

// The parent runner owns Manager stdin. Only this local attempt socket is used
// by the full Playwright worker; neither credentials nor tokens are in env.
export async function loginAs(page:Page,roleId:string,usernameSelector:string,passwordSelector:string,submitSelector:string,mode?:'workspace-entry'):Promise<{submitted:true}> {
  const gate = browserScope(page.context());
  if (mode !== undefined && (mode !== 'workspace-entry' || !gate)) throw new CredentialError();
  const socketPath=process.env.WHIPPET_LOGIN_SOCKET;
  if(!socketPath)throw new CredentialError();
  const values=await requestLoginSocket<Credentials>(socketPath, {roleId});
  try{
    if (mode === 'workspace-entry' && gate) {
      const hooks = (globalThis as LoginHooks)[LOGIN_HOOK];
      await hooks?.pause();
      try {
        return await gate.duringWorkspaceLogin(page, roleId, values.loginOrigin, async (entry, remaining) => {
          await page.goto(entry, {waitUntil:'commit', timeout:remaining()});
          await page.waitForURL(url => url.origin === values.loginOrigin, {waitUntil:'domcontentloaded', timeout:remaining()});
          const submitted = await submitLogin(page, values, usernameSelector, passwordSelector, submitSelector);
          await page.waitForURL(url => url.href === entry, {waitUntil:'domcontentloaded', timeout:remaining()});
          return submitted;
        });
      } catch { throw new CredentialError(); }
      finally { await hooks?.resume(); }
    }
    if (!gate) return await submitLogin(page, values, usernameSelector, passwordSelector, submitSelector);
    return await gate.duringLogin(values.loginOrigin, async () => {
      if (new URL(page.url()).origin !== new URL(values.loginOrigin).origin) {
        await page.goto(values.loginOrigin, { waitUntil: "domcontentloaded" });
      }
      return submitLogin(page, values, usernameSelector, passwordSelector, submitSelector);
    });
  }finally{
    values.username='';values.password='';
    await rememberCookies(page, socketPath);
  }
}
