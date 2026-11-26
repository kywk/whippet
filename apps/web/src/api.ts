import { validRepairContent, editableStage } from './plan';
import { AGENT_RUNTIME_SKILLS, DEFAULT_WORKSPACE_MANAGEMENT, RUN_STATUSES, SITE_ROLES, WORKSPACE_ARCHIVE_MODES, WORKSPACE_MANAGEMENT_STATES, WORKSPACE_MEMBER_ROLES } from './types';
import type { ManagedWorkspace, WorkspaceManagement, WorkspacePermissions, WorkspaceSummary } from './types';
import type { AiAgent, AiAgentDraft, AiOptions, AiPage, AiReason, AiResource, AiResourceAction, AiRouting } from './aiAdminTypes';
import type { RunActivity, SimilarTestSuggestion, VersionConversationMessage, WorkspaceAgentRuntime, WorkspaceMember, WorkspaceRunActivity } from './types';
import type { AgentToken, AgentToolAudit, AuthorEngine, BrowserSession, StageRetry, ModuleMetadata, Plan, PlanStage, PlanSummary, StageArgument, JsonValue, AuthorPartial, CatalogItem, AcceptanceSummary, ActiveEditingSession, Conversation, DevUser, Draft, EditingSession, Message, Run, RunArtifact, RunStatus, Test, Version, WhippetApi, WorkspaceCapabilities, WorkspaceCapability, WorkspaceConfig, WorkspaceConversationData, WorkspaceDetail, WorkspaceProposal, WorkspaceRoleRef, WorkspaceSettingsResponse, WorkspaceSettingsSnapshot } from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'NETWORK_ERROR', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : '發生未知錯誤，請稍後重試。';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('API 回應格式不符，請確認 Server 與前端使用相同契約。', 'INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('API 缺少必要欄位。', 'INVALID_RESPONSE');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : string(value);
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError('API revision 格式不符。', 'INVALID_RESPONSE');
  }
  return value;
}

function parseStatus(value: unknown): RunStatus {
  const status = string(value);
  if (!RUN_STATUSES.some((item) => item === status)) {
    throw new ApiError(`無法辨識執行狀態：${status}`, 'INVALID_RESPONSE');
  }
  return status as RunStatus;
}

function parseAuthorEngine(value: unknown): AuthorEngine {
  return value === undefined ? 'builtin' : choice(value, ['builtin', 'external'] as const);
}

function parseWorkspaceAgentRuntime(value: unknown, workspaceId: string): WorkspaceAgentRuntime {
  const data = record(value);
  const selection = record(data.selection);
  const result: WorkspaceAgentRuntime = {
    workspaceId: string(data.workspaceId), revision: revision(data.revision),
    selection: {
      profileId: string(selection.profileId),
      skillProfiles: Object.fromEntries(Object.entries(record(selection.skillProfiles)).map(([skill, profile]) => [choice(skill, AGENT_RUNTIME_SKILLS), string(profile)])),
    },
    profiles: array(data.profiles, (value) => {
      const profile = record(value);
      return { id: string(profile.id), engine: choice(profile.engine, ['builtin', 'vercel', 'pi'] as const), provider: string(profile.provider), model: string(profile.model), reasoningEffort: string(profile.reasoningEffort) };
    }),
  };
  if (result.workspaceId !== workspaceId || result.revision < 1 || new Set(result.profiles.map((profile) => profile.id)).size !== result.profiles.length) {
    throw new ApiError('Runtime 設定所屬 Workspace、revision 或 profile 清單不符。', 'INVALID_RESPONSE');
  }
  // A removed profile is still a real saved selection. Let the UI show it as
  // unavailable instead of silently substituting builtin or rejecting the read.
  return result;
}

function parseWorkspaceSnapshot(value: unknown): WorkspaceSettingsSnapshot {
  const data = record(value);
  const settingsRevision = revision(data.revision);
  if (settingsRevision < 1 || !Array.isArray(data.sites) || typeof data.timeoutMs !== 'number' || !Number.isSafeInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 3_600_000) {
    throw new ApiError('Workspace 設定格式不符。', 'INVALID_RESPONSE');
  }
  return {
    revision: settingsRevision,
    sites: data.sites.map((value: unknown) => { const site = record(value); return { name: string(site.name), url: string(site.url) }; }),
    defaultTestUrl: string(data.defaultTestUrl), timeoutMs: data.timeoutMs,
  };
}

function parseWorkspaceSettings(value: unknown): WorkspaceSettingsResponse {
  const data = record(value);
  return { id: string(data.id), name: string(data.name), ...parseWorkspaceSnapshot(data) };
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError('API 布林欄位格式不符。', 'INVALID_RESPONSE');
  return value;
}

function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ApiError('API 清單欄位格式不符。', 'INVALID_RESPONSE');
  return value.map(parse);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ApiError('API 狀態欄位格式不符。', 'INVALID_RESPONSE');
  return value as T;
}

function parseUser(value: unknown): DevUser {
  const data = record(value);
  const permissions = record(data.permissions);
  return {
    id: string(data.id), name: string(data.name), role: choice(data.role, SITE_ROLES),
    permissions: {
      createWorkspace: bool(permissions.createWorkspace),
      manageUsers: bool(permissions.manageUsers),
      manageSuperAdmins: bool(permissions.manageSuperAdmins),
      manageSiteWorkspaces: permissions.manageSiteWorkspaces === undefined ? false : bool(permissions.manageSiteWorkspaces),
      manageSiteRoles: permissions.manageSiteRoles === undefined ? false : bool(permissions.manageSiteRoles),
      manageAIResources: permissions.manageAIResources === undefined ? false : bool(permissions.manageAIResources),
    },
  };
}

function parseMember(value: unknown): WorkspaceMember {
  const data = record(value);
  return { id: string(data.id), name: string(data.name), role: choice(data.role, WORKSPACE_MEMBER_ROLES) };
}

function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  const data = record(value);
  const timeoutMs = revision(data.timeoutMs);
  if (timeoutMs < 1 || timeoutMs > 3_600_000) throw new ApiError('Workspace 逾時格式不符。', 'INVALID_RESPONSE');
  return {
    name: string(data.name), purpose: string(data.purpose), backgroundSummary: string(data.backgroundSummary),
    targets: array(data.targets, (value) => { const item = record(value); return { name: string(item.name), purpose: string(item.purpose), origin: string(item.origin) }; }),
    dependencies: array(data.dependencies, (value) => { const item = record(value); return { name: string(item.name), purpose: choice(item.purpose, ['login', 'api', 'cdn'] as const), origin: string(item.origin) }; }),
    excludedOrigins: array(data.excludedOrigins, string), exclusions: string(data.exclusions),
    loginRoles: array(data.loginRoles, (value) => { const item = record(value); return { roleId: nullableString(item.roleId), name: string(item.name), loginMethod: choice(item.loginMethod, ['form'] as const), loginOrigin: string(item.loginOrigin) }; }),
    defaultTestUrl: string(data.defaultTestUrl), timeoutMs,
  };
}

function parseWorkspaceRole(value: unknown): WorkspaceRoleRef {
  const data = record(value);
  const role = { roleId: string(data.roleId), secretRef: nullableString(data.secretRef), secretVersion: data.secretVersion === null ? null : revision(data.secretVersion), configured: bool(data.configured) };
  if (role.configured && (!role.secretRef || !role.secretVersion)) throw new ApiError('已設定角色缺少有效機密參照。', 'INVALID_RESPONSE');
  return role;
}

function parseWorkspaceProposal(value: unknown): WorkspaceProposal {
  const data = record(value);
  return {
    id: string(data.id), workspaceId: string(data.workspaceId), conversationId: string(data.conversationId), sourceRunId: string(data.sourceRunId),
    baseRevision: revision(data.baseRevision), contextRevision: revision(data.contextRevision),
    status: choice(data.status, ['pending', 'applied', 'cancelled', 'stale', 'superseded'] as const), content: parseWorkspaceConfig(data.content),
    scopeHash: string(data.scopeHash), scopeConfirmed: bool(data.scopeConfirmed), invalidationReason: nullableString(data.invalidationReason),
    appliedRevision: data.appliedRevision === null ? null : revision(data.appliedRevision), createdAt: string(data.createdAt),
  };
}

function parseWorkspacePermissions(value: unknown): WorkspacePermissions {
  const permissions = record(value);
  return {
    manageTests: bool(permissions.manageTests), manageSettings: bool(permissions.manageSettings),
    manageMembers: bool(permissions.manageMembers), manageWorkspaceAdmins: bool(permissions.manageWorkspaceAdmins),
    manageAgentTokens: bool(permissions.manageAgentTokens),
  };
}

function parseWorkspaceManagement(value: unknown): WorkspaceManagement {
  const data = record(value);
  const managementRevision = revision(data.revision);
  if (managementRevision < 1) throw new ApiError('Workspace 管理版本格式不符。', 'INVALID_RESPONSE');
  return {
    state: choice(data.state, WORKSPACE_MANAGEMENT_STATES), revision: managementRevision,
    archiveMode: data.archiveMode === null ? null : choice(data.archiveMode, WORKSPACE_ARCHIVE_MODES),
    archiveStartedAt: nullableString(data.archiveStartedAt), archivedAt: nullableString(data.archivedAt),
  };
}

function parseWorkspaceSummary(value: unknown): WorkspaceSummary {
  const data = record(value);
  return {
    id: string(data.id), name: string(data.name), lifecycle: choice(data.lifecycle, ['draft', 'needs_confirmation', 'active'] as const),
    management: parseWorkspaceManagement(data.management), permissions: parseWorkspacePermissions(data.permissions),
  };
}

