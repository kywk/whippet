import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { executionCapabilityForScript, scriptOriginLabel } from './capabilities';
import { Loading, Notice } from './components';
import { DraftEditor } from './DraftEditor';
import { LiveView } from './LiveView';
import { RunHistory } from './RunHistory';
import { DiscardSessionDialog } from './DiscardSessionDialog';
import { CloseIcon, PlayIcon, PlusIcon, SidebarIcon } from './icons';
import { VersionHistory } from './TestActions';
import { CapabilityStatus } from './WorkspaceSettings';
import { useResource, useRuns } from './hooks';
import type { ActiveEditingSession, Draft, EditingSession, Run, Test, Version, WhippetApi, WorkspaceCapabilities } from './types';

interface Props {
  testId: string;
  api: WhippetApi;
  apiBase: string;
  initialEditing: boolean;
  preferredMode?: 'general' | 'editing';
  onModeChange?: (mode: 'general' | 'editing') => void;
  railCollapsed?: boolean;
  onExpandRail?: () => void;
  unreadCount?: number;
  tags: string[];
  workspaceTags: string[];
  onAddTag: (raw: string) => void;
  onRemoveTag: (tag: string) => void;
  capabilities: WorkspaceCapabilities | undefined;
  settingsRefresh: number;
  onDirtyChange: (dirty: boolean) => void;
  onTestUpdated: (test: Test) => void;
}

