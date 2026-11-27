import { ApiError } from './api';
import { DEFAULT_DEV_USER, DEV_IDENTITIES } from './access';
import { DEFAULT_WORKSPACE_MANAGEMENT, isActiveRun } from './types';
import type { DevUser, Draft, Run, SiteRole, Test, Version, WhippetApi, WorkspaceDetail, WorkspaceMemberRole, WorkspaceRunActivity } from './types';

// 明確 opt-in 的 UI 示範；不與真實 API 自動互相切換。
export function createMockApi(): WhippetApi {
  const workspace: Omit<WorkspaceDetail, 'permissions'> = { id: '00000000-0000-4000-8000-000000000001', name: '示範 Workspace', revision: 1, authorEngine: 'builtin', sites: [], defaultTestUrl: '', timeoutMs: 60000, lifecycle: 'needs_confirmation', management: { ...DEFAULT_WORKSPACE_MANAGEMENT }, authorizationRevision: 0, scopeStatus: 'unconfirmed', settings: null, siteReadiness: [], conversationId: 'mock-unavailable', activeRunId: null, currentProposal: null, roles: [], secretsAvailable: false, executionAvailable: false, unavailableReason: 'mock_unavailable' };
  let currentUserId: string | undefined;
  const siteRoles = new Map<string, SiteRole>([['dev-admin', 'superadmin'], ['dev-site-admin', 'site_admin']]);
  const workspaceRoles = new Map<string, WorkspaceMemberRole>([['dev-workspace-admin', 'workspace_admin'], [DEFAULT_DEV_USER, 'qa']]);

  function user(id: string | undefined): DevUser {
    const identity = DEV_IDENTITIES.find((entry) => entry.id === id);
    if (!identity) throw new ApiError('請先選擇身分登入。', 'UNAUTHORIZED', 401);
    const role = siteRoles.get(identity.id) ?? 'none';
    return {
      id: identity.id, name: identity.name, role,
      permissions: { createWorkspace: role !== 'none', manageUsers: role !== 'none', manageSuperAdmins: role === 'superadmin',
        manageSiteWorkspaces: false, manageSiteRoles: role === 'superadmin', manageAIResources: false },
    };
  }

  function workspaceAccess(workspaceId: string) {
    const current = user(currentUserId);
    const siteAdmin = current.permissions.manageUsers;
    const memberRole = workspaceRoles.get(current.id) ?? 'none';
    const manager = siteAdmin || memberRole === 'workspace_admin';
    return {
      manageTests: workspaceId === workspace.id && (manager || memberRole === 'qa'),
      manageSettings: manager, manageMembers: manager, manageWorkspaceAdmins: siteAdmin,
      manageAgentTokens: current.permissions.manageSuperAdmins,
    };
  }

  function forbid() {
    throw new ApiError('你沒有執行此操作的權限。', 'FORBIDDEN', 403);
  }
  const tests: Test[] = [
    {
      id: '00000000-0000-4000-8000-000000000011', workspaceId: workspace.id,
      name: '本機頁面基本流程', description: '示範成功的執行狀態與報告入口。資料只保留在目前分頁。',
      publishedVersionId: '00000000-0000-4000-8000-000000000021',
      metadataRevision: 1,
    },
    {
      id: '00000000-0000-4000-8000-000000000012', workspaceId: workspace.id,
      name: '斷言失敗範例', description: '示範斷言失敗的狀態、錯誤訊息與報告入口。',
      publishedVersionId: '00000000-0000-4000-8000-000000000022',
      metadataRevision: 1,
    },
  ];
  const runs = new Map<string, Run>();
  const drafts = new Map<string, Draft>();
  const versions = new Map<string, Version>();
  const snapshots = new Map<string, string>();
  const cancelledAt = new Map<string, number>();
  const seedScript = `import { test, expect } from '@playwright/test';

test('本機頁面', async ({ page }) => {
  await page.setContent('<h1>完成</h1>');
  await expect(page.getByRole('heading')).toHaveText('完成');
});
`;
  for (const test of tests) {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const validationRunId = crypto.randomUUID();
    runs.set(validationRunId, { id: validationRunId, testId: test.id, status: 'succeeded', kind: 'validation', draftRevision: 1, createdAt, finishedAt: createdAt, reportUrl: '/mock-report.html' });
    versions.set(test.publishedVersionId!, { id: test.publishedVersionId!, testId: test.id, revision: 1, script: seedScript, createdAt, validationRunId, description: null, backgroundSummary: null, summaryRunId: null, editingSessionId: null });
    drafts.set(test.id, { testId: test.id, revision: 1, script: seedScript, updatedAt: createdAt, validationRunId, validationStatus: 'succeeded', reportUrl: '/mock-report.html' });
  }

  function getTest(testId: string): Test {
    const test = tests.find((item) => item.id === testId);
    if (!test) throw new ApiError('找不到示範測試。', 'NOT_FOUND', 404);
    if (!workspaceAccess(test.workspaceId).manageTests) forbid();
    return test;
  }

  function editableTest(testId: string): Test {
    const test = getTest(testId);
    if (test.archived) throw new ApiError('此測試已封存。', 'CONFLICT', 409);
    return test;
  }

  function getDraft(testId: string): Draft {
    editableTest(testId);
    const draft = drafts.get(testId)!;
    if (draft.validationRunId) {
      const run = progress(runs.get(draft.validationRunId)!);
      draft.validationStatus = run.status;
      draft.reportUrl = run.reportUrl;
    }
    return { ...draft };
  }

  function checkRevision(testId: string, revision: number): Draft {
    const draft = getDraft(testId);
    if (draft.revision !== revision) throw new ApiError('草稿 revision 已變更，請重新載入。', 'REVISION_CONFLICT', 409);
    return draft;
  }

  function newRun(testId: string, kind: 'run' | 'validation', script: string, draftRevision?: number): Run {
    const run: Run = { id: crypto.randomUUID(), testId, kind, draftRevision, status: 'queued', createdAt: new Date().toISOString(), versionId: kind === 'run' ? getTest(testId).publishedVersionId ?? undefined : undefined };
    runs.set(run.id, run); snapshots.set(run.id, script);
    return { ...run };
  }

  function progress(run: Run): Run {
    if (!isActiveRun(run)) return { ...run };
    const start = Date.parse(run.createdAt);
    const elapsed = Date.now() - start;
    const cancelled = cancelledAt.get(run.id);
    // mock 不執行腳本；MOCK_FAIL 僅為明確的示範失敗標記。
    const failed = snapshots.get(run.id)?.includes('MOCK_FAIL') || (run.kind === 'run' && run.testId === tests[1].id);
    const status = cancelled != null ? Date.now() - cancelled < 1_000 ? 'cancelling' : 'cancelled'
      : elapsed < 1_000 ? 'queued' : elapsed < 3_000 ? 'running'
        : elapsed < 4_000 ? 'collecting' : failed ? 'failed' : 'succeeded';
    const updated: Run = {
      ...run, status,
      startedAt: elapsed >= 1_000 ? new Date(start + 1_000).toISOString() : undefined,
      finishedAt: status === 'cancelled' ? new Date().toISOString() : elapsed >= 4_000 && !cancelled ? new Date(start + 4_000).toISOString() : undefined,
      error: status === 'failed' ? '示範斷言失敗：預期標題為「完成」，實際為「處理中」。' : undefined,
      reportUrl: status === 'succeeded' || status === 'failed' ? '/mock-report.html' : undefined,
    };
    runs.set(run.id, updated);
    return { ...updated };
  }

  return {
    async login(userId) {
      const next = user(userId);
      currentUserId = next.id;
      return next;
    },
    async logout() { currentUserId = undefined; },
    async getMe() { return user(currentUserId); },
    async listUsers() {
      if (!user(currentUserId).permissions.manageUsers) forbid();
      return DEV_IDENTITIES.map(({ id }) => user(id));
    },
    async updateUserRole(userId, role) {
      const actor = user(currentUserId);
      const target = user(userId);
      if (!actor.permissions.manageSuperAdmins) forbid();
      if (target.role === 'superadmin' && role !== 'superadmin' && ![...siteRoles].some(([id, siteRole]) => id !== userId && siteRole === 'superadmin')) {
        throw new ApiError('必須保留至少一位 Super Admin。', 'CONFLICT', 409);
      }
      siteRoles.set(userId, role);
      return user(userId);
    },
    async listMembers(workspaceId) {
      const access = workspaceAccess(workspaceId);
      if (workspaceId !== workspace.id || !access.manageMembers) forbid();
      return DEV_IDENTITIES.map(({ id, name }) => ({ id, name, role: workspaceRoles.get(id) ?? 'none' }));
    },
    async updateMember(workspaceId, userId, role) {
      const access = workspaceAccess(workspaceId);
      const target = user(userId);
      if (workspaceId !== workspace.id || !access.manageMembers || (!access.manageWorkspaceAdmins && (role === 'workspace_admin' || workspaceRoles.get(userId) === 'workspace_admin'))) forbid();
      workspaceRoles.set(userId, role);
      return { id: target.id, name: target.name, role };
    },
    async listWorkspaces() {
      const permissions = workspaceAccess(workspace.id);
      return permissions.manageTests ? [{ ...workspace, permissions }] : [];
    },
    async listTests(workspaceId) {
      if (!workspaceAccess(workspaceId).manageTests) forbid();
      return tests.filter((test) => !test.archived).map((test) => ({ ...test }));
    },
    async listArchivedTests(workspaceId) {
      if (!workspaceAccess(workspaceId).manageTests) forbid();
      return tests.filter((test) => test.archived).map((test) => ({ ...test }));
    },
    async archiveTest(testId) {
      const test = getTest(testId);
      if (test.activeEditingSession) throw new ApiError('請先完成發佈或放棄草稿。', 'CONFLICT', 409);
      test.archived = true;
    },
    async getTest(testId) { return { ...getTest(testId) }; },
    async updateTestMetadata(testId, patch) {
      const test = editableTest(testId);
      const version = test.publishedVersionId ? versions.get(test.publishedVersionId) : undefined;
      if (test.metadataRevision !== patch.metadataRevision || (!version && (patch.description !== undefined || patch.backgroundSummary !== undefined))) {
        throw new ApiError('測試資訊已變更。', 'CONFLICT', 409);
      }
      if (patch.description !== undefined) test.description = patch.description;
      if (patch.tags !== undefined) test.tags = patch.tags;
      if (version) {
        if (patch.description !== undefined) version.description = patch.description;
        if (patch.backgroundSummary !== undefined) version.backgroundSummary = patch.backgroundSummary;
      }
      test.metadataRevision++;
      return { ...test };
    },
    async createRun(testId) {
      const test = editableTest(testId);
      if (!test.publishedVersionId) throw new ApiError('請先發佈測試。', 'UNPUBLISHED', 409);
      return newRun(testId, 'run', versions.get(test.publishedVersionId)!.script);
    },
    async listRuns(testId) {
      getTest(testId);
      return [...runs.values()].filter((run) => run.testId === testId).map(progress);
    },
    async listWorkspaceRunActivity(workspaceId, testIds, signal) {
      signal?.throwIfAborted();
      if (!workspaceAccess(workspaceId).manageTests) forbid();
      const filter = testIds === undefined ? undefined : new Set(testIds);
      const visible = new Set(tests.filter((test) => test.workspaceId === workspaceId && !test.archived && (!filter || filter.has(test.id))).map((test) => test.id));
      const activity: WorkspaceRunActivity[] = [];
      for (const entry of runs.values()) {
        const { testId } = entry;
        if (testId === null || !visible.has(testId)) continue;
        const run = progress(entry);
        const { id, status, kind, createdAt, startedAt, finishedAt, editingSessionId, draftRevision, reportUrl, authorMode, authorEngine, authorPartial, authorRepliedOnly } = run;
        activity.push({ id, testId, status, kind, createdAt, startedAt, finishedAt, editingSessionId, draftRevision, reportUrl, authorMode, authorEngine, authorRepliedOnly,
          authorPartial: authorPartial && { reason: authorPartial.reason },
          progressEvents: kind === 'author' && isActiveRun(run) ? run.progressEvents : undefined,
        });
      }
      return activity.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (!run) throw new Error('找不到示範執行紀錄。');
      if (run.testId) getTest(run.testId);
      return progress(run);
    },
    async createTest(workspaceId, input) {
      if (!workspaceAccess(workspaceId).manageTests) forbid();
      const test: Test = { id: crypto.randomUUID(), workspaceId, kind: input.kind, name: input.name?.trim() || '未命名測試', description: input.description ?? '', publishedVersionId: null, metadataRevision: 1 };
      tests.push(test);
      drafts.set(test.id, { testId: test.id, revision: 1, script: '', updatedAt: new Date().toISOString() });
      return { ...test };
    },
    async getDraft(testId) { return getDraft(testId); },
    async saveDraft(testId, _editingSessionId, revision, script) {
      const current = checkRevision(testId, revision);
      const next: Draft = script === current.script ? current : { testId, revision: current.revision + 1, script, updatedAt: new Date().toISOString() };
      drafts.set(testId, next);
      return { ...next };
    },
    async validateDraft(testId, _editingSessionId, revision) {
      const draft = checkRevision(testId, revision);
      if (!draft.script.trim()) throw new ApiError('請先儲存腳本。', 'EMPTY_SCRIPT', 400);
      const run = newRun(testId, 'validation', draft.script, draft.revision);
      drafts.set(testId, { ...draft, validationRunId: run.id, validationStatus: run.status, reportUrl: undefined });
      return run;
    },
    async publishTest(testId, _editingSessionId, revision) {
      const draft = checkRevision(testId, revision);
      if (draft.validationStatus !== 'succeeded' || !draft.reportUrl || !draft.validationRunId) throw new ApiError('目前 revision 尚未成功驗證或缺少報告。', 'VALIDATION_REQUIRED', 409);
      const version: Version = { id: crypto.randomUUID(), testId, revision, script: draft.script, createdAt: new Date().toISOString(), validationRunId: draft.validationRunId, description: null, backgroundSummary: null, summaryRunId: null, editingSessionId: null };
      versions.set(version.id, version);
      const test = getTest(testId);
      test.publishedVersionId = version.id;
      test.metadataRevision = (test.metadataRevision ?? 0) + 1;
      return { ...version };
    },
    async listVersions(testId) {
      getTest(testId);
      return [...versions.values()].filter((version) => version.testId === testId).reverse().map((version) => ({ ...version }));
    },
    async getVersionConversation(testId, versionId) {
      getTest(testId);
      const version = versions.get(versionId);
      if (version?.testId !== testId || version.scriptOrigin !== 'ai') throw new ApiError('找不到這個版本的對話歷程。', 'NOT_FOUND', 404);
      return { messages: [], nextCursor: null };
    },
    async cancelRun(runId) {
      const stored = runs.get(runId);
      if (!stored) throw new ApiError('找不到執行紀錄。', 'NOT_FOUND', 404);
      if (stored.testId) getTest(stored.testId);
      const run = progress(stored);
      if (!isActiveRun(run)) return run;
      if (run.status === 'queued') { const result: Run = { ...run, status: 'cancelled', finishedAt: new Date().toISOString() }; runs.set(runId, result); return { ...result }; }
      if (!cancelledAt.has(runId)) cancelledAt.set(runId, Date.now());
      return progress(run);
    },
    async getConversation(testId) {
      getTest(testId);
      return { id: `mock-conversation-${testId}`, testId, messages: [] };
    },
    async sendMessage() {
      throw new ApiError('示範模式未連接 AI。請使用真實 API 進行持久對話；本機不會呼叫模型。', 'MOCK_AUTHOR_UNAVAILABLE', 400);
    },
    async decideSimilarTest() { throw new ApiError('示範模式未提供相似測試確認。', 'MOCK_AUTHOR_UNAVAILABLE', 400); },
    async getWorkspaceSettings() {
      throw new ApiError('示範模式未提供 Workspace 設定，請使用真實 Server API。', 'MOCK_SETTINGS_UNAVAILABLE', 400);
    },
    async updateWorkspaceSettings() {
      throw new ApiError('示範模式不會儲存 Workspace 設定，請使用真實 Server API。', 'MOCK_SETTINGS_UNAVAILABLE', 400);
    },
    async getRunArtifacts(runId) {
      const run = runs.get(runId);
      if (!run) throw new ApiError('找不到執行紀錄。', 'NOT_FOUND', 404);
      if (run.testId) getTest(run.testId);
      // mock 沒有產生 ZIP／MD，不假造下載連結或證據內容。
      return [];
    },
    async startEditingSession() { throw new ApiError('示範模式未提供 M7 編輯週期，請使用真實 API。', 'MOCK_SESSION_UNAVAILABLE', 400); },
    async getActiveEditingSession() { throw new ApiError('示範模式未提供編輯週期狀態。', 'MOCK_SESSION_UNAVAILABLE', 400); },
    async getEditingSession() { throw new ApiError('示範模式未提供編輯週期狀態。', 'MOCK_SESSION_UNAVAILABLE', 400); },
    async discardEditingSession() { throw new ApiError('示範模式不會放棄草稿。', 'MOCK_SESSION_UNAVAILABLE', 400); },
    async replaceDraftWithNewTest() { throw new ApiError('示範模式不會放棄草稿。', 'MOCK_SESSION_UNAVAILABLE', 400); },
    async requestSummary() { throw new ApiError('示範模式不產生驗收摘要，請使用真實 API。', 'MOCK_SUMMARY_UNAVAILABLE', 400); },
    async getWorkspace() { throw new ApiError('M8 設定對話請使用真實 API。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async updateWorkspaceAuthorEngine() { throw new ApiError('示範模式不會切換 AI 撰寫引擎。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async createWorkspace() { throw new ApiError('示範模式不會建立 Workspace。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async getWorkspaceConversation() { throw new ApiError('示範模式沒有持久設定對話。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async sendWorkspaceMessage() { throw new ApiError('示範模式不會送出設定訊息。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async getWorkspaceProposal() { throw new ApiError('示範模式沒有真實提案。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async confirmWorkspaceScope() { throw new ApiError('示範模式不會確認範圍。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async confirmWorkspaceProposal() { throw new ApiError('示範模式不會套用提案。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async cancelWorkspaceProposal() { throw new ApiError('示範模式不會取消提案。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async saveWorkspaceCredentials() { throw new ApiError('示範模式不收集登入資料。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
    async revokeWorkspaceCredentials() { throw new ApiError('示範模式沒有登入資料。', 'MOCK_WORKSPACE_UNAVAILABLE', 400); },
  };
}
