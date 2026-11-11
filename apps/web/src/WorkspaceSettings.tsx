import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage } from './api';
import { Loading, Notice } from './components';
import { useResource } from './hooks';
import type { WhippetApi, Workspace, WorkspaceSettingsResponse, WorkspaceSite } from './types';

interface Props {
  api: WhippetApi;
  workspace: Workspace;
  onClose: () => void;
  onSaved: (settings: WorkspaceSettingsResponse) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function WorkspaceSettings(props: Props) {
  const load = useCallback((signal: AbortSignal) => props.api.getWorkspaceSettings(props.workspace.id, signal), [props.api, props.workspace.id]);
  const settings = useResource(load);
  return <section id="workspace-settings" className="workspace-settings" aria-labelledby="workspace-settings-title">
    {settings.data ? <SettingsForm {...props} initial={settings.data} /> : <>
      <div className="section-heading"><h2 id="workspace-settings-title">Workspace 設定</h2><button className="button quiet" onClick={props.onClose}>關閉設定</button></div>
      {settings.loading ? <Loading text="正在載入 Workspace 設定…" /> : null}
      {settings.error ? <Notice message={settings.error} retry={settings.retry} /> : null}
    </>}
  </section>;
}

function urlError(value: string, label: string, optional = false): string | undefined {
  if (!value && optional) return undefined;
  if (!value || value.length > 2_048) return `${label}須填寫完整 HTTP(S) URL，最多 2,048 字元。`;
  if (!/^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i.test(value)) return `${label}須填寫完整 HTTP(S) URL。`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return `${label}只接受完整 HTTP(S) URL。`;
    if (url.username || url.password) return `${label}不得包含帳號或密碼。`;
  } catch { return `${label}須填寫完整 HTTP(S) URL。`; }
  return undefined;
}

