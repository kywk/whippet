import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ApiError, errorMessage, resolveReportUrl } from './api';
import { executionCapabilityForScript, scriptOriginLabel } from './capabilities';
import { formatDate, Loading, Notice, ReportLink, StatusBadge } from './components';
import { useResource } from './hooks';
import { emptyModule, ModuleFields, moduleProblem } from './ModuleFields';
import { PlanPanel } from './PlanPanel';
import { ConversationPanel } from './ConversationPanel';
import { AcceptanceSummaryCard } from './AcceptanceSummary';
import { CapabilityStatus } from './WorkspaceSettings';
import { isActiveRun } from './types';
import { CheckIcon, CloseIcon, CollapseIcon, ExpandIcon, RefreshIcon, TrashIcon } from './icons';
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
  onDiscard?: () => void;
  discardBusy: boolean;
  onReloadSession: () => void;
  testName?: string;
  testSlug?: string;
  testKind?: 'test' | 'module' | 'usecase';
}

type SideTab = 'script' | 'publish' | 'runs' | 'background';

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

function DraftForm({ api, apiBase, testId, initial, runs, onRun, onPublished, onDirtyChange, onRefreshRuns, settingsRefresh, onDraftChange, children, initialSettingsSequence, session, sessionRefreshing, onRefreshSession, capabilities, onDiscard, discardBusy, onReloadSession, testName, testKind, testSlug }: Props & { initial: Draft; initialSettingsSequence: number }) {
  const [draft, setDraft] = useState(initial);
  const [script, setScript] = useState(initial.script);
  const [module, setModule] = useState(() => initial.module ?? emptyModule(testSlug ?? ''));
  useEffect(() => {
    if (testSlug) setModule(current => current.slug ? current : { ...current, slug: testSlug });
  }, [testSlug]);
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
  const [planGuarded, setPlanGuarded] = useState(false);
  const [summaryRequestBusy, setSummaryRequestBusy] = useState(false);
  const [invalidatedSummaryId, setInvalidatedSummaryId] = useState<string>();
  const minimumDraftRevision = useRef(initial.revision);
  const actionLock = useRef(false);
  const actionController = useRef<AbortController | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const [tab, setTab] = useState<SideTab>('script');
  const [sideOpen, setSideOpen] = useState(() => typeof window === 'undefined' ? true : window.innerWidth > 1220);
  const [sideExpanded, setSideExpanded] = useState(false);
  const moduleDirty = testKind === 'module' && JSON.stringify(module) !== JSON.stringify(draft.module ?? emptyModule(testSlug ?? ''));
  const dirty = script !== draft.script || moduleDirty;
  const moduleError = testKind === 'module' ? moduleProblem(module, testSlug, script) : undefined;
  const readOnly = session.status !== 'active';
  const activeAuthor = runs.some((run) => run.kind === 'author' && isActiveRun(run));
  const editorState = useRef({ draft, script, busy, dirty });
  editorState.current = { draft, script, busy, dirty };
  const synchronizeDraft = useCallback((next: Draft, source: 'author' | 'settings' = 'author') => {
    const current = editorState.current;
    if (next.revision < Math.max(current.draft.revision, minimumDraftRevision.current)) return;
    minimumDraftRevision.current = next.revision;
    const changed = next.revision !== current.draft.revision || next.script !== current.draft.script;
    setConfirmed(false);
    if (changed && (current.dirty || current.busy)) {
      setConflict(true); setQualificationFresh(false);
      setError(source === 'settings' ? 'Workspace 設定已變更，本機未儲存的腳本已保留。請先保留需要的內容，再重新載入最新草稿；舊驗證不能用於新設定。' : 'AI 完成後 Server 草稿已變更；目前本機編輯已保留，請先檢視對照，再決定是否重新載入。');
      return;
    }
    setDraft(next); setQualificationFresh(true); setConflict(false); setError(undefined);
    if (changed) {
      setScript(next.script); setModule(next.module ?? emptyModule(testSlug ?? ''));
      setLocalAction(undefined);
      setMessage(source === 'settings' ? `已同步設定變更後的草稿 revision ${next.revision}，請重新驗證。已發佈版本維持原設定。` : `已同步 AI 完成後的草稿 revision ${next.revision}，仍需驗證與人工確認發佈。`);
    }
  }, [testSlug]);
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
  // 只保護會遺失的內容：未儲存腳本與尚未送達的請求。AI 任務、驗證與放棄回收都在 Server 背景進行，不綁住畫面。
  const guarded = planGuarded || dirty || Boolean(busy) || conversationGuarded || summaryRequestBusy;
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
  const summaryRunning = Boolean(summary && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(summary.status));
  const summaryValid = Boolean(summary && summary.status === 'succeeded' && summary.validForCurrentDraft && summary.revision === draft.revision && summary.validationRunId === draft.validationRunId && summary.runId !== invalidatedSummaryId && summary.description?.trim() && summary.backgroundSummary?.trim());
  const executionCapability = executionCapabilityForScript(capabilities, draft.scriptOrigin);
  const executionAvailable = executionCapability?.available === true;
  const eligible = !moduleError && testKind !== 'usecase' && !planGuarded && executionAvailable && !readOnly && !dirty && !conflict && !syncing && !settingsSyncing && !settingsPending && !sessionRefreshing && !activeAuthor && !summaryRequestBusy && !conversationGuarded && summaryValid && qualificationFresh && draft.validationStatus === 'succeeded' && Boolean(draft.validationRunId && report);
  useEffect(() => { setConfirmed(false); }, [summary?.runId, summaryValid, session.status, executionAvailable, draft.scriptOrigin]);

  function openManualEditor() {
    if (readOnly) return;
    setTab('script');
    setSideOpen(true);
    setTimeout(() => {
      if (!manualPanel.current) return;
      manualPanel.current.open = true;
      scriptInput.current?.scrollIntoView({ block: 'center' });
      scriptInput.current?.focus({ preventScroll: true });
    }, 0);
  }
  function returnToAI() {
    const composer = document.getElementById('author-message');
    composer?.scrollIntoView({ block: 'center' }); composer?.focus({ preventScroll: true });
  }

  async function perform(kind: NonNullable<typeof busy>, discard = false) {
    if (actionLock.current) return;
    if (readOnly) return;
    if (kind !== 'reload' && (settingsSyncing || settingsPending)) return;
    if (kind === 'save' && (testKind === 'usecase' || conflict || moduleError)) return;
    if (kind === 'reload' && dirty && !discard) { setReloadWarning(true); return; }
    if ((kind === 'validate' && (Boolean(moduleError) || !executionAvailable || dirty || conflict || !script.trim())) || (kind === 'publish' && (!eligible || !confirmed))) return;
    actionLock.current = true;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(kind); setError(undefined); setMessage(undefined);
    try {
      if (kind === 'save' || kind === 'reload') {
        const next = kind === 'save' ? await api.saveDraft(testId, session.id, draft.revision, script, controller.signal, testKind === 'module' ? module : undefined) : await api.getDraft(testId, session.id, controller.signal);
        if (controller.signal.aborted) return;
        if (next.revision < minimumDraftRevision.current) {
          setConflict(true); setQualificationFresh(false); setConfirmed(false);
          setError('較早的草稿回應已過期，本機編輯已保留。請重新載入最新草稿後再繼續。');
          return;
        }
        minimumDraftRevision.current = next.revision;
        setDraft(next); setScript(next.script); setModule(next.module ?? emptyModule(testSlug ?? '')); setLocalAction(undefined); setConflict(false); setReloadWarning(false); setConfirmed(false);
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

  const conditions = [
    { label: '腳本已儲存', ok: !dirty },
    { label: `revision ${draft.revision} 驗證通過`, ok: draft.validationStatus === 'succeeded' && qualificationFresh && !conflict },
    { label: '報告已保存', ok: Boolean(report) && draft.validationStatus === 'succeeded' },
    { label: '驗收摘要有效', ok: summaryValid },
  ];
  const sideBadge: Record<SideTab, ReactNode> = {
    script: dirty ? <span className="tab-dot warm" role="img" aria-label="有未儲存變更" /> : null,
    publish: eligible ? <span className="tab-dot ok" role="img" aria-label="可以發佈" /> : validating || summaryRunning ? <span className="tab-dot run" role="img" aria-label="進行中" /> : null,
    runs: runs.some(isActiveRun) ? <span className="tab-dot run" role="img" aria-label="進行中" /> : null,
    background: null,
  };
  const tabs: [SideTab, string][] = [['script', '腳本'], ['publish', '驗證與發佈'], ['runs', '紀錄與畫面'], ['background', '背景']];
  const focusTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex(([id]) => id === tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    setTab(next); document.getElementById(`side-tab-${next}`)?.focus();
  };

  const showSideTab = useCallback((next: SideTab) => {
    setTab(next);
    setSideOpen(true);
  }, []);

  return <div className={`studio${sideOpen ? ' side-open' : ' side-closed'}${sideExpanded ? ' side-expanded' : ''}`}>
    {sideOpen ? <div className="side-backdrop" aria-hidden="true" onClick={() => setSideOpen(false)} /> : null}
    <section className="studio-chat" aria-label="對話編輯工作區">
      <ConversationPanel api={api} apiBase={apiBase} testId={testId} editingSessionId={session.id} aiExploration={capabilities?.aiExploration} draft={draft} draftDirty={dirty} draftBusy={planGuarded || readOnly || Boolean(busy) || syncing || settingsSyncing || settingsPending || conflict || summaryRequestBusy} runs={runs} onRun={onRun} onRefreshRuns={onRefreshRuns} onSynchronized={synchronizeDraft} onUseCandidate={useCandidate} onOpenManual={openManualEditor} onGuardChange={setConversationGuarded} onConversationChanged={() => { setInvalidatedSummaryId(session.summary?.runId); setConfirmed(false); void onRefreshSession().catch(() => undefined); }} onRefreshSession={onRefreshSession} onShowTab={showSideTab} sideOpen={sideOpen} onToggleSide={() => setSideOpen((open) => !open)} testName={testName} publishReady={eligible} planMode={testKind === 'usecase'} />
    </section>
    <aside className="studio-side" aria-label="腳本、驗證與發佈" hidden={!sideOpen}>
      <div className="side-tabs" role="tablist" aria-label="產物面板">
        {tabs.map(([id, label]) => <button key={id} id={`side-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`side-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} onKeyDown={focusTab}>{label}{sideBadge[id]}</button>)}
        <div className="side-tab-actions">
          <button type="button" className="rail-icon-button light small side-icon-btn" aria-label={sideExpanded ? '恢復右側欄預設寬度' : '放大右側欄（方便檢視歷程）'} title={sideExpanded ? '恢復預設寬度' : '放大右側欄（方便檢視歷程）'} aria-pressed={sideExpanded} onClick={() => setSideExpanded((value) => !value)}>
            {sideExpanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
          <button type="button" className="rail-icon-button light small side-icon-btn side-close" aria-label="收合右側面板" title="收合右側面板" onClick={() => setSideOpen(false)}>
            <CloseIcon />
          </button>
        </div>
      </div>

      <div id="side-panel-script" role="tabpanel" aria-labelledby="side-tab-script" className="side-panel" hidden={tab !== 'script'}>
        <dl className="meta-list">
          <div><dt>revision</dt><dd><span className="mono">{draft.revision}</span> · {dirty ? '有未儲存變更' : '已儲存'}</dd></div>
          <div><dt>更新</dt><dd>{formatDate(draft.updatedAt)}</dd></div>
          <div><dt>來源</dt><dd>{scriptOriginLabel(draft.scriptOrigin)}</dd></div>
          {draft.workspaceSettings ? <div><dt>設定</dt><dd>版本 {draft.workspaceSettings.revision} · 逾時 {draft.workspaceSettings.timeoutMs.toLocaleString('zh-TW')} 毫秒</dd></div> : null}
        </dl>
        {settingsSyncing ? <p className="inline-hint" role="status">正在同步 Workspace 設定與草稿，暫時不可驗證或發佈。</p> : null}
        {dirty ? <p className="inline-hint" role="status">本機操作：{localAction === 'candidate' ? '帶入 AI 候選腳本' : '工程師手動修改'}，尚未儲存，尚未改變 Server 來源。</p> : null}
        <CapabilityStatus label="此草稿對應執行能力" capability={executionCapability} />
        <pre className="code-view" tabIndex={0} aria-label="目前草稿腳本">{script.split('\n').map((line, index) => <span key={index} className="code-line"><i>{index + 1}</i>{line || ' '}{'\n'}</span>)}</pre>
        <details ref={manualPanel} className="manual-script"><summary>工程師手動修改（進階）{dirty ? ' · 有未儲存變更' : ''}</summary>
          <p id="manual-source-note" className="inline-hint">可編輯完整 Playwright／Node 腳本。Server 只在人工儲存實際改變腳本時記錄人工來源；開啟入口或原樣儲存不會改變來源。工程師腳本不套 AI 網站範圍限制，仍需真實驗證、報告與人工確認發佈。</p>
          <label className="field-label" htmlFor="draft-script">{testKind === 'module' ? 'Module TypeScript 本體' : 'Playwright TypeScript 腳本'}</label>
          <textarea ref={scriptInput} id="draft-script" className="script-editor" rows={16} value={script} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={testKind === 'usecase' || planGuarded || readOnly || Boolean(busy)} onChange={(event) => { setScript(event.target.value); setLocalAction('manual'); setConfirmed(false); setMessage(undefined); }} aria-describedby="draft-help manual-source-note" />
          {testKind === 'module' ? <ModuleFields value={module} disabled={readOnly || Boolean(busy) || planGuarded} onChange={value => { setModule(value); setLocalAction('manual'); setConfirmed(false); setMessage(undefined); }} /> : null}
          {testKind === 'usecase' ? <p className="inline-hint">Use Case 腳本由 Plan / Compose 產生，請至「驗證與發佈」編輯 Stage。</p> : null}
          <p id="draft-help" className="inline-hint">AI 續編只使用已儲存 revision。有未儲存內容時，先儲存草稿；切回對話不會自動儲存或放棄編輯。</p>
          <div className="action-row"><button className="button secondary compact" onClick={returnToAI}>回到 AI 續編</button></div>
        </details>
        <div className="action-row">
          <button className="button secondary" disabled={testKind === 'usecase' || Boolean(moduleError) || readOnly || Boolean(busy) || settingsSyncing || settingsPending || !dirty || conflict} onClick={() => perform('save')}>{busy === 'save' ? '儲存中…' : '儲存草稿'}</button>
          <button className="button quiet" disabled={planGuarded || readOnly || Boolean(busy)} onClick={() => perform('reload')}>重新載入草稿</button>
        </div>
        {moduleError ? <p className="inline-hint">{moduleError}</p> : null}
        {conflict ? <Notice message="目前草稿或驗證資格已變更，不會自動覆寫。本機編輯仍保留，可先複製需要的內容，再重新載入最新草稿。" /> : null}
        {reloadWarning ? <div className="confirmation-panel"><p>重新載入會放棄目前未儲存內容，請先複製需要保留的腳本。</p><div className="action-row">
          <button className="button secondary" disabled={Boolean(busy)} onClick={() => perform('reload', true)}>確定放棄並重新載入</button>
          <button className="button quiet" disabled={Boolean(busy)} onClick={() => setReloadWarning(false)}>繼續編輯</button>
        </div></div> : null}
        {error ? <Notice message={error} /> : null}
        {message ? <p className="action-message" role="status">{message}</p> : null}
      </div>

      <div id="side-panel-publish" role="tabpanel" aria-labelledby="side-tab-publish" className="side-panel" hidden={tab !== 'publish'}>
        {testKind === 'usecase' ? <PlanPanel api={api} testId={testId} session={session} draft={draft} blocked={readOnly || dirty || Boolean(busy) || syncing || settingsSyncing || settingsPending || conflict || conversationGuarded || sessionRefreshing} onGuardChange={setPlanGuarded} onRun={onRun} onPublished={onPublished} onRefresh={() => { onRefreshRuns(); void onRefreshSession().catch(() => undefined); }} /> : <>
        <section className="validate-block" aria-labelledby="validate-title">
          <div className="section-heading"><h3 id="validate-title">驗證</h3><button className="button quiet compact" disabled={Boolean(busy) || syncing} onClick={() => setSyncRevision((value) => value + 1)}>{syncing ? '同步中…' : '重新整理狀態'}</button></div>
          <div className="validation-summary">
            {validation ? <StatusBadge status={validation.status} /> : draft.validationStatus ? <StatusBadge status={draft.validationStatus} /> : <span className="muted">尚未驗證目前 revision</span>}
            <ReportLink reportUrl={draft.reportUrl} apiBase={apiBase} label="查看草稿驗證報告" />
          </div>
          {validation?.error ? <details className="error-details"><summary>查看驗證錯誤</summary><pre className="run-error">{validation.error}</pre></details> : null}
          {!executionAvailable ? <p className="blocked-hint">此草稿的來源或對應執行能力尚未確認可用，目前不能新增驗證或發佈。仍可離線對話與改稿；摘要完成不代表可發佈。</p> : null}
          <div className="action-row"><button className="button secondary" disabled={Boolean(moduleError) || !executionAvailable || readOnly || Boolean(busy) || settingsSyncing || settingsPending || dirty || conflict || validating || !script.trim()} onClick={() => perform('validate')}>{busy === 'validate' ? '送出中…' : validating ? '驗證進行中' : '驗證此 revision'}</button></div>
          {dirty ? <p className="inline-hint">有未儲存變更，請先到「腳本」儲存；驗證只對應已儲存腳本。</p> : null}
        </section>
        <AcceptanceSummaryCard api={api} apiBase={apiBase} testId={testId} session={session} draft={draft} runs={runs} blocked={readOnly || dirty || Boolean(busy) || syncing || settingsSyncing || settingsPending || conflict || conversationGuarded || sessionRefreshing || activeAuthor} onRun={onRun} onRefresh={onRefreshSession} onBusyChange={setSummaryRequestBusy} />
        <section className="publish-panel" aria-labelledby="publish-title">
          <h3 id="publish-title">確認發佈</h3>
          <ul className="conditions" aria-label="發佈條件">{conditions.map((item) => <li key={item.label} className={item.ok ? 'ok' : ''}><span className="node" aria-hidden="true">{item.ok ? <CheckIcon /> : null}</span>{item.label}<span className="sr-only">{item.ok ? '：已達成' : '：尚未達成'}</span></li>)}</ul>
          <p className="inline-hint">{dirty ? '有未儲存變更，驗證結果只對應已儲存腳本。' : eligible ? '條件都已就緒。請檢視驗證報告與驗收摘要，由你明確確認。AI 不會自動發佈。' : '需目前 revision 驗證通過、報告與有效驗收摘要就緒，且沒有未儲存變更，才可發佈。'}</p>
          <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={!eligible || Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} />我已檢視驗證報告與驗收摘要，確認發佈 revision {draft.revision}</label>
          <button className="button primary" disabled={!eligible || !confirmed || Boolean(busy)} onClick={() => perform('publish')}>{busy === 'publish' ? '發佈中…' : `確認發佈 revision ${draft.revision}`}</button>
        </section>
        </>}
      </div>

      <div id="side-panel-runs" role="tabpanel" aria-labelledby="side-tab-runs" className="side-panel" hidden={tab !== 'runs'}>{children}</div>

      <div id="side-panel-background" role="tabpanel" aria-labelledby="side-tab-background" className="side-panel" hidden={tab !== 'background'}>
        <section className="session-background" aria-labelledby="background-title"><h3 id="background-title">本次編輯的版本背景</h3>
          <p className="inline-hint">來源版本：{session.sourceVersionId ?? '尚無正式版本'}</p>
          <h4>來源版本說明</h4><p className="summary-content">{session.sourceVersion?.description ?? '來源版本尚無獨立說明（舊資料或新測試）。'}</p>
          <h4>來源背景摘要</h4><p className="summary-content">{session.sourceVersion?.backgroundSummary ?? '尚未提供來源背景摘要。'}</p>
          <h4>本次對話背景</h4><p className="summary-content">{session.conversationSummary ?? '此編輯週期尚無已保存的對話摘要。'}</p>
        </section>
        <div className="side-actions"><button className="button quiet compact" disabled={sessionRefreshing} onClick={onReloadSession}><RefreshIcon />重新載入週期</button></div>
        {onDiscard ? <section className="danger-zone" aria-labelledby="danger-title"><h3 id="danger-title">放棄這次修改</h3>
          <p className="inline-hint">會放棄草稿與對話接續；正式版本、歷史執行與附件證據不受影響。進行中的任務會先取消。</p>
          <button className="button danger-outline" disabled={discardBusy} onClick={onDiscard}><TrashIcon />刪除草稿…</button></section> : null}
      </div>
    </aside>
  </div>;
}
