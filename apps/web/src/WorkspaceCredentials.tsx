import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, isProtectedCredentialTransport } from './api';
import { Notice } from './components';
import { CapabilityStatus } from './WorkspaceSettings';
import type { WhippetApi, WorkspaceAccountCredentials, WorkspaceDetail } from './types';

export function WorkspaceCredentials({ api, apiBase, workspace, contextRevision, blocked, onGuardChange, onRefresh }: {
  api: WhippetApi; apiBase: string; workspace: WorkspaceDetail; contextRevision?: number; blocked: boolean;
  onGuardChange: (state: { dirty: boolean; busy: boolean }) => void; onRefresh: (proposalId?: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const guard = useRef({ dirty: false, busy: false });
  const reportGuard = useCallback((state: { dirty: boolean; busy: boolean }) => { guard.current = state; onGuardChange(state); }, [onGuardChange]);
  const proposal = workspace.currentProposal;
  const draft = proposal && (proposal.accountCredentials !== undefined || proposal.content.testAccounts.length > 0) ? proposal : null;
  const editable = !draft || (draft.status === 'pending' && draft.baseRevision === workspace.revision && draft.contextRevision === contextRevision);
  const definitions = [...(workspace.settings?.loginRoles ?? []), ...(workspace.currentProposal?.content.loginRoles ?? [])];
  const accounts = draft ? draft.content.testAccounts.map((account) => ({
    id: account.accountId, label: `${account.name} · ${account.role}`, purpose: account.purpose,
    status: draft.accountCredentials?.find((item) => item.accountId === account.accountId),
  })) : workspace.roles.map((role) => ({
    id: role.roleId, label: definitions.find((definition) => definition.roleId === role.roleId)?.name ?? role.roleId,
    purpose: '', status: role,
  }));
  const account = accounts.find((item) => item.id === selected) ?? accounts[0];
  const protectedTransport = isProtectedCredentialTransport(apiBase, window.location.href);
  const blockedWrite = blocked || !editable || !workspace.permissions.manageSettings || workspace.management.state !== 'active';
  return <section className="workspace-credentials" aria-labelledby="workspace-credentials-title">
    <h3 id="workspace-credentials-title">專用登入資料</h3>
    {!draft ? <CapabilityStatus label="角色登入" capability={workspace.capabilities?.credentialLogin} /> : null}
    <p className="inline-hint">{draft ? '帳密保存在此提案，套用時才會成為正式設定。' : '此處維護既有角色的登入資料。'} 請在此輸入帳密，對話只提供用途等非機密資訊。</p>
    {!protectedTransport ? <Notice message="目前連線未受保護，不能輸入或保存登入資料。請使用 HTTPS 或明確的 loopback 本機連線。" /> : null}
    {!workspace.secretsAvailable ? <p className="blocked-hint">機密保存服務尚未就緒。</p> : null}
    {!editable ? <p className="blocked-hint">請在目前待確認的提案設定帳密。</p> : null}
    {account ? <>
      <label className="settings-field">{draft ? '測試帳號' : '登入角色'}
        <select className="text-input" value={account.id} disabled={guard.current.busy} onChange={(event) => {
          if (guard.current.dirty && !window.confirm('切換帳號會清除尚未保存的帳密，確定繼續？')) return;
          setSelected(event.target.value);
        }}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.status ? item.status.configured ? '已設定' : '未設定' : '待同步'}</option>)}</select>
      </label>
      {account.purpose ? <p className="summary-content">{account.purpose}</p> : null}
      <p className="identifier version-id">{draft ? '帳號 ID' : '角色'} {account.id}</p>
      {account.status ? <CredentialForm key={`${draft?.id ?? 'legacy'}:${account.id}`} status={account.status}
        canSave={workspace.secretsAvailable} blocked={blockedWrite || !protectedTransport} draft={Boolean(draft)}
        onSave={(input, signal) => draft
          ? api.saveWorkspaceProposalCredentials(workspace.id, draft.id, account.id, { ...input, baseRevision: draft.baseRevision }, signal)
          : api.saveWorkspaceCredentials(workspace.id, account.id, input, signal)}
        onRevoke={(expectedSecretVersion, signal) => draft
          ? api.revokeWorkspaceProposalCredentials(workspace.id, draft.id, account.id, { baseRevision: draft.baseRevision, expectedSecretVersion }, signal)
          : api.revokeWorkspaceCredentials(workspace.id, account.id, expectedSecretVersion, signal)}
        onGuardChange={reportGuard} onRefresh={() => onRefresh(draft?.id)}
      /> : <p className="blocked-hint">請重新載入設定對話，取得此帳號的憑證狀態。</p>}
    </> : <p className="mode-empty">請先在訪談中補充測試帳號的名稱、角色、用途與適用站台，再到此保存帳密。</p>}
  </section>;
}

