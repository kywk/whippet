import {randomUUID} from 'node:crypto';
import type {Readable,Writable} from 'node:stream';
import {origin,type WorkspaceContext} from '../workspace-context.js';
import {attemptIO,MAX_ATTEMPT_FRAME} from '../attempt-io.js';

export const MAX_CREDENTIAL_FRAME=MAX_ATTEMPT_FRAME;
export class CredentialError extends Error {constructor(){super('credential_operation_failed');}}
export interface Credentials {workspaceId:string;runId:string;attemptId:string;roleId:string;secretRef:string;secretVersion:number;loginOrigin:string;username:string;password:string;}
export type LoginInput={workspaceId?:string;runId:string;attemptId:string;workspaceContext?:WorkspaceContext|null};
export function validCredentialText(value:unknown):value is string{return typeof value==='string'&&value.trim()!==''&&!value.includes('\0')&&Buffer.byteLength(value)<=4096&&Buffer.from(value).toString('utf8')===value;}

export class KnownSecrets {
  private readonly values=new Set<string>();
  add(value:string):void {if(value&&this.values.size<256)this.values.add(value);}
  redact(value:string):string {
    for(const secret of [...this.values].sort((a,b)=>b.length-a.length)){
      for(const encoded of new Set([secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret)]))value=value.split(encoded).join('[redacted]');
    }
    return value;
  }
  list():string[]{return [...this.values];}
  clean<T>(value:T):T{if(typeof value==='string')return this.redact(value) as T;if(Array.isArray(value))return value.map((v)=>this.clean(v)) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.clean(v)])) as T;return value;}
  clear():void{this.values.clear();}
}

// One bounded, attempt-bound response on Docker stdin; never read env/file keys.
export class CredentialClient {
  readonly secrets=new KnownSecrets();
  private pending?:{id:string;roleId:string;resolve:(v:Credentials)=>void;reject:()=>void;timer:NodeJS.Timeout};
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
        const v=reply.credentials as Credentials;
        const ref=this.input.workspaceContext?.roleRefs.find((r)=>r.roleId===p.roleId);
        const role=this.input.workspaceContext?.config?.loginRoles.find((r)=>r.roleId===p.roleId);
        if(!ref||!role||v.workspaceId!==this.input.workspaceId||v.runId!==this.input.runId||v.attemptId!==this.input.attemptId||v.roleId!==p.roleId||v.secretRef!==ref.secretRef||v.secretVersion!==ref.secretVersion||origin(v.loginOrigin)!==origin(role.loginOrigin)||!validCredentialText(v.username)||!validCredentialText(v.password))throw new CredentialError();
        this.secrets.add(v.username);this.secrets.add(v.password);this.pending=undefined;clearTimeout(p.timer);p.resolve(v);
      }catch{this.fail();}
  };
  resolve(roleId:string):Promise<Credentials>{
    const ref=this.input.workspaceContext?.roleRefs.find((r)=>r.roleId===roleId);
    const role=this.input.workspaceContext?.config?.loginRoles.find((r)=>r.roleId===roleId);
    if(this.closed||this.pending||++this.count>20||!ref?.configured||!ref.secretRef||!ref.secretVersion||!role||!this.input.workspaceId)return Promise.reject(new CredentialError());
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(),15000);
      this.pending={id,roleId,resolve,reject:()=>reject(new CredentialError()),timer};
      this.transport.send({kind:'credential_request',requestId:id,attemptId:this.input.attemptId,roleId,secretRef:ref.secretRef,secretVersion:ref.secretVersion},this.fail);
    });
  }
  close():void{this.closed=true;this.fail();this.unsubscribe();}
}
