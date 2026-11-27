import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from './api';
import { Notice } from './components';
import type { WhippetApi, WorkspaceDetail, WorkspaceTestAccount, WorkspaceTestAccountUpdate } from './types';
import { loginStateLabels, loginVerificationReasons } from './workspaceLogin';

function AccountDescription({ account, workspace }: { account: WorkspaceTestAccount; workspace: WorkspaceDetail }) {
  return <>
    <p><strong>{account.name}</strong> · {account.role}</p>
    {account.purpose ? <p className="summary-content">{account.purpose}</p> : null}
    <p className="identifier version-id">帳號 ID {account.accountId}</p>
    {account.sites.length ? <ul className="workspace-login-results">{account.sites.map(({ targetOrigin }) => {
      const name = workspace.settings?.targets.find((site) => site.origin === targetOrigin)?.name;
      const verification = workspace.siteReadiness.find((site) => site.targetOrigin === targetOrigin)?.accounts.find((entry) => entry.accountId === account.accountId);
      return <li key={targetOrigin}>
        <p>{name ? `${name} · ` : ''}{targetOrigin}</p>
        <p>{verification ? loginStateLabels[verification.state] : '待驗證'}</p>
        {verification?.reason ? <p className="inline-hint">{loginVerificationReasons[verification.reason]}</p> : null}
      </li>;
    })}</ul> : <p className="muted">尚未指定適用站台。</p>}
  </>;
}

export function WorkspaceAccountDescriptions({ workspace }: { workspace: WorkspaceDetail }) {
  const accounts = workspace.settings?.testAccounts;
  if (!accounts?.length) return null;
  return <section className="workspace-home-panel" aria-labelledby="workspace-account-descriptions-title">
    <header className="workspace-home-panel-head"><h2 id="workspace-account-descriptions-title">測試帳號說明</h2></header>
    <div className="workspace-scope-body">
      <p className="inline-hint">在測試需求中可指定帳號的用途或 ID。需要兩個不同身分時，請選兩組不同帳號。</p>
      <ul className="workspace-snapshot-sites">{accounts.map((account) => <li key={account.accountId} data-account-id={account.accountId}>
        <AccountDescription account={account} workspace={workspace} />
      </li>)}</ul>
    </div>
  </section>;
}

type AccountDraft = WorkspaceTestAccountUpdate & { accountId: string };

export function WorkspaceTestAccountSettings({ api, workspace, blocked, onGuardChange, onUpdated, onRefresh }: {
  api: WhippetApi; workspace: WorkspaceDetail; blocked: boolean;
  onGuardChange: (state: { dirty: boolean; busy: boolean }) => void;
  onUpdated: (workspace: WorkspaceDetail) => void; onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AccountDraft>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const purposeHelpId = useId();
  const accounts = workspace.settings?.testAccounts ?? [];
  const original = accounts.find((account) => account.accountId === draft?.accountId);
  const dirty = Boolean(draft && (draft.name !== original?.name || draft.role !== original?.role || draft.purpose !== original?.purpose));
  const stale = draft && (!original || draft.revision !== workspace.revision);
  const editable = workspace.permissions.manageSettings && workspace.management.state === 'active';
  useEffect(() => { onGuardChange({ dirty, busy }); return () => onGuardChange({ dirty: false, busy: false }); }, [dirty, busy, onGuardChange]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (draft?.accountId) nameField.current?.focus(); }, [draft?.accountId]);

  function stopEditing() {
    if (dirty && !window.confirm('放棄尚未保存的帳號說明？')) return false;
    setDraft(undefined); setError(undefined); setNote(undefined);
    return true;
  }

  function edit(account: WorkspaceTestAccount) {
    if (!stopEditing()) return;
    const { accountId, name, role, purpose } = account;
    setDraft({ accountId, name, role, purpose, revision: workspace.revision });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !dirty || stale || !editable || blocked || controller.current) return;
    const { accountId, revision, name, role, purpose } = draft;
    const input = { revision, name: name.trim(), role: role.trim(), purpose: purpose.trim() };
    const encoder = new TextEncoder();
    if (!input.name || !input.role || encoder.encode(input.name).length > 200 || encoder.encode(input.role).length > 200 || encoder.encode(input.purpose).length > 8192) {
      setError('名稱與角色皆為必填，各限 200 位元組。用途上限為 8192 位元組。');
      return;
    }
    const request = new AbortController(); controller.current = request;
    setBusy(true); setNote(undefined); setError(undefined);
    try {
      const updated = await api.updateWorkspaceTestAccount(workspace.id, accountId, input, request.signal);
      if (request.signal.aborted) return;
      onUpdated(updated);
      setDraft(undefined); setNote('已保存帳號說明。新任務會讀取更新後的說明。');
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(cause instanceof ApiError && cause.status === 409 ? '正式設定版本已變更。請確認目前的帳號說明後重新編輯。'
        : cause instanceof ApiError && cause.status === 403 ? '你沒有維護此帳號的權限。' : '保存結果待確認。請檢視帳號說明後再操作。');
    } finally {
      if (!request.signal.aborted) {
        try { await onRefresh(); } catch { if (!request.signal.aborted) setError('同步帳號說明失敗。請重新載入設定對話。'); }
      }
      controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  if (!accounts.length && !draft) return null;
  return <section className="workspace-snapshot" aria-labelledby="workspace-test-accounts-title">
    <h3 id="workspace-test-accounts-title">測試帳號維護</h3>
    <p className="inline-hint">帳密、登入入口與適用站台請透過新的設定提案更新。</p>
    <ul className="workspace-snapshot-sites">{accounts.map((account) => <li key={account.accountId} data-account-id={account.accountId}>
      <AccountDescription account={account} workspace={workspace} />
      {editable && draft?.accountId !== account.accountId ? <button type="button" className="button secondary compact"
        disabled={blocked || busy} onClick={() => edit(account)}>編輯 {account.name} 的說明</button> : null}
    </li>)}</ul>
    {draft ? <form onSubmit={(event) => { void save(event); }}>
      <fieldset className="settings-fieldset" disabled={blocked || busy || !editable}>
        <legend>編輯帳號說明</legend>
        <label className="settings-field">名稱<input className="text-input" name="name" value={draft.name} required ref={nameField}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="settings-field">角色<input className="text-input" name="role" value={draft.role} required
          onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
        <label className="settings-field">用途<textarea className="text-input" name="purpose" value={draft.purpose} rows={3} aria-describedby={purposeHelpId}
          onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} /></label>
        <p className="inline-hint" id={purposeHelpId}>填寫供測試任務選用的非機密資訊。</p>
      </fieldset>
      {stale ? <p className="blocked-hint">已載入新版正式設定。請核對說明後重新編輯。</p> : null}
      <div className="action-row">
        <button type="submit" className="button primary" disabled={blocked || busy || Boolean(stale) || !editable || !dirty}>{busy ? '保存中…' : '保存帳號說明'}</button>
        <button type="button" className="button quiet" disabled={busy} onClick={stopEditing}>取消編輯</button>
      </div>
    </form> : null}
    {error ? <Notice message={error} /> : null}
    {note ? <p className="action-message" role="status">{note}</p> : null}
  </section>;
}