export function TestWorkspace({ testId, api, apiBase, initialEditing, preferredMode, onModeChange, railCollapsed, onExpandRail, unreadCount, tags, workspaceTags, onAddTag, onRemoveTag, capabilities, settingsRefresh, onDirtyChange, onTestUpdated }: Props) {
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
  const [tagInput, setTagInput] = useState('');
  const userChoseMode = useRef<'general' | 'editing' | undefined>(preferredMode);
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
  const publishedVersion = versions.data?.find((version) => version.id === publishedId);
  const formalCapability = executionCapabilityForScript(capabilities, publishedVersion?.scriptOrigin);
  const executionAvailable = formalCapability?.available === true;
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
    const timer = setTimeout(() => {
      initialStart.current = true;
      onModeChange?.('editing');
      if (pointer?.id) {
        setEditorMounted(true);
        setMode('editing');
        void readSession(pointer.id, true).catch(() => openEditor());
      } else {
        void openEditor();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [initialEditing, pointer?.id, readSession, openEditor, onModeChange]);

  // 若測試本身已有進行中的對話編輯週期（例如背景對話執行中或草稿進行中），且使用者未明確指定停留在「概覽」，自動載入並進入對話視窗。
  useEffect(() => {
    if (!pointer || session?.id === pointer.id) return;
    if (pointer.status === 'discarding') {
      void readSession(pointer.id, true).catch((cause: unknown) => setSessionError(errorMessage(cause)));
      return;
    }
    if (pointer.status === 'active' && userChoseMode.current !== 'general') {
      initialStart.current = true;
      setEditorMounted(true);
      setMode('editing');
      onModeChange?.('editing');
      void readSession(pointer.id, true).catch((cause: unknown) => setSessionError(errorMessage(cause)));
    }
  }, [pointer?.id, pointer?.status, session?.id, readSession, onModeChange]);
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
    userChoseMode.current = 'general';
    onModeChange?.('general');
    setEditorMounted(false); setKnownDraft(undefined); setMode('general'); setLiveSelection(undefined); test.retry(); versions.retry();
  }, [session?.id, session?.status, test.retry, versions.retry, onModeChange]);

  async function edit() {
    userChoseMode.current = 'editing';
    onModeChange?.('editing');
    if (activeInfo?.status === 'discarding' || activeInfo?.status === 'active') {
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
    userChoseMode.current = next;
    onModeChange?.(next);
    setLiveSelection(undefined);
    if (next === 'editing') setEditorMounted(true);
    setMode(next);
  }
  function startLive(run: Run) { setLiveSelection(run); setLiveRequest((value) => value + 1); }
  const liveView = liveRun ? <LiveView key={`${liveRun.id}:${liveRequest}`} run={liveRun} apiBase={apiBase} onClose={() => setLiveSelection(undefined)} /> : null;

  async function runTest() {
    if (submitLock.current || !publishedId || !executionAvailable) return;
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

  const suggestedTags = workspaceTags.filter((tag) => !tags.includes(tag));
  function submitTag() {
    if (!tagInput.trim()) return;
    onAddTag(tagInput);
    setTagInput('');
  }

  const statusChips = <>
    <span className={`chip ${publishedId ? 'ok' : 'neutral'}`}>{publishedId ? '已發佈' : test.loading ? '載入中' : !test.data ? '狀態尚未確認' : '尚未發佈'}</span>
    {activeInfo ? <span className="chip warm">{activeInfo.status === 'discarding' ? '正在放棄草稿' : `草稿 revision ${knownDraft?.revision ?? activeInfo.draftRevision}`}</span> : null}
    {tags.map((tag) => <span key={tag} className="chip tag-chip">#{tag}</span>)}
  </>;
  const tabBusy = sessionBusy && !session;

  return <div className="test-view">
    {test.loading ? <Loading text="正在載入測試詳情…" /> : null}
    {test.error ? <Notice message={test.error} retry={test.retry} /> : null}
    {sessionError ? <Notice message={sessionError} retry={() => { test.retry(); void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }} retryLabel="重新載入編輯狀態" /> : null}
    <header className="test-head">
      <div className="test-title">
        {railCollapsed && onExpandRail ? (
          <button type="button" className="rail-icon-button light small rail-expand-btn" aria-label="展開左側測試列表" title="展開左側欄" onClick={onExpandRail}>
            <SidebarIcon />
            {unreadCount ? <span className="unread-light inline" aria-hidden="true" /> : null}
          </button>
        ) : null}
        <h1>{test.data?.name ?? '測試詳情'}</h1>
        <div className="test-chips">{statusChips}</div>
      </div>
      <div className="mode-tabs" role="tablist" aria-label="檢視">
        <button role="tab" aria-selected={mode === 'general'} className={mode === 'general' ? 'on' : ''} onClick={() => changeMode('general')}>概覽</button>
        <button role="tab" aria-selected={mode === 'editing'} className={mode === 'editing' ? 'on' : ''} disabled={sessionBusy || !test.data} onClick={() => { if (editorMounted && session) changeMode('editing'); else void edit(); }}>
          {tabBusy ? '處理中…' : '對話編輯'}{activeInfo && mode !== 'editing' ? <span className="tab-dot" role="img" aria-label="有進行中的草稿" /> : null}
        </button>
      </div>
      <div className="test-actions"><button className="button primary" disabled={submitting || !publishedId || !executionAvailable} onClick={runTest}><PlayIcon />{submitting ? '送出中…' : '執行正式版本'}</button></div>
    </header>
    <div className="test-mode general-mode overview" hidden={mode !== 'general'} role="tabpanel" aria-label="測試概覽" data-mode="general">
      <div className="overview-main">
        <section className="test-tags-section" aria-labelledby="test-tags-title">
          <div className="section-heading">
            <h2 id="test-tags-title">標籤分類</h2>
            <span className="muted">可用於左側搜尋與快速篩選</span>
          </div>
          <div className="tag-editor">
            <div className="tag-list" aria-label="已設定的標籤">
              {tags.length === 0 ? <span className="muted">尚未加上標籤</span> : tags.map((tag) => (
                <span key={tag} className="tag-pill">
                  <span>#{tag}</span>
                  <button type="button" className="tag-remove" aria-label={`移除標籤 ${tag}`} title={`移除 #${tag}`} onClick={() => onRemoveTag(tag)}><CloseIcon /></button>
                </span>
              ))}
            </div>
            <form className="tag-form" onSubmit={(event) => { event.preventDefault(); submitTag(); }}>
              <input
                type="text"
                className="text-input tag-input"
                value={tagInput}
                maxLength={32}
                placeholder="新增標籤（例如：登入、S3、冒煙測試），按 Enter 新增…"
                aria-label="新增測試標籤"
                onChange={(event) => setTagInput(event.target.value)}
              />
              <button type="submit" className="button secondary compact" disabled={!tagInput.trim()}><PlusIcon />新增標籤</button>
            </form>
            {suggestedTags.length > 0 ? (
              <div className="tag-suggestions" aria-label="Workspace 常用標籤">
                <span className="muted">點擊套用既有標籤：</span>
                {suggestedTags.map((tag) => (
                  <button key={tag} type="button" className="tag-suggestion" onClick={() => onAddTag(tag)}>+ #{tag}</button>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <section className="version-description" aria-labelledby="version-description-title"><h2 id="version-description-title">版本說明</h2>
          <p className="version-description-content">{test.loading || versions.loading ? '正在載入正式版本資訊…' : !publishedId ? '尚未發佈，尚無正式版本說明。切到「對話編輯」說明要驗證的流程，完成驗證並確認後即可發佈。' : selectedVersion?.description ?? '此版本尚無版本說明（舊資料）。'}</p>
          {selectedVersion ? <details className="version-background"><summary>查看版本背景摘要</summary><p className="summary-content">{selectedVersion.backgroundSummary ?? '此版本尚無背景摘要（舊資料）。'}</p></details> : null}
          {historical ? <p className="inline-hint">正在檢視歷史版本 {selectedVersion?.id ?? selectedVersionId}。正式執行仍使用目前發佈版本。</p> : null}
          {publishedId ? <div className="formal-capability"><p className="inline-hint">目前正式版本來源：{scriptOriginLabel(publishedVersion?.scriptOrigin)}。執行能力依目前正式版本判斷，不隨歷史版本檢視切換。</p><CapabilityStatus label="正式版本執行" capability={formalCapability} /></div> : null}
        </section>
        {submitError ? <Notice message={submitError} retry={history.refresh} retryLabel="重新整理正式執行紀錄" /> : null}
        <RunHistory {...runHistoryProps} runs={formalRuns} group="formal" liveView={mode === 'general' ? liveView : null} />
      </div>
      <div className="overview-side">
        <VersionHistory api={api} apiBase={apiBase} versions={versions.data} runs={history.runs} publishedVersionId={publishedId} loading={versions.loading} error={versions.error} onRefresh={versions.retry} selectedVersionId={viewingVersionId} onSelectVersion={(version) => setSelectedVersionId(version.id)} onEditDraft={() => { void edit(); }} onDiscardDraft={() => { void askDiscard(); }} activeEditingSession={activeInfo} sessionBusy={sessionBusy} knownDraft={knownDraft} editorGuarded={editorGuarded} />
        <section className="published-script-section" aria-labelledby="published-script-title" id="published-script-panel">
          <div className="section-heading"><h3 id="published-script-title">{historical ? '歷史版本唯讀腳本' : '正式版本唯讀腳本'}</h3>{historical ? <button className="button quiet compact" onClick={() => setSelectedVersionId(undefined)}>回到目前正式版本</button> : null}</div>
          {test.loading || versions.loading ? <Loading text="正在載入版本腳本…" /> : selectedVersion ? <>
            <p className="script-version-label">{historical ? '歷史版本' : '目前正式版本'} · revision {selectedVersion.revision} · {scriptOriginLabel(selectedVersion.scriptOrigin)}</p><p className="version-id identifier">{selectedVersion.id}</p>
            <textarea className="script-editor readonly-script" readOnly rows={12} value={selectedVersion.script} spellCheck={false} aria-label={historical ? '歷史版本腳本（唯讀）' : '正式版本腳本（唯讀）'} />
          </> : !publishedId ? <p className="mode-empty">尚無正式版本腳本。草稿只會在「對話編輯」顯示。</p> : versions.error ? <p className="muted">版本載入失敗，請從歷史版本區重新載入。</p> : <Notice message="未取得所選版本的腳本，請重新載入版本。" retry={versions.retry} />}
        </section>
      </div>
    </div>
    {editorMounted ? <div className="test-mode editing-mode" hidden={mode !== 'editing'} role="tabpanel" aria-label="測試編輯模式" data-mode="editing">
      {session ? (session.status === 'discarding' ? <section className="editing-session-status" aria-label="編輯週期狀態"><p>正在放棄草稿，等待任務停止與資源回收。</p>
        <p className="inline-hint">{session.reclaimPending ? '等待執行節點確認回收，尚未完成放棄。' : '正在確認本週期所有任務已終止。'}待確認任務：{session.pendingRunIds.length}；正式執行不受影響。</p>
        <div className="action-row"><button className="button quiet compact" disabled={sessionRefreshing} onClick={() => { void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }}>重新載入週期</button></div></section> : null)
        : sessionBusy ? <Loading text="正在開始或接續編輯週期…" /> : <div className="mode-empty"><p>尚未載入編輯週期。請重試開始或接續修改。</p><button className="button secondary" onClick={() => { void openEditor(); }}>開始或接續修改</button></div>}
      {session && session.draft && (session.status === 'active' || session.status === 'discarding') ? <DraftEditor key={session.id} api={api} apiBase={apiBase} testId={testId} capabilities={capabilities} session={session} sessionRefreshing={sessionRefreshing} onRefreshSession={refreshSession} runs={editingRuns} onRun={history.addRun} onPublished={published} onDirtyChange={handleEditorGuard} onRefreshRuns={history.refresh} settingsRefresh={settingsRefresh} onDraftChange={setKnownDraft} onDiscard={session.status === 'active' ? () => { void askDiscard(); } : undefined} discardBusy={sessionBusy} onReloadSession={() => { void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }} testName={test.data?.name}>
        <RunHistory {...runHistoryProps} runs={editingRuns} group="editing" liveView={mode === 'editing' ? liveView : null} />
      </DraftEditor> : null}
    </div> : null}
    {discardTarget ? <DiscardSessionDialog session={discardTarget} busy={sessionBusy} error={discardError} onCancel={() => setDiscardTarget(undefined)} onConfirm={() => { void discard(); }} /> : null}
  </div>;
}
