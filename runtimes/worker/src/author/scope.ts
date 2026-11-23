import type {BrowserContext,CDPSession,Page,Request} from "@playwright/test";
import {origin,validateWorkspaceConfig,type WorkspaceConfig} from "../workspace-context.js";

export interface ScopeIssue {
  error:"scope_confirmation_required"|"origin_excluded"|"dependency_usage_not_allowed"|"invalid_browser_url"|"browser_scope_unavailable";
  origin?:string;
  message:string;
}
export class BrowserScopeError extends Error {
  constructor(readonly issue:ScopeIssue){super(issue.message);this.name="BrowserScopeError";}
}
export function unconfirmedBrowserScope():WorkspaceConfig{return {name:'尚未確認範圍',purpose:'',backgroundSummary:'',targets:[],dependencies:[],excludedOrigins:[],exclusions:'',loginRoles:[],defaultTestUrl:'',timeoutMs:60000};}
// The browser guard also distinguishes test targets from dependency uses.
export class AIOriginGate {
  private readonly targets=new Set<string>();
  private readonly dependencies=new Map<string,string>();
  private readonly excluded=new Set<string>();
  private readonly issues:ScopeIssue[]=[];
  private revision=0;
  private navigationBlock?:{revision:number;issue:ScopeIssue};
  private loginOrigin?:string;
  private readonly workspaceLogins = new WeakMap<Page, number>();
  private readonly entryUrl: string;
  private readonly roleOrigins = new Map<string, string>();
  private readonly loginTimeout: number;
  private readonly observedLoginOrigins=new Set<string>();
  constructor(config:WorkspaceConfig){
    validateWorkspaceConfig(config);
    this.entryUrl = config.defaultTestUrl;
    this.loginTimeout = Math.min(config.timeoutMs, 60000);
    for (const role of config.loginRoles) {
      if (role.roleId) this.roleOrigins.set(role.roleId, origin(role.loginOrigin));
    }
    for(const site of config.targets)this.targets.add(origin(site.origin));
    for(const site of config.dependencies)this.dependencies.set(origin(site.origin),site.purpose);
    for(const value of config.excludedOrigins)this.excluded.add(origin(value));
  }
  check(value:string,kind:string,page?:Page):ScopeIssue|undefined {
    let u:URL;
    try{u=new URL(value);if(u.username||u.password||!['http:','https:','ws:','wss:'].includes(u.protocol))throw new Error();}
    catch{return {error:"invalid_browser_url",message:"僅可使用無帳密的 HTTP(S) 網頁與對應 WebSocket。"};}
    let o:string;try{o=origin(`${u.protocol==='ws:'?'http:':u.protocol==='wss:'?'https:':u.protocol}//${u.host}`);}catch{return {error:'invalid_browser_url',message:'網站 origin 無效，已停止本次操作。'};}
    if(this.excluded.has(o))return {error:"origin_excluded",origin:o,message:"此網站已列為排除範圍，請先修改並明確確認 Workspace 設定。"};
    if(this.targets.has(o))return;
    const purpose=this.dependencies.get(o);
    if(purpose&&kind==='transport')return;
    if(purpose==='api'&&['xhr','fetch','eventsource','websocket'].includes(kind))return;
    if(purpose==='cdn'&&['script','stylesheet','image','font','media','manifest','texttrack'].includes(kind))return;
    if (purpose === 'login' && page && (this.workspaceLogins.get(page) ?? 0) > Date.now()) return;
    if(purpose==='login'&&this.loginOrigin===o)return;
    if(purpose==='login'&&kind!=='navigation'&&this.observedLoginOrigins.has(o))return;
    if(purpose)return {error:"dependency_usage_not_allowed",origin:o,message:"此網站僅可作已確認的 dependency 用途；登入請用角色登入工具，不能當一般驗測目標。"};
    return {error:"scope_confirmation_required",origin:o,message:"此網站尚未確認；請先更新並明確確認 Workspace 網站範圍，再繼續探索。"};
  }
  block(issue:ScopeIssue,kind:string):void {
    this.revision++;
    if(kind==='navigation')this.navigationBlock={revision:this.revision,issue};
    if(this.issues.length<8&&!this.issues.some((v)=>v.error===issue.error&&v.origin===issue.origin))this.issues.push(issue);
  }
  require(url:string,kind:string):void {const issue=this.check(url,kind);if(issue){this.block(issue,kind);throw new BrowserScopeError(issue);}}
  checkpoint():number{return this.revision;}
  throwNavigationSince(revision:number):void{if(this.navigationBlock&&this.navigationBlock.revision>revision)throw new BrowserScopeError(this.navigationBlock.issue);}
  takeIssues():ScopeIssue[]{return this.issues.splice(0);}
  async duringWorkspaceLogin<T>(
    page: Page, roleId: string, credentialOrigin: string,
    operation: (entry: string, remaining: () => number) => Promise<T>
  ): Promise<T> {
    const roleOrigin = origin(credentialOrigin);
    const denied = () => new BrowserScopeError({
      error: 'dependency_usage_not_allowed',
      message: '此角色或頁面未獲准使用工作區登入流程。'
    });
    if (browserScope(page.context()) !== this || !this.entryUrl ||
        this.roleOrigins.get(roleId) !== roleOrigin || this.excluded.has(roleOrigin) ||
        this.dependencies.get(roleOrigin) !== 'login' || this.workspaceLogins.has(page)) throw denied();
    const entry = new URL(this.entryUrl);
    if (!this.targets.has(entry.origin) || this.excluded.has(entry.origin)) throw denied();
    const deadline = Date.now() + this.loginTimeout;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw denied();
      return ms;
    };
    this.workspaceLogins.set(page, deadline);
    try { return await operation(entry.href, remaining); }
    finally { this.workspaceLogins.delete(page); }
  }
  async duringLogin<T>(url:string,operation:()=>Promise<T>):Promise<T>{
    const o=origin(url);
    if(!this.targets.has(o)&&this.dependencies.get(o)!=='login')this.require(url,'navigation');
    const previous=this.loginOrigin;this.loginOrigin=o;
    this.observedLoginOrigins.add(o);
    try{return await operation();}finally{this.loginOrigin=previous;}
  }
}

