import type { AgentRuntimeEngine, AgentRuntimeSkill, RunStatus } from './types';

export type AiMode = 'managed' | 'self_managed';
export type AiProvider = 'opencode' | 'openai-responses';
export type AiAgentStatus = 'waiting_connection' | 'verifying' | 'ready' | 'failed' | 'disabled';
export type AiReason = 'manager_unavailable' | 'no_capacity' | 'engine_mismatch' | 'worker_changed'
  | 'heartbeat_timeout' | 'provider_auth_failed' | 'provider_unavailable' | 'probe_failed' | 'probe_timed_out'
  | 'cleanup_pending' | 'key_missing' | 'verification_required' | 'token_revoked' | 'workspace_archiving' | 'workspace_archived';

export interface AiAgent {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  mode: AiMode;
  engine: AgentRuntimeEngine;
  provider: AiProvider;
  model: string;
  profileId: string | null;
  skills: AgentRuntimeSkill[];
  status: AiAgentStatus;
  reason: AiReason | null;
  modelKey: { configured: boolean; version: number | null } | null;
  tokenId: string | null;
  probeId: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AiAgentDraft = { workspaceId: string; name: string; provider: AiProvider; model: string } & (
  { mode: 'managed'; engine: AgentRuntimeEngine; profileId: string }
  | { mode: 'self_managed'; engine: 'vercel' | 'pi' }
);
export type NewAiAgent = { requestId: string } & (
  Extract<AiAgentDraft, { mode: 'managed' }> & { apiKey: string }
  | Extract<AiAgentDraft, { mode: 'self_managed' }>
);

export interface AiOptions {
  managed: { profileId: string; engine: AgentRuntimeEngine; provider: AiProvider; model: string; managerIds: string[]; reason: AiReason | null }[];
  selfManaged: { engine: 'vercel' | 'pi'; providers: AiProvider[]; skills: AgentRuntimeSkill[] }[];
}

export type AiResourceAction = 'assign' | 'pause_dispatch' | 'resume_dispatch' | 'drain_remove'
  | 'pause_claim' | 'resume_claim' | 'cancel_run' | 'close_browser' | 'revoke_access' | 'reissue_access';
export type AiRevisionAction = Exclude<AiResourceAction, 'assign' | 'cancel_run' | 'close_browser' | 'reissue_access'>;
export type AiResourceChange = { action: AiRevisionAction; revision: number }
  | { action: 'assign'; revision: number; workspaceIds: string[] | null }
  | { action: 'cancel_run'; runId: string; attemptId: string; leaseId: string }
  | { action: 'close_browser'; sessionId: string; leaseId: string };

export interface AiResource {
  id: string;
  source: 'manager' | 'mcp';
  name: string;
  agentId: string | null;
  revision: number;
  workspaceIds: string[] | null;
  control: 'enabled' | 'paused' | 'draining' | 'removed' | 'revoked';
  connection: 'waiting_connection' | 'online' | 'offline';
  lastActivityAt: string | null;
  interactiveAt: string | null;
  claimAt: string | null;
  capabilities: { modes: ('managed' | 'mcp_interactive' | 'mcp_claim')[]; engines: AgentRuntimeEngine[] | null; skills: AgentRuntimeSkill[] | null };
  capacity: { total: number | null; occupied: number; available: number | null };
  attempts: { runId: string; attemptId: string; workspaceId: string; agentId: string | null; status: RunStatus; leaseId: string | null }[];
  browserLeases: { sessionId: string; leaseId: string; workspaceId: string; runId: string | null; state: 'opening' | 'ready' | 'closing' | 'reclaim_pending'; deadlineAt: string }[];
  allowedActions: AiResourceAction[];
}

export interface AiRouting {
  workspaceId: string;
  revision: number;
  agents: Partial<Record<AgentRuntimeSkill, string>>;
}

export interface AiPage<T> { items: T[]; nextAfter: string | null }
export interface AiAccessReceipt { resource: AiResource; agent: AiAgent | null; token?: string }

export interface AiAdminApi {
  listResources(after: string | null, signal?: AbortSignal): Promise<AiPage<AiResource>>;
  getResource(id: string, signal?: AbortSignal): Promise<AiResource>;
  changeResource(id: string, change: AiResourceChange, signal?: AbortSignal): Promise<AiResource>;
  reissueAccess(id: string, input: { revision: number; workspaceId: string; requestId: string }, signal?: AbortSignal): Promise<AiAccessReceipt>;
  listAgents(workspaceId: string | null, after: string | null, signal?: AbortSignal): Promise<AiPage<AiAgent>>;
  getAgent(id: string, signal?: AbortSignal): Promise<AiAgent>;
  getOptions(workspaceId: string, signal?: AbortSignal): Promise<AiOptions>;
  createAgent(input: NewAiAgent, signal?: AbortSignal): Promise<{ agent: AiAgent; token?: string }>;
  retryAgent(id: string, revision: number, signal?: AbortSignal): Promise<AiAgent>;
  rotateKey(id: string, expectedSecretVersion: number, apiKey: string, signal?: AbortSignal): Promise<AiAgent>;
  revokeKey(id: string, expectedSecretVersion: number, signal?: AbortSignal): Promise<AiAgent>;
  getRouting(workspaceId: string, signal?: AbortSignal): Promise<AiRouting>;
  changeRouting(workspaceId: string, input: { revision: number; skillId: AgentRuntimeSkill; agentId: string | null }, signal?: AbortSignal): Promise<AiRouting>;
}
