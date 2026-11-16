import { useRef, useState } from 'react';
import { errorMessage } from './api';
import { editableStage, parseStageEditor } from './plan';
import type { Plan, PlanStageInput } from './types';

interface Props {
  plan: Plan; index: number; disabled: boolean;
  onSubmit: (stageId: string, input: { planRevision: number; confirmed: true; stages: PlanStageInput[] }) => Promise<void>;
  onClose: () => void;
}
export function StageSplitForm({ plan, index, disabled, onSubmit, onClose }: Props) {
  // Polling never rewrites this editor's CAS or content.
  const [snapshot] = useState(() => ({ revision: plan.revision, stage: plan.stages[index]!, prior: plan.stages.slice(0, index).map(s => s.id) }));
  const [text, setText] = useState(() => {
    const source = editableStage(snapshot.stage), module = source.module!;
    return JSON.stringify([
      { ...source, id: `${source.id.slice(0, 53)}-part-1`, title: `${source.title}（前段）`, bind: undefined, module: { ...module, slug: `${module.slug.slice(0, 53)}-part-1` } },
      { ...source, title: `${source.title}（完成）`, module: { ...module, slug: `${module.slug.slice(0, 53)}-part-2` } },
    ], null, 2);
  });
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const locked = useRef(false);
  async function submit() {
    if (disabled || locked.current || !confirmed) return;
    locked.current = true; setSaving(true); setError(undefined);
    try {
      const children = parseStageEditor(text, snapshot.prior);
      const last = children.at(-1)!;
      if (children.length !== 2 || children.some(s => s.action !== 'create') || last.id !== snapshot.stage.id || (last.bind ?? '') !== (snapshot.stage.bind ?? '')) throw new Error('需兩個新建 Stage；最後一段保留原 id 與 bind。');
      await onSubmit(snapshot.stage.id, { planRevision: snapshot.revision, confirmed: true, stages: children });
    } catch (cause) { setError(errorMessage(cause)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { locked.current = false; setSaving(false); }
  }
  return <section className="plan-editor" aria-label="拆分 Stage">
    <h4>拆分「{snapshot.stage.title}」</h4>
    <p>保留前段成果，將這個尚未執行的工作分成兩段。請分配每段的責任、參數與驗證條件，最後一段保留原 id 與回傳綁定。</p>
    <p>子段共用原 Stage 的固定總額，儲存後各段額度不會補回；失敗不會自動重試。儲存不會開始執行，之後可逐段確認。</p>
    {error ? <p role="alert" tabIndex={-1} ref={errorRef}>{error} 請檢視輸入與最新 Plan；不會自動重送。</p> : null}
    <label className="platform-field">子 Stage JSON<textarea rows={14} value={text} disabled={disabled || saving} onChange={event => { setText(event.target.value); setConfirmed(false); }} /></label>
    <p className="muted">編輯基底：Plan r{snapshot.revision}。原目標會保留在各段的背景資料中。</p>
    <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={disabled || saving} onChange={event => setConfirmed(event.target.checked)} />我已檢視拆分責任、參數與固定額度，確認保留既有進度。</label>
    <div className="action-row"><button className="button primary" disabled={disabled || saving || !confirmed} onClick={() => void submit()}>{saving ? '正在儲存…' : '儲存拆分並保留進度'}</button><button className="button secondary" disabled={saving} onClick={onClose}>取消編輯</button></div>
  </section>;
}
