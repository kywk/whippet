import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { executionCapabilityForScript, scriptOriginLabel } from './capabilities';
import { Loading, Notice } from './components';
import { DraftEditor } from './DraftEditor';
import { LiveView } from './LiveView';
import { RunHistory } from './RunHistory';
import { DiscardSessionDialog } from './DiscardSessionDialog';
import { CloseIcon, PlayIcon, PlusIcon, SidebarIcon } from './icons';
import { VersionHistory } from './VersionHistory';
import { VersionMarkdown } from './VersionMarkdown';
import { CapabilityStatus } from './WorkspaceSettings';
import { useResource, useRuns } from './hooks';
import type { ActiveEditingSession, AuthorEngine, Draft, EditingSession, Run, Test, Version, WhippetApi, WorkspaceCapabilities } from './types';

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
  authorEngine: AuthorEngine;
  settingsRefresh: number;
  onDirtyChange: (dirty: boolean) => void;
  onTestUpdated: (test: Test) => void;
  onTestRemoved: (testId: string) => void;
  onTestCreated: (test: Test) => void;
}

export function TestWorkspace({ testId, api, apiBase, initialEditing, preferredMode, onModeChange, railCollapsed, onExpandRail, unreadCount, tags, workspaceTags, onAddTag, onRemoveTag, capabilities, authorEngine, settingsRefresh, onDirtyChange, onTestUpdated, onTestRemoved, onTestCreated }: Props) {
  const loadTest = useCallback((signal: AbortSignal) => api.getTest(testId, signal), [api, testId]);
  const loadVersions = useCallback((signal: AbortSignal) => api.listVersions(testId, signal), [api, testId]);
  const test = useResource(loadTest);
  const loadedTest = useRef(test.data);
  if (test.data) loadedTest.current = test.data;
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
  const [discardTarget, setDiscardTarget] = useState<{ session: EditingSession; replyId?: string }>();
  const [discardError, setDiscardError] = useState<string>();
  const sessionLock = useRef(false);
  const sessionGuard = useRef(false);
  sessionGuard.current = sessionBusy || session?.status === 'discarding';
  const sessionControllers = useRef(new Set<AbortController>());
  const sessionSequence = useRef(0);
  const initialStart = useRef(false);
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
  const deletesUnpublishedTest = (loadedTest.current?.kind ?? 'test') === 'test' && loadedTest.current?.publishedVersionId === null;
  const publishedVersion = versions.data?.find((version) => version.id === publishedId);
  const formalCapability = executionCapabilityForScript(capabilities, publishedVersion?.scriptOrigin);
  const executionAvailable = formalCapability?.available === true;
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
    if (!initialEditing || initialStart.current || !test.data) return;
    const timer = setTimeout(() => {
      initialStart.current = true;
      onModeChange?.('editing');
      if (pointer?.id) {
        setEditorMounted(true);
        setMode('editing');
        void readSession(pointer.id, true).catch((cause: unknown) => setSessionError(errorMessage(cause)));
      } else {
        void openEditor();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [initialEditing, test.data, pointer?.id, readSession, openEditor, onModeChange]);

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
    if (session && session.status !== 'active') setDiscardTarget((current) => current?.replyId ? current : undefined);
  }, [session?.status]);
  const replacingDraft = Boolean(discardTarget?.replyId);
  useEffect(() => {
    if (session?.status !== 'discarded' && session?.status !== 'published') return;
    if (session.testDeleted) {
      // Keep the confirmation available to replay a replacement whose response was lost.
      if (!replacingDraft) onTestRemoved(testId);
      return;
    }
    userChoseMode.current = 'general';
    onModeChange?.('general');
    setEditorMounted(false); setKnownDraft(undefined); setMode('general'); setLiveSelection(undefined); test.retry(); versions.retry();
  }, [session?.id, session?.status, session?.testDeleted, replacingDraft, testId, onTestRemoved, test.retry, versions.retry, onModeChange]);

  async function edit() {
    userChoseMode.current = 'editing';
    onModeChange?.('editing');
    if (activeInfo?.status === 'discarding' || activeInfo?.status === 'active') {
      try { await readSession(activeInfo.id, true); setEditorMounted(true); setMode('editing'); setLiveSelection(undefined); }
      catch (cause) { setSessionError(errorMessage(cause)); }
    } else await openEditor();
  }
  async function askDiscard(recommendation?: { id: string; revision: number }) {
    if (!activeInfo || sessionLock.current) return;
    sessionLock.current = true; setSessionBusy(true); setDiscardError(undefined);
    try {
      const next = await readSession(activeInfo.id, true);
      if (next?.status !== 'active') return;
      if (recommendation && next.draft?.revision !== recommendation.revision) {
        setSessionError('草稿已更新，請重新整理對話後再決定是否另開測試。');
        return;
      }
      setDiscardTarget({ session: next, replyId: recommendation?.id });
    } catch (cause) { setSessionError(errorMessage(cause)); }
    finally { sessionLock.current = false; setSessionBusy(false); }
  }
  async function discard() {
    if (!discardTarget?.session.draft || sessionLock.current) return;
    const { session: target, replyId } = discardTarget;
    const revision = discardTarget.session.draft.revision;
    sessionLock.current = true; setSessionBusy(true); setDiscardError(undefined);
    const controller = new AbortController(); sessionControllers.current.add(controller);
    try {
      if (replyId) {
        const result = await api.replaceDraftWithNewTest(testId, target.id, revision, replyId, controller.signal);
        if (controller.signal.aborted) return;
        setDiscardTarget(undefined);
        onModeChange?.('general');
        if (result.sourceTest.deleted || deletesUnpublishedTest) onTestRemoved(testId);
        else onTestUpdated(result.sourceTest);
        onTestCreated(result.test);
        return;
      }
      const next = await api.discardEditingSession(testId, target.id, revision, controller.signal);
      if (controller.signal.aborted) return;
      ++sessionSequence.current; setSessionRefreshing(false);
      setSession(next); setDiscardTarget(undefined);
      if (next.status === 'discarding') { setMode('editing'); setEditorMounted(true); test.retry(); }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (replyId) {
        setDiscardError(cause instanceof ApiError && cause.status === 409
          ? '草稿或對話已更新。請關閉視窗並重新整理對話。'
          : `${errorMessage(cause)} 可以重試並接續同一個新測試。`);
      } else {
        setDiscardError(`${errorMessage(cause)} 草稿未被視為已刪除；若請求已送達，請重新載入週期確認回收狀態。`);
      }
      void refreshSession().catch(() => undefined);
    }
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
  const liveView = liveRun ? <LiveView key={`${liveRun.id}:${liveRequest}`} run={liveRun} apiBase={apiBase} onClose={() => setLiveSelection(undefined)} revealInChat={mode === 'editing'} /> : null;

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
    setEditorMounted(false); setKnownDraft(undefined); test.retry(); versions.retry(); changeMode('general');
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
    {activeInfo ? <span className="chip warm">{activeInfo.status === 'discarding' ? (deletesUnpublishedTest ? '正在刪除測試' : '正在放棄草稿') : `草稿 revision ${knownDraft?.revision ?? activeInfo.draftRevision}`}</span> : null}
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
        <section className="version-description" aria-labelledby="version-description-title">
          <h2 id="version-description-title">版本說明</h2>
          {test.loading || versions.loading ? <Loading text="正在載入正式版本資訊…" /> : publishedVersion ? <>
            <VersionMarkdown text={publishedVersion.description || '此版本尚無版本說明（舊資料）。'} />
            <details className="version-background"><summary>查看版本背景摘要</summary><p className="summary-content">{publishedVersion.backgroundSummary ?? '此版本尚無背景摘要（舊資料）。'}</p></details>
            <div className="formal-capability"><CapabilityStatus label="正式版本執行" capability={formalCapability} /></div>
          </> : <p className="muted">{publishedId ? '目前無法載入正式版本說明。' : '完成草稿驗證並確認發佈後，這裡會顯示版本說明。'}</p>}
        </section>
        {submitError ? <Notice message={submitError} retry={history.refresh} retryLabel="重新整理正式執行紀錄" /> : null}
        <RunHistory {...runHistoryProps} runs={formalRuns} group="formal" liveView={mode === 'general' ? liveView : null} />
      </div>
      <div className="overview-side">
        <section className="published-script-section" aria-labelledby="published-script-title">
          <div className="section-heading"><h3 id="published-script-title">正式版本唯讀腳本</h3></div>
          {test.loading || versions.loading ? <Loading text="正在載入版本腳本…" /> : publishedVersion ? <>
            <p className="script-version-label">revision {publishedVersion.revision} · {scriptOriginLabel(publishedVersion.scriptOrigin)}</p>
            <textarea className="script-editor readonly-script" readOnly rows={12} value={publishedVersion.script} spellCheck={false} aria-label="正式版本腳本（唯讀）" />
          </> : !publishedId ? <p className="mode-empty">完成發佈後會顯示正式版本腳本。</p> : <Notice message="目前無法載入正式版本腳本。" retry={versions.retry} />}
        </section>
        <VersionHistory api={api} apiBase={apiBase} versions={versions.data} runs={history.runs} publishedVersionId={publishedId} loading={versions.loading} error={versions.error} onRefresh={versions.retry} onEditDraft={() => { void edit(); }} onDiscardDraft={() => { void askDiscard(); }} activeEditingSession={activeInfo} sessionBusy={sessionBusy} knownDraft={knownDraft} editorGuarded={editorGuarded} deletesTest={deletesUnpublishedTest} />
      </div>
    </div>
    {editorMounted ? <div className="test-mode editing-mode" hidden={mode !== 'editing'} role="tabpanel" aria-label="測試編輯模式" data-mode="editing">
      {session ? (session.status === 'discarding' ? <section className="editing-session-status" aria-label="編輯週期狀態"><p role="status">{deletesUnpublishedTest ? '正在刪除測試' : '正在放棄草稿'}，等待任務停止與資源回收。</p>
        <p className="inline-hint">{session.reclaimPending ? '等待執行節點確認回收，尚未完成放棄。' : '正在確認本週期所有任務已終止。'}待確認任務：{session.pendingRunIds.length}；正式執行不受影響。</p>
        <div className="action-row"><button className="button quiet compact" disabled={sessionRefreshing} onClick={() => { void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }}>重新載入週期</button></div></section> : null)
        : sessionBusy ? <Loading text="正在開始或接續編輯週期…" /> : <div className="mode-empty"><p>尚未載入編輯週期。請重試開始或接續修改。</p><button className="button secondary" onClick={() => { void openEditor(); }}>開始或接續修改</button></div>}
      {session && session.draft && (session.status === 'active' || session.status === 'discarding') ? <DraftEditor key={session.id} api={api} apiBase={apiBase} testId={testId} capabilities={capabilities} authorEngine={authorEngine} session={session} sessionRefreshing={sessionRefreshing} onRefreshSession={refreshSession} runs={editingRuns} onRun={history.addRun} onPublished={published} onDirtyChange={handleEditorGuard} onRefreshRuns={history.refresh} settingsRefresh={settingsRefresh} onDraftChange={setKnownDraft} onDiscard={session.status === 'active' ? () => { void askDiscard(); } : undefined} discardBusy={sessionBusy} onReloadSession={() => { void refreshSession().catch((cause: unknown) => setSessionError(errorMessage(cause))); }} testName={loadedTest.current?.name} testKind={loadedTest.current?.kind} testSlug={loadedTest.current?.slug}
        onReplaceDraft={session.status === 'active' ? (id, revision) => { void askDiscard({ id, revision }); } : undefined} deletesTest={deletesUnpublishedTest}
        onWatch={startLive} liveView={mode === 'editing' && liveRun?.editingSessionId === session.id ? liveView : null}
        renderRunHistory={(onWatch) => <RunHistory {...runHistoryProps} runs={editingRuns} group="editing" onWatch={onWatch} />}
      /> : null}
    </div> : null}
    {discardTarget ? <DiscardSessionDialog session={discardTarget.session} replacing={replacingDraft} deletesTest={deletesUnpublishedTest} busy={sessionBusy} error={discardError} onCancel={() => setDiscardTarget(undefined)} onConfirm={() => { void discard(); }} /> : null}
  </div>;
}
