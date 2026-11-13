import { validRepairContent, editableStage } from './plan';
import { RUN_STATUSES } from './types';
import type { StageRetry, ModuleMetadata, Plan, PlanStage, PlanSummary, StageArgument, JsonValue, AuthorPartial, CatalogItem, AcceptanceSummary, ActiveEditingSession, Conversation, DevUser, Draft, EditingSession, Message, Run, RunArtifact, RunStatus, Test, Version, WhippetApi, WorkspaceCapabilities, WorkspaceCapability, WorkspaceConfig, WorkspaceConversationData, WorkspaceDetail, WorkspaceProposal, WorkspaceRoleRef, WorkspaceSettingsResponse, WorkspaceSettingsSnapshot } from './types';

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

function parseWorkspaceDetail(value: unknown): WorkspaceDetail {
  const data = record(value);
  const result: WorkspaceDetail = {
    ...parseWorkspaceSettings(data), lifecycle: choice(data.lifecycle, ['draft', 'needs_confirmation', 'active'] as const),
    authorizationRevision: revision(data.authorizationRevision), scopeStatus: choice(data.scopeStatus, ['unconfirmed', 'confirmed', 'revoking'] as const),
    settings: data.settings === null ? null : parseWorkspaceConfig(data.settings), conversationId: string(data.conversationId), activeRunId: nullableString(data.activeRunId),
    currentProposal: data.currentProposal === null ? null : parseWorkspaceProposal(data.currentProposal), roles: array(data.roles, parseWorkspaceRole),
    secretsAvailable: bool(data.secretsAvailable), executionAvailable: bool(data.executionAvailable), unavailableReason: nullableString(data.unavailableReason),
    capabilities: parseCapabilities(data.capabilities),
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
    publishedVersionId: optionalString(data.publishedVersionId) || null,
    activeEditingSession: data.activeEditingSession === undefined ? undefined : data.activeEditingSession === null ? null : parseActiveSession(data.activeEditingSession),
  };
}