function SettingsForm({ api, workspace, initial, onClose, onSaved, onDirtyChange }: Props & { initial: WorkspaceSettingsResponse }) {
  const [saved, setSaved] = useState(initial);
  const [sites, setSites] = useState<WorkspaceSite[]>(() => initial.sites.map((site) => ({ ...site })));
  const [defaultTestUrl, setDefaultTestUrl] = useState(initial.defaultTestUrl);
  const [timeout, setTimeoutValue] = useState(String(initial.timeoutMs));
  const [busy, setBusy] = useState<'save' | 'reload'>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [discardWarning, setDiscardWarning] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const dirty = JSON.stringify(sites) !== JSON.stringify(saved.sites) || defaultTestUrl !== saved.defaultTestUrl || timeout !== String(saved.timeoutMs);
  const guarded = dirty || Boolean(busy);

  useEffect(() => {
    onDirtyChange(guarded);
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    if (guarded) window.addEventListener('beforeunload', beforeUnload);
    return () => { onDirtyChange(false); window.removeEventListener('beforeunload', beforeUnload); };
  }, [guarded, onDirtyChange]);
  useEffect(() => () => controller.current?.abort(), []);

  function accept(next: WorkspaceSettingsResponse) {
    setSaved(next); setSites(next.sites.map((site) => ({ ...site }))); setDefaultTestUrl(next.defaultTestUrl);
    setTimeoutValue(String(next.timeoutMs)); setConflict(false); setDiscardWarning(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || conflict || !dirty) return;
    const normalizedSites = sites.map((site) => ({ name: site.name.trim(), url: site.url.trim() }));
    const normalizedDefault = defaultTestUrl.trim();
    const milliseconds = Number(timeout);
    let problem: string | undefined;
    if (normalizedSites.length > 20) problem = '最多可設定 20 個網站。';
    for (let index = 0; index < normalizedSites.length && !problem; index++) {
      const site = normalizedSites[index];
      if (!site.name || Array.from(site.name).length > 100) problem = `網站 ${index + 1} 的名稱必填，最多 100 字元。`;
      else problem = urlError(site.url, `網站 ${index + 1} URL`);
    }
    problem ??= urlError(normalizedDefault, '預設測試 URL', true);
    if (!problem && (!timeout.trim() || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3_600_000)) problem = '執行逾時須為 1 到 3,600,000 之間的整數毫秒。';
    if (problem) { setError(problem); return; }
    lock.current = true; setBusy('save'); setError(undefined); setMessage(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const next = await api.updateWorkspaceSettings(workspace.id, { revision: saved.revision, sites: normalizedSites, defaultTestUrl: normalizedDefault, timeoutMs: milliseconds }, request.signal);
      if (request.signal.aborted) return;
      const changed = next.revision !== saved.revision;
      accept(next); onSaved(next);
      setMessage(changed ? `已儲存 Workspace 設定 revision ${next.revision}。現有草稿需重新驗證，已發佈版本維持原設定。` : `設定內容未變更，Workspace revision 仍為 ${next.revision}。`);
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      setError(`${errorMessage(cause)} 本機輸入已保留。若請求結果不明，請先重新載入設定確認結果，再決定是否重送。`);
    } finally { if (!request.signal.aborted) setBusy(undefined); lock.current = false; }
  }

  async function reload(discard = false) {
    if (lock.current) return;
    if (dirty && !discard) { setDiscardWarning(true); return; }
    lock.current = true; setBusy('reload'); setError(undefined); setMessage(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const next = await api.getWorkspaceSettings(workspace.id, request.signal);
      if (request.signal.aborted) return;
      const changed = next.revision !== saved.revision;
      accept(next); if (changed) onSaved(next);
      setMessage(`已載入 Workspace 設定 revision ${next.revision}。`);
    } catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted) setBusy(undefined); lock.current = false; }
  }

  function close() {
    if (busy) return;
    if (!dirty || window.confirm('關閉設定會放棄尚未儲存的 Workspace 設定，確定繼續？')) onClose();
  }
  function updateSite(index: number, field: keyof WorkspaceSite, value: string) {
    setSites((current) => current.map((site, position) => position === index ? { ...site, [field]: value } : site)); setMessage(undefined);
  }

  return <form onSubmit={save} noValidate>
    <div className="section-heading"><h2 id="workspace-settings-title">Workspace 設定</h2><button className="button quiet" type="button" disabled={Boolean(busy)} onClick={close}>關閉設定</button></div>
    <p className="settings-meta">{saved.name} · revision {saved.revision}{dirty ? ' · 有未儲存變更' : ''}</p>
    <p id="settings-impact" className="settings-impact">變更設定後，現有草稿需重新驗證；已發佈版本維持原設定。既有執行（含排隊中）也保留建立時的設定。</p>
    <fieldset className="settings-fieldset" disabled={Boolean(busy)}><legend>網站清單 <span className="count">{sites.length} / 20</span></legend>
      {sites.length === 0 ? <p className="muted">尚未設定網站，可按「新增網站」加入名稱與 URL。</p> : null}
      {sites.map((site, index) => <div className="settings-site" key={index}>
        <label className="settings-field">網站名稱 {index + 1}<input className="text-input" value={site.name} onChange={(event) => updateSite(index, 'name', event.target.value)} autoComplete="off" /></label>
        <label className="settings-field">網站 URL {index + 1}<input className="text-input" type="url" value={site.url} onChange={(event) => updateSite(index, 'url', event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <button className="button quiet compact" type="button" aria-label={`移除網站 ${index + 1}`} onClick={() => { setSites((current) => current.filter((_, position) => position !== index)); setMessage(undefined); }}>移除網站</button>
      </div>)}
      <button className="button secondary compact" type="button" disabled={sites.length >= 20} onClick={() => { setSites((current) => [...current, { name: '', url: '' }]); setMessage(undefined); }}>新增網站</button>
      <p className="inline-hint">網站名稱最多 100 字元；URL 須為完整 HTTP(S)，最多 2,048 字元，且不得包含帳號或密碼。</p>
    </fieldset>
    <fieldset className="settings-fieldset" disabled={Boolean(busy)}><legend>預設執行設定</legend>
      <label className="settings-field">預設測試 URL（選填）<input className="text-input" type="url" value={defaultTestUrl} onChange={(event) => { setDefaultTestUrl(event.target.value); setMessage(undefined); }} autoComplete="off" spellCheck={false} /></label>
      <p className="inline-hint">可留空，或填寫完整 HTTP(S) URL；不必列在網站清單中。</p>
      <label className="settings-field timeout-field">執行逾時（毫秒）<input className="text-input" type="number" min="1" max="3600000" step="1" value={timeout} onChange={(event) => { setTimeoutValue(event.target.value); setMessage(undefined); }} /></label>
      <p className="inline-hint">1 至 3,600,000 毫秒，適用正式執行與草稿驗證。AI 撰寫限時不受此欄位影響。</p>
    </fieldset>
    {conflict ? <Notice message="設定 revision 已過期（409），不會自動覆寫。本機輸入已保留；請重新載入設定，再重新編輯。" /> : null}
    {error ? <Notice message={error} /> : null}
    {discardWarning ? <div className="confirmation-panel"><p>重新載入會放棄尚未儲存的設定，請先保留需要的內容。</p><div className="action-row">
      <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => reload(true)}>放棄編輯並重新載入設定</button>
      <button className="button quiet" type="button" disabled={Boolean(busy)} onClick={() => setDiscardWarning(false)}>保留目前編輯</button>
    </div></div> : null}
    <div className="action-row"><button className="button primary" type="submit" aria-describedby="settings-impact" disabled={Boolean(busy) || !dirty || conflict}>{busy === 'save' ? '儲存中…' : '儲存 Workspace 設定'}</button>
      <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => reload()}>{busy === 'reload' ? '載入中…' : '重新載入設定'}</button></div>
    {message ? <p className="action-message" role="status">{message}</p> : null}
  </form>;
}
