import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Loading, Notice, ReportLink, RunStatusBadge } from './components';
import { AssistantTurn, ChatScroll, Composer, UserTurn, useStoredText } from './chat';
import { collapseDiff, diffLines, diffStat } from './diff';
import { CancelRunButton } from './TestActions';
import { AuthorLiveStatus, isBadStatus, trailFromRuns, TrailCard } from './trail';
import { capabilityReason } from './capabilities';
import { isActiveRun } from './types';
import { PanelIcon, RefreshIcon, ScriptIcon } from './icons';
import type { Conversation, Draft, EditingSession, Message, Run, WhippetApi, WorkspaceCapability } from './types';

type SideTab = 'script' | 'publish' | 'runs' | 'background';

interface Props {
  api: WhippetApi;
  apiBase: string;
  testId: string;
  draft: Draft;
  draftDirty: boolean;
  draftBusy: boolean;
  runs: Run[];
  onRun: (run: Run) => void;
  onRefreshRuns: () => void;
  onSynchronized: (draft: Draft) => void;
  onUseCandidate: (script: string) => boolean;
  onOpenManual: () => void;
  aiExploration: WorkspaceCapability | undefined;
  onGuardChange: (guarded: boolean) => void;
  editingSessionId: string;
  onConversationChanged: () => void;
  onRefreshSession: () => Promise<EditingSession | undefined>;
  onShowTab: (tab: SideTab) => void;
  sideOpen?: boolean;
  onToggleSide?: () => void;
  testName?: string;
  publishReady: boolean;
  planMode?: boolean;
}

const STARTERS = [
  '登入後檢查首頁是否顯示使用者名稱',
  '把商品加入購物車並完成結帳，最後確認出現訂單編號',
  '搜尋關鍵字，確認結果清單依相關度排序',
];

