import { useEffect, useRef } from 'react';
import { Notice } from './components';
import type { EditingSession } from './types';

export function DiscardSessionDialog({ session, replacing, busy, error, onCancel, onConfirm }: {
  session: EditingSession; replacing: boolean; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (replacing) cancelButton.current?.focus();
    return () => element?.close();
  }, [replacing]);
  return <dialog ref={dialog} className="discard-dialog" aria-labelledby="discard-title" onCancel={(event) => { if (busy) event.preventDefault(); else onCancel(); }}>
    <h2 id="discard-title">{replacing ? '放棄草稿並新增測試？' : '確認放棄本次修改？'}</h2>
    {replacing ? <p>觸發這則建議的需求會原樣成為新測試對話的第一則訊息。</p> : null}
    <p>這會放棄本次修改與對話接續，也會放棄本機未儲存內容。正式版本、歷史執行及附件證據不受影響。</p>
    <p>活躍任務會先取消，等執行節點確認資源回收後，才完成放棄；等待期間仍保留草稿。</p>
    <p className="inline-hint">目前草稿 revision {session.draft?.revision ?? '未知'}</p>
    {error ? <Notice message={error} /> : null}
    <div className="action-row"><button className="button danger-button" disabled={busy || session.status !== 'active' || !session.draft} onClick={onConfirm}>{busy ? '正在送出…' : replacing ? '確認放棄並新增' : '確認放棄草稿'}</button><button ref={cancelButton} className="button secondary" disabled={busy} onClick={onCancel}>保留草稿</button></div>
  </dialog>;
}
