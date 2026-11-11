import type { ScriptOrigin, WorkspaceCapabilities, WorkspaceCapability } from './types';

export function scriptOriginLabel(origin: ScriptOrigin | undefined): string {
  if (origin === 'manual') return '工程師手動修改';
  if (origin === 'ai') return 'AI 修改';
  if (origin === 'legacy') return '來源未記錄（不視為人工）';
  return '來源未知（API 尚未提供）';
}

export function executionCapabilityForScript(capabilities: WorkspaceCapabilities | undefined, origin: ScriptOrigin | undefined): WorkspaceCapability | undefined {
  if (origin === 'manual') return capabilities?.manualExecution;
  if (origin === 'ai' || origin === 'legacy') return capabilities?.aiExecution;
  return undefined;
}

export function capabilityReason(capability: WorkspaceCapability | undefined): string {
  if (!capability) return 'API 尚未提供能力狀態';
  if (capability.available) return '仍由 Server 逐次核對任務快照與許可';
  const reasons: Record<string, string> = {
    security_unavailable: '相關執行或工具能力尚未就緒',
    scope_confirmation_required: '需先確認 Workspace 網站範圍',
    protected_transport_required: '需受保護的傳輸入口',
    secrets_unavailable: '機密服務尚未就緒',
    credentials_required: '需設定可用的角色登入資料',
  };
  return capability.reason ? reasons[capability.reason] ?? capability.reason : 'Server 尚未提供原因';
}
