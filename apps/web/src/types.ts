export interface DevUser {
  id: string;
  role: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface WorkspaceSite {
  name: string;
  url: string;
}

export interface WorkspaceSettingsSnapshot {
  revision: number;
  sites: WorkspaceSite[];
  defaultTestUrl: string;
  timeoutMs: number;
}

export interface WorkspaceSettingsResponse extends WorkspaceSettingsSnapshot {
  id: string;
  name: string;
}

export interface WorkspaceSettingsPatch {
  revision: number;
  sites?: WorkspaceSite[];
  defaultTestUrl?: string;
  timeoutMs?: number;
}

export interface Test {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
  activeEditingSession?: ActiveEditingSession | null;
}

export interface ActiveEditingSession {
  id: string;
  status: 'active' | 'discarding';
  draftRevision: number;
  updatedAt: string;
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
  workspaceSettings?: WorkspaceSettingsSnapshot;
  editingSessionId?: string | null;
  authorMode?: 'edit' | 'summary';
}

export interface Draft {
  testId: string;
  revision: number;
  script: string;
  updatedAt: string;
  validationRunId?: string;
  validationStatus?: RunStatus;
  reportUrl?: string;
  workspaceSettings?: WorkspaceSettingsSnapshot;
  editingSessionId?: string;
}

export interface Version {
  id: string;
  testId: string;
  revision: number;
  script: string;
  createdAt: string;
  validationRunId: string;
  workspaceSettings?: WorkspaceSettingsSnapshot;
  description: string | null;
  backgroundSummary: string | null;
  summaryRunId: string | null;
  editingSessionId: string | null;
}

export interface AcceptanceSummary {
  runId: string;
  status: RunStatus;
  revision: number;
  validationRunId: string;
  description?: string;
  backgroundSummary?: string;
  name?: string;
  validForCurrentDraft: boolean;
}

export interface EditingSession {
  id: string;
  testId: string;
  workspaceId: string;
  status: 'active' | 'discarding' | 'discarded' | 'published';
  sourceVersionId: string | null;
  sourceVersion: { id: string; description: string | null; backgroundSummary: string | null } | null;
  conversationId: string;
  conversationSummary: string | null;
  contextRevision?: number;
  draft: Draft | null;
  summary: AcceptanceSummary | null;
  pendingRunIds: string[];
  reclaimPending: boolean;
  publishedVersionId: string | null;
  createdAt: string;
  closedAt: string | null;
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
  editingSessionId?: string;
}

export interface RunArtifact {
  name: string;
  size: number;
  contentType: string;
  url: string;
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
  createTest(workspaceId: string, input: { name?: string; description?: string }, signal?: AbortSignal): Promise<Test>;
  getDraft(testId: string, editingSessionId: string, signal?: AbortSignal): Promise<Draft>;
  saveDraft(testId: string, editingSessionId: string, revision: number, script: string, signal?: AbortSignal): Promise<Draft>;
  validateDraft(testId: string, editingSessionId: string, revision: number, signal?: AbortSignal): Promise<Run>;
  publishTest(testId: string, editingSessionId: string, revision: number, summaryRunId: string, signal?: AbortSignal): Promise<Version>;
  listVersions(testId: string, signal?: AbortSignal): Promise<Version[]>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<Run>;
  getConversation(testId: string, editingSessionId: string, signal?: AbortSignal): Promise<Conversation>;
  sendMessage(testId: string, editingSessionId: string, content: string, revision: number, signal?: AbortSignal): Promise<{ run: Run; conversationId: string }>;
  getWorkspaceSettings(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceSettingsResponse>;
  updateWorkspaceSettings(workspaceId: string, input: WorkspaceSettingsPatch, signal?: AbortSignal): Promise<WorkspaceSettingsResponse>;
  getRunArtifacts(runId: string, signal?: AbortSignal): Promise<RunArtifact[]>;
  startEditingSession(testId: string, signal?: AbortSignal): Promise<EditingSession>;
  getActiveEditingSession(testId: string, signal?: AbortSignal): Promise<EditingSession | null>;
  getEditingSession(testId: string, sessionId: string, signal?: AbortSignal): Promise<EditingSession>;
  discardEditingSession(testId: string, sessionId: string, revision: number, signal?: AbortSignal): Promise<EditingSession>;
  requestSummary(testId: string, editingSessionId: string, revision: number, validationRunId: string, signal?: AbortSignal): Promise<Run>;
}
