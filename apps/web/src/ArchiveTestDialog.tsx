import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Notice } from './components';
import type { Test, WhippetApi } from './types';

export function ArchiveTestDialog({ api, test, activeEditing, onCancel, onArchived }: {
  api: WhippetApi; test: Test; activeEditing: boolean; onCancel: () => void; onArchived: (test: Test) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { request.current?.abort(); dialog?.close(); };
  }, []);

  async function archive() {
    if (activeEditing || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await api.archiveTest(test.id, controller.signal);
      if (!controller.signal.aborted) onArchived(test);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <dialog ref={dialogRef} className="script-edit-dialog" aria-labelledby="archive-dialog-title" aria-describedby="archive-dialog-description"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="archive-dialog-title">封存「{test.name}」？</h2>
    <p id="archive-dialog-description">{activeEditing ? '請完成發佈或放棄草稿後，再封存這個測試。' : '封存後可從「已封存測試」查看版本與報告。已排入的執行會繼續。'}</p>
    {error ? <Notice message={error} /> : null}
    <div className="action-row">
      <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
      {!activeEditing ? <button type="button" className="button danger-button" disabled={busy} onClick={() => { void archive(); }}>{busy ? '封存中…' : '確認封存'}</button> : null}
    </div>
  </dialog>;
}