function parsePlanStage(value: unknown): PlanStage {
  const data = record(value);
  const module = data.module == null ? undefined : record(data.module);
  const args = Object.fromEntries(Object.entries(record(data.args)).map(([key, value]) => {
    const arg = record(value);
    const kind = choice(arg.kind, ['literal', 'binding'] as const);
    if (kind === 'literal' && !Object.hasOwn(arg, 'value')) throw new ApiError('Stage literal 缺少 value。', 'INVALID_RESPONSE');
    const parsed: StageArgument = kind === 'literal' ? { kind, value: arg.value as JsonValue } : { kind, stageId: string(arg.stageId), path: array(arg.path, string) };
    return [key, parsed];
  }));
  return { id: string(data.id), title: string(data.title), action: choice(data.action, ['reuse', 'modify', 'create'] as const),
    status: choice(data.status, ['pending', 'authoring', 'validating', 'ready', 'failed'] as const),
    moduleTestId: optionalString(data.moduleTestId), moduleVersionId: optionalString(data.moduleVersionId),
    module: module ? { slug: string(module.slug), moduleKind: choice(module.moduleKind, ['setup', 'step', 'page'] as const), description: string(module.description) } : undefined,
    args, bind: optionalString(data.bind), draftRevision: data.draftRevision == null ? undefined : revision(data.draftRevision),
    candidateVersionId: optionalString(data.candidateVersionId), authorRunId: optionalString(data.authorRunId), validationRunId: optionalString(data.validationRunId), error: optionalString(data.error) };
}
function parseStageRetry(value: unknown): StageRetry {
  const data = record(value);
  const eligible = bool(data.eligible);
  const reason = data.reason === null ? null : choice(data.reason, ['plan_not_stopped', 'stage_not_retryable', 'cancelled', 'source_unavailable', 'session_closed', 'reclaim_pending', 'snapshot_mismatch', 'prior_stage_invalid', 'scope_unavailable'] as const);
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
    status: choice(data.status, ['draft', 'confirmed', 'running', 'composed', 'done', 'stopped'] as const), stages,
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
    message: nullableString(data.message), description: nullableString(data.description), backgroundSummary: nullableString(data.backgroundSummary), name: nullableString(data.name), candidates };
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
    checkpoint = { scriptHash, selfTestPassed: true };
  }
  return { reason: choice(data.reason, ['budget_exhausted'] as const), nextStep, checkpoint,
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

function parseRun(value: unknown): Run {
  const data = record(value);
  if (data.kind != null && data.kind !== 'run' && data.kind !== 'validation' && data.kind !== 'author') {
    throw new ApiError('API Run kind 格式不符。', 'INVALID_RESPONSE');
  }
  if (data.authorMode != null && data.authorMode !== 'edit' && data.authorMode !== 'summary' && data.authorMode !== 'workspace') throw new ApiError('authorMode 格式不符。', 'INVALID_RESPONSE');
  return {
    id: string(data.id), testId: nullableString(data.testId), workspaceId: string(data.workspaceId), status: parseStatus(data.status),
    createdAt: string(data.createdAt), startedAt: optionalString(data.startedAt),
    finishedAt: optionalString(data.finishedAt), error: optionalString(data.error),
    reportUrl: optionalString(data.reportUrl),
    kind: data.kind as Run['kind'],
    draftRevision: data.draftRevision == null ? undefined : revision(data.draftRevision),
    versionId: optionalString(data.versionId),
    workspaceSettings: data.workspaceSettings == null ? undefined : parseWorkspaceSnapshot(data.workspaceSettings),
    editingSessionId: optionalString(data.editingSessionId) ?? null,
    authorMode: data.authorMode as Run['authorMode'],
    scriptOrigin: data.scriptOrigin == null ? undefined : choice(data.scriptOrigin, ['ai', 'manual', 'legacy'] as const),
    authorPartial: data.authorPartial == null ? undefined : parseAuthorPartial(data.authorPartial),
    progressEvents: data.progressEvents == null ? undefined : array(data.progressEvents, string),
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
    summaryRunId: optionalString(data.summaryRunId) ?? null, editingSessionId: optionalString(data.editingSessionId) ?? null,
    scriptOrigin: data.scriptOrigin == null ? undefined : choice(data.scriptOrigin, ['ai', 'manual', 'legacy'] as const),
  };
}

function parseMessage(value: unknown): Message {
  const data = record(value);
  if (data.role !== 'user' && data.role !== 'assistant') throw new ApiError('對話角色格式不符。', 'INVALID_RESPONSE');
  return {
    id: string(data.id), role: data.role, content: string(data.content), createdAt: string(data.createdAt),
    runId: optionalString(data.runId), baseRevision: data.baseRevision == null ? undefined : revision(data.baseRevision),
    appliedRevision: data.appliedRevision == null ? undefined : revision(data.appliedRevision),
    baseScript: optionalString(data.baseScript),
    proposedScript: optionalString(data.proposedScript), validationRunId: optionalString(data.validationRunId),
  };
}

function parseConversation(value: unknown): Conversation {
  const data = record(value);
  if (!Array.isArray(data.messages)) throw new ApiError('對話訊息格式不符。', 'INVALID_RESPONSE');
  return {
    id: string(data.id), testId: string(data.testId), messages: data.messages.map(parseMessage),
    activeRunId: optionalString(data.activeRunId),
    editingSessionId: optionalString(data.editingSessionId),
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

export function createHttpApi(apiBase = '/api'): WhippetApi {
  const base = apiBase.replace(/\/+$/, '');

  async function request(path: string, method = 'GET', signal?: AbortSignal, body?: unknown, sensitive = false, expectedStatus?: number | number[]): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);

    try {
      const response = await fetch(`${base}${path}`, {
        method, credentials: 'include',
        cache: sensitive ? 'no-store' : 'default', redirect: sensitive ? 'error' : 'follow',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
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
      if (data === null) throw new ApiError('API 未回傳 JSON，請確認 /api 代理設定。', 'INVALID_RESPONSE');
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
  const proposalPath = (workspaceId: string, proposalId: string) => `/workspaces/${id(workspaceId)}/proposals/${id(proposalId)}`;
  function ownedProposal(value: unknown, workspaceId: string) {
    const proposal = parseWorkspaceProposal(value);
    if (proposal.workspaceId !== workspaceId) throw new ApiError('提案所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
    return proposal;
  }
  return {
    async login(signal) {
      const data = record(await request('/dev-login', 'POST', signal));
      const user = record(data.user);
      return { id: string(user.id), role: string(user.role) } satisfies DevUser;
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
    async retryStage(planId, stageId, input, signal) {
      if (!validRepairContent(input.content) || input.confirmed !== true || !Number.isSafeInteger(input.planRevision) || input.planRevision < 1 || !Number.isSafeInteger(input.moduleRevision) || input.moduleRevision < 1 || !Number.isSafeInteger(input.moduleContextRevision) || input.moduleContextRevision < 0) throw new ApiError('修復指示或重試 CAS 格式不符。', 'INVALID_REQUEST');
      const { planRevision, moduleRevision, moduleContextRevision, confirmed, content } = input;
      const data = record(await request(`/plans/${id(planId)}/stages/${id(stageId)}/retry`, 'POST', signal, { planRevision, moduleRevision, moduleContextRevision, confirmed, content }, false, 200));
      const plan = parsePlan(data.plan);
      if (plan.id !== planId) throw new ApiError('重試 Plan 回應不符。', 'INVALID_RESPONSE');
      return plan;
    },
    async confirmPlan(planId, planRevision, signal) {
      const data = record(await request(`/plans/${id(planId)}/confirm`, 'POST', signal, { planRevision, confirmed: true }, false, 200));
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
    async getTest(testId, signal) {
      return parseTest(await request(`/tests/${id(testId)}`, 'GET', signal));
    },
    async createRun(testId, signal) {
      return parseRun(await request(`/tests/${id(testId)}/runs`, 'POST', signal));
    },
    async listRuns(testId, signal) {
      return items(await request(`/tests/${id(testId)}/runs`, 'GET', signal), parseRun);
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
      return { run: parseRun(data.run), conversationId: string(data.conversationId) };
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
    async requestSummary(testId, editingSessionId, revision, validationRunId, signal) {
      return parseRun(record(await request(`/tests/${id(testId)}/draft/summary`, 'POST', signal, { editingSessionId, revision, validationRunId })).run);
    },
    async getWorkspace(workspaceId, signal) {
      const workspace = parseWorkspaceDetail(await request(`/workspaces/${id(workspaceId)}`, 'GET', signal));
      if (workspace.id !== workspaceId) throw new ApiError('Workspace 回應不符。', 'WORKSPACE_CONFLICT');
      return workspace;
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
