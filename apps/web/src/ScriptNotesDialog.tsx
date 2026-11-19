import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Notice } from './components';
import type { TestMetadataPatch, Version } from './types';

export function ScriptNotesDialog({ version, metadataRevision, onSave, onClose }: {
  version: Version;
  metadataRevision: number;
  onSave: (patch: TestMetadataPatch, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(version.description ?? '');
  const [backgroundSummary, setBackgroundSummary] = useState(version.backgroundSummary ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const encoder = new TextEncoder();
  const longDescription = encoder.encode(description).length > 16384;
  const longBackground = encoder.encode(backgroundSummary).length > 8192;
  const descriptionChanged = description !== (version.description ?? '');
  const backgroundChanged = backgroundSummary !== (version.backgroundSummary ?? '');
  const changed = descriptionChanged || backgroundChanged;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { request.current?.abort(); element?.close(); };
  }, []);

  function close() {
    dialog.current?.close();
    onClose();
  }

  async function save() {
    if (request.current || !changed || stale || longDescription || longBackground) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError(undefined);
    try {
      const patch: TestMetadataPatch = { metadataRevision };
      if (descriptionChanged) patch.description = description;
      if (backgroundChanged) patch.backgroundSummary = backgroundSummary;
      await onSave(patch, controller.signal);
      if (!controller.signal.aborted) close();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setStale(true);
        setError('測試資訊已更新。請保留你輸入的文字，關閉後重新開啟編輯。');
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return <dialog ref={dialog} className="script-edit-dialog script-notes-dialog" aria-labelledby="script-notes-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
    <h2 id="script-notes-title">編輯說明與背景</h2>
    <form className="script-notes-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error ? <Notice message={error} /> : null}
      <label className="field-label">腳本說明（Markdown）
        <textarea className="text-input" value={description} rows={8} disabled={saving} aria-invalid={longDescription}
          aria-describedby={longDescription ? 'script-description-limit' : undefined} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {longDescription ? <p id="script-description-limit" className="blocked-hint">腳本說明最多 16 KiB。</p> : null}
      <label className="field-label">腳本背景
        <textarea className="text-input" value={backgroundSummary} rows={4} disabled={saving} aria-invalid={longBackground}
          aria-describedby={longBackground ? 'script-background-limit' : undefined} onChange={(event) => setBackgroundSummary(event.target.value)} />
      </label>
      {longBackground ? <p id="script-background-limit" className="blocked-hint">腳本背景最多 8 KiB。</p> : null}
      <div className="action-row">
        <button type="button" className="button secondary" disabled={saving} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={saving || !changed || stale || longDescription || longBackground}>
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
    </form>
  </dialog>;
}