function parseManagedWorkspace(value: unknown, workspaceId: string): ManagedWorkspace {
  const data = record(value);
  const workspace = parseWorkspaceSummary(data.workspace);
  if (workspace.id !== workspaceId) throw new ApiError('Workspace 回應不符。', 'WORKSPACE_CONFLICT');
  const impact = record(data.impact);
  return { workspace, impact: {
    queuedRuns: revision(impact.queuedRuns), activeRuns: revision(impact.activeRuns), externalClaims: revision(impact.externalClaims),
    browserLeases: revision(impact.browserLeases), unreleasedRunSlots: revision(impact.unreleasedRunSlots), provisionJobs: revision(impact.provisionJobs),
  } };
}

export const AI_AGENT_PROPOSAL_MAX_BYTES = 1024;
export const AI_AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const aiAgentProposalPath = '/admin/ai/agents/proposal';
const aiEngines = ['builtin', 'vercel', 'pi'] as const;
const aiProviders = ['opencode', 'openai-responses'] as const;
const aiReasons = ['manager_unavailable', 'no_capacity', 'engine_mismatch', 'worker_changed', 'heartbeat_timeout', 'provider_auth_failed',
  'provider_unavailable', 'probe_failed', 'probe_timed_out', 'cleanup_pending', 'key_missing', 'verification_required', 'token_revoked',
  'workspace_archiving', 'workspace_archived'] as const satisfies readonly AiReason[];
const aiActions = ['assign', 'pause_dispatch', 'resume_dispatch', 'drain_remove', 'pause_claim', 'resume_claim', 'cancel_run',
  'close_browser', 'revoke_access', 'reissue_access'] as const satisfies readonly AiResourceAction[];

const aiErrors: Record<string, string> = {
  invalid_request: '請檢查輸入欄位。', protected_transport_required: 'Server 尚未確認此連線的傳輸保護。',
  unauthorized: '登入已失效，請重新登入。', forbidden: '目前身分無法執行此操作。', not_found: '找不到此資源。',
  stale_revision: '資料版本已變更，請確認重新載入的狀態後再操作。', conflict: '資源目前的狀態無法執行這項操作。',
  workspace_archiving: 'Workspace 正在封存。', workspace_archived: 'Workspace 已封存。',
  action_unavailable: '此資源目前未開放這項操作。', resource_busy: '仍有工作或資源待結案，請等候回收。',
  agent_not_ready: 'Agent 尚未就緒。', credential_unavailable: '憑證已失效、撤銷，或版本已變更。',
  idempotency_conflict: '此請求編號已有不同內容，請確認原操作的結果。', unsupported_combination: '目前未提供這個執行設定組合。',
  disabled: 'Server 尚未啟用此功能。', secrets_unavailable: 'Server 的機密儲存服務目前無法使用。', rate_limited: '請求過於頻繁，請稍候再試。',
  proposal_rejected: 'AI Manager 無法依這段描述產生有效提案。請調整描述後重試。',
  sensitive_input: '描述可能含有機密。請移除金鑰、Token 或密碼後再送出。',
  proposal_unavailable: 'AI Manager 暫時無法產生提案，可以重試或手動設定。',
  HTTP_401: '登入已失效，請重新登入。', HTTP_403: '目前身分無法執行此操作。', HTTP_404: '找不到此 AI 管理介面或資源。',
};

function positiveRevision(value: unknown): number {
  const result = revision(value);
  if (result < 1) throw new ApiError('AI 管理版本格式不符。', 'INVALID_RESPONSE');
  return result;
}

function parseAiAgent(value: unknown, agentId?: string): AiAgent {
  const data = record(value);
  const key = data.modelKey === null ? null : record(data.modelKey);
  const agent: AiAgent = {
    id: string(data.id), workspaceId: string(data.workspaceId), name: string(data.name), revision: positiveRevision(data.revision),
    mode: choice(data.mode, ['managed', 'self_managed'] as const), engine: choice(data.engine, aiEngines), provider: choice(data.provider, aiProviders),
    model: string(data.model), profileId: nullableString(data.profileId), skills: array(data.skills, (skill) => choice(skill, AGENT_RUNTIME_SKILLS)),
    status: choice(data.status, ['waiting_connection', 'verifying', 'ready', 'failed', 'disabled'] as const),
    reason: data.reason === null ? null : choice(data.reason, aiReasons), modelKey: key && {
      configured: bool(key.configured), version: key.version === null ? null : positiveRevision(key.version),
    },
    tokenId: nullableString(data.tokenId), probeId: nullableString(data.probeId), verifiedAt: nullableString(data.verifiedAt),
    createdAt: string(data.createdAt), updatedAt: string(data.updatedAt),
  };
  if ((agentId && agent.id !== agentId) || (agent.mode === 'self_managed' && (agent.modelKey || agent.profileId !== null || agent.engine === 'builtin'))) {
    throw new ApiError('Agent 設定或識別不符。', 'INVALID_RESPONSE');
  }
  return agent;
}

function parseAiOptions(value: unknown): AiOptions {
  const data = record(value);
  return {
    managed: array(data.managed, (value) => {
      const profile = record(value);
      return { profileId: string(profile.profileId), engine: choice(profile.engine, aiEngines), provider: choice(profile.provider, aiProviders),
        model: string(profile.model), managerIds: array(profile.managerIds, string), reason: profile.reason === null ? null : choice(profile.reason, aiReasons) };
    }),
    selfManaged: array(data.selfManaged, (value) => {
      const option = record(value);
      return { engine: choice(option.engine, ['vercel', 'pi'] as const), providers: array(option.providers, (provider) => choice(provider, aiProviders)),
        skills: array(option.skills, (skill) => choice(skill, AGENT_RUNTIME_SKILLS)) };
    }),
  };
}

function parseAiAgentProposal(value: unknown, workspaceId: string): AiAgentDraft {
  const body = record(value);
  const proposal = record(body.proposal);
  const fields = ['workspaceId', 'name', 'mode', 'engine', 'provider', 'model', 'profileId'];
  const invalid = () => new ApiError('AI Manager 的提案格式不符。請重試或手動設定。', 'INVALID_RESPONSE');
  if (Object.keys(body).length !== 1 || Object.keys(proposal).length !== fields.length || fields.some((field) => !Object.hasOwn(proposal, field))) throw invalid();
  const name = string(proposal.name);
  const model = string(proposal.model);
  if (proposal.workspaceId !== workspaceId || !name.trim() || name !== name.trim() || new TextEncoder().encode(name).length > 200 || !AI_AGENT_MODEL_PATTERN.test(model)) throw invalid();
  const fieldsForDraft = { workspaceId, name, model, provider: choice(proposal.provider, aiProviders) };
  const mode = choice(proposal.mode, ['managed', 'self_managed'] as const);
  if (mode === 'managed') {
    const profileId = string(proposal.profileId);
    if (!profileId) throw invalid();
    return { ...fieldsForDraft, mode, profileId, engine: choice(proposal.engine, aiEngines) };
  }
  if (proposal.profileId !== null) throw invalid();
  return { ...fieldsForDraft, mode, engine: choice(proposal.engine, ['vercel', 'pi'] as const) };
}

function parseAiResource(value: unknown, resourceId?: string): AiResource {
  const data = record(value);
  const id = string(data.id);
  const source = choice(data.source, ['manager', 'mcp'] as const);
  if (!id.startsWith(`${source}:`) || id.length === source.length + 1 || (resourceId && id !== resourceId)) {
    throw new ApiError('AI 資源識別不符。', 'INVALID_RESPONSE');
  }
  const capabilities = record(data.capabilities);
  const capacity = record(data.capacity);
  return {
    id, source, name: string(data.name), agentId: nullableString(data.agentId), revision: positiveRevision(data.revision),
    workspaceIds: data.workspaceIds === null ? null : array(data.workspaceIds, string),
    control: choice(data.control, ['enabled', 'paused', 'draining', 'removed', 'revoked'] as const),
    connection: choice(data.connection, ['waiting_connection', 'online', 'offline'] as const), lastActivityAt: nullableString(data.lastActivityAt),
    interactiveAt: nullableString(data.interactiveAt), claimAt: nullableString(data.claimAt),
    capabilities: {
      modes: array(capabilities.modes, (mode) => choice(mode, ['managed', 'mcp_interactive', 'mcp_claim'] as const)),
      engines: capabilities.engines === null ? null : array(capabilities.engines, (engine) => choice(engine, aiEngines)),
      skills: capabilities.skills === null ? null : array(capabilities.skills, (skill) => choice(skill, AGENT_RUNTIME_SKILLS)),
    },
    capacity: { total: capacity.total === null ? null : revision(capacity.total), occupied: revision(capacity.occupied),
      available: capacity.available === null ? null : revision(capacity.available) },
    attempts: array(data.attempts, (value) => {
      const attempt = record(value);
      return { runId: string(attempt.runId), attemptId: string(attempt.attemptId), workspaceId: string(attempt.workspaceId),
        agentId: nullableString(attempt.agentId), status: parseStatus(attempt.status), leaseId: nullableString(attempt.leaseId) };
    }),
    browserLeases: array(data.browserLeases, (value) => {
      const lease = record(value);
      return { sessionId: string(lease.sessionId), leaseId: string(lease.leaseId), workspaceId: string(lease.workspaceId),
        runId: nullableString(lease.runId), state: choice(lease.state, ['opening', 'ready', 'closing', 'reclaim_pending'] as const), deadlineAt: string(lease.deadlineAt) };
    }),
    allowedActions: array(data.allowedActions, (action) => choice(action, aiActions)),
  };
}

