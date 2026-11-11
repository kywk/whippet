import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, isProtectedCredentialTransport } from './api';
import { Notice } from './components';
import { CapabilityStatus } from './WorkspaceSettings';
import type { WhippetApi, WorkspaceDetail, WorkspaceRoleRef } from './types';

export function WorkspaceCredentials({ api, apiBase, workspace, blocked, onGuardChange, onRefresh }: {
  api: WhippetApi; apiBase: string; workspace: WorkspaceDetail; blocked: boolean;
  onGuardChange: (state: { dirty: boolean; busy: boolean }) => void; onRefresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const guard = useRef({ dirty: false, busy: false });
  const reportGuard = useCallback((state: { dirty: boolean; busy: boolean }) => { guard.current = state; onGuardChange(state); }, [onGuardChange]);
  const role = workspace.roles.find((item) => item.roleId === selected) ?? workspace.roles[0];
  const definitions = [...(workspace.settings?.loginRoles ?? []), ...(workspace.currentProposal?.content.loginRoles ?? [])];
  const protectedTransport = isProtectedCredentialTransport(apiBase, window.location.href);
  return <section className="workspace-credentials" aria-labelledby="workspace-credentials-title">
    <h3 id="workspace-credentials-title">專用登入資料</h3>
    <CapabilityStatus label="角色登入" capability={workspace.capabilities?.credentialLogin} />
    <p className="inline-hint">帳密只由此處經專用 API 保存；不加入一般對話、提案或瀏覽器持久儲存。只顯示角色參照及是否已設定，不能讀回明文。</p>
    {!protectedTransport ? <Notice message="目前連線未受保護，不能輸入或保存登入資料。請使用 HTTPS 或明確的 loopback 本機連線。" /> : null}
    {!workspace.secretsAvailable ? <p className="blocked-hint">機密保存服務尚未就緒。已有「已設定」參照也不代表目前可解密或登入。</p> : null}
    {workspace.roles.length ? <>
      <label className="settings-field">登入角色<select className="text-input" value={role?.roleId ?? ''} disabled={guard.current.busy} onChange={(event) => { if (guard.current.dirty && !window.confirm('切換角色會清除尚未保存的帳密，確定繼續？')) return; setSelected(event.target.value); }}>{workspace.roles.map((item) => <option key={item.roleId} value={item.roleId}>{definitions.find((definition) => definition.roleId === item.roleId)?.name ?? `角色 ${item.roleId}`} · {item.configured ? '已設定' : '未設定'}</option>)}</select></label>
      {role ? <CredentialForm key={role.roleId} api={api} workspaceId={workspace.id} role={role} canSave={workspace.secretsAvailable && protectedTransport} blocked={blocked} onGuardChange={reportGuard} onRefresh={onRefresh} /> : null}
    </> : <p className="mode-empty">目前沒有 Server 分配的角色參照。請先在設定對話中提出登入角色，取得提案後再保存帳密。</p>}
    <p className="inline-hint">保存與登入能力分開；即使角色登入尚未就緒，符合保護傳輸及機密保存條件時仍可保存。實際登入還須逐角色檢查，不代表已登入或可填入任意網站。</p>
  </section>;
}

function CredentialForm({ api, workspaceId, role, canSave, blocked, onGuardChange, onRefresh }: {
  api: WhippetApi; workspaceId: string; role: WorkspaceRoleRef; canSave: boolean; blocked: boolean;
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
  useEffect(() => { setSyncRequired(false); }, [role]);
  async function act(kind: 'save' | 'revoke', event?: FormEvent) {
    event?.preventDefault();
    if (lock.current || blocked || syncRequired || (kind === 'save' && (!canSave || !username || !password)) || (kind === 'revoke' && !role.configured)) return;
    if (kind === 'revoke' && !window.confirm('撤銷此角色的登入資料？舊參照不能再取得新機密授權，受影響任務需停止與回收。')) return;
    lock.current = true; setBusy(kind); setError(undefined); setMessage(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      if (kind === 'save') await api.saveWorkspaceCredentials(workspaceId, role.roleId, { expectedSecretVersion: role.secretVersion ?? 0, username, password }, request.signal);
      else await api.revokeWorkspaceCredentials(workspaceId, role.roleId, role.secretVersion ?? 0, request.signal);
      if (request.signal.aborted) return;
      setUsername(''); setPassword(''); setSyncRequired(true);
      setMessage(kind === 'save' ? 'Server 已保存登入資料，表單已清空；這不代表已登入或可執行測試。' : 'Server 已撤銷登入資料；執行中的回收進度仍以現行許可狀態為準。');
      try { await onRefresh(); } catch { setError('操作已回應，但角色狀態同步失敗。請先重新載入設定對話，勿直接重送。'); }
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) setSyncRequired(true);
      setError(cause instanceof ApiError && (cause.code === 'PROTECTED_TRANSPORT_REQUIRED' || cause.code === 'INSECURE_TRANSPORT') ? 'Server 尚未確認受保護的傳輸，操作已被拒絕。瀏覽器 localhost 經代理不保證符合條件，請改用部署者提供的受保護入口。' : cause instanceof ApiError && cause.status === 409 ? '登入資料版本已變更（409），請重新載入角色狀態後再試；輸入仍留在本表單。' : '登入資料操作未確認成功。請先重新載入角色狀態確認結果，再決定是否重送；輸入仍留在本表單。');
    } finally { lock.current = false; if (!request.signal.aborted) setBusy(undefined); }
  }
  return <form onSubmit={(event) => { void act('save', event); }} autoComplete="off">
    <p className="settings-meta">{role.configured ? '已設定加密登入資料' : '尚未設定登入資料'} · 版本 {role.secretVersion ?? '尚無'}</p>
    <p className="identifier version-id">角色 {role.roleId}</p>{role.secretRef ? <p className="identifier version-id">參照 {role.secretRef}</p> : null}
    <fieldset className="settings-fieldset" disabled={!canSave || blocked || Boolean(busy) || syncRequired}><legend>專用帳密欄位</legend>
      <label className="settings-field">登入帳號<input className="text-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
      <label className="settings-field">登入密碼<input className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
      <button className="button secondary" type="submit" disabled={!username || !password}>{busy === 'save' ? '保存中…' : '保存登入資料'}</button>
    </fieldset>
    <button className="button quiet" type="button" disabled={blocked || Boolean(busy) || syncRequired || !role.configured} onClick={() => { void act('revoke'); }}>{busy === 'revoke' ? '撤銷中…' : '撤銷登入資料'}</button>
    {syncRequired ? <p className="blocked-hint">需重新載入角色狀態後才可進行下一次操作。</p> : null}
    {error ? <Notice message={error} /> : null}{message ? <p className="action-message" role="status">{message}</p> : null}
  </form>;
}
