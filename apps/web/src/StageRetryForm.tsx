import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { validRepairContent } from './plan';
import type { StageRetry, StageRetryInput, WhippetApi } from './types';

const reasons: Record<NonNullable<StageRetry['reason']>, string> = {
  plan_not_stopped: 'Plan 尚未停止', stage_not_retryable: '此 Stage 不適用人工重試', cancelled: '此工作已取消',
  source_unavailable: '無法確認原始執行來源', session_closed: '原 Module 編輯週期已關閉', reclaim_pending: '原工作尚未完成回收',
  snapshot_mismatch: '來源快照與目前版本不一致', prior_stage_invalid: '前序 Stage 資格已失效', scope_unavailable: '執行範圍尚未就緒',
};
interface Props {
  api: WhippetApi; planId: string; stageId: string; planRevision: number; blocked: boolean;
  onSubmit: (stageId: string, input: StageRetryInput) => Promise<void>;
}
export function StageRetryForm({ api, planId, stageId, planRevision, blocked, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<StageRetry>();
  const [content, setContent] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const sending = useRef(false);
  const snapshotKey = useRef('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(undefined); setConfirmation(''); setLoading(true);
    async function read() {
      if (sending.current) return;
      try {
        if (!api.getStageRetry) throw new Error('此連線尚未提供 Stage 重試資格。');
        const next = await api.getStageRetry(planId, stageId, controller.signal);
        if (controller.signal.aborted || sending.current) return;
        const nextKey = JSON.stringify(next);
        if (snapshotKey.current !== nextKey) setConfirmation('');
        snapshotKey.current = nextKey; setSnapshot(next);
      } catch (cause) {
        if (!controller.signal.aborted) { setSnapshot(undefined); setConfirmation(''); setError(`重試資格尚未確認：${errorMessage(cause)}`); }
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(read, 3000); }
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, planId, stageId, planRevision, open, refresh]);
  const key = JSON.stringify({ snapshot, content });
  const source = snapshot?.source;
  const eligible = snapshot?.eligible && source?.reclaimed && snapshot.planRevision === planRevision;
  const disabled = blocked || pending || loading || locked || !eligible || !api.retryStage;
  async function submit() {
    if (sending.current || disabled || !source || !validRepairContent(content) || confirmation !== key) return;
    sending.current = true; setPending(true); setConfirmation(''); setError(undefined);
    try {
      await onSubmit(stageId, { planRevision: snapshot!.planRevision, moduleRevision: source.moduleRevision, moduleContextRevision: source.moduleContextRevision, confirmed: true, content });
      setLocked(true);
    } catch (cause) { setLocked(true); setError(`${errorMessage(cause)} 請重新載入現況並重新人工確認；不會自動重送或替換 CAS。`); }
    finally { sending.current = false; setPending(false); }
  }
  return <section aria-label="失敗 Stage 人工修復" className="platform-card">
    <button className="button secondary" disabled={pending} onClick={() => setOpen(!open)}>{open ? '收合修復表單' : '修復並重試'}</button>
    {open ? <>
      <p>沿原 Stage 與 Module 編輯週期修復；不獨立發佈 Module，仍須整批驗證、摘要與發佈。</p>
      {source ? <><p className="identifier">Module {source.moduleTestId}<br />編輯週期 {source.editingSessionId}<br />Author {source.authorRunId} · {source.authorStatus}<br />Validation {source.validationRunId ?? '無'} · {source.validationStatus ?? '無'}<br />Plan r{snapshot!.planRevision} / Module r{source.moduleRevision} / 背景 r{source.moduleContextRevision}</p><p>{source.reclaimed ? 'Server 資格快照：原工作已回收；送出時仍會重新核對。' : '原工作尚未回收，不可重試。'}</p></> : <p>尚無完整來源與回收證據，不可重試。</p>}
      {snapshot?.reason ? <p className="blocked-hint">{reasons[snapshot.reason]}（{snapshot.reason}）</p> : null}
      {snapshot && snapshot.planRevision !== planRevision ? <p className="blocked-hint">Plan 版本已變，請重新檢視現況。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button className="button quiet" disabled={pending || blocked} onClick={() => { setLocked(false); setError(undefined); setConfirmation(''); setSnapshot(undefined); setRefresh(value => value + 1); }}>重新載入重試資格</button>
      <label className="platform-field">人工修復指示<textarea rows={4} value={content} disabled={pending} onChange={event => { setContent(event.target.value); setConfirmation(''); }} /></label>
      <p className="inline-hint">{Array.from(content).length} / 16000 字元；必填，不接受空白、NUL 或無效 Unicode。原文會送出。</p>
      <label className="checkbox-label"><input type="checkbox" checked={confirmation === key} disabled={disabled || !validRepairContent(content)} onChange={event => setConfirmation(event.target.checked ? key : '')} />我已檢視原 Stage、來源與回收狀態，確認依上述指示重新產稿及驗證。</label>
      <button className="button primary" disabled={disabled || !validRepairContent(content) || confirmation !== key} onClick={() => { void submit(); }}>確認修復並重試</button>
    </> : null}
  </section>;
}
