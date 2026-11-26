import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Notice } from './components';

export function WorkspaceNameForm({ action, initialName = '', disabled = false, onSave, onCancel, onAccessChanged }: {
  action: 'create' | 'rename';
  initialName?: string;
  disabled?: boolean;
  onSave: (name: string, signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
  onAccessChanged: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; checkList?: boolean }>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const creating = action === 'create';
  const trimmedName = name.trim();
  const canSubmit = !disabled && !error?.checkList && (creating || Boolean(trimmedName && trimmedName !== initialName));

  async function submit() {
    if (!canSubmit || request.current) return;
    if (new TextEncoder().encode(trimmedName).length > 200) {
      setError({ message: 'Workspace 名稱最多 200 UTF-8 bytes，請縮短名稱。' });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try { await onSave(trimmedName, controller.signal); }
    catch (cause) {
      if (controller.signal.aborted) return;
      const uncertainCreate = creating && cause instanceof ApiError && (cause.status === 0 || cause.status >= 500);
      setError({ message: `${errorMessage(cause)}${uncertainCreate ? ' 請先回到 Workspace 清單確認建立結果，再送出新的建立請求。' : ''}`, checkList: uncertainCreate });
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessChanged();
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <form className="site-workspace-name-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="settings-field">
      <label htmlFor={nameId}>Workspace 名稱{creating ? '（選填）' : ''}</label>
      <input id={nameId} className="text-input" value={name} onChange={(event) => { setName(event.target.value); setError(undefined); }}
        disabled={busy || error?.checkList} required={!creating} autoComplete="off" />
    </div>
    {error ? <Notice message={error.message} /> : null}
    <div className="action-row site-workspace-actions">
      <button type="submit" className="button primary" disabled={busy || !canSubmit}>
        {creating ? busy ? '建立中…' : '建立 Workspace' : busy ? '儲存中…' : '儲存名稱'}
      </button>
      <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}