function CredentialForm({ status, canSave, blocked, draft, onSave, onRevoke, onGuardChange, onRefresh }: {
  status: Pick<WorkspaceAccountCredentials, 'configured' | 'secretVersion'>; canSave: boolean; blocked: boolean; draft: boolean;
  onSave: (input: { expectedSecretVersion: number; username: string; password: string }, signal: AbortSignal) => Promise<unknown>;
  onRevoke: (version: number, signal: AbortSignal) => Promise<unknown>;
  onGuardChange: (state: { dirty: boolean; busy: boolean }) => void; onRefresh: () => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'save' | 'revoke'>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [syncRequired, setSyncRequired] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const dirty = Boolean(username || password);
  useEffect(() => { onGuardChange({ dirty, busy: Boolean(busy) }); return () => onGuardChange({ dirty: false, busy: false }); }, [dirty, busy, onGuardChange]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setSyncRequired(false); }, [status]);
  async function act(kind: 'save' | 'revoke', event?: FormEvent) {
    event?.preventDefault();
    if (lock.current || blocked || syncRequired || (kind === 'save' && (!canSave || !username || !password)) || (kind === 'revoke' && !status.configured)) return;
    if (kind === 'revoke' && !window.confirm(draft ? '移除此帳號在本提案的登入資料？此帳號在提案中的登入驗證將失效。' : '撤銷此角色的登入資料？使用該資料的任務將停止與回收。')) return;
    lock.current = true; setBusy(kind); setError(undefined); setMessage(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const version = status.secretVersion ?? 0;
      if (kind === 'save') await onSave({ expectedSecretVersion: version, username, password }, request.signal);
      else await onRevoke(version, request.signal);
      if (request.signal.aborted) return;
      setUsername(''); setPassword(''); setSyncRequired(true);
      setMessage(kind === 'save' ? draft ? '已保存。請在設定提案為各適用站台執行登入驗證。' : '已保存登入資料。' : '已移除登入資料。');
      try { await onRefresh(); } catch { setError('操作已回應，但帳號狀態同步失敗。請重新載入設定對話。'); }
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.code === 'INVALID_CREDENTIAL_LENGTH') {
        setError(cause.message);
      } else if (cause instanceof ApiError && (cause.code === 'PROTECTED_TRANSPORT_REQUIRED' || cause.code === 'INSECURE_TRANSPORT')) {
        setError('Server 拒絕連線。請改用部署者提供的受保護入口。');
      } else {
        setSyncRequired(true);
        setError(cause instanceof ApiError && cause.status === 409 ? '登入資料或提案版本已變更。請重新載入確認，輸入已保留。'
          : cause instanceof ApiError && cause.status === 403 ? '你沒有管理此登入資料的權限。'
          : '登入資料的操作結果待確認。請重新載入設定對話，輸入已保留。');
      }
    } finally { lock.current = false; if (!request.signal.aborted) setBusy(undefined); }
  }
  return <form onSubmit={(event) => { void act('save', event); }} autoComplete="off">
    <p className="settings-meta">{status.configured ? '已設定加密登入資料' : '尚未設定登入資料'} · 版本 {status.secretVersion ?? '尚無'}</p>
    <fieldset className="settings-fieldset" disabled={!canSave || blocked || Boolean(busy) || syncRequired}><legend>專用帳密欄位</legend>
      <label className="settings-field">登入帳號<input name="username" className="text-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /></label>
      <label className="settings-field">登入密碼<input name="password" className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></label>
      <button className="button secondary" type="submit" disabled={!username || !password}>{busy === 'save' ? '保存中…' : '保存登入資料'}</button>
    </fieldset>
    <button className="button quiet" type="button" disabled={blocked || Boolean(busy) || syncRequired || !status.configured} onClick={() => { void act('revoke'); }}>{busy === 'revoke' ? '移除中…' : draft ? '移除提案登入資料' : '撤銷登入資料'}</button>
    {error ? <Notice message={error} /> : null}{message ? <p className="action-message" role="status">{message}</p> : null}
  </form>;
}