function parseAiPage<T>(value: unknown, parse: (item: unknown) => T): AiPage<T> {
  const data = record(value);
  return { items: array(data.items, parse), nextAfter: nullableString(data.nextAfter) };
}

function parseAiRouting(value: unknown, workspaceId: string): AiRouting {
  const data = record(value);
  if (data.workspaceId !== workspaceId) throw new ApiError('Agent 選用所屬 Workspace 不符。', 'INVALID_RESPONSE');
  return { workspaceId, revision: positiveRevision(data.revision), agents: Object.fromEntries(Object.entries(record(data.agents))
    .map(([skill, agentId]) => [choice(skill, AGENT_RUNTIME_SKILLS), string(agentId)])) };
}

function aiReceiptToken(value: unknown, mayIssue: boolean): string | undefined {
  if (mayIssue && typeof value === 'string' && value.length > 0) return value;
  if (!mayIssue && value === undefined) return undefined;
  throw new ApiError('一次性憑證回應格式不符。請從管理端確認操作結果。', 'INVALID_RESPONSE');
}

function parseWorkspaceDetail(value: unknown): WorkspaceDetail {
  const data = record(value);
  const result: WorkspaceDetail = {
    ...parseWorkspaceSettings(data), authorEngine: parseAuthorEngine(data.authorEngine), lifecycle: choice(data.lifecycle, ['draft', 'needs_confirmation', 'active'] as const),
    management: data.management === undefined ? { ...DEFAULT_WORKSPACE_MANAGEMENT } : parseWorkspaceManagement(data.management),
    authorizationRevision: revision(data.authorizationRevision), scopeStatus: choice(data.scopeStatus, ['unconfirmed', 'confirmed', 'revoking'] as const),
    settings: data.settings === null ? null : parseWorkspaceConfig(data.settings), conversationId: string(data.conversationId), activeRunId: nullableString(data.activeRunId),
    currentProposal: data.currentProposal === null ? null : parseWorkspaceProposal(data.currentProposal), roles: array(data.roles, parseWorkspaceRole),
    secretsAvailable: bool(data.secretsAvailable), executionAvailable: bool(data.executionAvailable), unavailableReason: nullableString(data.unavailableReason),
    capabilities: parseCapabilities(data.capabilities),
    permissions: parseWorkspacePermissions(data.permissions),
  };
  if (result.currentProposal && result.currentProposal.workspaceId !== result.id) throw new ApiError('提案所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
  return result;
}

function parseCapabilities(value: unknown): WorkspaceCapabilities | undefined {
  if (value == null) return undefined;
  const data = record(value);
  function capability(value: unknown): WorkspaceCapability | undefined {
    if (value == null) return undefined;
    const item = record(value);
    if (item.available == null || item.reason === undefined) return undefined;
    return { available: bool(item.available), reason: nullableString(item.reason) };
  }
  return { aiExploration: capability(data.aiExploration), aiExecution: capability(data.aiExecution), manualExecution: capability(data.manualExecution), credentialLogin: capability(data.credentialLogin) };
}

function parseWorkspaceConversation(value: unknown): WorkspaceConversationData {
  const data = record(value);
  return {
    id: string(data.id), workspaceId: string(data.workspaceId), ownerType: choice(data.ownerType, ['workspace'] as const),
    contextRevision: revision(data.contextRevision), conversationSummary: nullableString(data.conversationSummary),
    messages: array(data.messages, parseMessage), activeRunId: nullableString(data.activeRunId),
  };
}

function parseTest(value: unknown): Test {
  const data = record(value);
  return {
    id: string(data.id), workspaceId: string(data.workspaceId), name: string(data.name),
    slug: data.kind === 'module' ? string(data.slug) : optionalString(data.slug),
    kind: data.kind == null ? 'test' : choice(data.kind, ['test', 'module', 'usecase'] as const),
    description: optionalString(data.description) ?? '',
    tags: data.tags == null ? null : array(data.tags, string),
    metadataRevision: data.metadataRevision == null ? undefined : revision(data.metadataRevision),
    publishedVersionId: optionalString(data.publishedVersionId) || null,
    activeEditingSession: data.activeEditingSession === undefined ? undefined : data.activeEditingSession === null ? null : parseActiveSession(data.activeEditingSession),
    deleted: data.deleted === true,
    archived: data.archived === true,
  };
}

function parsePlanStage(value: unknown): PlanStage {
  const data = record(value);
  const split = data.decomposition == null ? undefined : record(data.decomposition);
  const budget = split ? record(split.budget) : undefined;
  const decomposition = split && budget ? { sourceStageId: string(split.sourceStageId), ordinal: revision(split.ordinal), count: revision(split.count), budget: {
    maxModelRequests: revision(budget.maxModelRequests), maxToolCalls: revision(budget.maxToolCalls), maxDurationMs: revision(budget.maxDurationMs),
    ...(budget.maxOutputTokens == null ? {} : { maxOutputTokens: revision(budget.maxOutputTokens) }) } } : undefined;
  if (decomposition && (decomposition.count !== 2 || decomposition.ordinal < 1 || decomposition.ordinal > decomposition.count || decomposition.budget.maxModelRequests < 1 || decomposition.budget.maxDurationMs < 1)) throw new ApiError('Stage 拆分額度格式不符。', 'INVALID_RESPONSE');
  const module = data.module == null ? undefined : record(data.module);
  const args = Object.fromEntries(Object.entries(record(data.args)).map(([key, value]) => {
    const arg = record(value);
    const kind = choice(arg.kind, ['literal', 'binding'] as const);
    if (kind === 'literal' && !Object.hasOwn(arg, 'value')) throw new ApiError('Stage literal 缺少 value。', 'INVALID_RESPONSE');
    const parsed: StageArgument = kind === 'literal' ? { kind, value: arg.value as JsonValue } : { kind, stageId: string(arg.stageId), path: array(arg.path, string) };
    return [key, parsed];
  }));
  return { id: string(data.id), title: string(data.title), decomposition, action: choice(data.action, ['reuse', 'modify', 'create'] as const),
    status: choice(data.status, ['pending', 'authoring', 'validating', 'ready', 'failed'] as const),
    moduleTestId: optionalString(data.moduleTestId), moduleVersionId: optionalString(data.moduleVersionId),
    module: module ? { slug: string(module.slug), moduleKind: choice(module.moduleKind, ['setup', 'step', 'page'] as const), description: string(module.description) } : undefined,
    args, bind: optionalString(data.bind), draftRevision: data.draftRevision == null ? undefined : revision(data.draftRevision),
    candidateVersionId: optionalString(data.candidateVersionId), authorRunId: optionalString(data.authorRunId), validationRunId: optionalString(data.validationRunId), error: optionalString(data.error) };
}
function parseStageRetry(value: unknown): StageRetry {
  const data = record(value);
  const eligible = bool(data.eligible);
  const reason = data.reason === null ? null : choice(data.reason, ['plan_not_stopped', 'stage_not_retryable', 'cancelled', 'source_unavailable', 'session_closed', 'reclaim_pending', 'snapshot_mismatch', 'prior_stage_invalid', 'scope_unavailable', 'split_budget_reserved'] as const);
  const planRevision = revision(data.planRevision);
  const raw = data.source === null ? null : record(data.source);
  const source = raw && { moduleTestId: string(raw.moduleTestId), editingSessionId: string(raw.editingSessionId), moduleRevision: revision(raw.moduleRevision), moduleContextRevision: revision(raw.moduleContextRevision), authorRunId: string(raw.authorRunId), authorStatus: parseStatus(raw.authorStatus), validationRunId: nullableString(raw.validationRunId), validationStatus: raw.validationStatus === null ? null : parseStatus(raw.validationStatus), reclaimed: bool(raw.reclaimed) };
  const failed = (status: string | null) => status === 'failed' || status === 'timed_out';
  if (planRevision < 1 || (source && (source.moduleRevision < 1 || !source.moduleTestId || !source.editingSessionId || !source.authorRunId || ((source.validationRunId === null) !== (source.validationStatus === null)))) || (eligible ? reason !== null || !source || !source.reclaimed || !(failed(source.authorStatus) || (source.authorStatus === 'succeeded' && failed(source.validationStatus))) : reason === null)) throw new ApiError('Stage 重試資格回應不符。', 'INVALID_RESPONSE');
  return { eligible, reason, planRevision, source };
}
function parsePlan(value: unknown): Plan {
  const data = record(value);
  const stages = array(data.stages, parsePlanStage);
  if (!stages.length || stages.length > 32 || new Set(stages.map((stage) => stage.id)).size !== stages.length) throw new ApiError('Plan Stage 清單格式不符。', 'INVALID_RESPONSE');
  return { id: string(data.id), testId: string(data.testId), editingSessionId: string(data.editingSessionId),
    revision: revision(data.revision), baseRevision: revision(data.baseRevision), contextRevision: revision(data.contextRevision),
    status: choice(data.status, ['draft', 'confirmed', 'running', 'composed', 'done', 'stopped'] as const), stages, throughStageId: optionalString(data.throughStageId),
    validationRunId: optionalString(data.validationRunId), error: optionalString(data.error) };
}
function hash(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ApiError('批次摘要 hash 格式不符。', 'INVALID_RESPONSE');
  return result;
}
function parsePlanSummary(value: unknown): PlanSummary {
  const data = record(value);
  const candidates = array(data.candidates, (value) => {
    const item = record(value);
    return { testId: string(item.testId), versionId: string(item.versionId), name: string(item.name), slug: string(item.slug),
      moduleKind: choice(item.moduleKind, ['setup', 'step', 'page'] as const), revision: revision(item.revision), bundleHash: hash(item.bundleHash) };
  });
  if (candidates.length > 32) throw new ApiError('批次候選清單超過上限。', 'INVALID_RESPONSE');
  return { runId: string(data.runId), planId: string(data.planId), planRevision: revision(data.planRevision), batchHash: hash(data.batchHash),
    status: parseStatus(data.status), stale: bool(data.stale), publishReady: bool(data.publishReady),
    message: nullableString(data.message), description: nullableString(data.description), backgroundSummary: nullableString(data.backgroundSummary), name: nullableString(data.name),
    suggestedTags: data.suggestedTags == null ? undefined : array(data.suggestedTags, string), candidates };
}

function parseAuthorPartial(value: unknown): AuthorPartial {
  const data = record(value);
  const nextStep = string(data.nextStep);
  if (!nextStep.trim() || new TextEncoder().encode(nextStep).length > 8192) throw new ApiError('partial 下一步格式不符。', 'INVALID_RESPONSE');
  let checkpoint: AuthorPartial['checkpoint'];
  if (data.checkpoint != null) {
    const item = record(data.checkpoint);
    const scriptHash = string(item.scriptHash);
    if (!/^[a-f0-9]{64}$/.test(scriptHash) || item.selfTestPassed !== true) throw new ApiError('partial checkpoint 格式不符。', 'INVALID_RESPONSE');
    const moduleHash = Object.hasOwn(item, 'moduleHash') ? string(item.moduleHash) : undefined;
    if (moduleHash !== undefined && !/^[a-f0-9]{64}$/.test(moduleHash)) throw new ApiError('Module checkpoint 格式不符。', 'INVALID_RESPONSE');
    checkpoint = { scriptHash, ...(moduleHash ? { moduleHash } : {}), selfTestPassed: true };
  }
  const reason = choice(data.reason, ['budget_exhausted', 'checkpoint_saved'] as const);
  if (reason === 'checkpoint_saved' && !checkpoint?.moduleHash) throw new ApiError('Module checkpoint 缺少完整候選引用。', 'INVALID_RESPONSE');
  return { reason, nextStep, checkpoint,
    appliedRevision: data.appliedRevision == null ? undefined : revision(data.appliedRevision) };
}

function parseCatalogItem(value: unknown): CatalogItem {
  const data = record(value);
  const module = record(data.module);
  return {
    testId: string(data.testId), versionId: string(data.versionId), name: string(data.name), description: string(data.description),
    module: parseModule(module),
    validationRunId: nullableString(data.validationRunId), validationStatus: data.validationStatus === '' || data.validationStatus == null ? undefined : parseStatus(data.validationStatus),
    referencedBy: array(data.referencedBy, (value) => { const item = record(value); return { testId: string(item.testId), versionId: string(item.versionId) }; }),
  };
}

function parseRunActivityFields(data: Record<string, unknown>): Omit<RunActivity, 'testId' | 'authorPartial'> {
  if (data.kind != null && data.kind !== 'run' && data.kind !== 'validation' && data.kind !== 'author') {
    throw new ApiError('API Run kind 格式不符。', 'INVALID_RESPONSE');
  }
  if (data.authorMode != null && data.authorMode !== 'edit' && data.authorMode !== 'summary' && data.authorMode !== 'workspace') throw new ApiError('authorMode 格式不符。', 'INVALID_RESPONSE');
  return {
    id: string(data.id), status: parseStatus(data.status),
    createdAt: string(data.createdAt), startedAt: optionalString(data.startedAt),
    finishedAt: optionalString(data.finishedAt),
    reportUrl: optionalString(data.reportUrl),
    kind: data.kind as RunActivity['kind'],
    draftRevision: data.draftRevision == null ? undefined : revision(data.draftRevision),
    editingSessionId: optionalString(data.editingSessionId) ?? null,
    authorMode: data.authorMode as RunActivity['authorMode'],
    authorRepliedOnly: data.authorRepliedOnly === true,
    authorEngine: parseAuthorEngine(data.authorEngine),
    progressEvents: data.progressEvents == null ? undefined : array(data.progressEvents, string),
  };
}

function parseWorkspaceRunActivity(value: unknown): WorkspaceRunActivity {
  const data = record(value);
  const partial = data.authorPartial == null ? undefined : record(data.authorPartial);
  return {
    ...parseRunActivityFields(data),
    testId: string(data.testId),
    authorPartial: partial && { reason: choice(partial.reason, ['budget_exhausted', 'checkpoint_saved'] as const) },
  };
}

function parseRun(value: unknown): Run {
  const data = record(value);
  return {
    ...parseRunActivityFields(data),
    testId: nullableString(data.testId), workspaceId: string(data.workspaceId), error: optionalString(data.error),
    ...(data.agentId === undefined ? {} : { agentId: string(data.agentId) }),
    versionId: optionalString(data.versionId), feedbackReportUrl: optionalString(data.feedbackReportUrl),
    workspaceSettings: data.workspaceSettings == null ? undefined : parseWorkspaceSnapshot(data.workspaceSettings),
    scriptOrigin: data.scriptOrigin == null ? undefined : choice(data.scriptOrigin, ['ai', 'manual', 'legacy'] as const),
    authorPartial: data.authorPartial == null ? undefined : parseAuthorPartial(data.authorPartial),
  };
}

function parseModule(value: unknown): ModuleMetadata {
  const data = record(value);
  return { slug: string(data.slug), moduleKind: choice(data.moduleKind, ['setup', 'step', 'page'] as const),
    exportName: string(data.exportName), signature: string(data.signature), inputs: string(data.inputs), returns: string(data.returns),
    preconditions: string(data.preconditions), postconditions: string(data.postconditions), harness: string(data.harness) };
}

function parseDraft(value: unknown): Draft {
  const data = record(value);
  return {
    testId: string(data.testId), revision: revision(data.revision), script: string(data.script),
    module: data.module == null ? undefined : parseModule(data.module),
    updatedAt: string(data.updatedAt), validationRunId: optionalString(data.validationRunId),
    validationStatus: data.validationStatus == null ? undefined : parseStatus(data.validationStatus),
    reportUrl: optionalString(data.reportUrl),
    workspaceSettings: data.workspaceSettings == null ? undefined : parseWorkspaceSnapshot(data.workspaceSettings),
    editingSessionId: optionalString(data.editingSessionId),
    scriptOrigin: data.scriptOrigin == null ? undefined : choice(data.scriptOrigin, ['ai', 'manual', 'legacy'] as const),
  };
}

function parseVersion(value: unknown, historical = false): Version {
  const data = record(value);
  return {
    id: string(data.id), testId: string(data.testId), revision: revision(data.revision),
    script: string(data.script), createdAt: string(data.createdAt),
    // M1 seed versions predate validation_run_id; only history may contain null.
    validationRunId: historical ? nullableString(data.validationRunId) : string(data.validationRunId),
    workspaceSettings: data.workspaceSettings == null ? undefined : parseWorkspaceSnapshot(data.workspaceSettings),
    description: optionalString(data.description) ?? null, backgroundSummary: optionalString(data.backgroundSummary) ?? null,
    suggestedTags: data.suggestedTags == null ? undefined : array(data.suggestedTags, string),
    summaryRunId: optionalString(data.summaryRunId) ?? null, editingSessionId: optionalString(data.editingSessionId) ?? null,
    scriptOrigin: data.scriptOrigin == null ? undefined : choice(data.scriptOrigin, ['ai', 'manual', 'legacy'] as const),
  };
}

function parseMessageText(data: Record<string, unknown>): VersionConversationMessage {
  if (data.role !== 'user' && data.role !== 'assistant') throw new ApiError('對話角色格式不符。', 'INVALID_RESPONSE');
  return { id: string(data.id), role: data.role, content: string(data.content), createdAt: string(data.createdAt) };
}

function parseMessage(value: unknown): Message {
  const data = record(value);
  return {
    ...parseMessageText(data),
    runId: optionalString(data.runId), baseRevision: data.baseRevision == null ? undefined : revision(data.baseRevision),
    appliedRevision: data.appliedRevision == null ? undefined : revision(data.appliedRevision),
    baseScript: optionalString(data.baseScript),
    proposedScript: optionalString(data.proposedScript), validationRunId: optionalString(data.validationRunId),
    newTestNeeded: data.newTestNeeded === true,
  };
}

function parseSimilarTest(value: unknown, testId: string): SimilarTestSuggestion {
  const data = record(value);
  const matchedTestId = string(data.testId);
  if (matchedTestId === testId) throw new ApiError('相似案例與目前測試相同。', 'INVALID_RESPONSE');
  return { id: string(data.id), testId: matchedTestId, name: string(data.name), content: string(data.content), createdAt: string(data.createdAt) };
}

function parseConversation(value: unknown): Conversation {
  const data = record(value);
  if (!Array.isArray(data.messages)) throw new ApiError('對話訊息格式不符。', 'INVALID_RESPONSE');
  const testId = string(data.testId);
  return {
    id: string(data.id), testId, messages: data.messages.map(parseMessage),
    activeRunId: optionalString(data.activeRunId),
    editingSessionId: optionalString(data.editingSessionId),
    similarTest: data.similarTest == null ? undefined : parseSimilarTest(data.similarTest, testId),
  };
}

function parseActiveSession(value: unknown): ActiveEditingSession {
  const data = record(value);
  if (data.status !== 'active' && data.status !== 'discarding') throw new ApiError('編輯週期狀態不符。', 'INVALID_RESPONSE');
  return { id: string(data.id), status: data.status, draftRevision: revision(data.draftRevision), updatedAt: string(data.updatedAt) };
}

function parseSummary(value: unknown): AcceptanceSummary {
  const data = record(value);
  if (typeof data.validForCurrentDraft !== 'boolean') throw new ApiError('摘要資格格式不符。', 'INVALID_RESPONSE');
  return {
    runId: string(data.runId), status: parseStatus(data.status), revision: revision(data.revision), validationRunId: string(data.validationRunId),
    description: optionalString(data.description), backgroundSummary: optionalString(data.backgroundSummary), name: optionalString(data.name), validForCurrentDraft: data.validForCurrentDraft,
    suggestedTags: data.suggestedTags == null ? undefined : array(data.suggestedTags, string),
  };
}

function parseSession(value: unknown): EditingSession {
  const data = record(value);
  if (!['active', 'discarding', 'discarded', 'published'].includes(string(data.status)) || typeof data.reclaimPending !== 'boolean' || !Array.isArray(data.pendingRunIds)) throw new ApiError('編輯週期回應格式不符。', 'INVALID_RESPONSE');
  const source = data.sourceVersion == null ? null : record(data.sourceVersion);
  return {
    id: string(data.id), testId: string(data.testId), workspaceId: string(data.workspaceId), status: data.status as EditingSession['status'],
    sourceVersionId: optionalString(data.sourceVersionId) ?? null,
    sourceVersion: source ? { id: string(source.id), description: optionalString(source.description) ?? null, backgroundSummary: optionalString(source.backgroundSummary) ?? null } : null,
    conversationId: string(data.conversationId), conversationSummary: optionalString(data.conversationSummary) ?? null,
    contextRevision: data.contextRevision == null ? undefined : revision(data.contextRevision),
    draft: data.draft == null ? null : parseDraft(data.draft), summary: data.summary == null ? null : parseSummary(data.summary),
    pendingRunIds: data.pendingRunIds.map(string), reclaimPending: data.reclaimPending,
    publishedVersionId: optionalString(data.publishedVersionId) ?? null, createdAt: string(data.createdAt), closedAt: optionalString(data.closedAt) ?? null,
    testDeleted: data.testDeleted === true,
  };
}

function parseRunArtifact(value: unknown): RunArtifact {
  const data = record(value);
  if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) {
    throw new ApiError('附件大小格式不符。', 'INVALID_RESPONSE');
  }
  return { name: string(data.name), size: data.size, contentType: string(data.contentType), url: string(data.url) };
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  const data = record(value);
  if (!Array.isArray(data.items)) throw new ApiError('API 列表格式不符。', 'INVALID_RESPONSE');
  return data.items.map(parse);
}

