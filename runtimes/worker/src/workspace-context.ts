import { isIP } from "node:net";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface WorkspaceConfig {
  name:string;purpose:string;backgroundSummary:string;
  targets:{name:string;purpose:string;origin:string}[];
  dependencies:{name:string;purpose:"login"|"api"|"cdn";origin:string}[];
  excludedOrigins:string[];exclusions:string;
  loginRoles:{roleId:string|null;name:string;loginMethod:"form";loginOrigin:string}[];
  defaultTestUrl:string;timeoutMs:number;
}
export interface WorkspaceContext {
  schemaVersion:"1";workspaceId:string;settingsRevision:number;config:WorkspaceConfig|null;
  roleRefs:{roleId:string;secretRef:string|null;secretVersion:number|null;configured:boolean}[];
}
function object(value:unknown,keys:string[]):value is Record<string,any>{return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every((k)=>Object.hasOwn(value,k));}
function text(value:unknown,max:number,nonempty=false):value is string{return typeof value==="string"&&Buffer.byteLength(value)<=max&&!value.includes("\0")&&Buffer.from(value).toString("utf8")===value&&(!nonempty||value.trim()!=="");}
function name(value:unknown):value is string{return typeof value==="string"&&!value.includes("\0")&&Buffer.from(value).toString("utf8")===value&&text(value.trim(),200,true);}
function invalid():never{throw new Error("Invalid nonsecret Workspace snapshot");}

export function origin(value:unknown):string {
  if(typeof value!=="string"||[...value].length>2048||!/^[\x21-\x7e]+$/.test(value)||/[?#*\\]/.test(value)||!/^https?:\/\//i.test(value))return invalid();
  // WHATWG URL normalizes /a/.. to /; inspect the original spelling first so
  // a non-root path is rejected consistently with the Go boundary.
  const authorityAndPath=value.replace(/^https?:\/\//i,"");
  const slash=authorityAndPath.indexOf("/");
  if(slash>=0&&authorityAndPath.slice(slash)!=="/"||(slash<0?authorityAndPath:authorityAndPath.slice(0,slash)).endsWith(":"))return invalid();
  let u:URL;try{u=new URL(value);}catch{return invalid();}
  const host=u.hostname.replace(/^\[|\]$/g,"");
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||value.split("/")[2]!.includes("@")||u.pathname!=="/"||u.port==="0"||
    (!isIP(host)&&!host.split(".").every((label)=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))))return invalid();
  return u.origin;
}

export function validateWorkspaceConfig(value:unknown,knownRoles?:Set<string>):WorkspaceConfig {
  if(!object(value,["name","purpose","backgroundSummary","targets","dependencies","excludedOrigins","exclusions","loginRoles","defaultTestUrl","timeoutMs"])||
    !name(value.name)||!text(value.purpose,8192)||!text(value.backgroundSummary,8192)||!text(value.exclusions,8192)||
    !Number.isInteger(value.timeoutMs)||value.timeoutMs<1||value.timeoutMs>3600000||!text(value.defaultTestUrl,8192)||[...value.defaultTestUrl].length>2048||
    !Array.isArray(value.targets)||value.targets.length>20||!Array.isArray(value.dependencies)||value.dependencies.length>20||
    !Array.isArray(value.excludedOrigins)||value.excludedOrigins.length>40||!Array.isArray(value.loginRoles)||value.loginRoles.length>10)return invalid();
  const targets=new Set<string>(),dependencies=new Set<string>();
  for(const site of value.targets){if(!object(site,["name","purpose","origin"])||!name(site.name)||!text(site.purpose,8192))return invalid();const o=origin(site.origin);if(targets.has(o))return invalid();targets.add(o);}
  for(const site of value.dependencies){if(!object(site,["name","purpose","origin"])||!name(site.name)||!["login","api","cdn"].includes(site.purpose))return invalid();const o=origin(site.origin);if(targets.has(o)||dependencies.has(o))return invalid();dependencies.add(o);}
  const exclusions=new Set<string>();
  for(const excluded of value.excludedOrigins){const o=origin(excluded);if(targets.has(o)||dependencies.has(o)||exclusions.has(o))return invalid();exclusions.add(o);}
  const roles=new Set<string>();
  for(const role of value.loginRoles){
    if(!object(role,["roleId","name","loginMethod","loginOrigin"])||!name(role.name)||role.loginMethod!=="form"||
      role.roleId!==null&&(typeof role.roleId!=="string"||!uuid.test(role.roleId)||knownRoles!==undefined&&!knownRoles.has(role.roleId)||roles.has(role.roleId)))return invalid();
    const o=origin(role.loginOrigin);if(!targets.has(o)&&!value.dependencies.some((d:any)=>d.purpose==="login"&&origin(d.origin)===o))return invalid();
    if(role.roleId!==null)roles.add(role.roleId);
  }
  if(value.defaultTestUrl!==""){
    let u:URL;try{u=new URL(value.defaultTestUrl);}catch{return invalid();}
    if(!/^https?:\/\//i.test(value.defaultTestUrl)||/[\s\u0000-\u001f\\]/u.test(value.defaultTestUrl)||u.username||u.password||!targets.has(origin(u.origin)))return invalid();
  }
  return value as unknown as WorkspaceConfig;
}

export function validateWorkspaceContext(value:unknown,workspaceId?:string):WorkspaceContext|undefined {
  if(value===undefined||value===null)return undefined;
  if(!object(value,["schemaVersion","workspaceId","settingsRevision","config","roleRefs"])||value.schemaVersion!=="1"||!uuid.test(value.workspaceId)||
    workspaceId!==undefined&&value.workspaceId!==workspaceId||!Number.isSafeInteger(value.settingsRevision)||value.settingsRevision<1||!Array.isArray(value.roleRefs)||value.roleRefs.length>10)return invalid();
  const roles=new Set<string>();
  for(const role of value.roleRefs){
    if(!object(role,["roleId","secretRef","secretVersion","configured"])||!uuid.test(role.roleId)||roles.has(role.roleId)||typeof role.configured!=="boolean"||
      role.secretRef!==null&&(typeof role.secretRef!=="string"||!uuid.test(role.secretRef))||role.secretVersion!==null&&(!Number.isSafeInteger(role.secretVersion)||role.secretVersion<1)||
      role.configured&&(role.secretRef===null||role.secretVersion===null))return invalid();roles.add(role.roleId);
  }
  if(value.config!==null)validateWorkspaceConfig(value.config);
  return value as unknown as WorkspaceContext;
}