export function ConversationPanel({ api, apiBase, testId, editingSessionId, draft, draftDirty, draftBusy, runs, onRun, onRefreshRuns, onSynchronized, onUseCandidate, onOpenManual, onGuardChange, onConversationChanged, onRefreshSession, onShowTab, sideOpen, onToggleSide, aiExploration, publishReady, planMode = false }: Props) {
  const [conversation, setConversation] = useState<Conversation>();
  const [content, setContent] = useStoredText(editingSessionId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [synchronizing, setSynchronizing] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [continueConflict, setContinueConflict] = useState<string>();
  const [continueChecked, setContinueChecked] = useState<string>();
  const [continuedSources, setContinuedSources] = useState<string[]>([]);
  const [sentRunId, setSentRunId] = useState<string>();
  const [scripts, setScripts] = useState<Record<number, string>>({ [draft.revision]: draft.script });
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const querySequence = useRef(0);
  const handledRuns = useRef(new Set<string>());
  const submitLock = useRef(false);
  const submitController = useRef<AbortController | null>(null);
  // 只保護「請求正在送達」：未送出的文字已自動保存，AI 任務在背景進行，兩者都不需要綁住畫面。
  const composerGuarded = submitting || synchronizing;
  useEffect(() => { onGuardChange(composerGuarded); return () => onGuardChange(false); }, [composerGuarded, onGuardChange]);
  useEffect(() => () => submitController.current?.abort(), []);
  useEffect(() => {
    setScripts((current) => current[draft.revision] === draft.script ? current : { ...current, [draft.revision]: draft.script });
  }, [draft.revision, draft.script]);

  const fetchConversation = useCallback(async (signal: AbortSignal) => {
    const sequence = ++querySequence.current;
    const next = await api.getConversation(testId, editingSessionId, signal);
    if (signal.aborted) return undefined;
    if (sequence === querySequence.current) { setConversation(next); setLoadError(undefined); }
    // 重開對話時可接續既有任務；後續狀態由共用 Run 輪詢負責。
    if (next.activeRunId && !runsRef.current.some((run) => run.id === next.activeRunId)) {
      const active = await api.getRun(next.activeRunId, signal);
      if (!signal.aborted && sequence === querySequence.current) onRun(active);
    }
    return next;
  }, [api, testId, editingSessionId, onRun]);

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    fetchConversation(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    });
    return () => controller.abort();
  }, [fetchConversation, refreshRevision]);

  const lastAuthor = runs.find((run) => run.kind === 'author' && run.authorMode !== 'summary');
  const conversationRun = runs.find((run) => run.id === conversation?.activeRunId);
  const trackedId = (conversationRun?.authorMode === 'summary' ? undefined : conversation?.activeRunId) || lastAuthor?.id || sentRunId;
  const trackedRun = runs.find((run) => run.id === trackedId);
  const authorActive = Boolean((trackedId && (!trackedRun || isActiveRun(trackedRun))) || runs.some((run) => run.kind === 'author' && isActiveRun(run)));

  useEffect(() => {
    if (!authorActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await fetchConversation(controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setLoadError(`對話更新暫時失敗，將自動重試。${errorMessage(cause)}`); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2_000);
    }
    timer = setTimeout(poll, 2_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [authorActive, fetchConversation]);

  const completedKey = trackedRun && !isActiveRun(trackedRun) ? `${trackedRun.id}:${trackedRun.status}` : '';
  useEffect(() => {
    if (!completedKey || handledRuns.current.has(completedKey)) return;
    const controller = new AbortController();
    setSynchronizing(true);
    Promise.all([fetchConversation(controller.signal), api.getDraft(testId, editingSessionId, controller.signal)]).then(
      ([nextConversation, nextDraft]) => {
        if (controller.signal.aborted || !nextConversation) return;
        handledRuns.current.add(completedKey);
        setScripts((current) => ({ ...current, [nextDraft.revision]: nextDraft.script }));
        onSynchronized(nextDraft);
        onRefreshRuns();
        void onRefreshSession().catch(() => undefined);
        setSyncError(undefined); setSynchronizing(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setSyncError(`AI 任務已結束，但草稿或對話同步失敗。請重新整理對話後再繼續。${errorMessage(cause)}`);
        setSynchronizing(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, editingSessionId, completedKey, refreshRevision, fetchConversation, onSynchronized, onRefreshRuns, onRefreshSession]);

  const blocked = loading || refreshing || synchronizing || submitting || authorActive || draftDirty || draftBusy || !conversation || Boolean(loadError || syncError);
  const reason = authorActive ? 'AI 正在處理這一輪。可以先輸入下一則，完成後再送出；離開此頁也不會中斷。'
    : draftDirty ? '有未儲存的腳本修改，請先到「腳本」儲存，再送出訊息。'
      : draftBusy ? '正在處理草稿操作、同步或 revision 衝突，完成後即可送出。'
        : loadError || syncError ? '對話尚未同步，請先重新整理。' : undefined;

  async function send(overrideText?: string) {
    const outgoing = (overrideText ?? content).trim();
    const outgoingCount = Array.from(outgoing).length;
    if (submitLock.current || blocked || !outgoing || outgoingCount > 16_000) return;
    submitLock.current = true; setSubmitting(true); setSubmitError(undefined); setNote(undefined);
    const controller = new AbortController(); submitController.current = controller;
    const revision = draft.revision;
    try {
      const result = await api.sendMessage(testId, editingSessionId, outgoing, revision, controller.signal);
      if (controller.signal.aborted) return;
      setScripts((current) => ({ ...current, [revision]: draft.script }));
      onRun(result.run); setSentRunId(result.run.id);
      if (overrideText === undefined) setContent('');
      onConversationChanged();
      setNote(`訊息已送出，使用已儲存 revision ${revision}。AI 會先試跑驗證草稿，不會自動發佈。`);
      setRefreshRevision((value) => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const conflict = cause instanceof ApiError && cause.status === 409;
      setSubmitError(`${errorMessage(cause)} ${conflict ? '請確認目前已儲存 revision，或等待既有 AI 任務結束；輸入內容已保留。' : '若請求結果不明，請先重新整理對話與執行紀錄，確認是否已保存或排隊，再決定是否重送；輸入內容已保留。'}`);
      setRefreshRevision((value) => value + 1); onRefreshRuns();
    } finally { if (!controller.signal.aborted) setSubmitting(false); submitLock.current = false; }
  }

  const partialRun = lastAuthor?.authorPartial ? lastAuthor : undefined;
  // Both fields belong to the immutable source Run, never the current Draft.
  const expectedRevision = partialRun?.authorPartial?.appliedRevision ?? partialRun?.draftRevision;
  const partialMatches = Boolean(partialRun && partialRun.status === 'succeeded' &&
    (partialRun.authorMode === 'edit' || partialRun.authorMode === undefined) &&
    partialRun.testId === testId && partialRun.editingSessionId === editingSessionId &&
    expectedRevision !== undefined && expectedRevision === draft.revision);
  const canContinue = partialMatches && Boolean(api.continueAuthor) && !blocked &&
    !runs.some(isActiveRun) && !continuedSources.includes(partialRun!.id) && continueConflict !== partialRun!.id;

  async function continuePartial() {
    if (submitLock.current || !canContinue || !partialRun || expectedRevision === undefined || !api.continueAuthor) return;
    submitLock.current = true; setSubmitting(true); setSubmitError(undefined); setNote(undefined);
    const controller = new AbortController(); submitController.current = controller;
    try {
      const result = await api.continueAuthor(partialRun.id, editingSessionId, expectedRevision, controller.signal);
      if (controller.signal.aborted) return;
      if (result.run.testId !== testId || result.run.editingSessionId !== editingSessionId || result.conversationId !== conversation?.id) {
        throw new ApiError('繼續回應的測試、週期或對話不符，請重新載入確認。', 'INVALID_RESPONSE');
      }
      setContinuedSources((current) => [...current, partialRun.id]);
      onRun(result.run); setSentRunId(result.run.id); onConversationChanged();
      setNote('Server 已接受繼續請求；後續進度以 Run 狀態為準，尚未完成驗證或發佈。');
      setRefreshRevision((value) => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      // Lock all uncertain outcomes until an explicit read/confirmation. No POST retries.
      setContinueConflict(partialRun.id); setContinueChecked(undefined);
      setSubmitError(cause instanceof ApiError && cause.status === 409
        ? '繼續條件已變更或 Worker 尚未回收。請重新載入並確認草稿；不會自動改用新 revision 重送。'
        : `${errorMessage(cause)} 繼續尚未確認成功；端點可能未就緒或結果不明，請重新載入對話與草稿確認。`);
      onRefreshRuns();
    } finally { if (!controller.signal.aborted) setSubmitting(false); submitLock.current = false; }
  }

  async function reloadPartial() {
    if (submitLock.current || !partialRun) return;
    submitLock.current = true; setSubmitting(true); setContinueChecked(undefined);
    const controller = new AbortController(); submitController.current = controller;
    try {
      const [nextDraft, nextConversation] = await Promise.all([
        api.getDraft(testId, editingSessionId, controller.signal), fetchConversation(controller.signal), onRefreshSession(),
      ]);
      if (controller.signal.aborted || !nextConversation) return;
      onSynchronized(nextDraft); onRefreshRuns();
      if (nextDraft.revision === expectedRevision) {
        setContinueChecked(partialRun.id);
        setSubmitError('已重新讀取草稿；請檢視內容後明確確認。Worker 回收與 context 仍由 Server 在送出時核對。');
      } else {
        setSubmitError(`目前草稿 r${nextDraft.revision} 與來源預期 r${expectedRevision ?? '未知'} 不符；不能以新版自動繼續，請重新討論需求。`);
      }
    } catch (cause) { if (!controller.signal.aborted) setSubmitError(errorMessage(cause)); }
    finally { if (!controller.signal.aborted) setSubmitting(false); submitLock.current = false; }
  }

  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const pendingTurn = authorActive && (!lastMessage || lastMessage.role === 'user');
  const lastAssistantIndex = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1);
  const lastAssistantMessage = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;
  const lastTurnChangedDraft = lastAssistantMessage
    ? (lastAssistantMessage.proposedScript !== undefined || lastAssistantMessage.appliedRevision !== undefined)
    : undefined;
  const lastTurnTouchedPipeline = Boolean(lastTurnChangedDraft || lastAssistantMessage?.validationRunId);
  const trail = useMemo(
    () => trailFromRuns(runs, { id: editingSessionId, draftRevision: draft.revision, latestTurnChangedDraft: lastTurnChangedDraft }),
    [runs, editingSessionId, draft.revision, lastTurnChangedDraft],
  );
  // 僅在任務失敗、本輪有腳本/驗證進展、或尚未有對話但已有執行紀錄時顯示四站進度卡；AI 執行中已由對話氣泡即時顯示步驟，純對話與環境問題回報保持自然對話呈現。
  const showTrail = !planMode && ((trail.running && !pendingTurn) || (!authorActive && (trail.failed || lastTurnTouchedPipeline)) || (messages.length === 0 && runs.length > 0 && !pendingTurn));
  const activeRun = runs.find(isActiveRun);
  const scrollWatch = `${messages.length}:${pendingTurn}:${trackedRun?.progressEvents?.length ?? 0}:${trail.step}:${trail.running}:${loading}`;
  const repairPrompt = '請根據最新驗證失敗原因排查問題，先在瀏覽器試跑確認修正後再更新草稿；若是目標環境連線問題請直接回報。';

  const trailFooter = <>
    <span className="foot-note">{trail.running ? '可以離開，任務在背景繼續；完成後左欄會亮燈。' : trail.failed ? '此輪未成功。可點選「請 AI 排查並修正」或送出新訊息重試。' : trail.awaitingPublish ? '條件已就緒，等你檢視後確認發佈。' : '驗證與發佈在右側「驗證與發佈」進行。'}</span>
    <span className="foot-actions">
      {activeRun ? <CancelRunButton api={api} run={activeRun} onUpdated={onRun} /> : null}
      {trail.failed && !trail.running ? <button className="button primary compact" disabled={blocked} onClick={() => { void send(repairPrompt); }}>請 AI 排查並修正</button> : null}
      {trail.running ? <button className="button secondary compact" onClick={() => onShowTab('runs')}>監看與紀錄</button>
        : trail.awaitingPublish ? <button className="button primary compact" onClick={() => onShowTab('publish')}>前往確認發佈</button>
          : <button className="button secondary compact" onClick={() => onShowTab('publish')}>前往驗證與發佈</button>}
    </span>
  </>;

  return <div className="chat">
    <div className="chat-bar">
      <span className={`chip ${aiExploration?.available === true ? 'ok' : 'neutral'}`} title={capabilityReason(aiExploration)}>AI 探索：{aiExploration ? aiExploration.available ? '可用' : '尚未就緒' : '未知'}</span>
      <span className="chat-bar-spacer" />
      <button className="button quiet compact" disabled={draftBusy || submitting || synchronizing} onClick={onOpenManual}><ScriptIcon />工程師手動修改</button>
      <button className="rail-icon-button light small" aria-label="重新整理對話" title="重新整理對話" disabled={refreshing || submitting || synchronizing} onClick={() => { setRefreshRevision((value) => value + 1); onRefreshRuns(); }}><RefreshIcon /></button>
      {onToggleSide ? <button className={`button ${sideOpen ? 'quiet' : 'secondary'} compact side-toggle${!sideOpen ? ' is-closed' : ''}`} aria-expanded={Boolean(sideOpen)} title={sideOpen ? '收合右側面板' : '展開右側面板'} onClick={onToggleSide}><PanelIcon />{sideOpen ? '收合面板' : '展開右側欄'}{publishReady ? <span className="tab-dot ok" aria-hidden="true" /> : null}</button> : null}
    </div>
    <ChatScroll watch={scrollWatch} label="對話訊息">
      {loading ? <Loading text="正在載入對話…" /> : null}
      {loadError ? <Notice message={loadError} /> : null}
      {syncError ? <Notice message={syncError} /> : null}
      {conversation && messages.length === 0 && !pendingTurn ? <div className="chat-empty">
        <h2>要驗證什麼流程？</h2>
        <p>{planMode ? '描述 Use Case 的步驟與預期結果。AI 提出 Plan 後，由你在「驗證與發佈」確認，再逐階段產稿、驗證與檢視整批摘要。' : '用一般的話描述步驟與預期結果。AI 會先與你確認需求、在瀏覽器自我試跑並排除問題後才更新草稿；你看過報告後才會發佈。'}</p>
        {aiExploration?.available !== true ? <p className="inline-hint">AI 探索尚未確認可用，仍可送出離線訪談與改稿需求；不代表已造訪網站。</p> : null}
        <ul className="starters" aria-label="可用的開場">{STARTERS.map((text) => <li key={text}><button className="starter" onClick={() => setContent(text)}>{text}</button></li>)}</ul>
      </div> : null}
      <ol className="turns" aria-label="已儲存的對話訊息">
        {messages.map((message, index) => message.role === 'user'
          ? <UserTurn key={message.id} message={message} />
          : <ConversationMessage key={message.id} message={message} latest={index === lastAssistantIndex} scripts={scripts} draft={draft} runs={runs} apiBase={apiBase} onRefreshRuns={onRefreshRuns} onUseCandidate={onUseCandidate} onRequestRepair={() => { void send(repairPrompt); }} candidateDisabled={draftBusy || authorActive || synchronizing} />)}
        {pendingTurn ? <AssistantTurn pending>
          <AuthorLiveStatus run={trackedRun ?? activeRun} mode="edit" />
          <div className="pending-actions">
            {activeRun ? <CancelRunButton api={api} run={activeRun} onUpdated={onRun} /> : null}
            <button className="button quiet compact" onClick={() => onShowTab('runs')}>監看與紀錄</button>
          </div>
        </AssistantTurn> : null}
      </ol>
      {partialRun ? <section className="artifact partial-card" aria-label="部分完成與繼續">
        <h3>部分完成 · 預算耗盡</h3>
        <p>Run <span className="identifier">{partialRun.id}</span> · 預期草稿 revision {expectedRevision ?? '未知'}</p>
        <p className="summary-content">下一步：{partialRun.authorPartial!.nextStep}</p>
        <p>{partialRun.authorPartial!.checkpoint ? '保留最後自我試跑通過的候選結果；不等於正式驗證通過。' : '沒有自我試跑通過的 checkpoint；此輪不套用新腳本。'}</p>
        <p className="inline-hint">繼續前仍由 Server 核對週期、背景與 Worker 回收狀態。此結果不可直接發佈。</p>
        {!partialMatches ? <p className="blocked-hint">來源 Run 與目前草稿／週期不符，或缺少來源 revision，無法繼續。</p> : null}
        {!api.continueAuthor ? <p className="blocked-hint">此連線尚未提供繼續功能。</p> : null}
        {partialMatches && api.continueAuthor ? <button className="button primary" disabled={!canContinue} onClick={() => { void continuePartial(); }}>{submitting ? '處理中…' : '繼續'}</button> : null}
        {continueConflict === partialRun.id ? <div className="action-row">
          <button className="button secondary" disabled={submitting || draftDirty || draftBusy} onClick={() => { void reloadPartial(); }}>重新載入草稿與對話</button>
          {continueChecked === partialRun.id && partialMatches ? <button className="button secondary" disabled={blocked} onClick={() => { setContinueConflict(undefined); setContinueChecked(undefined); setSubmitError(undefined); }}>已檢視草稿，允許再次嘗試</button> : null}
        </div> : null}
      </section> : null}
      {showTrail && !partialRun ? <div className="trail-slot" aria-live="polite">
        <TrailCard trail={trail} title="目前進度" footer={trailFooter} />
        {trackedRun?.error ? <pre className="run-error">{trackedRun.error}</pre> : null}
        {synchronizing ? <p className="inline-hint" role="status">正在同步對話、草稿與驗證紀錄…</p> : null}
      </div> : null}
    </ChatScroll>
    <div className="composer-dock">
      {submitError ? <Notice message={submitError} /> : null}
      <Composer id="author-message" label="測試需求或修改訊息" value={content} onChange={setContent} onSubmit={() => { void send(); }} placeholder={messages.length ? '與 AI 討論驗證步驟、確認選擇器，或請 AI 排查修正草稿…' : '描述要驗證的 Playwright 測試流程與預期結果…'} sending={submitting} canSend={!blocked} reason={reason ?? (note && !content ? note : undefined)} helper={`僅處理 Playwright 驗測腳本討論 · 使用已儲存 revision ${draft.revision} · Enter 送出`} />
      {publishReady ? <p className="dock-hint">驗證與摘要已就緒；繼續送出訊息若修改草稿，將使目前的驗證與摘要失效。</p> : null}
    </div>
  </div>;
}

function ScriptChange({ message, scripts, draft, candidateDisabled, run, onUseCandidate }: { message: Message; scripts: Record<number, string>; draft: Draft; candidateDisabled: boolean; run?: Run; onUseCandidate: (script: string) => boolean }) {
  const [appliedToEditor, setAppliedToEditor] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const before = message.baseScript ?? (message.baseRevision == null ? undefined : scripts[message.baseRevision]);
  const after = message.proposedScript ?? (message.appliedRevision == null ? undefined : scripts[message.appliedRevision]);
  const isCandidate = message.proposedScript !== undefined && message.appliedRevision == null;
  const lines = useMemo(() => before !== undefined && after !== undefined ? diffLines(before, after) : undefined, [before, after]);
  const stat = lines ? diffStat(lines) : undefined;
  const items = useMemo(() => lines ? (expanded ? lines : collapseDiff(lines, 1)) : undefined, [lines, expanded]);
  const title = `腳本變更 · ${message.baseRevision != null ? `revision ${message.baseRevision} → ` : ''}${isCandidate ? '候選（未套用）' : `revision ${message.appliedRevision}`}`;
  return <section className="artifact script-change" aria-label={title}>
    <header className="artifact-head"><strong>{title}</strong>
      <span className="artifact-meta">{stat ? <><span className="add">+{stat.added}</span><span className="del">−{stat.removed}</span></> : null}
        <span className={`chip ${isCandidate ? 'warm' : 'ok'}`}>{isCandidate ? '尚未套用' : '已套用至草稿'}</span></span></header>
    {items ? (stat && stat.added + stat.removed === 0 ? <p className="artifact-note">腳本沒有變更。</p> : <pre className="diff" tabIndex={0}>{items.map((item, index) => item.kind === 'skip'
      ? <button key={index} className="diff-skip" onClick={() => setExpanded(true)}>展開未變更的 {item.count} 行</button>
      : <span key={index} className={`diff-line ${item.kind}`}><i>{item.after ?? item.before}</i><b aria-hidden="true">{item.kind === 'add' ? '+' : item.kind === 'del' ? '−' : ' '}</b>{item.text || ' '}{'\n'}</span>)}</pre>)
      : <div className="code-comparison">
        <section><h4>變更前{message.baseRevision != null ? ` · revision ${message.baseRevision}` : ''}</h4>{before === undefined ? <p className="muted">此歷史訊息未附原始腳本快照，本分頁無法還原。未使用目前腳本冒充舊稿。</p> : <pre>{before || '（空腳本）'}</pre>}</section>
        <section><h4>{isCandidate ? '候選腳本 · 未套用' : `變更後 · revision ${message.appliedRevision}`}</h4>{after === undefined ? <p className="muted">此歷史 revision 的腳本未由 API 提供；目前草稿為 revision {draft.revision}。</p> : <pre>{after || '（空腳本）'}</pre>}</section>
      </div>}
    {expanded && lines ? <footer className="artifact-foot"><button className="button quiet compact" onClick={() => setExpanded(false)}>只看變更處</button></footer> : null}
    {isCandidate ? <footer className="artifact-foot"><span className="foot-note">候選不會覆蓋目前草稿；只帶入本機編輯器，需儲存並重新驗證。{run?.status !== 'succeeded' ? '失敗或取消的任務不能套用。' : ''}</span>
      <span className="foot-actions"><button className="button secondary compact" disabled={candidateDisabled || run?.status !== 'succeeded'} onClick={() => { if (onUseCandidate(message.proposedScript!)) setAppliedToEditor(true); }}>將候選帶入編輯器</button></span>
      {appliedToEditor ? <p className="action-message" role="status">已帶入編輯器，尚未儲存或發佈。</p> : null}</footer> : null}
  </section>;
}

function ConversationMessage({ message, latest, scripts, draft, runs, apiBase, onRefreshRuns, onUseCandidate, onRequestRepair, candidateDisabled }: {
  message: Message; latest: boolean; scripts: Record<number, string>; draft: Draft; runs: Run[]; apiBase: string;
  onRefreshRuns: () => void; onUseCandidate: (script: string) => boolean; onRequestRepair: () => void; candidateDisabled: boolean;
}) {
  const run = runs.find((item) => item.id === message.runId);
  const validation = runs.find((item) => item.id === message.validationRunId);
  const hasScript = message.proposedScript !== undefined || message.appliedRevision !== undefined;
  const validationFailed = Boolean(validation && isBadStatus(validation.status));
  return <AssistantTurn time={message.createdAt}>
    {message.content ? <p className="message-content">{message.content}</p> : null}
    {hasScript ? <ScriptChange message={message} scripts={scripts} draft={draft} candidateDisabled={candidateDisabled} run={run} onUseCandidate={onUseCandidate} /> : null}
    {message.validationRunId ? <section className="artifact validation" aria-label="續接驗證">
      <header className="artifact-head"><strong>續接驗證</strong>{validation ? <RunStatusBadge run={validation} /> : null}</header>
      <div className="artifact-body">{validation ? <><ReportLink reportUrl={validation.reportUrl} apiBase={apiBase} label="查看續接驗證報告" />{validation.error ? <pre className="run-error">{validation.error}</pre> : null}</> : <button className="button quiet compact" onClick={onRefreshRuns}>重新整理驗證紀錄</button>}</div>
      {validationFailed && latest ? <footer className="artifact-foot">
        <span className="foot-note">驗證未通過，可請 AI 依據錯誤訊息試跑排查或回報環境問題。</span>
        <span className="foot-actions"><button className="button secondary compact" disabled={candidateDisabled} onClick={onRequestRepair}>請 AI 排查並修正</button></span>
      </footer> : null}
    </section> : null}
    {latest ? <span className="sr-only">最新一則 AI 回覆</span> : null}
  </AssistantTurn>;
}
