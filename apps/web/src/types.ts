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
  kind?: 'run' | 'validation' | 'author';
  draftRevision?: number;
  versionId?: string;
}

export interface Draft {
  testId: string;
  revision: number;
  script: string;
  updatedAt: string;
  validationRunId?: string;
  validationStatus?: RunStatus;
  reportUrl?: string;
}

export interface Version {
  id: string;
  testId: string;
  revision: number;
  script: string;
  createdAt: string;
  validationRunId: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  runId?: string;
  baseRevision?: number;
  appliedRevision?: number;
  baseScript?: string;
  proposedScript?: string;
  validationRunId?: string;
}

export interface Conversation {
  id: string;
  testId: string;
  messages: Message[];
  activeRunId?: string;
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
  createTest(workspaceId: string, input: { name: string; description?: string }, signal?: AbortSignal): Promise<Test>;
  getDraft(testId: string, signal?: AbortSignal): Promise<Draft>;
  saveDraft(testId: string, revision: number, script: string, signal?: AbortSignal): Promise<Draft>;
  validateDraft(testId: string, revision: number, signal?: AbortSignal): Promise<Run>;
  publishTest(testId: string, revision: number, signal?: AbortSignal): Promise<Version>;
  listVersions(testId: string, signal?: AbortSignal): Promise<Version[]>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<Run>;
  getConversation(testId: string, signal?: AbortSignal): Promise<Conversation>;
  sendMessage(testId: string, content: string, revision: number, signal?: AbortSignal): Promise<{ run: Run; conversationId: string }>;
}
