import {randomUUID} from 'node:crypto';
import type {Readable,Writable} from 'node:stream';
import {findAccountBinding,origin,type LoginBinding,type LoginVerification,type WorkspaceContext} from '../workspace-context.js';
import {attemptIO,MAX_ATTEMPT_FRAME} from '../attempt-io.js';

export const MAX_CREDENTIAL_FRAME=MAX_ATTEMPT_FRAME;
export class CredentialError extends Error {constructor(){super('credential_operation_failed');}}
type Lookup = { secretRef: string; secretVersion: number } & ({ roleId: string } | { accountId: string; targetOrigin: string });
export interface LoginValues { loginOrigin: string; username: string; password: string }
type AttemptCredentials = LoginValues & Lookup & { workspaceId: string; runId: string; attemptId: string };
export type Credentials = Extract<AttemptCredentials, { roleId: string }>;
export interface CredentialResolver {
  readonly secrets: KnownSecrets;
  resolve(roleId: string, callId?: string): Promise<LoginValues>;
  resolveAccount?(accountId: string, targetOrigin: string, callId?: string): Promise<LoginValues>;
  close(): void;
}
export type LoginInput={workspaceId?:string;runId:string;attemptId:string;workspaceContext?:WorkspaceContext|null;loginVerification?:LoginVerification};
export function validCredentialText(value:unknown):value is string{return typeof value==='string'&&value.trim()!==''&&!value.includes('\0')&&Buffer.byteLength(value)<=4096&&Buffer.from(value).toString('utf8')===value;}

export class KnownSecrets {
  private readonly values=new Set<string>();
  private readonly credentials=new Set<string>();
  add(value:string):void {if(value&&this.values.size<256)this.values.add(value);}
  addCredentials(...values: string[]): void { for (const value of values) if (value && this.credentials.size < 40) this.credentials.add(value); }
  redact(value:string):string {
    for(const secret of this.list().sort((a,b)=>b.length-a.length)){
      for(const encoded of new Set([secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret)]))value=value.split(encoded).join('[redacted]');
    }
    return value;
  }
  list():string[]{return [...new Set([...this.credentials, ...this.values])];}
  clean<T>(value:T):T{if(typeof value==='string')return this.redact(value) as T;if(Array.isArray(value))return value.map((v)=>this.clean(v)) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.clean(v)])) as T;return value;}
  clear():void{this.values.clear();this.credentials.clear();}
}

// One bounded, attempt-bound response on Docker stdin; never read env/file keys.
export class CredentialClient {
  readonly secrets=new KnownSecrets();
  private pending?:{id:string;lookup:Lookup;loginOrigin:string;resolve:(v:AttemptCredentials)=>void;reject:()=>void;timer:NodeJS.Timeout};
  private count=0;
  private closed=false;
  private readonly transport:ReturnType<typeof attemptIO>;
  private readonly unsubscribe:()=>void;
  constructor(private readonly input:LoginInput,io:{read:Readable;write:Writable}={read:process.stdin,write:process.stdout}){
    this.transport=attemptIO(io);this.unsubscribe=this.transport.subscribe('credential_response',this.onData,this.fail);
  }
  private fail=():void=>{const p=this.pending;this.pending=undefined;if(p){clearTimeout(p.timer);p.reject();}};
  private onData=(reply:Record<string,unknown>):void=>{
      const p=this.pending;if(!p)return;
      try{
        if(reply.requestId!==p.id||reply.attemptId!==this.input.attemptId)return;
        if(reply.error)throw new CredentialError();
        const v=reply.credentials as AttemptCredentials;
        const expected = ["workspaceId", "runId", "attemptId", "loginOrigin", "username", "password", ...Object.keys(p.lookup)];
        if (!v || Object.keys(v).length !== expected.length || !expected.every(key => Object.hasOwn(v, key)) ||
            v.workspaceId !== this.input.workspaceId || v.runId !== this.input.runId || v.attemptId !== this.input.attemptId ||
            !Object.entries(p.lookup).every(([key, value]) => (v as unknown as Record<string, unknown>)[key] === value) ||
            origin(v.loginOrigin) !== p.loginOrigin || !validCredentialText(v.username) || !validCredentialText(v.password)) throw new CredentialError();
        this.secrets.addCredentials(v.username,v.password);this.pending=undefined;clearTimeout(p.timer);p.resolve(v);
      }catch{this.fail();}
  };
  async resolve(roleId:string):Promise<Credentials>{
    const ref=this.input.workspaceContext?.roleRefs.find((r)=>r.roleId===roleId);
    const role=this.input.workspaceContext?.config?.loginRoles.find((r)=>r.roleId===roleId);
    if (!ref?.configured || !ref.secretRef || !ref.secretVersion || !role || this.input.loginVerification) throw new CredentialError();
    const value = await this.request({ roleId, secretRef: ref.secretRef, secretVersion: ref.secretVersion }, origin(role.loginOrigin));
    if (!("roleId" in value)) throw new CredentialError();
    return value;
  }

  accountBinding(accountId: string, targetOrigin: string): LoginBinding | undefined {
    const binding = this.input.loginVerification?.binding;
    if (!binding) return findAccountBinding(this.input.workspaceContext, accountId, targetOrigin);
    try {
      if (binding.accountId === accountId && origin(binding.targetOrigin) === origin(targetOrigin)) return binding;
    } catch { /* Invalid origin receives no binding. */ }
    return undefined;
  }

  resolveAccount(accountId: string, targetOrigin: string): Promise<AttemptCredentials> {
    const binding = this.accountBinding(accountId, targetOrigin);
    if (!binding) return Promise.reject(new CredentialError());
    return this.request({ accountId: binding.accountId, targetOrigin: origin(binding.targetOrigin), secretRef: binding.secretRef,
      secretVersion: binding.secretVersion }, new URL(binding.entryUrl).origin);
  }

  private request(lookup: Lookup, loginOrigin: string): Promise<AttemptCredentials> {
    if (this.closed || this.pending || ++this.count > 20 || !this.input.workspaceId) return Promise.reject(new CredentialError());
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(),15000);
      this.pending={id,lookup,loginOrigin,resolve,reject:()=>reject(new CredentialError()),timer};
      this.transport.send({kind:'credential_request',requestId:id,attemptId:this.input.attemptId,...lookup},this.fail);
    });
  }
  close():void{this.closed=true;this.fail();this.unsubscribe();}
}
