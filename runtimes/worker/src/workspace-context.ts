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
interface WorkspaceContextBase {
  workspaceId:string;settingsRevision:number;config:WorkspaceConfig|null;
  roleRefs:{roleId:string;secretRef:string|null;secretVersion:number|null;configured:boolean}[];
}
interface WorkspaceContextV1 extends WorkspaceContextBase { schemaVersion: "1" }
interface WorkspaceAccountDirectory extends WorkspaceContextBase {
  schemaVersion: "2";
  testAccounts: { accountId: string; name: string; role: string; purpose: string;
    sites: { targetOrigin: string; state: SiteAccountVerification["state"] }[] }[];
}
export type PublicWorkspaceContext = WorkspaceContextV1 | WorkspaceAccountDirectory;
export type WorkspaceContext = WorkspaceContextV1 | (WorkspaceAccountDirectory & { accountBindings: LoginBinding[] });

const testScopes = ["unknown", "guest", "authenticated", "both"] as const;
export type TestScope = typeof testScopes[number];
export interface FormSelectors {
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  loginRejectedSelector?: string;
  mfaSelector?: string;
}
export interface SuccessCheck { url: string; visibleSelector: string }
export interface LoginBinding {
  accountId: string;
  targetOrigin: string;
  loginConfigVersion: string;
  entryUrl: string;
  form: FormSelectors;
  success: SuccessCheck;
  secretRef: string;
  secretVersion: number;
}
export interface LoginVerification {
  proposalId: string;
  baseRevision: number;
  contextRevision: number;
  scopeHash: string;
  binding: LoginBinding;
}
export interface SiteLogin {
  targetOrigin: string;
  loginMethod: "form" | "sso" | "mfa" | "other" | null;
  entryUrl: string | null;
  form: FormSelectors | null;
  success: SuccessCheck | null;
}
export interface TestAccount {
  accountId: string | null;
  name: string;
  role: string;
  purpose: string;
  sites: SiteLogin[];
}
export interface WorkspaceProposalConfig extends WorkspaceConfig {
  targets: (WorkspaceConfig["targets"][number] & { testScope: TestScope })[];
  testAccounts: TestAccount[];
}
const verificationReasons = [
  "scope_confirmation_required", "login_setup_required", "credentials_required", "unsupported_login_method",
  "login_rejected", "mfa_required", "guest_accessible", "login_not_verified", "credential_unavailable",
  "invalid_evidence", "timed_out", "cancelled", "interrupted",
] as const;
export type VerificationReason = typeof verificationReasons[number];
export type VerificationFailure = "login_rejected" | "mfa_required" | "guest_accessible" | "login_not_verified" | "credential_unavailable" | "invalid_evidence";
export interface SiteAccountVerification {
  accountId: string;
  state: "pending" | "running" | "verified" | "failed";
  reason: VerificationReason | null;
  runId: string | null;
  verifiedAt: string | null;
}
export interface SiteReadiness {
  targetOrigin: string;
  testScope: TestScope;
  ready: boolean;
  reason: "scope_choice_required" | "login_verification_required" | null;
  accounts: SiteAccountVerification[];
}
export interface WorkspaceProposalSnapshot {
  content: WorkspaceProposalConfig;
  siteReadiness: SiteReadiness[];
}

const configKeys = ["name", "purpose", "backgroundSummary", "targets", "dependencies", "excludedOrigins", "exclusions", "loginRoles", "defaultTestUrl", "timeoutMs"];
const formRequired = ["usernameSelector", "passwordSelector", "submitSelector"];
const formOptional = ["loginRejectedSelector", "mfaSelector"];
function object(value:unknown,keys:string[]):value is Record<string,any>{return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every((k)=>Object.hasOwn(value,k));}
function text(value:unknown,max:number,nonempty=false):value is string{return typeof value==="string"&&Buffer.byteLength(value)<=max&&!value.includes("\0")&&Buffer.from(value).toString("utf8")===value&&(!nonempty||value.trim()!=="");}
function name(value:unknown):value is string{return typeof value==="string"&&!value.includes("\0")&&Buffer.from(value).toString("utf8")===value&&text(value.trim(),200,true);}
function invalid():never{throw new Error("Invalid nonsecret Workspace snapshot");}
function isUUID(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }

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

