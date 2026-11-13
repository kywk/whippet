export interface DevUser {
  id: string;
  role: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface WorkspaceConfig {
  name: string;
  purpose: string;
  backgroundSummary: string;
  targets: { name: string; purpose: string; origin: string }[];
  dependencies: { name: string; purpose: 'login' | 'api' | 'cdn'; origin: string }[];
  excludedOrigins: string[];
  exclusions: string;
  loginRoles: { roleId: string | null; name: string; loginMethod: 'form'; loginOrigin: string }[];
  defaultTestUrl: string;
  timeoutMs: number;
}

export interface WorkspaceRoleRef {
  roleId: string;
  secretRef: string | null;
  secretVersion: number | null;
  configured: boolean;
}

export type ScriptOrigin = 'ai' | 'manual' | 'legacy';
export interface WorkspaceCapability { available: boolean; reason: string | null }
export interface WorkspaceCapabilities {
  aiExploration?: WorkspaceCapability;
  aiExecution?: WorkspaceCapability;
  manualExecution?: WorkspaceCapability;
  credentialLogin?: WorkspaceCapability;
}

export interface WorkspaceProposal {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceRunId: string;
  baseRevision: number;
  contextRevision: number;
  status: 'pending' | 'applied' | 'cancelled' | 'stale' | 'superseded';
  content: WorkspaceConfig;
  scopeHash: string;
  scopeConfirmed: boolean;
  invalidationReason: string | null;
  appliedRevision: number | null;
  createdAt: string;
}

export interface WorkspaceDetail extends Workspace, WorkspaceSettingsSnapshot {
  lifecycle: 'draft' | 'needs_confirmation' | 'active';
  revision: number;
  authorizationRevision: number;
  scopeStatus: 'unconfirmed' | 'confirmed' | 'revoking';
  settings: WorkspaceConfig | null;
  conversationId: string;
  activeRunId: string | null;
  currentProposal: WorkspaceProposal | null;
  roles: WorkspaceRoleRef[];
  secretsAvailable: boolean;
  executionAvailable: boolean;
  unavailableReason: string | null;
  capabilities?: WorkspaceCapabilities;
}

export interface WorkspaceConversationData {
  id: string;
  workspaceId: string;
  ownerType: 'workspace';
  contextRevision: number;
  conversationSummary: string | null;
  messages: Message[];
  activeRunId: string | null;
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
  slug?: string;
  kind?: 'test' | 'module' | 'usecase';
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

export interface ModuleMetadata {
  slug: string;
  moduleKind: 'setup' | 'step' | 'page';
  exportName: string;
  signature: string;
  inputs: string;
  returns: string;
  preconditions: string;
  postconditions: string;
  harness: string;
}

export interface CatalogItem {
  testId: string;
  versionId: string;
  name: string;
  description: string;
  module: ModuleMetadata;
  validationRunId: string | null;
  validationStatus?: RunStatus;
  referencedBy: { testId: string; versionId: string }[];
}

export interface AuthorPartial {
  reason: 'budget_exhausted';
  nextStep: string;
  checkpoint?: { scriptHash: string; selfTestPassed: true };
  appliedRevision?: number;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StageArgument = { kind: 'literal'; value: JsonValue } | { kind: 'binding'; stageId: string; path: string[] };
export interface PlanStageInput {
  id: string;
  title: string;
  action: 'reuse' | 'modify' | 'create';
  moduleTestId?: string;
  moduleVersionId?: string;
  module?: { slug: string; moduleKind: 'setup' | 'step' | 'page'; description: string };
  args: Record<string, StageArgument>;
  bind?: string;
}
export interface PlanStage extends PlanStageInput {
  status: 'pending' | 'authoring' | 'validating' | 'ready' | 'failed';
  draftRevision?: number;
  candidateVersionId?: string;
  authorRunId?: string;
  validationRunId?: string;
  error?: string;
}
export interface Plan {
  id: string;
  testId: string;
  editingSessionId: string;
  revision: number;
  baseRevision: number;
  contextRevision: number;
  status: 'draft' | 'confirmed' | 'running' | 'composed' | 'done' | 'stopped';
  stages: PlanStage[];
  validationRunId?: string;
  error?: string;
}
export interface StageRetry {
  eligible: boolean;
  reason: null | 'plan_not_stopped' | 'stage_not_retryable' | 'cancelled' | 'source_unavailable' | 'session_closed' | 'reclaim_pending' | 'snapshot_mismatch' | 'prior_stage_invalid' | 'scope_unavailable';
  planRevision: number;
  source: null | { moduleTestId: string; editingSessionId: string; moduleRevision: number; moduleContextRevision: number; authorRunId: string; authorStatus: RunStatus; validationRunId: string | null; validationStatus: RunStatus | null; reclaimed: boolean };
}
export interface StageRetryInput { planRevision: number; moduleRevision: number; moduleContextRevision: number; confirmed: true; content: string }
export interface PlanSummary {
  runId: string;
  planId: string;
  planRevision: number;
  batchHash: string;
  status: RunStatus;
  stale: boolean;
  publishReady: boolean;
  message: string | null;
  description: string | null;
  backgroundSummary: string | null;
  name: string | null;
  candidates: { testId: string; versionId: string; name: string; slug: string; moduleKind: 'setup' | 'step' | 'page'; revision: number; bundleHash: string }[];
}

export interface Run {
  id: string;
  testId: string | null;
  workspaceId?: string;
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
  authorMode?: 'edit' | 'summary' | 'workspace';
  scriptOrigin?: ScriptOrigin;
  progressEvents?: string[];
  authorPartial?: AuthorPartial;
}

export interface Draft {
  module?: ModuleMetadata;
  testId: string;
  revision: number;
  script: string;
  updatedAt: string;
  validationRunId?: string;
  validationStatus?: RunStatus;
  reportUrl?: string;
  workspaceSettings?: WorkspaceSettingsSnapshot;
  editingSessionId?: string;
  scriptOrigin?: ScriptOrigin;
}

export interface Version {
  id: string;
  testId: string;
  revision: number;
  script: string;
  createdAt: string;
  validationRunId: string | null;
  workspaceSettings?: WorkspaceSettingsSnapshot;
  description: string | null;
  backgroundSummary: string | null;
  summaryRunId: string | null;
  editingSessionId: string | null;
  scriptOrigin?: ScriptOrigin;
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
  getPlan?: (testId: string, editingSessionId: string, signal?: AbortSignal) => Promise<Plan | null>;
  savePlan?: (testId: string, input: { editingSessionId: string; revision: number; planRevision: number; stages: PlanStageInput[] }, signal?: AbortSignal) => Promise<Plan>;
  getStageRetry?: (planId: string, stageId: string, signal?: AbortSignal) => Promise<StageRetry>;
  retryStage?: (planId: string, stageId: string, input: StageRetryInput, signal?: AbortSignal) => Promise<Plan>;
  confirmPlan?: (planId: string, planRevision: number, signal?: AbortSignal) => Promise<Plan>;
  cancelPlan?: (planId: string, planRevision: number, signal?: AbortSignal) => Promise<Plan>;
  getPlanSummary?: (planId: string, signal?: AbortSignal) => Promise<PlanSummary | null>;
  requestPlanSummary?: (planId: string, planRevision: number, validationRunId: string, signal?: AbortSignal) => Promise<Run>;
  publishPlan?: (planId: string, planRevision: number, summaryRunId: string, signal?: AbortSignal) => Promise<{ usecaseVersion: Version; moduleVersions: Version[] }>;

  // Optional: older/mock adapters must report unavailable, never fabricate results.
  listCatalog?: (workspaceId: string, signal?: AbortSignal) => Promise<CatalogItem[]>;
  continueAuthor?: (runId: string, editingSessionId: string, revision: number, signal?: AbortSignal) => Promise<{ run: Run; conversationId: string }>;
  login(signal?: AbortSignal): Promise<DevUser>;
  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceDetail[]>;
  listTests(workspaceId: string, signal?: AbortSignal): Promise<Test[]>;
  getTest(testId: string, signal?: AbortSignal): Promise<Test>;
  createRun(testId: string, signal?: AbortSignal): Promise<Run>;
  listRuns(testId: string, signal?: AbortSignal): Promise<Run[]>;
  getRun(runId: string, signal?: AbortSignal): Promise<Run>;
  createTest(workspaceId: string, input: { name?: string; description?: string; kind?: 'test' | 'module' | 'usecase'; slug?: string }, signal?: AbortSignal): Promise<Test>;
  getDraft(testId: string, editingSessionId: string, signal?: AbortSignal): Promise<Draft>;
  saveDraft(testId: string, editingSessionId: string, revision: number, script: string, signal?: AbortSignal, module?: ModuleMetadata): Promise<Draft>;
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
  getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceDetail>;
  createWorkspace(name: string | undefined, signal?: AbortSignal): Promise<WorkspaceDetail>;
  getWorkspaceConversation(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceConversationData>;
  sendWorkspaceMessage(workspaceId: string, input: { content: string; revision: number; contextRevision: number }, signal?: AbortSignal): Promise<{ run: Run; conversationId: string }>;
  getWorkspaceProposal(workspaceId: string, proposalId: string, signal?: AbortSignal): Promise<WorkspaceProposal>;
  confirmWorkspaceScope(workspaceId: string, proposalId: string, baseRevision: number, signal?: AbortSignal): Promise<WorkspaceProposal>;
  confirmWorkspaceProposal(workspaceId: string, proposalId: string, baseRevision: number, signal?: AbortSignal): Promise<{ workspace: WorkspaceDetail; proposal: WorkspaceProposal }>;
  cancelWorkspaceProposal(workspaceId: string, proposalId: string, baseRevision: number, signal?: AbortSignal): Promise<WorkspaceProposal>;
  saveWorkspaceCredentials(workspaceId: string, roleId: string, input: { expectedSecretVersion: number; username: string; password: string }, signal?: AbortSignal): Promise<WorkspaceRoleRef>;
  revokeWorkspaceCredentials(workspaceId: string, roleId: string, expectedSecretVersion: number, signal?: AbortSignal): Promise<{ roleId: string; secretRef: string | null; configured: boolean }>;
}
