import { useEffect, useRef } from 'react';
import { Notice } from './components';
import type { EditingSession } from './types';

export function DiscardSessionDialog({ session, replacing, deletesTest, busy, error, onCancel, onConfirm }: {
  session: EditingSession; replacing: boolean; deletesTest: boolean; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const removal = deletesTest ? '刪除測試' : '放棄草稿';
  const title = replacing ? `${removal}並新增測試？` : deletesTest ? '確認刪除測試？' : '確認放棄本次修改？';
  const confirmLabel = replacing ? `確認${deletesTest ? '刪除' : '放棄'}並新增` : `確認${removal}`;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (replacing || deletesTest) cancelButton.current?.focus();
    return () => element?.close();
  }, [replacing, deletesTest]);
  return <dialog ref={dialog} className="discard-dialog" aria-labelledby="discard-title" onCancel={(event) => { if (busy) event.preventDefault(); else onCancel(); }}>
    <h2 id="discard-title">{title}</h2>
    {replacing ? <p>觸發這則建議的需求會原樣成為新測試對話的第一則訊息。</p> : null}
    <p>{deletesTest ? '這個測試尚未發佈。確認後會從 Workspace 移除整筆測試及其草稿。' : '這會放棄本次修改與對話接續，也會放棄本機未儲存內容。正式版本、歷史執行及附件證據不受影響。'}</p>
    <p>有進行中的任務時，會先取消並等候執行節點回收資源。</p>
    <p className="inline-hint">目前草稿 revision {session.draft?.revision ?? '未知'}</p>
    {error ? <Notice message={error} /> : null}
    <div className="action-row"><button className="button danger-button" disabled={busy || session.status !== 'active' || !session.draft} onClick={onConfirm}>{busy ? '正在送出…' : confirmLabel}</button><button ref={cancelButton} className="button secondary" disabled={busy} onClick={onCancel}>保留草稿</button></div>
  </dialog>;
}
