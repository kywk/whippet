import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Loading, Notice } from './components';
import { DraftEditor } from './DraftEditor';
import { LiveView } from './LiveView';
import { RunHistory } from './RunHistory';
import { DiscardSessionDialog } from './DiscardSessionDialog';
import { VersionHistory } from './TestActions';
import { useResource, useRuns } from './hooks';
import type { ActiveEditingSession, Draft, EditingSession, Run, Test, Version, WhippetApi } from './types';

interface Props {
  testId: string;
  api: WhippetApi;
  apiBase: string;
  initialEditing: boolean;
  settingsRefresh: number;
  onDirtyChange: (dirty: boolean) => void;
  onTestUpdated: (test: Test) => void;
}

export function TestWorkspace({ testId, api, apiBase, initialEditing, settingsRefresh, onDirtyChange, onTestUpdated }: Props) {
  const loadTest = useCallback((signal: AbortSignal) => api.getTest(testId, signal), [api, testId]);
  const loadVersions = useCallback((signal: AbortSignal) => api.listVersions(testId, signal), [api, testId]);
  const test = useResource(loadTest);
  const versions = useResource(loadVersions);
  const history = useRuns(api, testId);
  const [mode, setMode] = useState<'general' | 'editing'>(initialEditing ? 'editing' : 'general');
  const [editorMounted, setEditorMounted] = useState(initialEditing);
  const [editorGuarded, setEditorGuarded] = useState(false);
  const [knownDraft, setKnownDraft] = useState<Draft>();
  const [session, setSession] = useState<EditingSession>();
  const sessionRef = useRef(session); sessionRef.current = session;
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionRefreshing, setSessionRefreshing] = useState(false);
  const [sessionError, setSessionError] = useState<string>();
  const [discardTarget, setDiscardTarget] = useState<EditingSession>();
  const [discardError, setDiscardError] = useState<string>();
  const sessionLock = useRef(false);
  const sessionGuard = useRef(false);
  sessionGuard.current = sessionBusy || session?.status === 'discarding';
  const sessionControllers = useRef(new Set<AbortController>());
  const sessionSequence = useRef(0);
  const initialStart = useRef(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [liveSelection, setLiveSelection] = useState<Run>();
  const [liveRequest, setLiveRequest] = useState(0);
  const submitLock = useRef(false);
  const submitController = useRef<AbortController | null>(null);
  useEffect(() => () => submitController.current?.abort(), []);
  useEffect(() => () => { for (const controller of sessionControllers.current) controller.abort(); }, []);
  useEffect(() => { if (test.data) onTestUpdated(test.data); }, [test.data, onTestUpdated]);
  const handleEditorGuard = useCallback((guarded: boolean) => { setEditorGuarded(guarded); onDirtyChange(guarded || sessionGuard.current); }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(editorGuarded || sessionBusy || session?.status === 'discarding');
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    if (sessionBusy || session?.status === 'discarding') window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editorGuarded, sessionBusy, session?.status, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const formalRuns = history.runs.filter((run) => !run.kind || run.kind === 'run');
  const editingRuns = history.runs.filter((run) => run.editingSessionId === session?.id && (run.kind === 'author' || run.kind === 'validation'));
  const publishedId = test.data?.publishedVersionId;
  const viewingVersionId = selectedVersionId ?? publishedId;
  const selectedVersion = versions.data?.find((version) => version.id === viewingVersionId);
  const historical = Boolean(selectedVersionId && selectedVersionId !== publishedId);
  const liveRun = liveSelection ? history.runs.find((run) => run.id === liveSelection.id) ?? liveSelection : undefined;
  const pointer = test.data?.activeEditingSession;
  let activeInfo: ActiveEditingSession | null | undefined = pointer;
  if (session && ['active', 'discarding'].includes(session.status) && session.draft) activeInfo = { id: session.id, status: session.status as ActiveEditingSession['status'], draftRevision: session.draft.revision, updatedAt: session.draft.updatedAt };
  else if (session && ['discarded', 'published'].includes(session.status) && pointer?.id === session.id) activeInfo = null;

  const readSession = useCallback(async (sessionId: string, replace = false) => {
    const controller = new AbortController(); sessionControllers.current.add(controller);
    const sequence = ++sessionSequence.current; setSessionRefreshing(true);
    try {
      const next = await api.getEditingSession(testId, sessionId, controller.signal);
      if (controller.signal.aborted) return undefined;
      if (sequence === sessionSequence.current) {
        setSession((current) => !replace && current && current.id !== sessionId ? current : next);
        setSessionError(undefined);
      }
      return next;
    } finally { sessionControllers.current.delete(controller); if (!controller.signal.aborted && sequence === sessionSequence.current) setSessionRefreshing(false); }
  }, [api, testId]);
  const refreshSession = useCallback(async () => {
    const current = sessionRef.current;
    return current ? readSession(current.id) : undefined;
  }, [readSession]);

  const openEditor = useCallback(async () => {
    if (sessionLock.current) return;
    sessionLock.current = true; setSessionBusy(true); setSessionError(undefined);
    const controller = new AbortController(); sessionControllers.current.add(controller);
    try {
      const next = await api.startEditingSession(testId, controller.signal);
      if (controller.signal.aborted) return;
      ++sessionSequence.current; setSessionRefreshing(false);
      setSession(next); setEditorMounted(true); setMode('editing'); setLiveSelection(undefined);
      test.retry();
    } catch (cause) { if (!controller.signal.aborted) { setSessionError(`${errorMessage(cause)} 編輯週期尚未確認，請重新載入狀態後再試。`); test.retry(); } }
    finally { sessionControllers.current.delete(controller); sessionLock.current = false; if (!controller.signal.aborted) setSessionBusy(false); }
  }, [api, testId, test.retry]);
  useEffect(() => {
    if (!initialEditing || initialStart.current) return;
    const timer = setTimeout(() => { initialStart.current = true; void openEditor(); }, 0);
    return () => clearTimeout(timer);
  }, [initialEditing, openEditor]);

  useEffect(() => {
    if (pointer?.status !== 'discarding' || session?.id === pointer.id) return;
    void readSession(pointer.id, true).catch((cause: unknown) => setSessionError(errorMessage(cause)));
  }, [pointer?.id, pointer?.status, session?.id, readSession]);
  const activity = editingRuns.map((run) => `${run.id}:${run.status}`).join(',');
  useEffect(() => {
    if (!session || (!activity && session.status !== 'discarding') || !['active', 'discarding'].includes(session.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionId = session.id;
    async function sync() {
      try {
        const next = await readSession(sessionId);
        if (!stopped && next?.status === 'discarding') timer = setTimeout(sync, 2_000);
      } catch (cause) { if (!stopped) { setSessionError(`無法同步編輯週期，請重新載入。${errorMessage(cause)}`); if (session?.status === 'discarding') timer = setTimeout(sync, 2_000); } }
    }
    void sync();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session?.id, session?.status, activity, readSession]);
  useEffect(() => {
    if (session && session.status !== 'active') { setDiscardTarget(undefined); setDiscardError(undefined); }
  }, [session?.status]);
  useEffect(() => {
    if (session?.status !== 'discarded' && session?.status !== 'published') return;
    setEditorMounted(false); setKnownDraft(undefined); setMode('general'); setLiveSelection(undefined); test.retry(); versions.retry();
  }, [session?.id, session?.status, test.retry, versions.retry]);

  async function edit() {
    if (activeInfo?.status === 'discarding') {
      try { await readSession(activeInfo.id, true); setEditorMounted(true); setMode('editing'); setLiveSelection(undefined); }
      catch (cause) { setSessionError(errorMessage(cause)); }
    } else await openEditor();
  }
  async function askDiscard() {
    if (!activeInfo || sessionLock.current) return;
    setSessionBusy(true); setDiscardError(undefined);
    try { const next = await readSession(activeInfo.id, true); if (next?.status === 'active') setDiscardTarget(next); }
    catch (cause) { setSessionError(errorMessage(cause)); }
    finally { setSessionBusy(false); }
  }
  async function discard() {
    if (!discardTarget?.draft || sessionLock.current) return;
    sessionLock.current = true; setSessionBusy(true); setDiscardError(undefined);
    const controller = new AbortController(); sessionControllers.current.add(controller);
    try {
      const next = await api.discardEditingSession(testId, discardTarget.id, discardTarget.draft.revision, controller.signal);
      if (controller.signal.aborted) return;
      ++sessionSequence.current; setSessionRefreshing(false);
      setSession(next); setDiscardTarget(undefined); test.retry();
      if (next.status === 'discarding') { setMode('editing'); setEditorMounted(true); }
    } catch (cause) { if (!controller.signal.aborted) { setDiscardError(`${errorMessage(cause)} 草稿未被視為已刪除；若請求已送達，請重新載入週期確認回收狀態。`); void refreshSession().catch(() => undefined); } }
    finally { sessionControllers.current.delete(controller); sessionLock.current = false; if (!controller.signal.aborted) setSessionBusy(false); }
  }

  function changeMode(next: 'general' | 'editing') {
    setLiveSelection(undefined);
    if (next === 'editing') setEditorMounted(true);
    setMode(next);
  }
  function startLive(run: Run) { setLiveSelection(run); setLiveRequest((value) => value + 1); }
  const liveView = liveRun ? <LiveView key={`${liveRun.id}:${liveRequest}`} run={liveRun} apiBase={apiBase} onClose={() => setLiveSelection(undefined)} /> : null;

  async function runTest() {
    if (submitLock.current || !publishedId) return;
    submitLock.current = true; setSubmitting(true); setSubmitError(undefined);
    const controller = new AbortController(); submitController.current = controller;
    try { const run = await api.createRun(testId, controller.signal); if (!controller.signal.aborted) history.addRun(run); }
    catch (cause) { if (!controller.signal.aborted) setSubmitError(`${errorMessage(cause)} 若結果不明，請先重新整理正式執行紀錄，確認是否已建立任務再重試。`); }
    finally { if (!controller.signal.aborted) setSubmitting(false); submitLock.current = false; }
  }
  function published(version: Version) {
    if (test.data) onTestUpdated({ ...test.data, publishedVersionId: version.id });
    setSession((current) => current ? { ...current, status: 'published', draft: null, publishedVersionId: version.id } : current);
    setEditorMounted(false); setKnownDraft(undefined); setSelectedVersionId(undefined); test.retry(); versions.retry(); changeMode('general');
  }
  const runHistoryProps = { api, apiBase, loading: history.loading, error: history.error, polling: history.polling, onRefresh: history.refresh, onRun: history.addRun, onWatch: startLive };

  return <>
    {test.loading ? <Loading text="正在載入測試詳情…" /> : null}
    {test.error ? <Notice message={test.error} retry={test.retry} /> : null}
    {sessionError ? <Notice message={sessionError} retry={() => { test.retry(); void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }} retryLabel="重新載入編輯狀態" /> : null}
    <div className="test-mode general-mode" hidden={mode !== 'general'} role="region" aria-label="測試一般模式" data-mode="general">
      <div className="detail-heading"><div><h2>{test.data?.name ?? '測試詳情'}</h2><p className="mode-label">{publishedId ? '已發佈' : test.loading ? '載入中' : !test.data ? '狀態尚未確認' : '尚未發佈'}</p></div><div className="detail-actions">
        <button className="button secondary" disabled={sessionBusy || !test.data} onClick={() => { void edit(); }}>{sessionBusy ? '處理中…' : activeInfo?.status === 'discarding' ? '查看放棄進度' : activeInfo ? '繼續修改' : activeInfo === undefined ? '開啟編輯工作區' : '修改腳本'}</button>
        <button className="button primary" disabled={submitting || !publishedId} onClick={runTest}>{submitting ? '送出中…' : '執行正式版本'}</button>
      </div></div>
      <section className="version-description" aria-labelledby="version-description-title"><h3 id="version-description-title">版本說明</h3>
        <p className="version-description-content">{test.loading || versions.loading ? '正在載入正式版本資訊…' : !publishedId ? '尚未發佈，尚無正式版本說明。請先在對話工作區完成修改、驗證與確認發佈。' : selectedVersion?.description ?? '此版本尚無版本說明（舊資料）。'}</p>
        {selectedVersion ? <details className="version-background"><summary>查看版本背景摘要</summary><p className="summary-content">{selectedVersion.backgroundSummary ?? '此版本尚無背景摘要（舊資料）。'}</p></details> : null}
        {historical ? <p className="inline-hint">正在檢視歷史版本 {selectedVersion?.id ?? selectedVersionId}。正式執行仍使用目前發佈版本。</p> : null}
      </section>
      {submitError ? <Notice message={submitError} retry={history.refresh} retryLabel="重新整理正式執行紀錄" /> : null}
      <RunHistory {...runHistoryProps} runs={formalRuns} group="formal" liveView={mode === 'general' ? liveView : null} />
      <VersionHistory api={api} apiBase={apiBase} versions={versions.data} runs={history.runs} publishedVersionId={publishedId} loading={versions.loading} error={versions.error} onRefresh={versions.retry} selectedVersionId={viewingVersionId} onSelectVersion={(version) => setSelectedVersionId(version.id)} onEditDraft={() => { void edit(); }} onDiscardDraft={() => { void askDiscard(); }} activeEditingSession={activeInfo} sessionBusy={sessionBusy} knownDraft={knownDraft} editorGuarded={editorGuarded} />
      <section className="published-script-section" aria-labelledby="published-script-title" id="published-script-panel">
        <div className="section-heading"><h3 id="published-script-title">{historical ? '歷史版本唯讀腳本' : '正式版本唯讀腳本'}</h3>{historical ? <button className="button secondary compact" onClick={() => setSelectedVersionId(undefined)}>回到目前正式版本</button> : null}</div>
        {test.loading || versions.loading ? <Loading text="正在載入版本腳本…" /> : selectedVersion ? <>
          <p className="script-version-label">{historical ? '歷史版本' : '目前正式版本'} · revision {selectedVersion.revision}</p><p className="version-id identifier">{selectedVersion.id}</p>
          <textarea className="script-editor readonly-script" readOnly rows={12} value={selectedVersion.script} spellCheck={false} aria-label={historical ? '歷史版本腳本（唯讀）' : '正式版本腳本（唯讀）'} />
        </> : !publishedId ? <p className="mode-empty">尚無正式版本腳本。草稿只會在編輯模式顯示。</p> : versions.error ? <p className="muted">版本載入失敗，請從歷史版本區重新載入。</p> : <Notice message="未取得所選版本的腳本，請重新載入版本。" retry={versions.retry} />}
      </section>
    </div>
    {editorMounted ? <div className="test-mode editing-mode" hidden={mode !== 'editing'} role="region" aria-label="測試編輯模式" data-mode="editing">
      <div className="editing-heading"><div><h2>{test.data?.name ?? '編輯測試'}</h2><p>編輯模式 · {editorGuarded ? '有未儲存內容或進行中的操作' : '已儲存內容可持續接續'}</p></div><button className="button secondary" onClick={() => changeMode('general')}>返回一般模式</button></div>
      <p className="editing-intro">說明要測試的流程或修改需求，從對話取得腳本與結果。切換回一般模式會保留此處的編輯內容。</p>
      {session ? <section className="editing-session-status" aria-label="編輯週期狀態"><p>{session.status === 'discarding' ? '正在放棄草稿，等待任務停止與資源回收。' : session.status === 'active' ? '本次編輯週期進行中' : '本次編輯週期已結束'}</p>
        {session.status === 'discarding' ? <p className="inline-hint">{session.reclaimPending ? '等待執行節點確認回收，尚未完成放棄。' : '正在確認本週期所有任務已終止。'}待確認任務：{session.pendingRunIds.length}；正式執行不受影響。</p> : null}
        <div className="action-row"><button className="button quiet compact" disabled={sessionRefreshing} onClick={() => { void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }}>重新載入週期</button>{session.status === 'active' ? <button className="button quiet compact" disabled={sessionBusy} onClick={() => { void askDiscard(); }}>刪除草稿</button> : null}</div>
      </section> : sessionBusy ? <Loading text="正在開始或接續編輯週期…" /> : <div className="mode-empty"><p>尚未載入編輯週期。請重試開始或接續修改。</p><button className="button secondary" onClick={() => { void openEditor(); }}>開始或接續修改</button></div>}
      {session && session.draft && (session.status === 'active' || session.status === 'discarding') ? <DraftEditor key={session.id} api={api} apiBase={apiBase} testId={testId} session={session} sessionRefreshing={sessionRefreshing} onRefreshSession={refreshSession} runs={editingRuns} onRun={history.addRun} onPublished={published} onDirtyChange={handleEditorGuard} onRefreshRuns={history.refresh} settingsRefresh={settingsRefresh} onDraftChange={setKnownDraft}>
        <RunHistory {...runHistoryProps} runs={editingRuns} group="editing" liveView={mode === 'editing' ? liveView : null} />
      </DraftEditor> : null}
    </div> : null}
    {discardTarget ? <DiscardSessionDialog session={discardTarget} busy={sessionBusy} error={discardError} onCancel={() => setDiscardTarget(undefined)} onConfirm={() => { void discard(); }} /> : null}
  </>;
}
