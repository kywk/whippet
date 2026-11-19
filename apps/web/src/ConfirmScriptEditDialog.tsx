import { useEffect, useRef } from 'react';
import { ScriptIcon } from './icons';

export function ConfirmScriptEditDialog({ hasDraft, onCancel, onConfirm }: {
  hasDraft: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    cancel.current?.focus();
    return () => dialog?.close();
  }, []);

  function close(action: () => void) {
    ref.current?.close();
    action();
  }

  return <dialog ref={ref} className="script-edit-dialog" aria-labelledby="script-edit-title" aria-describedby="script-edit-description"
    onCancel={(event) => { event.preventDefault(); close(onCancel); }}>
    <div className="script-edit-heading">
      <span className="script-edit-icon"><ScriptIcon /></span>
      <h2 id="script-edit-title">調整已發佈的測試腳本？</h2>
    </div>
    <p id="script-edit-description">{hasDraft
      ? '會接續現有草稿，你可以在對話中說明要調整的步驟與預期結果。'
      : '會從目前正式版本建立草稿。請在對話中說明要調整的步驟與預期結果。'}</p>
    <p>草稿通過驗證並由你確認發佈後，才會成為新的正式版本。</p>
    <div className="action-row">
      <button ref={cancel} type="button" className="button secondary" onClick={() => close(onCancel)}>取消</button>
      <button type="button" className="button primary" onClick={() => close(onConfirm)}>{hasDraft ? '繼續調整' : '開始調整'}</button>
    </div>
  </dialog>;
}