function workspaceURLOrigin(value: unknown): string {
  if (!text(value, 8192, true) || [...value].length > 2048 || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\\]/u.test(value)) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password) return invalid();
  return origin(url.origin);
}

export function validateWorkspaceConfig(value:unknown,knownRoles?:Set<string>):WorkspaceConfig {
  if(!object(value,configKeys)||
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
  if(value.defaultTestUrl!==""&&!targets.has(workspaceURLOrigin(value.defaultTestUrl)))return invalid();
  return value as unknown as WorkspaceConfig;
}

function readWorkspaceContext(value: unknown, workspaceId: string | undefined, projected: boolean): WorkspaceContext | PublicWorkspaceContext | undefined {
  if(value===undefined||value===null)return undefined;
  const v2 = (value as { schemaVersion?: unknown }).schemaVersion === "2";
  const keys = ["schemaVersion", "workspaceId", "settingsRevision", "config", "roleRefs"];
  if (v2) keys.push("testAccounts", ...(!projected ? ["accountBindings"] : []));
  if(!object(value,keys)||!v2&&value.schemaVersion!=="1"||!isUUID(value.workspaceId)||
    workspaceId!==undefined&&value.workspaceId!==workspaceId||!Number.isSafeInteger(value.settingsRevision)||value.settingsRevision<1||!Array.isArray(value.roleRefs)||value.roleRefs.length>10)return invalid();
  const roles=new Set<string>();
  for(const role of value.roleRefs){
    if(!object(role,["roleId","secretRef","secretVersion","configured"])||!isUUID(role.roleId)||roles.has(role.roleId)||typeof role.configured!=="boolean"||
      role.secretRef!==null&&!isUUID(role.secretRef)||role.secretVersion!==null&&(!Number.isSafeInteger(role.secretVersion)||role.secretVersion<1)||
      (projected ? role.secretRef!==null||role.secretVersion!==null : role.configured&&(role.secretRef===null||role.secretVersion===null)))return invalid();roles.add(role.roleId);
  }
  const config = value.config === null ? null : validateWorkspaceConfig(value.config);
  if (v2) {
    const proven = validateAccountDirectory(value.testAccounts, config);
    if (!projected) {
      if (!Array.isArray(value.accountBindings) || value.accountBindings.length > proven.size) return invalid();
      for (const raw of value.accountBindings) {
        if (!config) return invalid();
        const binding = validateLoginBinding(raw, config);
        if (!proven.delete(accountSiteKey(binding.accountId, binding.targetOrigin))) return invalid();
      }
    }
  }
  return value as unknown as WorkspaceContext | PublicWorkspaceContext;
}

export function validateWorkspaceContext(value: unknown, workspaceId?: string): WorkspaceContext | undefined {
  return readWorkspaceContext(value, workspaceId, false) as WorkspaceContext | undefined;
}

export function validatePublicWorkspaceContext(value: unknown, workspaceId?: string): PublicWorkspaceContext | undefined {
  return readWorkspaceContext(value, workspaceId, true) as PublicWorkspaceContext | undefined;
}

export function publicWorkspaceContext(value: WorkspaceContext): PublicWorkspaceContext {
  const roleRefs = value.roleRefs.map(ref => ({ ...ref, secretRef: null, secretVersion: null }));
  if (value.schemaVersion === "1") return { ...value, roleRefs };
  const { accountBindings, ...directory } = value;
  return { ...directory, roleRefs };
}

function accountSiteKey(accountId: string, targetOrigin: string): string {
  return `${accountId.toLowerCase()} ${origin(targetOrigin)}`;
}

function validateAccountDirectory(value: unknown, config: WorkspaceConfig | null): Set<string> {
  if (!Array.isArray(value) || value.length > 10) return invalid();
  const targets = new Set(config?.targets.map(site => origin(site.origin)));
  const accounts = new Set<string>();
  const proven = new Set<string>();
  for (const item of value) {
    if (!object(item, ["accountId", "name", "role", "purpose", "sites"]) || !isUUID(item.accountId) || !name(item.name) || !name(item.role) ||
        !text(item.purpose, 8192) || !Array.isArray(item.sites) || item.sites.length > targets.size) return invalid();
    const id = item.accountId.toLowerCase();
    if (accounts.has(id)) return invalid();
    accounts.add(id);
    const seen = new Set<string>();
    for (const site of item.sites) {
      if (!object(site, ["targetOrigin", "state"]) || !["pending", "running", "verified", "failed"].includes(site.state)) return invalid();
      const target = origin(site.targetOrigin);
      if (!targets.has(target) || seen.has(target)) return invalid();
      seen.add(target);
      if (site.state === "verified") proven.add(accountSiteKey(id, target));
    }
  }
  return proven;
}

export function findAccountBinding(context: WorkspaceContext | null | undefined, accountId: string, targetOrigin: string): LoginBinding | undefined {
  if (context?.schemaVersion !== "2" || !isUUID(accountId)) return undefined;
  try {
    const key = accountSiteKey(accountId, targetOrigin);
    return context.accountBindings.find(binding => accountSiteKey(binding.accountId, binding.targetOrigin) === key);
  } catch { return undefined; }
}

function selector(value: unknown): boolean {
  return text(value, 4000, true) && value.length <= 1000;
}

function validateForm(value: unknown): void {
  if (value === null) return;
  const optional = formOptional.filter(key => value && Object.hasOwn(value, key));
  if (!object(value, [...formRequired, ...optional]) || !Object.values(value).every(selector)) invalid();
}

export function validateLoginBinding(value: unknown, config: WorkspaceConfig): LoginBinding {
  if (!object(value, ["accountId", "targetOrigin", "loginConfigVersion", "entryUrl", "form", "success", "secretRef", "secretVersion"]) ||
      !isUUID(value.accountId) || !isUUID(value.loginConfigVersion) || !isUUID(value.secretRef) ||
      !Number.isSafeInteger(value.secretVersion) || value.secretVersion < 1 || value.form === null) return invalid();
  const target = origin(value.targetOrigin);
  const entry = workspaceURLOrigin(value.entryUrl);
  if (!config.targets.some(site => origin(site.origin) === target) ||
      (entry !== target && !config.dependencies.some(site => site.purpose === "login" && origin(site.origin) === entry))) return invalid();
  validateForm(value.form);
  if (!object(value.success, ["url", "visibleSelector"]) || workspaceURLOrigin(value.success.url) !== target || !selector(value.success.visibleSelector)) return invalid();
  return value as unknown as LoginBinding;
}

export function validateLoginVerification(value: unknown, context: WorkspaceContext): LoginVerification {
  if (context.schemaVersion !== "1" || !context.config || context.roleRefs.length !== 0 ||
      !object(value, ["proposalId", "baseRevision", "contextRevision", "scopeHash", "binding"]) || !isUUID(value.proposalId) ||
      value.baseRevision !== context.settingsRevision || !Number.isSafeInteger(value.contextRevision) || value.contextRevision < 0 ||
      typeof value.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.scopeHash)) return invalid();
  validateLoginBinding(value.binding, context.config);
  return value as unknown as LoginVerification;
}