function requestKind(request:Request):string{return request.isNavigationRequest()?'navigation':request.resourceType();}
type ResponsePause={requestId:string;request:{url:string};resourceType:string;responseStatusCode?:number;responseHeaders?:{name:string;value:string}[]};
const contextGates = new WeakMap<BrowserContext, AIOriginGate>();
export function browserScope(context: BrowserContext): AIOriginGate | undefined {
  return contextGates.get(context);
}

// Playwright skips route callbacks after the first request in an HTTP redirect
// chain. A response-stage Chromium hook checks Location before native redirect.
export async function installAIOriginGate(context:BrowserContext,gate:AIOriginGate):Promise<{ready(page:Page):Promise<void>}> {
  const sessions=new Map<Page,Promise<void>>();
  const unavailable:ScopeIssue={error:"browser_scope_unavailable",message:"瀏覽器範圍檢查未就緒，已停止本次探索；請稍後重試。"};
  function ready(page:Page):Promise<void>{
    let pending=sessions.get(page);if(pending)return pending;
    pending=(async()=>{
      const session:CDPSession=await context.newCDPSession(page);
      session.on('Fetch.requestPaused',(event:ResponsePause)=>{
        void (async()=>{
          const kind=event.resourceType==='Document'?'navigation':event.resourceType.toLowerCase();
          let issue=gate.check(event.request.url,kind,page);
          if(!issue&&[301,302,303,307,308].includes(event.responseStatusCode??0)){
            const location=event.responseHeaders?.find((h)=>h.name.toLowerCase()==='location')?.value;
            if(location){try{issue=gate.check(new URL(location,event.request.url).href,kind,page);}catch{issue={error:'invalid_browser_url',message:'網站跳轉網址無效，已停止本次跳轉。'};}}
          }
          if(issue){gate.block(issue,kind);await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});}
          else await session.send('Fetch.continueResponse',{requestId:event.requestId});
        })().catch(()=>{if(!page.isClosed()){gate.block(unavailable,'navigation');void page.close().catch(()=>undefined);}});
      });
      await session.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Response'}]});
      page.on('framenavigated',(frame)=>{
        if(frame!==page.mainFrame()||frame.url()==='about:blank')return;
        const issue=gate.check(frame.url(),'navigation',page);
        if(issue){gate.block(issue,'navigation');void page.close().catch(()=>undefined);}
      });
    })();
    sessions.set(page,pending);return pending;
  }
  context.on('page',(page)=>{void ready(page).catch(()=>{gate.block(unavailable,'navigation');void page.close().catch(()=>undefined);});});
  await context.route('**/*',async(route,request)=>{
    let owner: Page | undefined;
    try { owner = request.frame().page(); } catch { /* No owning page for this request. */ }
    const kind=requestKind(request),issue=gate.check(request.url(),kind,owner);
    if(issue){gate.block(issue,kind);await route.abort('blockedbyclient');return;}
    try{await ready(request.frame().page());}
    catch{gate.block(unavailable,kind);await route.abort('blockedbyclient');return;}
    await route.continue();
  });
  await context.routeWebSocket('**/*',(ws)=>{
    const issue=gate.check(ws.url(),'websocket');
    if(issue){gate.block(issue,'websocket');void ws.close({code:1008,reason:'Workspace scope confirmation required'});}
    else ws.connectToServer();
  });
  contextGates.set(context, gate);
  return {ready};
}