function parseAgentToken(value: unknown, workspaceId: string): AgentToken {
  const data = record(value);
  if (Object.hasOwn(data, 'token') || Object.hasOwn(data, 'digest') || Object.hasOwn(data, 'hash') || Object.hasOwn(data, 'prefix')) throw new ApiError('Agent Token 清單含不應回傳的機密欄位。', 'INVALID_RESPONSE');
  const result = { id: string(data.id), workspaceId: string(data.workspaceId), name: string(data.name), createdAt: string(data.createdAt), revokedAt: nullableString(data.revokedAt), lastUsedAt: nullableString(data.lastUsedAt) };
  if (result.workspaceId !== workspaceId) throw new ApiError('Agent Token 所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
  return result;
}

function parseAgentToolAudit(value: unknown, workspaceId: string): AgentToolAudit {
  const data = record(value);
  const result = { id: string(data.id), tokenId: string(data.tokenId), workspaceId: string(data.workspaceId), toolName: string(data.toolName), decision: choice(data.decision, ['allowed', 'denied', 'rate_limited', 'failed'] as const), occurredAt: string(data.occurredAt) };
  if (result.workspaceId !== workspaceId) throw new ApiError('稽核紀錄所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
  return result;
}

const browserSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseBrowserSession(value: unknown): BrowserSession {
  const data = record(value);
  const sessionId = string(data.sessionId);
  const leaseId = string(data.leaseId);
  if (!browserSessionId.test(sessionId) || !browserSessionId.test(leaseId)) throw new ApiError('瀏覽器 session 識別格式不符。', 'INVALID_RESPONSE');
  return {
    sessionId, leaseId, state: choice(data.state, ['opening', 'ready'] as const),
    createdAt: string(data.createdAt), deadlineAt: string(data.deadlineAt),
  };
}

export function createHttpApi(apiBase = '/api'): WhippetApi {
  const base = apiBase.replace(/\/+$/, '');
  let adminToken = '';

  async function request(path: string, method = 'GET', signal?: AbortSignal, body?: unknown, sensitive: boolean | 'ai' = false,
    expectedStatus?: number | number[], reportStatus?: (status: number) => void): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    // The proposal provider has its own 15-second deadline. Allow its error response to reach the form.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, path === aiAgentProposalPath ? 20_000 : 12_000);

    try {
      if (adminToken && !isProtectedCredentialTransport(base, window.location.href)) throw new ApiError('管理 key 只能透過 HTTPS 或 loopback 本機連線傳送。', 'INSECURE_TRANSPORT');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (adminToken) headers['X-Whippet-Admin-Token'] = adminToken;
      const response = await fetch(`${base}${path}`, {
        method, credentials: 'include',
        cache: sensitive || adminToken ? 'no-store' : 'default', redirect: sensitive || adminToken ? 'error' : 'follow',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data: unknown = await response.json().catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return null;
      });
      if (!response.ok) {
        const body = data && typeof data === 'object' ? (data as Record<string, unknown>).error : null;
        const details = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        if (sensitive === 'ai') {
          const code = typeof details.code === 'string' && Object.hasOwn(aiErrors, details.code) ? details.code : `HTTP_${response.status}`;
          throw new ApiError(aiErrors[code] ?? 'AI 管理請求失敗，請確認目前狀態後再試。', code, response.status);
        }
        if (sensitive) {
          if (details.code === 'protected_transport_required') throw new ApiError('Server 尚未確認此連線的傳輸保護，無法保存或撤銷登入資料。', 'PROTECTED_TRANSPORT_REQUIRED', response.status);
          throw new ApiError(response.status === 409 ? '登入資料版本已變更，請重新載入角色狀態後再試。' : response.status === 503 ? '機密保存服務目前不可用。' : '登入資料操作失敗，請重新載入角色狀態確認結果。', 'CREDENTIALS_ERROR', response.status);
        }
        throw new ApiError(
          typeof details.message === 'string' ? details.message : `API 請求失敗（HTTP ${response.status}）。`,
          typeof details.code === 'string' ? details.code : `HTTP_${response.status}`,
          response.status,
        );
      }
      if (expectedStatus !== undefined && !(Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]).includes(response.status)) throw new ApiError('API 未依契約接受請求，請重新載入確認。', 'INVALID_RESPONSE', response.status);
      if (data === null && response.status !== 204) throw new ApiError('API 未回傳 JSON，請確認 /api 代理設定。', 'INVALID_RESPONSE');
      reportStatus?.(response.status);
      return data;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('請求已取消', 'AbortError');
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('API 回應逾時，請確認 Server 連線後重試。', 'REQUEST_TIMEOUT');
      throw new ApiError('無法連線到 API，請確認 Server 與代理設定後重試。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const id = encodeURIComponent;
  const aiPath = '/admin/ai';
  const resourcePath = (resourceId: string) => `${aiPath}/resources/${id(resourceId)}`;
  const agentPath = (agentId: string) => `${aiPath}/agents/${id(agentId)}`;
  const routingPath = (workspaceId: string) => `${aiPath}/workspaces/${id(workspaceId)}/agent-routing`;
  function requireAiCredentialTransport() {
    if (!isProtectedCredentialTransport(base, window.location.href)) {
      throw new ApiError('憑證操作需要 HTTPS 或雙端 loopback 連線。', 'INSECURE_TRANSPORT');
    }
  }
  const adminWorkspacePath = (workspaceId: string) => `/admin/workspaces/${id(workspaceId)}`;
  const proposalPath = (workspaceId: string, proposalId: string) => `/workspaces/${id(workspaceId)}/proposals/${id(proposalId)}`;
  function ownedProposal(value: unknown, workspaceId: string) {
    const proposal = parseWorkspaceProposal(value);
    if (proposal.workspaceId !== workspaceId) throw new ApiError('提案所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
    return proposal;
  }
  return {
    aiAdmin: {
      async listResources(after, signal) {
        const query = new URLSearchParams({ limit: '100' });
        if (after) query.set('after', after);
        return parseAiPage(await request(`${aiPath}/resources?${query}`, 'GET', signal, undefined, 'ai', 200), (value) => parseAiResource(value));
      },
      async getResource(resourceId, signal) {
        return parseAiResource(await request(resourcePath(resourceId), 'GET', signal, undefined, 'ai', 200), resourceId);
      },
      async changeResource(resourceId, change, signal) {
        const { action, ...body } = change;
        const status = action === 'drain_remove' || action === 'close_browser' ? [200, 202] : 200;
        return parseAiResource(await request(`${resourcePath(resourceId)}/actions/${action}`, 'POST', signal, body, 'ai', status), resourceId);
      },
      async reissueAccess(resourceId, input, signal) {
        requireAiCredentialTransport();
        let status = 0;
        const data = record(await request(`${resourcePath(resourceId)}/actions/reissue_access`, 'POST', signal, input, 'ai', [200, 201], (value) => { status = value; }));
        const resource = parseAiResource(data.resource);
        const agent = data.agent === null ? null : parseAiAgent(data.agent);
        if (resource.source !== 'mcp' || resource.id === resourceId || resource.workspaceIds?.length !== 1 || resource.workspaceIds[0] !== input.workspaceId ||
            resource.agentId !== (agent?.id ?? null) || (agent && (agent.workspaceId !== input.workspaceId || (status === 201 && resource.id !== `mcp:${agent.tokenId}`)))) {
          throw new ApiError('換發憑證與目標 Workspace 不符。', 'INVALID_RESPONSE');
        }
        return { resource, agent, token: aiReceiptToken(data.token, status === 201) };
      },
      async listAgents(workspaceId, after, signal) {
        const query = new URLSearchParams({ limit: '100' });
        if (workspaceId) query.set('workspaceId', workspaceId);
        if (after) query.set('after', after);
        return parseAiPage(await request(`${aiPath}/agents?${query}`, 'GET', signal, undefined, 'ai', 200), (value) => {
          const agent = parseAiAgent(value);
          if (workspaceId && agent.workspaceId !== workspaceId) throw new ApiError('Agent 所屬 Workspace 不符。', 'INVALID_RESPONSE');
          return agent;
        });
      },
      async getAgent(agentId, signal) {
        return parseAiAgent(await request(agentPath(agentId), 'GET', signal, undefined, 'ai', 200), agentId);
      },
      async getOptions(workspaceId, signal) {
        const query = new URLSearchParams({ workspaceId });
        return parseAiOptions(await request(`${aiPath}/options?${query}`, 'GET', signal, undefined, 'ai', 200));
      },
      async proposeAgent(workspaceId, instruction, signal) {
        const trimmed = instruction.trim();
        if (!trimmed || new TextEncoder().encode(trimmed).length > AI_AGENT_PROPOSAL_MAX_BYTES) {
          throw new ApiError('需求描述去除前後空白後須為 1 至 1024 UTF-8 bytes。', 'INVALID_REQUEST');
        }
        const data = await request(aiAgentProposalPath, 'POST', signal, { workspaceId, instruction: trimmed }, 'ai', 200);
        return parseAiAgentProposal(data, workspaceId);
      },
      async createAgent(input, signal) {
        requireAiCredentialTransport();
        let status = 0;
        const data = record(await request(`${aiPath}/agents`, 'POST', signal, input, 'ai', [200, 201], (value) => { status = value; }));
        const agent = parseAiAgent(data.agent);
        if (agent.workspaceId !== input.workspaceId || agent.mode !== input.mode || agent.name !== input.name || agent.engine !== input.engine ||
            agent.provider !== input.provider || agent.model !== input.model || (input.mode === 'managed' && agent.profileId !== input.profileId)) {
          throw new ApiError('建立 Agent 的回應與所送設定不符。', 'INVALID_RESPONSE');
        }
        return { agent, token: aiReceiptToken(data.token, status === 201 && input.mode === 'self_managed') };
      },
      async retryAgent(agentId, revision, signal) {
        return parseAiAgent(await request(`${agentPath(agentId)}/retry`, 'POST', signal, { revision }, 'ai', [200, 202]), agentId);
      },
      async rotateKey(agentId, expectedSecretVersion, apiKey, signal) {
        requireAiCredentialTransport();
        return parseAiAgent(await request(`${agentPath(agentId)}/model-key`, 'PUT', signal, { expectedSecretVersion, apiKey }, 'ai', 200), agentId);
      },
      async revokeKey(agentId, expectedSecretVersion, signal) {
        requireAiCredentialTransport();
        return parseAiAgent(await request(`${agentPath(agentId)}/model-key`, 'DELETE', signal, { expectedSecretVersion, confirmed: true }, 'ai', 200), agentId);
      },
      async getRouting(workspaceId, signal) {
        return parseAiRouting(await request(routingPath(workspaceId), 'GET', signal, undefined, 'ai', 200), workspaceId);
      },
      async changeRouting(workspaceId, input, signal) {
        const routing = parseAiRouting(await request(routingPath(workspaceId), 'PATCH', signal, input, 'ai', 200), workspaceId);
        if ((routing.agents[input.skillId] ?? null) !== input.agentId) throw new ApiError('Agent 選用回應不符。', 'INVALID_RESPONSE');
        return routing;
      },
    },
    adminWorkspaces: {
      async list(state, after, signal) {
        const query = new URLSearchParams({ state });
        if (after) query.set('after', after);
        const data = record(await request(`/admin/workspaces?${query}`, 'GET', signal, undefined, false, 200));
        return { items: array(data.items, parseWorkspaceSummary), nextAfter: nullableString(data.nextAfter) };
      },
      async get(workspaceId, signal) {
        return parseManagedWorkspace(await request(adminWorkspacePath(workspaceId), 'GET', signal, undefined, false, 200), workspaceId);
      },
      async rename(workspaceId, revision, name, signal) {
        const updated = parseManagedWorkspace(await request(adminWorkspacePath(workspaceId), 'PATCH', signal, { revision, name }, false, 200), workspaceId);
        if (updated.workspace.name !== name) throw new ApiError('Workspace 更新名稱回應不符。', 'INVALID_RESPONSE');
        return updated;
      },
      async archive(workspaceId, revision, mode, signal) {
        const updated = parseManagedWorkspace(await request(`${adminWorkspacePath(workspaceId)}/archive`, 'POST', signal, { revision, mode }, false, [200, 202]), workspaceId);
        if (updated.workspace.management.state === 'active' || updated.workspace.management.archiveMode !== mode) {
          throw new ApiError('Workspace 封存狀態回應不符。', 'INVALID_RESPONSE');
        }
        return updated;
      },
      async restore(workspaceId, revision, signal) {
        const updated = parseManagedWorkspace(await request(`${adminWorkspacePath(workspaceId)}/restore`, 'POST', signal, { revision }, false, 200), workspaceId);
        if (updated.workspace.management.state !== 'active') throw new ApiError('Workspace 還原狀態回應不符。', 'INVALID_RESPONSE');
        return updated;
      },
    },
    setAdminToken(token) { adminToken = token; },
    async logout(signal) { await request('/dev-logout', 'POST', signal, undefined, false, 204); },
    async listAgentTokens(workspaceId, signal) {
      return items(await request(`/workspaces/${id(workspaceId)}/agent-tokens`, 'GET', signal, undefined, false, 200), (value) => parseAgentToken(value, workspaceId));
    },
    async listBrowserSessions(workspaceId, signal) {
      return items(await request(`/workspaces/${id(workspaceId)}/browser-sessions`, 'GET', signal, undefined, false, 200), parseBrowserSession);
    },
    async createAgentToken(workspaceId, name, signal) {
      const data = record(await request(`/workspaces/${id(workspaceId)}/agent-tokens`, 'POST', signal, { name }, false, 201));
      return { token: string(data.token), agentToken: parseAgentToken(data.agentToken, workspaceId) };
    },
    async revokeAgentToken(workspaceId, tokenId, signal) {
      await request(`/workspaces/${id(workspaceId)}/agent-tokens/${id(tokenId)}`, 'DELETE', signal, undefined, false, 204);
    },
    async listAgentToolAudit(workspaceId, before, signal) {
      const query = new URLSearchParams({ limit: '20' });
      if (before) query.set('before', before);
      const data = record(await request(`/workspaces/${id(workspaceId)}/agent-tool-audit?${query}`, 'GET', signal, undefined, false, 200));
      return { items: array(data.items, (value) => parseAgentToolAudit(value, workspaceId)), nextCursor: nullableString(data.nextCursor) };
    },
    async login(userId, signal) {
      const data = record(await request('/dev-login', 'POST', signal, { userId }, false, 200));
      const user = parseUser(data.user);
      if (user.id !== userId) throw new ApiError('Server 回傳的登入身分與選擇不符。', 'INVALID_RESPONSE');
      return user;
    },
    async getMe(signal) {
      return parseUser(record(await request('/me', 'GET', signal, undefined, false, 200)).user);
    },
    async listUsers(signal) {
      return items(await request('/users', 'GET', signal, undefined, false, 200), parseUser);
    },
    async updateUserRole(userId, role, signal) {
      const user = parseUser(record(await request(`/users/${id(userId)}/role`, 'PATCH', signal, { role }, false, 200)).user);
      if (user.id !== userId || user.role !== role) throw new ApiError('全站角色儲存回應不符。', 'INVALID_RESPONSE');
      return user;
    },
    async listMembers(workspaceId, signal) {
      return items(await request(`/workspaces/${id(workspaceId)}/members`, 'GET', signal, undefined, false, 200), parseMember);
    },
    async updateMember(workspaceId, userId, role, signal) {
      const member = parseMember(record(await request(`/workspaces/${id(workspaceId)}/members/${id(userId)}`, 'PUT', signal, { role }, false, 200)).member);
      if (member.id !== userId || member.role !== role) throw new ApiError('Workspace 成員儲存回應不符。', 'INVALID_RESPONSE');
      return member;
    },
    async getPlan(testId, editingSessionId, signal) {
      const data = record(await request(`/tests/${id(testId)}/plan?editingSessionId=${id(editingSessionId)}`, 'GET', signal, undefined, false, 200));
      if (data.plan === null) return null;
      const plan = parsePlan(data.plan);
      if (plan.testId !== testId || plan.editingSessionId !== editingSessionId) throw new ApiError('Plan 所屬測試或週期不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async savePlan(testId, input, signal) {
      const data = record(await request(`/tests/${id(testId)}/plan`, 'PUT', signal, { editingSessionId: input.editingSessionId, revision: input.revision, planRevision: input.planRevision, stages: input.stages.map(editableStage) }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.testId !== testId || plan.editingSessionId !== input.editingSessionId) throw new ApiError('Plan 所屬測試或週期不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async getStageRetry(planId, stageId, signal) {
      const data = record(await request(`/plans/${id(planId)}/stages/${id(stageId)}/retry`, 'GET', signal));
      return parseStageRetry(data.retry);
    },
    async splitPlanStage(planId, stageId, input, signal) {
      const data = record(await request(`/plans/${id(planId)}/stages/${id(stageId)}/split`, 'POST', signal, { ...input, stages: input.stages.map(editableStage) }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('拆分回應所屬 Plan 不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async continuePlanStage(planId, stageId, input, signal) {
      if (!Number.isSafeInteger(input.planRevision) || input.planRevision < 1 || !Number.isSafeInteger(input.moduleRevision) || input.moduleRevision < 1 || !input.sourceRunId || input.confirmed !== true) throw new ApiError('Stage 續接 CAS 格式不符。', 'INVALID_REQUEST');
      const data = record(await request(`/plans/${id(planId)}/stages/${id(stageId)}/continue`, 'POST', signal, input, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('續接回應所屬 Plan 不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async retryStage(planId, stageId, input, signal) {
      if (!validRepairContent(input.content) || input.confirmed !== true || !Number.isSafeInteger(input.planRevision) || input.planRevision < 1 || !Number.isSafeInteger(input.moduleRevision) || input.moduleRevision < 1 || !Number.isSafeInteger(input.moduleContextRevision) || input.moduleContextRevision < 0) throw new ApiError('修復指示或重試 CAS 格式不符。', 'INVALID_REQUEST');
      const { planRevision, moduleRevision, moduleContextRevision, confirmed, content } = input;
      const data = record(await request(`/plans/${id(planId)}/stages/${id(stageId)}/retry`, 'POST', signal, { planRevision, moduleRevision, moduleContextRevision, confirmed, content }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('重試 Plan 回應不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async confirmPlan(planId, planRevision, signal, throughStageId) {
      const data = record(await request(`/plans/${id(planId)}/confirm`, 'POST', signal, { planRevision, confirmed: true, ...(throughStageId ? { throughStageId } : {}) }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('Plan 回應不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async cancelPlan(planId, planRevision, signal) {
      const data = record(await request(`/plans/${id(planId)}/cancel`, 'POST', signal, { planRevision }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('Plan 回應不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async getPlanSummary(planId, signal) {
      const data = record(await request(`/plans/${id(planId)}/summary`, 'GET', signal, undefined, false, 200));
      if (data.summary === null) return null;
      const summary = parsePlanSummary(data.summary);
      if (summary.planId !== planId) throw new ApiError('批次摘要所屬 Plan 不符。', 'INVALID_RESPONSE');
      return summary;
    },
    async requestPlanSummary(planId, planRevision, validationRunId, signal) {
      const data = record(await request(`/plans/${id(planId)}/summary`, 'POST', signal, { planRevision, validationRunId }, false, [200, 202]));
      return parseRun(data.run);
    },
    async publishPlan(planId, planRevision, summaryRunId, signal) {
      const data = record(await request(`/plans/${id(planId)}/publish`, 'POST', signal, { planRevision, confirmed: true, summaryRunId }, false, 200));
      return { usecaseVersion: parseVersion(data.usecaseVersion), moduleVersions: array(data.moduleVersions, (value) => parseVersion(value)) };
    },
    async listCatalog(workspaceId, signal) {
      return items(await request(`/workspaces/${id(workspaceId)}/catalog`, 'GET', signal), parseCatalogItem);
    },
    async continueAuthor(runId, editingSessionId, revision, signal) {
      const data = record(await request(`/runs/${id(runId)}/continue`, 'POST', signal, { editingSessionId, revision }, false, 202));
      return { run: parseRun(data.run), conversationId: string(data.conversationId) };
    },
    async listWorkspaces(signal) {
      return items(await request('/workspaces', 'GET', signal), parseWorkspaceDetail);
    },
    async listTests(workspaceId, signal) {
      return items(await request(`/workspaces/${id(workspaceId)}/tests`, 'GET', signal), parseTest);
    },
    async listArchivedTests(workspaceId, signal) {
      const tests = items(await request(`/workspaces/${id(workspaceId)}/archived-tests`, 'GET', signal, undefined, false, 200), parseTest);
      if (tests.some((test) => test.workspaceId !== workspaceId || !test.archived)) throw new ApiError('封存測試清單與目前的 Workspace 不符。', 'INVALID_RESPONSE');
      return tests;
    },
    async archiveTest(testId, signal) {
      await request(`/tests/${id(testId)}/archive`, 'POST', signal, { confirmed: true }, false, 204);
    },
    async getTest(testId, signal) {
      return parseTest(await request(`/tests/${id(testId)}`, 'GET', signal));
    },
    async updateTestMetadata(testId, patch, signal) {
      const test = parseTest(await request(`/tests/${id(testId)}/metadata`, 'PATCH', signal, patch));
      if (test.id !== testId || test.metadataRevision !== patch.metadataRevision + 1) throw new ApiError('測試資訊儲存回應不符。', 'INVALID_RESPONSE');
      return test;
    },
    async createRun(testId, signal) {
      return parseRun(await request(`/tests/${id(testId)}/runs`, 'POST', signal));
    },
    async listRuns(testId, signal) {
      return items(await request(`/tests/${id(testId)}/runs`, 'GET', signal), parseRun);
    },
    async listWorkspaceRunActivity(workspaceId, testIds, signal) {
      if (testIds?.length === 0) return [];
      const query = new URLSearchParams(testIds?.map(testId => ['testId', testId]));
      const suffix = query.size ? `?${query}` : '';
      return items(await request(`/workspaces/${id(workspaceId)}/run-activity${suffix}`, 'GET', signal, undefined, false, 200), parseWorkspaceRunActivity);
    },
    async getRun(runId, signal) {
      return parseRun(await request(`/runs/${id(runId)}`, 'GET', signal));
    },
    async getRunArtifacts(runId, signal) {
      return items(await request(`/runs/${id(runId)}/artifacts`, 'GET', signal), parseRunArtifact);
    },
    async createTest(workspaceId, input, signal) {
      return parseTest(await request(`/workspaces/${id(workspaceId)}/tests`, 'POST', signal, input));
    },
    async getDraft(testId, editingSessionId, signal) {
      const draft = parseDraft(await request(`/tests/${id(testId)}/draft`, 'GET', signal));
      if (draft.editingSessionId !== editingSessionId) throw new ApiError('草稿已屬於其他編輯週期，請重新載入。', 'SESSION_CONFLICT', 409);
      return draft;
    },
    async saveDraft(testId, editingSessionId, revision, script, signal, module) {
      const saved = parseDraft(await request(`/tests/${id(testId)}/draft`, 'PUT', signal, { editingSessionId, revision, script, ...(module ? { module } : {}) }));
      if (module && !saved.module) throw new ApiError('Module 儲存回應缺少完整 metadata，請重新載入確認。', 'INVALID_RESPONSE');
      return saved;
    },
    async validateDraft(testId, editingSessionId, revision, signal) {
      return parseRun(await request(`/tests/${id(testId)}/draft/validate`, 'POST', signal, { editingSessionId, revision }));
    },
    async publishTest(testId, editingSessionId, revision, summaryRunId, signal) {
      return parseVersion(await request(`/tests/${id(testId)}/publish`, 'POST', signal, { editingSessionId, revision, summaryRunId, confirmed: true }));
    },
    async listVersions(testId, signal) {
      return items(await request(`/tests/${id(testId)}/versions`, 'GET', signal), (value) => parseVersion(value, true));
    },
    async getVersionConversation(testId, versionId, after, signal) {
      const query = after === null ? '' : `?after=${encodeURIComponent(after)}`;
      const data = record(await request(`/tests/${id(testId)}/versions/${id(versionId)}/conversation${query}`, 'GET', signal));
      const nextCursor = nullableString(data.nextCursor);
      if (data.testId !== testId || data.versionId !== versionId || (nextCursor !== null && (!/^[1-9]\d{0,18}$/.test(nextCursor) || nextCursor === after))) {
        throw new ApiError('對話歷程所屬版本或分頁資訊不符。', 'INVALID_RESPONSE');
      }
      return { messages: array(data.messages, (value) => parseMessageText(record(value))), nextCursor };
    },
    async cancelRun(runId, signal) {
      return parseRun(await request(`/runs/${id(runId)}/cancel`, 'POST', signal));
    },
    async getConversation(testId, editingSessionId, signal) {
      const conversation = parseConversation(await request(`/tests/${id(testId)}/conversation?editingSessionId=${id(editingSessionId)}`, 'GET', signal));
      if (conversation.editingSessionId !== editingSessionId) throw new ApiError('對話週期不符，請重新載入。', 'SESSION_CONFLICT', 409);
      return conversation;
    },
    async sendMessage(testId, editingSessionId, content, revision, signal) {
      const data = record(await request(`/tests/${id(testId)}/messages`, 'POST', signal, { editingSessionId, content, revision }));
      const conversationId = string(data.conversationId);
      return data.similarTest == null ? { conversationId, run: parseRun(data.run) }
        : { conversationId, similarTest: parseSimilarTest(data.similarTest, testId) };
    },
    async decideSimilarTest(testId, editingSessionId, reviewId, revision, selection, signal) {
      const data = record(await request(`/tests/${id(testId)}/editing-sessions/${id(editingSessionId)}/similar-test`, 'POST', signal,
        { id: reviewId, revision, choice: selection }, false, selection === 'continue' ? 202 : 200));
      if (selection === 'continue') {
        const run = parseRun(data.run);
        if (run.testId !== testId || run.editingSessionId !== editingSessionId || run.draftRevision !== revision || run.kind !== 'author') {
          throw new ApiError('新測試任務與目前草稿不符。', 'INVALID_RESPONSE');
        }
        return { run };
      }
      const test = parseTest(data.test);
      if (test.id === testId || !test.publishedVersionId || test.activeEditingSession?.status !== 'active') {
        throw new ApiError('相似案例的編輯週期不符。', 'INVALID_RESPONSE');
      }
      return { test };
    },
    async startEditingSession(testId, signal) {
      return parseSession(record(await request(`/tests/${id(testId)}/editing-session`, 'POST', signal, {})).session);
    },
    async getActiveEditingSession(testId, signal) {
      const data = record(await request(`/tests/${id(testId)}/editing-session`, 'GET', signal));
      return data.session === null ? null : parseSession(data.session);
    },
    async getEditingSession(testId, sessionId, signal) {
      return parseSession(record(await request(`/tests/${id(testId)}/editing-sessions/${id(sessionId)}`, 'GET', signal)).session);
    },
    async discardEditingSession(testId, sessionId, revision, signal) {
      await request(`/tests/${id(testId)}/editing-sessions/${id(sessionId)}/discard`, 'POST', signal, { revision, confirmed: true });
      // 以純讀端點確認真實狀態，不從 POST 成功碼推定已完成回收。
      return parseSession(record(await request(`/tests/${id(testId)}/editing-sessions/${id(sessionId)}`, 'GET', signal)).session);
    },
    async replaceDraftWithNewTest(testId, sessionId, revision, replyId, signal) {
      const data = record(await request(`/tests/${id(testId)}/editing-sessions/${id(sessionId)}/replace-with-new-test`, 'POST', signal, { revision, replyId, confirmed: true }));
      const sourceTest = parseTest(data.sourceTest);
      const test = parseTest(data.test);
      if (sourceTest.id !== testId || test.id === testId || test.workspaceId !== sourceTest.workspaceId) {
        throw new ApiError('放棄草稿與新增測試的回應不符。', 'INVALID_RESPONSE');
      }
      return { sourceTest, test };
    },
    async requestSummary(testId, editingSessionId, revision, validationRunId, signal) {
      return parseRun(record(await request(`/tests/${id(testId)}/draft/summary`, 'POST', signal, { editingSessionId, revision, validationRunId })).run);
    },
    async getWorkspace(workspaceId, signal) {
      const workspace = parseWorkspaceDetail(await request(`/workspaces/${id(workspaceId)}`, 'GET', signal));
      if (workspace.id !== workspaceId) throw new ApiError('Workspace 回應不符。', 'WORKSPACE_CONFLICT');
      return workspace;
    },
    async updateWorkspaceAuthorEngine(workspaceId, revision, authorEngine, signal) {
      const workspace = parseWorkspaceDetail(await request(`/workspaces/${id(workspaceId)}/author-engine`, 'PATCH', signal, { revision, authorEngine }));
      if (workspace.id !== workspaceId) throw new ApiError('Workspace 回應不符。', 'WORKSPACE_CONFLICT');
      return workspace;
    },
    async getWorkspaceAgentRuntime(workspaceId, signal) {
      return parseWorkspaceAgentRuntime(await request(`/workspaces/${id(workspaceId)}/agent-runtime`, 'GET', signal, undefined, false, 200), workspaceId);
    },
    async updateWorkspaceAgentRuntime(workspaceId, revision, selection, signal) {
      const { profileId, skillProfiles } = selection;
      return parseWorkspaceAgentRuntime(await request(`/workspaces/${id(workspaceId)}/agent-runtime`, 'PATCH', signal, { revision, profileId, skillProfiles }, false, 200), workspaceId);
    },
    async createWorkspace(name, signal) { return parseWorkspaceDetail(await request('/workspaces', 'POST', signal, name?.trim() ? { name: name.trim() } : {})); },
    async getWorkspaceConversation(workspaceId, signal) {
      const conversation = parseWorkspaceConversation(await request(`/workspaces/${id(workspaceId)}/conversation`, 'GET', signal));
      if (conversation.workspaceId !== workspaceId) throw new ApiError('設定對話所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
      return conversation;
    },
    async sendWorkspaceMessage(workspaceId, input, signal) {
      const data = record(await request(`/workspaces/${id(workspaceId)}/messages`, 'POST', signal, { content: input.content, revision: input.revision, contextRevision: input.contextRevision }));
      const run = parseRun(data.run);
      if (run.workspaceId !== workspaceId || run.testId !== null || run.authorMode !== 'workspace') throw new ApiError('設定任務所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
      return { run, conversationId: string(data.conversationId) };
    },
    async getWorkspaceProposal(workspaceId, proposalId, signal) { return ownedProposal(await request(proposalPath(workspaceId, proposalId), 'GET', signal), workspaceId); },
    async confirmWorkspaceScope(workspaceId, proposalId, baseRevision, signal) { return ownedProposal(await request(`${proposalPath(workspaceId, proposalId)}/confirm-scope`, 'POST', signal, { baseRevision, confirmed: true }), workspaceId); },
    async confirmWorkspaceProposal(workspaceId, proposalId, baseRevision, signal) {
      const data = record(await request(`${proposalPath(workspaceId, proposalId)}/confirm`, 'POST', signal, { baseRevision, confirmed: true }));
      const workspace = parseWorkspaceDetail(data.workspace);
      if (workspace.id !== workspaceId) throw new ApiError('Workspace 回應不符。', 'WORKSPACE_CONFLICT');
      return { workspace, proposal: ownedProposal(data.proposal, workspaceId) };
    },
    async cancelWorkspaceProposal(workspaceId, proposalId, baseRevision, signal) { return ownedProposal(await request(`${proposalPath(workspaceId, proposalId)}/cancel`, 'POST', signal, { baseRevision, confirmed: true }), workspaceId); },
    async saveWorkspaceCredentials(workspaceId, roleId, input, signal) {
      if (!isProtectedCredentialTransport(base, window.location.href)) throw new ApiError('需 HTTPS 或明確的 loopback 本機連線才能保存登入資料。', 'INSECURE_TRANSPORT');
      if (!Number.isSafeInteger(input.expectedSecretVersion) || input.expectedSecretVersion < 0) throw new ApiError('需提供有效的登入資料版本。', 'INVALID_CREDENTIAL_VERSION');
      const role = parseWorkspaceRole(await request(`/workspaces/${id(workspaceId)}/roles/${id(roleId)}/credentials`, 'PUT', signal, { expectedSecretVersion: input.expectedSecretVersion, username: input.username, password: input.password }, true));
      if (role.roleId !== roleId || !role.configured) throw new ApiError('角色回應不符。', 'INVALID_RESPONSE');
      return role;
    },
    async revokeWorkspaceCredentials(workspaceId, roleId, expectedSecretVersion, signal) {
      if (!Number.isSafeInteger(expectedSecretVersion) || expectedSecretVersion < 0) throw new ApiError('需提供有效的登入資料版本。', 'INVALID_CREDENTIAL_VERSION');
      const data = record(await request(`/workspaces/${id(workspaceId)}/roles/${id(roleId)}/credentials`, 'DELETE', signal, { expectedSecretVersion, confirmed: true }, true));
      if (string(data.roleId) !== roleId || bool(data.configured)) throw new ApiError('角色撤銷回應不符。', 'INVALID_RESPONSE');
      return { roleId, secretRef: nullableString(data.secretRef), configured: false };
    },
    async getWorkspaceSettings(workspaceId, signal) {
      return parseWorkspaceSettings(await request(`/workspaces/${id(workspaceId)}`, 'GET', signal));
    },
    async updateWorkspaceSettings(workspaceId, input, signal) {
      // 只傳契約允許的欄位，避免 UI 資料或未定義欄位混入 PATCH。
      const body = {
        revision: input.revision,
        sites: input.sites?.map((site) => ({ name: site.name, url: site.url })),
        defaultTestUrl: input.defaultTestUrl, timeoutMs: input.timeoutMs,
      };
      return parseWorkspaceSettings(await request(`/workspaces/${id(workspaceId)}`, 'PATCH', signal, body));
    },
  };
}

export function isProtectedCredentialTransport(apiBase: string, pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const api = new URL(apiBase, page);
    const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    return !api.username && !api.password && (page.protocol === 'https:' || (page.protocol === 'http:' && loopback(page))) && (api.protocol === 'https:' || (api.protocol === 'http:' && loopback(api) && loopback(page)));
  } catch { return false; }
}

export function resolveMcpEndpoint(apiBase: string, pageUrl: string): string | null {
  try {
    const endpoint = new URL(apiBase, pageUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !/\/api\/?$/.test(endpoint.pathname)) return null;
    endpoint.pathname = endpoint.pathname.replace(/\/api\/?$/, '/mcp');
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.href;
  } catch { return null; }
}

export function resolveReportUrl(reportUrl: string | undefined, apiBase: string, pageUrl: string): string | null {
  if (!reportUrl) return null;
  try {
    const base = new URL(`${apiBase.replace(/\/+$/, '')}/`, pageUrl);
    const url = new URL(reportUrl, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
