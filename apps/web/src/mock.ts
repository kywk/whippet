import type { Run, Test, WhippetApi } from './types';

// 明確 opt-in 的 UI 示範；不與真實 API 自動互相切換。
export function createMockApi(): WhippetApi {
  const workspace = { id: '00000000-0000-4000-8000-000000000001', name: '示範 Workspace' };
  const tests: Test[] = [
    {
      id: '00000000-0000-4000-8000-000000000011', workspaceId: workspace.id,
      name: '本機頁面基本流程', description: '示範成功的執行狀態與報告入口。資料只保留在目前分頁。',
      publishedVersionId: '00000000-0000-4000-8000-000000000021',
    },
    {
      id: '00000000-0000-4000-8000-000000000012', workspaceId: workspace.id,
      name: '斷言失敗範例', description: '示範斷言失敗的狀態、錯誤訊息與報告入口。',
      publishedVersionId: '00000000-0000-4000-8000-000000000022',
    },
  ];
  const runs = new Map<string, Run>();

  function progress(run: Run): Run {
    const start = Date.parse(run.createdAt);
    const elapsed = Date.now() - start;
    const status = elapsed < 1_000 ? 'queued' : elapsed < 3_000 ? 'running'
      : elapsed < 4_000 ? 'collecting' : run.testId === tests[1].id ? 'failed' : 'succeeded';
    return {
      ...run, status,
      startedAt: elapsed >= 1_000 ? new Date(start + 1_000).toISOString() : undefined,
      finishedAt: elapsed >= 4_000 ? new Date(start + 4_000).toISOString() : undefined,
      error: status === 'failed' ? '示範斷言失敗：預期標題為「完成」，實際為「處理中」。' : undefined,
      reportUrl: elapsed >= 4_000 ? '/mock-report.html' : undefined,
    };
  }

  return {
    async login() { return { id: 'dev-admin', role: 'superadmin' }; },
    async listWorkspaces() { return [workspace]; },
    async listTests() { return tests; },
    async getTest(testId) {
      const test = tests.find((item) => item.id === testId);
      if (!test) throw new Error('找不到示範測試。');
      return test;
    },
    async createRun(testId) {
      const run: Run = { id: crypto.randomUUID(), testId, status: 'queued', createdAt: new Date().toISOString() };
      runs.set(run.id, run);
      return run;
    },
    async listRuns(testId) {
      return [...runs.values()].filter((run) => run.testId === testId).map(progress);
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (!run) throw new Error('找不到示範執行紀錄。');
      return progress(run);
    },
  };
}
