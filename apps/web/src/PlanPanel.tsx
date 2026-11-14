import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Notice, RunStatusBadge, StatusBadge } from './components';
import { batchPublishReady, editableStage, parseStageEditor } from './plan';
import type { AuthorEngine, Draft, EditingSession, Plan, PlanSummary, StageRetryInput, Run, Version, WhippetApi } from './types';
import './platform-preview.css';
import { StageRetryForm } from './StageRetryForm';
import { AuthorEngineStatus } from './AuthorEngineStatus';

const planLabels = { draft: '待確認', confirmed: '已確認', running: '逐階段執行中', composed: '已組合，等待驗證／摘要', done: '整批已發佈', stopped: '已停止' };
const stageLabels = { pending: '等待前一階段', authoring: '作者任務中', validating: '驗證中', ready: '就緒', failed: '失敗' };
const actionLabels = { reuse: '複用', modify: '修改', create: '新建' };
interface Props {
  api: WhippetApi; testId: string; session: EditingSession; draft: Draft; runs: Run[]; authorEngine: AuthorEngine; blocked: boolean;
  onGuardChange: (guarded: boolean) => void; onRun: (run: Run) => void;
  onPublished: (version: Version) => void; onRefresh: () => void;
}
export function PlanPanel({ api, testId, session, draft, runs, authorEngine, blocked, onGuardChange, onRun, onPublished, onRefresh }: Props) {
  const [plan, setPlan] = useState<Plan | null>();
  const [summary, setSummary] = useState<PlanSummary | null>();
  const [validation, setValidation] = useState<Run>();
  const [activeStageRun, setActiveStageRun] = useState<Run>();
  const [fresh, setFresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [editor, setEditor] = useState<{ text: string; planRevision: number; draftRevision: number }>();
  const [confirmation, setConfirmation] = useState('');
  const lock = useRef(false);
  const sequence = useRef(0);
  const mutationController = useRef<AbortController | undefined>(undefined);
  useEffect(() => { onGuardChange(pending || Boolean(editor)); return () => onGuardChange(false); }, [pending, editor, onGuardChange]);
  useEffect(() => () => mutationController.current?.abort(), []);

  const reload = useCallback(async (signal: AbortSignal, explicit = false) => {
    if (lock.current) return;
    const seq = ++sequence.current;
    setLoading(true);
    const current = () => !signal.aborted && sequence.current === seq;
    try {
      if (!api.getPlan) throw new Error('此連線尚未提供 Plan API。');
      const next = await api.getPlan(testId, session.id, signal);
      if (!current()) return;
      setPlan(next); setFresh(true); setError(undefined);
      if (explicit) { setConflict(false); setConfirmation(''); setNote('已重新讀取 Server 狀態，請重新檢視後操作；沒有重送任何寫入。'); }
      if (next) {
        const activeStageRunId = next.stages.find((stage) => stage.status === 'authoring' && stage.authorRunId)?.authorRunId;
        const results = await Promise.allSettled([
          api.getPlanSummary ? api.getPlanSummary(next.id, signal) : Promise.reject(new Error('批次摘要讀取尚未提供。')),
          next.validationRunId ? api.getRun(next.validationRunId, signal) : Promise.resolve(undefined),
          activeStageRunId ? api.getRun(activeStageRunId, signal) : Promise.resolve(undefined),
        ]);
        if (!current()) return;
        const [summaryResult, validationResult, stageRunResult] = results;
        if (summaryResult.status === 'fulfilled') { setSummary(summaryResult.value); setSummaryError(undefined); }
        else { setSummary(undefined); setSummaryError(`批次摘要不可用：${errorMessage(summaryResult.reason)}`); }
        if (validationResult.status === 'fulfilled' && (!validationResult.value || (validationResult.value.testId === testId && validationResult.value.editingSessionId === session.id))) setValidation(validationResult.value);
        else { setValidation(undefined); setSummaryError((previous) => `${previous ?? ''} Use Case 驗證結果尚未確認。`); }
        const stageRun = stageRunResult.status === 'fulfilled' ? stageRunResult.value : undefined;
        setActiveStageRun(stageRun?.id === activeStageRunId && stageRun?.kind === 'author' ? stageRun : undefined);
      } else { setSummary(null); setValidation(undefined); setActiveStageRun(undefined); setSummaryError(undefined); }
    } catch (cause) { if (current()) { setFresh(false); setError(`Plan 尚未確認可用：${errorMessage(cause)}`); } }
    finally { if (current()) setLoading(false); }
  }, [api, testId, session.id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await reload(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); sequence.current++; };
  }, [reload]);

  const editable = !plan || plan.status === 'draft' || plan.status === 'stopped';
  const disabled = blocked || pending || loading || !fresh || conflict;
  const confirmationKey = plan && summary ? JSON.stringify({ plan, summary }) : '';
  const publishReady = !summaryError && batchPublishReady(plan, summary);
  const mayPublish = !disabled && !editor && publishReady && Boolean(api.publishPlan);
  const validationReady = validation?.status === 'succeeded' && validation.id === plan?.validationRunId;
  const maySummarize = !disabled && !editor && plan?.status === 'composed' && plan.stages.every((stage) => stage.status === 'ready') && validationReady && Boolean(api.requestPlanSummary) && !(summary && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(summary.status));
  const summaryRun = summary ? runs.find((run) => run.id === summary.runId && run.kind === 'author' && run.authorMode === 'summary') : undefined;

  async function retryStage(stageId: string, input: StageRetryInput) {
    if (lock.current || disabled || editor || !plan || !api.retryStage || !api.getPlan) throw new Error('目前無法重試，請重新確認。');
    const currentPlan = plan;
    lock.current = true; sequence.current++; setPending(true); setFresh(false); setConfirmation(''); setError(undefined);
    const controller = new AbortController(); mutationController.current = controller;
    try {
      const receipt = await api.retryStage(currentPlan.id, stageId, input, controller.signal);
      if (receipt.testId !== testId || receipt.editingSessionId !== session.id) throw new Error('重試回應所屬範圍不符。');
      // An idempotent receipt may describe an old running Plan. Only a new GET is current state.
      const current = await api.getPlan(testId, session.id, controller.signal);
      if (controller.signal.aborted) return;
      setPlan(current); setFresh(true); setSummary(undefined); setValidation(undefined);
      setNote('Server 已接受修復請求；已重新讀取目前 Plan，不以歷史回應推斷正在執行。');
      onRefresh();
    } catch (cause) {
      if (!controller.signal.aborted) { setConflict(true); setFresh(false); setError(`${errorMessage(cause)} 重試結果需重新確認；不會自動重送或更新 CAS。`); }
      throw cause;
    } finally { lock.current = false; if (!controller.signal.aborted) setPending(false); }
  }

  async function mutate(action: 'save' | 'confirm' | 'cancel' | 'summary' | 'publish') {
    if (lock.current || disabled) return;
    const currentPlan = plan;
    if (action === 'save' && (!editor || !editable || !api.savePlan)) return;
    if (action !== 'save' && !currentPlan) return;
    if (action === 'confirm' && (editor || currentPlan?.status !== 'draft' || !api.confirmPlan || currentPlan.baseRevision !== draft.revision)) return;
    if (action === 'cancel' && (!api.cancelPlan || currentPlan?.status === 'done' || currentPlan?.status === 'stopped')) return;
    if (action === 'summary' && !maySummarize) return;
    if (action === 'publish' && (!mayPublish || confirmation !== confirmationKey || !summary)) return;
    let stageInputs;
    if (action === 'save') {
      try { stageInputs = parseStageEditor(editor!.text); }
      catch (cause) { setError(`Stage 格式未通過本機檢查，尚未送出：${errorMessage(cause)}`); return; }
    }
    lock.current = true; sequence.current++; setPending(true); setError(undefined); setNote(undefined); setConfirmation('');
    const controller = new AbortController(); mutationController.current = controller;
    try {
      if (action === 'publish') {
        const result = await api.publishPlan!(currentPlan!.id, currentPlan!.revision, summary!.runId, controller.signal);
        if (controller.signal.aborted) return;
        const expected = new Set(summary!.candidates.map((item) => item.versionId));
        if (result.usecaseVersion.testId !== testId || result.usecaseVersion.editingSessionId !== session.id || result.moduleVersions.length !== expected.size || new Set(result.moduleVersions.map((item) => item.id)).size !== expected.size || result.moduleVersions.some((item) => !expected.has(item.id))) throw new Error('發佈回應與確認的批次不符，請重新載入確認結果。');
        onPublished(result.usecaseVersion);
        return;
      }
      if (action === 'summary') {
        const run = await api.requestPlanSummary!(currentPlan!.id, currentPlan!.revision, currentPlan!.validationRunId!, controller.signal);
        if (controller.signal.aborted) return;
        if (run.testId !== testId || run.editingSessionId !== session.id || run.authorMode !== 'summary') throw new Error('批次摘要 Run 所屬範圍不符。');
        onRun(run); setNote('Server 已回傳摘要任務；是否可發佈仍以批次摘要的最新判定為準。');
      } else {
        const next = action === 'save'
          ? await api.savePlan!(testId, { editingSessionId: session.id, revision: editor!.draftRevision, planRevision: editor!.planRevision, stages: stageInputs! }, controller.signal)
          : action === 'confirm' ? await api.confirmPlan!(currentPlan!.id, currentPlan!.revision, controller.signal)
          : await api.cancelPlan!(currentPlan!.id, currentPlan!.revision, controller.signal);
        if (controller.signal.aborted) return;
        if (next.testId !== testId || next.editingSessionId !== session.id) throw new Error('Plan 回應所屬範圍不符。');
        setPlan(next); setEditor(undefined); setSummary(undefined);
        setNote(`Server 回傳 Plan r${next.revision}：${planLabels[next.status]}。${action === 'cancel' ? '取消後仍須等待 Worker 回收，不表示名額已釋放。' : ''}`);
      }
      onRefresh();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setConflict(true); setFresh(false);
      setError(`${errorMessage(cause)} ${cause instanceof ApiError && cause.status === 409 ? '狀態或版本衝突。' : '未確認操作成功，後端可能尚未提供此能力。'}請重新載入並檢視後再決定；不會自動重送或更新 CAS revision。`);
    } finally { lock.current = false; if (!controller.signal.aborted) setPending(false); }
  }

  return <section className="plan-panel" aria-label="Use Case Plan 與整批發佈">
    <header className="platform-heading"><div><h3>Use Case Plan</h3><p className="muted">真實 Server 資料 · 非合成預覽</p></div><button className="button secondary compact" disabled={pending} onClick={() => { void reload(new AbortController().signal, true); }}>重新載入</button></header>
    {error ? <Notice message={error} /> : null}{note ? <p role="status">{note}</p> : null}
    {loading && plan === undefined ? <p role="status">正在讀取 Plan…</p> : null}
    {plan === null && fresh ? <p>此編輯週期尚無 Plan。可由對話提出計畫，或手動編輯 Stage。</p> : null}
    {plan ? <><p className="identifier">{planLabels[plan.status]} · Plan r{plan.revision} · 草稿基底 r{plan.baseRevision}</p>
      <p>{plan.stages.filter((stage) => stage.status === 'ready').length} / {plan.stages.length} 階段就緒</p>
      {plan.error ? <Notice message={plan.error} /> : null}
      <ol className="platform-stages">{plan.stages.map((stage, index) => { const authorRun = stage.authorRunId === activeStageRun?.id ? activeStageRun : runs.find((run) => run.id === stage.authorRunId && run.kind === 'author'); return <li key={stage.id}><div className="platform-heading"><h4>{index + 1}. {stage.title} · {actionLabels[stage.action]}</h4><strong>{stageLabels[stage.status]}</strong></div>
        <p className="identifier">{stage.module?.slug ?? stage.moduleTestId ?? '待建立 Module'} · 固定來源版本 {stage.moduleVersionId ?? '新建'}</p>
        {stage.candidateVersionId ? <p className="identifier">候選版本 {stage.candidateVersionId}（尚未發佈）</p> : null}
        <details><summary>參數與回傳綁定</summary><pre className="plan-json">{JSON.stringify(stage.args, null, 2)}</pre><p>綁定別名：{stage.bind || '未設定'}</p></details>
        {stage.authorRunId ? <p className="identifier">Author Run {stage.authorRunId}{authorRun ? <> · <AuthorEngineStatus engine={authorRun.authorEngine ?? 'builtin'} status={authorRun.status} /></> : null}</p> : null}{stage.validationRunId ? <p className="identifier">Validation Run {stage.validationRunId}</p> : null}
        {stage.error ? <Notice message={stage.error} /> : null}
        {stage.status === 'failed' && stage.action !== 'reuse' ? <StageRetryForm api={api} planId={plan.id} stageId={stage.id} planRevision={plan.revision} blocked={disabled || Boolean(editor) || plan.status !== 'stopped'} onSubmit={retryStage} /> : null}</li>; })}</ol>
      <div className="action-row"><button className="button primary" disabled={disabled || Boolean(editor) || plan.status !== 'draft' || plan.baseRevision !== draft.revision || !api.confirmPlan} onClick={() => { void mutate('confirm'); }}>確認 Plan 並開始</button>
        <button className="button secondary" disabled={disabled || Boolean(editor) || ['done', 'stopped'].includes(plan.status) || !api.cancelPlan} onClick={() => { void mutate('cancel'); }}>停止 Plan</button></div>
      {plan.status === 'stopped' ? <p className="inline-hint">已停止，不會自動重跑。失敗 Stage 可先查詢人工修復資格；修訂整份 Plan 則須儲存後重新確認。</p> : null}
      {plan.status === 'draft' && plan.baseRevision !== draft.revision ? <p className="blocked-hint">Plan 基底與目前草稿不同，請重新載入草稿並修訂計畫。</p> : null}
    </> : null}
    {editable && fresh ? <div className="plan-editor">{!editor ? <button className="button secondary" disabled={disabled || !api.savePlan} onClick={() => setEditor({ text: JSON.stringify(plan?.stages.map(editableStage) ?? [], null, 2), planRevision: plan?.revision ?? 0, draftRevision: draft.revision })}>{plan ? '修訂 Stage' : '建立 Plan'}</button> : <>
      <label className="platform-field">Stage JSON（未儲存）<textarea rows={14} value={editor.text} disabled={pending} onChange={(event) => setEditor({ ...editor, text: event.target.value })} /></label>
      <p className="inline-hint">1–32 個線性 Stage；欄位 id、title、action（reuse/modify/create）、args、bind。複用／修改指定 moduleVersionId；新建指定 module（slug/moduleKind/description）。儲存不會開始執行。</p>
      <p className="muted">編輯基底：Plan r{editor.planRevision} / 草稿 r{editor.draftRevision}；重新載入不會替換這份編輯的 CAS 值。</p>
      <div className="action-row"><button className="button primary" disabled={disabled || !api.savePlan} onClick={() => { void mutate('save'); }}>儲存 Plan</button><button className="button quiet" disabled={pending} onClick={() => setEditor(undefined)}>放棄本機 Plan 編輯</button></div>
    </>}</div> : null}
    {plan ? <section className="platform-card"><h3>整批驗證與摘要</h3>
      {validation ? <RunStatusBadge run={validation} /> : <p>尚未取得 Use Case 真實驗證結果。</p>}
      {summaryError ? <Notice message={summaryError} /> : null}
      <button className="button secondary" disabled={!maySummarize} onClick={() => { void mutate('summary'); }}>要求整批摘要</button>
      <p className="inline-hint">新整批摘要：{authorEngine === 'external' ? '外部 Agent 接單' : '內建引擎'}。{summaryRun ? `此摘要 Run 來源：${summaryRun.authorEngine === 'external' ? '外部 Agent' : '內建引擎'}。` : '實際來源以新建 Run 快照為準。'}只請求摘要，不重跑驗證；Server 仍核對每個候選與 Worker 回收狀態。</p>
      {summary ? <><StatusBadge status={summary.status} /><p className="identifier">摘要 Run {summary.runId} · Plan r{summary.planRevision}</p>
        {summary.stale || summary.planRevision !== plan.revision || summary.planId !== plan.id ? <p className="blocked-hint">此摘要已過期或不屬於目前 Plan，不可發佈。</p> : null}
        <h4>本批次候選 Module（{summary.candidates.length}）</h4>
        {summary.candidates.length ? <ul>{summary.candidates.map((item) => <li className="identifier" key={item.versionId}>{item.name} · @lib/{item.slug} · {item.moduleKind} · r{item.revision}<br />候選 {item.versionId}<details><summary>批次綁定</summary>Test {item.testId}<br />Bundle {item.bundleHash}</details></li>)}</ul> : <p>此批次沒有新建／修改候選；複用版本不重新發佈。</p>}
        <h4>整批摘要</h4><p className="summary-content">{summary.description ?? '摘要尚未完成。'}</p><p className="summary-content">{summary.backgroundSummary ?? '尚無背景摘要。'}</p>{summary.message ? <p className="summary-content">{summary.message}</p> : null}
        <details><summary>批次識別</summary><code className="identifier">{summary.batchHash}</code></details>
      </> : <p>尚無可讀取的整批摘要；不使用單一 Test 摘要替代。</p>}
      {!publishReady ? <p className="blocked-hint">整批候選／摘要／發佈資格尚未確認，不可發佈。</p> : null}
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(confirmationKey) && confirmation === confirmationKey} disabled={!mayPublish} onChange={(event) => setConfirmation(event.target.checked ? confirmationKey : '')} />我已檢視全部候選清單與整批摘要，確認一起發佈 Use Case 與候選 Module。</label>
      <button className="button primary" disabled={!mayPublish || confirmation !== confirmationKey} onClick={() => { void mutate('publish'); }}>確認整批發佈</button>
    </section> : null}
  </section>;
}
