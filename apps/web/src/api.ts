import { RUN_STATUSES } from './types';
import type { Conversation, DevUser, Draft, Message, Run, RunStatus, Test, Version, WhippetApi, Workspace } from './types';

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

function parseWorkspace(value: unknown): Workspace {
  const data = record(value);
  return { id: string(data.id), name: string(data.name) };
}

function parseTest(value: unknown): Test {
  const data = record(value);
  return {
    id: string(data.id), workspaceId: string(data.workspaceId), name: string(data.name),
    description: optionalString(data.description) ?? '',
    publishedVersionId: optionalString(data.publishedVersionId) || null,
  };
}

function parseRun(value: unknown): Run {
  const data = record(value);
  if (data.kind != null && data.kind !== 'run' && data.kind !== 'validation' && data.kind !== 'author') {
    throw new ApiError('API Run kind 格式不符。', 'INVALID_RESPONSE');
  }
  return {
    id: string(data.id), testId: string(data.testId), status: parseStatus(data.status),
    createdAt: string(data.createdAt), startedAt: optionalString(data.startedAt),
    finishedAt: optionalString(data.finishedAt), error: optionalString(data.error),
    reportUrl: optionalString(data.reportUrl),
    kind: data.kind as Run['kind'],
    draftRevision: data.draftRevision == null ? undefined : revision(data.draftRevision),
    versionId: optionalString(data.versionId),
  };
}

function parseDraft(value: unknown): Draft {
  const data = record(value);
  return {
    testId: string(data.testId), revision: revision(data.revision), script: string(data.script),
    updatedAt: string(data.updatedAt), validationRunId: optionalString(data.validationRunId),
    validationStatus: data.validationStatus == null ? undefined : parseStatus(data.validationStatus),
    reportUrl: optionalString(data.reportUrl),
  };
}

function parseVersion(value: unknown): Version {
  const data = record(value);
  return {
    id: string(data.id), testId: string(data.testId), revision: revision(data.revision),
    script: string(data.script), createdAt: string(data.createdAt), validationRunId: string(data.validationRunId),
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
  };
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  const data = record(value);
  if (!Array.isArray(data.items)) throw new ApiError('API 列表格式不符。', 'INVALID_RESPONSE');
  return data.items.map(parse);
}

export function createHttpApi(apiBase = '/api'): WhippetApi {
  const base = apiBase.replace(/\/+$/, '');

  async function request(path: string, method = 'GET', signal?: AbortSignal, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);

    try {
      const response = await fetch(`${base}${path}`, {
        method, credentials: 'include',
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
        throw new ApiError(
          typeof details.message === 'string' ? details.message : `API 請求失敗（HTTP ${response.status}）。`,
          typeof details.code === 'string' ? details.code : `HTTP_${response.status}`,
          response.status,
        );
      }
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
  return {
    async login(signal) {
      const data = record(await request('/dev-login', 'POST', signal));
      const user = record(data.user);
      return { id: string(user.id), role: string(user.role) } satisfies DevUser;
    },
    async listWorkspaces(signal) {
      return items(await request('/workspaces', 'GET', signal), parseWorkspace);
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
    async createTest(workspaceId, input, signal) {
      return parseTest(await request(`/workspaces/${id(workspaceId)}/tests`, 'POST', signal, input));
    },
    async getDraft(testId, signal) {
      return parseDraft(await request(`/tests/${id(testId)}/draft`, 'GET', signal));
    },
    async saveDraft(testId, revision, script, signal) {
      return parseDraft(await request(`/tests/${id(testId)}/draft`, 'PUT', signal, { revision, script }));
    },
    async validateDraft(testId, revision, signal) {
      return parseRun(await request(`/tests/${id(testId)}/draft/validate`, 'POST', signal, { revision }));
    },
    async publishTest(testId, revision, signal) {
      return parseVersion(await request(`/tests/${id(testId)}/publish`, 'POST', signal, { revision, confirmed: true }));
    },
    async listVersions(testId, signal) {
      return items(await request(`/tests/${id(testId)}/versions`, 'GET', signal), parseVersion);
    },
    async cancelRun(runId, signal) {
      return parseRun(await request(`/runs/${id(runId)}/cancel`, 'POST', signal));
    },
    async getConversation(testId, signal) {
      return parseConversation(await request(`/tests/${id(testId)}/conversation`, 'GET', signal));
    },
    async sendMessage(testId, content, revision, signal) {
      const data = record(await request(`/tests/${id(testId)}/messages`, 'POST', signal, { content, revision }));
      return { run: parseRun(data.run), conversationId: string(data.conversationId) };
    },
  };
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
