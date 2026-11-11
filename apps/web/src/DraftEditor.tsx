import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage, resolveReportUrl } from './api';
import { executionCapabilityForScript, scriptOriginLabel } from './capabilities';
import { formatDate, Loading, Notice, ReportLink, StatusBadge } from './components';
import { useResource } from './hooks';
import { ConversationPanel } from './ConversationPanel';
import { AcceptanceSummaryCard } from './AcceptanceSummary';
import { CapabilityStatus } from './WorkspaceSettings';
import { isActiveRun } from './types';
import type { Draft, EditingSession, Run, Version, WhippetApi, WorkspaceCapabilities } from './types';

interface Props {
  api: WhippetApi;
  apiBase: string;
  testId: string;
  runs: Run[];
  onRun: (run: Run) => void;
  onPublished: (version: Version) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRefreshRuns: () => void;
  settingsRefresh: number;
  onDraftChange: (draft: Draft) => void;
  capabilities: WorkspaceCapabilities | undefined;
  children?: ReactNode;
  session: EditingSession;
  sessionRefreshing: boolean;
  onRefreshSession: () => Promise<EditingSession | undefined>;
}

export function DraftEditor(props: Props) {
  const settingsSequence = useRef(props.settingsRefresh);
  settingsSequence.current = props.settingsRefresh;
  const load = useCallback(async (signal: AbortSignal) => {
    const sequence = settingsSequence.current;
    const draft = await props.api.getDraft(props.testId, props.session.id, signal);
    return { draft, sequence };
  }, [props.api, props.testId, props.session.id]);
  const resource = useResource(load);
  return <section className="draft-section" aria-label="對話編輯工作區">
    {resource.loading ? <Loading text="正在載入草稿…" /> : null}
    {resource.error ? <Notice message={resource.error} retry={resource.retry} /> : null}
    {resource.data ? <DraftForm {...props} initial={resource.data.draft} initialSettingsSequence={resource.data.sequence} /> : null}
  </section>;
}

