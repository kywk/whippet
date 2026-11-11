export interface DevUser {
  id: string;
  role: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Test {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
}

export const RUN_STATUSES = [
  'queued', 'dispatched', 'running', 'collecting', 'succeeded',
  'failed', 'cancelling', 'cancelled', 'timed_out', 'interrupted',
] as const;

export type RunStatus = typeof RUN_STATUSES[number];

export interface Run {
  id: string;
  testId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  reportUrl?: string;
}

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: '排隊中',
  dispatched: '已派送',
  running: '執行中',
  collecting: '整理報告中',
  succeeded: '通過',
  failed: '失敗',
  cancelling: '取消中',
  cancelled: '已取消',
  timed_out: '已逾時',
  interrupted: '執行中斷',
};

export function isActiveRun(run: Run): boolean {
  return ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(run.status);
}

export interface WhippetApi {
  login(signal?: AbortSignal): Promise<DevUser>;
  listWorkspaces(signal?: AbortSignal): Promise<Workspace[]>;
  listTests(workspaceId: string, signal?: AbortSignal): Promise<Test[]>;
  getTest(testId: string, signal?: AbortSignal): Promise<Test>;
  createRun(testId: string, signal?: AbortSignal): Promise<Run>;
  listRuns(testId: string, signal?: AbortSignal): Promise<Run[]>;
  getRun(runId: string, signal?: AbortSignal): Promise<Run>;
}