export function validateWorkspaceProposalConfig(value: unknown): WorkspaceProposalConfig {
  if (!object(value, [...configKeys, "testAccounts"]) || !Array.isArray(value.targets) || value.targets.length > 20 ||
      !Array.isArray(value.testAccounts) || value.testAccounts.length > 10) return invalid();
  const { testAccounts, targets, ...base } = value;
  const scope = validateWorkspaceConfig({ ...base, targets: targets.map(target => {
    if (!object(target, ["name", "purpose", "origin", "testScope"]) || !testScopes.includes(target.testScope)) return invalid();
    return { name: target.name, purpose: target.purpose, origin: target.origin };
  }) });
  if (scope.loginRoles.some(role => role.roleId === null)) return invalid();

  const targetOrigins = new Set(scope.targets.map(target => origin(target.origin)));
  const loginOrigins = new Set(scope.dependencies.filter(site => site.purpose === "login").map(site => origin(site.origin)));
  const accountIDs = new Set<string>();
  for (const account of testAccounts) {
    if (!object(account, ["accountId", "name", "role", "purpose", "sites"]) || !name(account.name) || !name(account.role) || !text(account.purpose, 8192) ||
        !Array.isArray(account.sites) || account.sites.length > targetOrigins.size) return invalid();
    if (account.accountId !== null) {
      if (typeof account.accountId !== "string" || !uuid.test(account.accountId)) return invalid();
      const id = account.accountId.toLowerCase();
      if (accountIDs.has(id)) return invalid();
      accountIDs.add(id);
    }
    const siteOrigins = new Set<string>();
    for (const site of account.sites) {
      if (!object(site, ["targetOrigin", "loginMethod", "entryUrl", "form", "success"]) || ![null, "form", "sso", "mfa", "other"].includes(site.loginMethod)) return invalid();
      const target = origin(site.targetOrigin);
      if (!targetOrigins.has(target) || siteOrigins.has(target)) return invalid();
      siteOrigins.add(target);
      if (site.entryUrl !== null) {
        const entry = workspaceURLOrigin(site.entryUrl);
        if (entry !== target && !loginOrigins.has(entry)) return invalid();
      }
      validateForm(site.form);
      if (site.success !== null && (!object(site.success, ["url", "visibleSelector"]) || workspaceURLOrigin(site.success.url) !== target || !selector(site.success.visibleSelector))) return invalid();
    }
  }
  return value as unknown as WorkspaceProposalConfig;
}