function DraftForm({ api, apiBase, testId, initial, runs, onRun, onPublished, onDirtyChange, onRefreshRuns, settingsRefresh, onDraftChange, children, initialSettingsSequence, session, sessionRefreshing, onRefreshSession, capabilities }: Props & { initial: Draft; initialSettingsSequence: number }) {
  const [draft, setDraft] = useState(initial);
  const [script, setScript] = useState(initial.script);
  const [localAction, setLocalAction] = useState<'manual' | 'candidate'>();
  const manualPanel = useRef<HTMLDetailsElement | null>(null);
  const scriptInput = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | 'publish' | 'reload'>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloadWarning, setReloadWarning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qualificationFresh, setQualificationFresh] = useState(true);
  const [settingsSyncing, setSettingsSyncing] = useState(false);
  const [conversationGuarded, setConversationGuarded] = useState(false);
  const [summaryRequestBusy, setSummaryRequestBusy] = useState(false);
  const [invalidatedSummaryId, setInvalidatedSummaryId] = useState<string>();
  const minimumDraftRevision = useRef(initial.revision);
  const actionLock = useRef(false);
  const actionController = useRef<AbortController | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const dirty = script !== draft.script;
  const readOnly = session.status !== 'active';
  const activeAuthor = runs.some((run) => run.kind === 'author' && isActiveRun(run));
  const editorState = useRef({ draft, script, busy });
  editorState.current = { draft, script, busy };
  const synchronizeDraft = useCallback((next: Draft, source: 'author' | 'settings' = 'author') => {
    const current = editorState.current;
    if (next.revision < Math.max(current.draft.revision, minimumDraftRevision.current)) return;
    minimumDraftRevision.current = next.revision;
    const changed = next.revision !== current.draft.revision || next.script !== current.draft.script;
    setConfirmed(false);
    if (changed && (current.script !== current.draft.script || current.busy)) {
      setConflict(true); setQualificationFresh(false);
      setError(source === 'settings' ? 'Workspace 設定已變更，本機未儲存的腳本已保留。請先保留需要的內容，再重新載入最新草稿；舊驗證不能用於新設定。' : 'AI 完成後 Server 草稿已變更；目前本機編輯已保留，請先檢視對照，再決定是否重新載入。');
      return;
    }
    setDraft(next); setQualificationFresh(true); setConflict(false); setError(undefined);
    if (changed) {
      setScript(next.script);
      setLocalAction(undefined);
      setMessage(source === 'settings' ? `已同步設定變更後的草稿 revision ${next.revision}，請重新驗證。已發佈版本維持原設定。` : `已同步 AI 完成後的草稿 revision ${next.revision}，仍需驗證與人工確認發佈。`);
    }
  }, []);
  useEffect(() => { if (session.draft) synchronizeDraft(session.draft); }, [session.draft, synchronizeDraft]);
  const lastSettingsSequence = useRef(initialSettingsSequence);
  const settingsPending = settingsRefresh !== lastSettingsSequence.current;
  useEffect(() => {
    if (settingsRefresh === lastSettingsSequence.current) return;
    const controller = new AbortController();
    setSettingsSyncing(true); setQualificationFresh(false); setConfirmed(false);
    api.getDraft(testId, session.id, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        if (next.revision < minimumDraftRevision.current) {
          setSettingsSyncing(false); setConflict(true);
          setError('草稿同步回應已過期，請重新載入最新草稿；本機編輯仍保留。');
          return;
        }
        minimumDraftRevision.current = next.revision;
        lastSettingsSequence.current = settingsRefresh;
        synchronizeDraft(next, 'settings'); setSettingsSyncing(false); void onRefreshSession().catch(() => undefined);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(`Workspace 設定已儲存，但草稿同步失敗。請重新載入草稿後再驗證或發佈。${errorMessage(cause)}`);
        setConflict(true); setQualificationFresh(false); setSettingsSyncing(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, session.id, settingsRefresh, synchronizeDraft, onRefreshSession]);
  const useCandidate = useCallback((candidate: string): boolean => {
    const current = editorState.current;
    if (current.busy) return false;
    if (current.script !== current.draft.script && !window.confirm('帶入候選腳本會取代目前未儲存內容。請先複製需要保留的內容，確定繼續？')) return false;
    setScript(candidate); setConfirmed(false);
    setLocalAction('candidate');
    setMessage('候選腳本已帶入編輯器，尚未儲存。請檢視、儲存並重新驗證。');
    return true;
  }, []);
  // 請求中的變更也應受導覽保護，避免切頁後誤認 POST 未送出。
  const guarded = dirty || Boolean(busy) || conversationGuarded || summaryRequestBusy || activeAuthor || session.status === 'discarding';
  useEffect(() => { onDraftChange(draft); }, [draft, onDraftChange]);

  useEffect(() => {
    onDirtyChange(guarded);
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    if (guarded) window.addEventListener('beforeunload', beforeUnload);
    return () => {
      onDirtyChange(false);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [guarded, onDirtyChange]);
  useEffect(() => () => actionController.current?.abort(), []);

  const validation = runs.find((run) => run.id === draft.validationRunId);
  const completedValidation = validation && !isActiveRun(validation) ? `${validation.id}:${validation.status}:${validation.reportUrl ?? ''}` : '';
  const savedRevision = draft.revision;
  const savedScript = draft.script;
  useEffect(() => {
    if (!completedValidation && syncRevision === 0) return;
    const controller = new AbortController();
    setSyncing(true);
    api.getDraft(testId, session.id, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        if (next.revision < minimumDraftRevision.current) { setSyncing(false); return; }
        minimumDraftRevision.current = next.revision;
        if (next.revision !== savedRevision || next.script !== savedScript) {
          setConflict(true);
          setQualificationFresh(false);
          setConfirmed(false);
          setError('Server 草稿已變更，目前編輯內容已保留。請重新載入並確認最新 revision。');
        } else {
          setDraft(next);
          setQualificationFresh(true);
          setConfirmed(false);
          setError(undefined);
        }
        setSyncing(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(`無法同步草稿驗證資格，請重新整理驗證狀態。${errorMessage(cause)}`);
        setQualificationFresh(false);
        setConfirmed(false);
        setSyncing(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, session.id, savedRevision, savedScript, completedValidation, syncRevision]);

  const report = resolveReportUrl(draft.reportUrl, apiBase, window.location.href);
  const validating = validation ? isActiveRun(validation) : Boolean(draft.validationStatus && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(draft.validationStatus));
  const summary = session.summary;
  const summaryValid = Boolean(summary && summary.status === 'succeeded' && summary.validForCurrentDraft && summary.revision === draft.revision && summary.validationRunId === draft.validationRunId && summary.runId !== invalidatedSummaryId && summary.description?.trim() && summary.backgroundSummary?.trim());
  const executionCapability = executionCapabilityForScript(capabilities, draft.scriptOrigin);
  const executionAvailable = executionCapability?.available === true;
  const eligible = executionAvailable && !readOnly && !dirty && !conflict && !syncing && !settingsSyncing && !settingsPending && !sessionRefreshing && !activeAuthor && !summaryRequestBusy && !conversationGuarded && summaryValid && qualificationFresh && draft.validationStatus === 'succeeded' && Boolean(draft.validationRunId && report);
  useEffect(() => { setConfirmed(false); }, [summary?.runId, summaryValid, session.status, executionAvailable, draft.scriptOrigin]);

  function openManualEditor() {
    if (readOnly || !manualPanel.current) return;
    manualPanel.current.open = true;
    scriptInput.current?.scrollIntoView({ block: 'center' });
    scriptInput.current?.focus({ preventScroll: true });
  }
  function returnToAI() {
    const composer = document.getElementById('author-message');
    composer?.scrollIntoView({ block: 'center' }); composer?.focus({ preventScroll: true });
  }

  async function perform(kind: NonNullable<typeof busy>, discard = false) {
    if (actionLock.current) return;
    if (readOnly) return;
    if (kind !== 'reload' && (settingsSyncing || settingsPending)) return;
    if (kind === 'reload' && dirty && !discard) { setReloadWarning(true); return; }
    if ((kind === 'validate' && (!executionAvailable || dirty || conflict || !script.trim())) || (kind === 'publish' && (!eligible || !confirmed))) return;
    actionLock.current = true;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(kind); setError(undefined); setMessage(undefined);
    try {
      if (kind === 'save' || kind === 'reload') {
        const next = kind === 'save' ? await api.saveDraft(testId, session.id, draft.revision, script, controller.signal) : await api.getDraft(testId, session.id, controller.signal);
        if (controller.signal.aborted) return;
        if (next.revision < minimumDraftRevision.current) {
          setConflict(true); setQualificationFresh(false); setConfirmed(false);
          setError('較早的草稿回應已過期，本機編輯已保留。請重新載入最新草稿後再繼續。');
          return;
        }
        minimumDraftRevision.current = next.revision;
        setDraft(next); setScript(next.script); setLocalAction(undefined); setConflict(false); setReloadWarning(false); setConfirmed(false);
        lastSettingsSequence.current = settingsRefresh;
        setQualificationFresh(true);
        setMessage(kind === 'save' ? `已儲存 revision ${next.revision}。` : `已載入 revision ${next.revision}。`);
        void onRefreshSession().catch(() => undefined);
      } else if (kind === 'validate') {
        const run = await api.validateDraft(testId, session.id, draft.revision, controller.signal);
        if (controller.signal.aborted) return;
        if (draft.revision < minimumDraftRevision.current) {
          onRun(run); setConfirmed(false);
          setMessage(`驗證已排入佇列，但對應舊 revision ${draft.revision}；不能用於目前草稿的發佈。`);
          return;
        }
        setDraft((current) => ({ ...current, validationRunId: run.id, validationStatus: run.status, reportUrl: undefined }));
        setQualificationFresh(false);
        setConfirmed(false); onRun(run);
        setMessage(`revision ${draft.revision} 已送出驗證，進度與取消操作可在執行紀錄查看。`);
        void onRefreshSession().catch(() => undefined);
      } else {
        if (!summary) return;
        const version = await api.publishTest(testId, session.id, draft.revision, summary.runId, controller.signal);
        if (controller.signal.aborted) return;
        setConfirmed(false); onPublished(version);
        setMessage(`已發佈 revision ${version.revision}，版本 ${version.id}。`);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setConfirmed(false); }
      const uncertain = kind === 'validate' || kind === 'publish' ? ' 請先重新整理紀錄確認結果，再決定是否重送。' : '';
      setError(`${errorMessage(cause)}${uncertain}`);
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      actionLock.current = false;
    }
  }

  return <>
    <ConversationPanel api={api} apiBase={apiBase} testId={testId} editingSessionId={session.id} aiExploration={capabilities?.aiExploration} draft={draft} draftDirty={dirty} draftBusy={readOnly || Boolean(busy) || syncing || settingsSyncing || settingsPending || conflict || summaryRequestBusy} runs={runs} onRun={onRun} onRefreshRuns={onRefreshRuns} onSynchronized={synchronizeDraft} onUseCandidate={useCandidate} onOpenManual={openManualEditor} onGuardChange={setConversationGuarded} onConversationChanged={() => { setInvalidatedSummaryId(session.summary?.runId); setConfirmed(false); void onRefreshSession().catch(() => undefined); }} onRefreshSession={onRefreshSession} />
    <details className="session-background"><summary>本次編輯的版本背景</summary><p>來源版本：{session.sourceVersionId ?? '尚無正式版本'}</p><h4>來源版本說明</h4><p className="summary-content">{session.sourceVersion?.description ?? '來源版本尚無獨立說明（舊資料或新測試）。'}</p><h4>來源背景摘要</h4><p className="summary-content">{session.sourceVersion?.backgroundSummary ?? '尚未提供來源背景摘要。'}</p><h4>本次對話背景</h4><p className="summary-content">{session.conversationSummary ?? '此編輯週期尚無已保存的對話摘要。'}</p></details>
    {children}
    <section className="draft-tools" aria-labelledby="draft-tools-title"><h3 id="draft-tools-title">草稿與驗證</h3>
    <div className="draft-meta"><span>revision {draft.revision}{dirty ? ' · 有未儲存變更' : ' · 已儲存'}</span><span>更新：{formatDate(draft.updatedAt)}</span></div>
    {draft.workspaceSettings ? <p className="inline-hint">草稿設定版本 {draft.workspaceSettings.revision} · 執行逾時 {draft.workspaceSettings.timeoutMs.toLocaleString('zh-TW')} 毫秒</p> : null}
    {settingsSyncing ? <p className="inline-hint" role="status">正在同步 Workspace 設定與草稿，暫時不可驗證或發佈。</p> : null}
    <p className="inline-hint" role="status">已儲存腳本來源：{scriptOriginLabel(draft.scriptOrigin)}。{dirty ? ` 本機操作：${localAction === 'candidate' ? '帶入 AI 候選腳本' : '工程師手動修改'}，尚未儲存，尚未改變 Server 來源。` : ' 目前沒有本機未儲存修改。'}</p>
    <CapabilityStatus label="此草稿對應執行能力" capability={executionCapability} />
    <details ref={manualPanel} className="manual-script"><summary>工程師手動修改（進階）{dirty ? ' · 有未儲存變更' : ''}</summary>
    <p id="manual-source-note" className="inline-hint">可編輯完整 Playwright／Node 腳本。Server 只在人工儲存實際改變腳本時記錄人工來源；開啟入口或原樣儲存不會改變來源。工程師腳本不套 AI 網站範圍限制，仍需真實驗證、報告與人工確認發佈。</p>
    <label className="field-label" htmlFor="draft-script">Playwright TypeScript 腳本</label>
    <textarea ref={scriptInput} id="draft-script" className="script-editor" rows={16} value={script} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={readOnly || Boolean(busy)} onChange={(event) => { setScript(event.target.value); setLocalAction('manual'); setConfirmed(false); setMessage(undefined); }} aria-describedby="draft-help manual-source-note" />
    <p id="draft-help" className="inline-hint">AI 續編只使用已儲存 revision。有未儲存內容時，先儲存草稿；切回對話不會自動儲存或放棄編輯。</p>
    <div className="action-row"><button className="button secondary compact" onClick={returnToAI}>回到 AI 續編</button></div>
    </details>
    <div className="action-row">
      <button className="button secondary" disabled={readOnly || Boolean(busy) || settingsSyncing || settingsPending || !dirty || conflict} onClick={() => perform('save')}>{busy === 'save' ? '儲存中…' : '儲存草稿'}</button>
      <button className="button secondary" disabled={!executionAvailable || readOnly || Boolean(busy) || settingsSyncing || settingsPending || dirty || conflict || validating || !script.trim()} onClick={() => perform('validate')}>{busy === 'validate' ? '送出中…' : validating ? '驗證進行中' : '驗證此 revision'}</button>
      <button className="button quiet" disabled={readOnly || Boolean(busy)} onClick={() => perform('reload')}>重新載入草稿</button>
    </div>
    {conflict ? <Notice message="目前草稿或驗證資格已變更，不會自動覆寫。本機編輯仍保留，可先複製需要的內容，再重新載入最新草稿。" /> : null}
    {reloadWarning ? <div className="confirmation-panel"><p>重新載入會放棄目前未儲存內容，請先複製需要保留的腳本。</p><div className="action-row">
      <button className="button secondary" disabled={Boolean(busy)} onClick={() => perform('reload', true)}>確定放棄並重新載入</button>
      <button className="button quiet" disabled={Boolean(busy)} onClick={() => setReloadWarning(false)}>繼續編輯</button>
    </div></div> : null}
    {error ? <Notice message={error} /> : null}
    {message ? <p className="action-message" role="status">{message}</p> : null}
    <AcceptanceSummaryCard api={api} apiBase={apiBase} testId={testId} session={session} draft={draft} runs={runs} blocked={readOnly || dirty || Boolean(busy) || syncing || settingsSyncing || settingsPending || conflict || conversationGuarded || sessionRefreshing || activeAuthor} onRun={onRun} onRefresh={onRefreshSession} onBusyChange={setSummaryRequestBusy} />
    <div className="publish-panel">
      <div className="section-heading"><h4>驗證與發佈</h4><button className="button quiet compact" disabled={Boolean(busy) || syncing} onClick={() => setSyncRevision((value) => value + 1)}>{syncing ? '同步中…' : '重新整理驗證狀態'}</button></div>
      {!executionAvailable ? <p className="blocked-hint">此草稿的來源或對應執行能力尚未確認可用，目前不能新增驗證或發佈。仍可離線對話與改稿；摘要完成不代表可發佈。</p> : null}
      <div className="validation-summary">
        {validation ? <StatusBadge status={validation.status} /> : draft.validationStatus ? <StatusBadge status={draft.validationStatus} /> : <span className="muted">尚未驗證目前 revision</span>}
        <ReportLink reportUrl={draft.reportUrl} apiBase={apiBase} label="查看草稿驗證報告" />
      </div>
      {validation?.error ? <details className="error-details"><summary>查看驗證錯誤</summary><pre className="run-error">{validation.error}</pre></details> : null}
      <p className="inline-hint">{dirty ? '目前有未儲存變更，上方驗證結果只對應已儲存腳本。' : eligible ? '目前 revision 的驗證、報告與驗收摘要皆已就緒，請檢視後明確確認發佈。' : '需目前 revision 驗證通過、報告與有效驗收摘要就緒，且沒有未儲存變更或未送出訊息，才可發佈。'}</p>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={!eligible || Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} />我已檢視驗證報告與驗收摘要，確認發佈 revision {draft.revision}</label>
      <button className="button primary" disabled={!eligible || !confirmed || Boolean(busy)} onClick={() => perform('publish')}>{busy === 'publish' ? '發佈中…' : `確認發佈 revision ${draft.revision}`}</button>
    </div>
    </section>
  </>;
}