export function validateWorkspaceProposalSnapshot(value: unknown): WorkspaceProposalSnapshot | null {
  if (value === null) return null;
  if (!object(value, ["content", "siteReadiness"]) || !Array.isArray(value.siteReadiness)) return invalid();
  const content = validateWorkspaceProposalConfig(value.content);
  if (value.siteReadiness.length !== content.targets.length) return invalid();
  const sites = new Map(content.targets.map(target => [origin(target.origin), target.testScope]));
  const accounts = new Map<string, Set<string>>();
  for (const account of content.testAccounts) {
    if (account.accountId === null) return invalid();
    accounts.set(account.accountId.toLowerCase(), new Set(account.sites.map(site => origin(site.targetOrigin))));
  }
  for (const site of value.siteReadiness) {
    if (!object(site, ["targetOrigin", "testScope", "ready", "reason", "accounts"]) || !Array.isArray(site.accounts) || site.accounts.length > accounts.size) return invalid();
    const target = origin(site.targetOrigin);
    const scope = sites.get(target);
    if (!scope || site.testScope !== scope) return invalid();
    sites.delete(target);
    const seen = new Set<string>();
    for (const account of site.accounts) {
      if (!object(account, ["accountId", "state", "reason", "runId", "verifiedAt"]) || typeof account.accountId !== "string" ||
          !["pending", "running", "verified", "failed"].includes(account.state) ||
          account.reason !== null && !verificationReasons.includes(account.reason) ||
          account.runId !== null && (typeof account.runId !== "string" || !uuid.test(account.runId)) ||
          account.verifiedAt !== null && typeof account.verifiedAt !== "string") return invalid();
      const id = account.accountId.toLowerCase();
      if (!accounts.get(id)?.has(target) || seen.has(id)) return invalid();
      seen.add(id);
    }
    let reason: SiteReadiness["reason"] = null;
    if (scope === "unknown") reason = "scope_choice_required";
    else if (scope !== "guest" && !site.accounts.some(account => account.state === "verified")) reason = "login_verification_required";
    if (site.ready !== (reason === null) || site.reason !== reason) return invalid();
  }
  return value as unknown as WorkspaceProposalSnapshot;
}
