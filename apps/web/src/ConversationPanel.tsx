import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage } from './api';
import { formatDate, Loading, Notice, ReportLink, RunStatusBadge } from './components';
import { CancelRunButton } from './TestActions';
import { isActiveRun } from './types';
import type { Conversation, Draft, Message, Run, WhippetApi } from './types';

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
}

export function ConversationPanel({ api, apiBase, testId, draft, draftDirty, draftBusy, runs, onRun, onRefreshRuns, onSynchronized, onUseCandidate }: Props) {
  const [conversation, setConversation] = useState<Conversation>();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [synchronizing, setSynchronizing] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [sentRunId, setSentRunId] = useState<string>();
  const [scripts, setScripts] = useState<Record<number, string>>({ [draft.revision]: draft.script });
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const querySequence = useRef(0);
  const handledRuns = useRef(new Set<string>());
  const submitLock = useRef(false);
  const submitController = useRef<AbortController | null>(null);
  useEffect(() => () => submitController.current?.abort(), []);
  useEffect(() => {
    setScripts((current) => current[draft.revision] === draft.script ? current : { ...current, [draft.revision]: draft.script });
  }, [draft.revision, draft.script]);

  const fetchConversation = useCallback(async (signal: AbortSignal) => {
    const sequence = ++querySequence.current;
    const next = await api.getConversation(testId, signal);
    if (signal.aborted) return undefined;
    if (sequence === querySequence.current) { setConversation(next); setLoadError(undefined); }
    // 重開對話時可接續既有任務；後續狀態由共用 Run 輪詢負責。
    if (next.activeRunId && !runsRef.current.some((run) => run.id === next.activeRunId)) {
      const active = await api.getRun(next.activeRunId, signal);
      if (!signal.aborted && sequence === querySequence.current) onRun(active);
    }
    return next;
  }, [api, testId, onRun]);

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

  const lastAuthor = runs.find((run) => run.kind === 'author');
  const trackedId = conversation?.activeRunId || lastAuthor?.id || sentRunId;
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
    Promise.all([fetchConversation(controller.signal), api.getDraft(testId, controller.signal)]).then(
      ([nextConversation, nextDraft]) => {
        if (controller.signal.aborted || !nextConversation) return;
        handledRuns.current.add(completedKey);
        setScripts((current) => ({ ...current, [nextDraft.revision]: nextDraft.script }));
        onSynchronized(nextDraft);
        onRefreshRuns();
        setSyncError(undefined); setSynchronizing(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setSyncError(`AI 任務已結束，但草稿或對話同步失敗。請重新整理對話後再繼續。${errorMessage(cause)}`);
        setSynchronizing(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, completedKey, refreshRevision, fetchConversation, onSynchronized, onRefreshRuns]);

  const characterCount = Array.from(content).length;
  const blocked = loading || refreshing || synchronizing || submitting || authorActive || draftDirty || draftBusy || !conversation || Boolean(loadError || syncError);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (submitLock.current || blocked || !content.trim() || characterCount > 16_000) return;
    submitLock.current = true; setSubmitting(true); setSubmitError(undefined); setNote(undefined);
    const controller = new AbortController(); submitController.current = controller;
    const revision = draft.revision;
    try {
      const result = await api.sendMessage(testId, content.trim(), revision, controller.signal);
      if (controller.signal.aborted) return;
      setScripts((current) => ({ ...current, [revision]: draft.script }));
      onRun(result.run); setSentRunId(result.run.id); setContent('');
      setNote(`訊息已送出，使用已儲存 revision ${revision}。AI 只會修改草稿，不會自動發佈。`);
      setRefreshRevision((value) => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const conflict = cause instanceof ApiError && cause.status === 409;
      setSubmitError(`${errorMessage(cause)} ${conflict ? '請確認目前已儲存 revision，或等待既有 AI 任務結束；輸入內容已保留。' : '若請求結果不明，請先重新整理對話與執行紀錄，確認是否已保存或排隊，再決定是否重送；輸入內容已保留。'}`);
      setRefreshRevision((value) => value + 1); onRefreshRuns();
    } finally { if (!controller.signal.aborted) setSubmitting(false); submitLock.current = false; }
  }

  return <section className="conversation-panel" aria-labelledby="conversation-title">
    <div className="section-heading"><h3 id="conversation-title">AI 測試對話</h3>
      <button className="button secondary compact" disabled={refreshing || submitting || synchronizing} onClick={() => { setRefreshRevision((value) => value + 1); onRefreshRuns(); }}>重新整理對話</button></div>
    <p className="inline-hint">對話由 Server 保存。說明測試需求或修改方式，AI 產生的內容仍需驗證並由你確認發佈。</p>
    {loading ? <Loading text="正在載入對話…" /> : null}
    {loadError ? <Notice message={loadError} /> : null}
    {syncError ? <Notice message={syncError} /> : null}
    {conversation?.messages.length === 0 ? <p className="conversation-empty">尚無對話。可以描述要測試的流程、頁面內容與預期結果。</p> : null}
    <ol className="message-list" aria-label="已儲存的對話訊息">{conversation?.messages.map((message) => <ConversationMessage key={message.id} message={message} scripts={scripts} draft={draft} runs={runs} apiBase={apiBase} onRefreshRuns={onRefreshRuns} onUseCandidate={onUseCandidate} candidateDisabled={draftBusy || authorActive || synchronizing} />)}</ol>
    {trackedId ? <div className="author-state" aria-live="polite">
      <div className="validation-summary"><strong>AI 撰寫狀態</strong>{trackedRun ? <RunStatusBadge run={trackedRun} /> : <span className="muted">正在讀取任務狀態…</span>}
        {trackedRun ? <CancelRunButton api={api} run={trackedRun} onUpdated={onRun} /> : null}</div>
      <p className="run-id">Run <span className="identifier">{trackedId}</span></p>
      {trackedRun?.error ? <pre className="run-error">{trackedRun.error}</pre> : null}
      {trackedRun?.status === 'succeeded' ? <p className="inline-hint">撰寫完成不代表測試通過；請檢視套用結果與驗證報告。</p> : null}
      {trackedRun && !isActiveRun(trackedRun) && trackedRun.status !== 'succeeded' ? <p className="inline-hint">此輪未成功套用候選腳本。已儲存的對話與草稿保留，狀態同步後可送出新訊息重試。</p> : null}
      {authorActive ? <p className="inline-hint">每 2 秒更新；排隊或執行期間仍可取消。暫時離開不會自動重跑任務。</p> : null}
      {synchronizing ? <p className="inline-hint" role="status">正在同步對話、草稿與驗證紀錄…</p> : null}
    </div> : null}
    <form onSubmit={send}>
      <label className="field-label" htmlFor="author-message">測試需求或修改訊息</label>
      <textarea id="author-message" className="text-input" rows={4} value={content} disabled={submitting} onChange={(event) => setContent(event.target.value)} aria-describedby="author-message-help" />
      <p id="author-message-help" className="inline-hint">使用已儲存 revision {draft.revision} · {characterCount.toLocaleString('zh-TW')} / 16,000 字元</p>
      {draftDirty ? <p className="blocked-hint" role="status">有未儲存的腳本編輯，請先儲存草稿再送出訊息。</p> : draftBusy ? <p className="blocked-hint">請先完成草稿操作、同步或處理 revision 衝突，再送出訊息。</p> : null}
      {characterCount > 16_000 ? <p className="blocked-hint">訊息超過 16,000 字元，請縮短內容後再送出。</p> : null}
      <div className="action-row"><button className="button primary" type="submit" disabled={blocked || !content.trim() || characterCount > 16_000}>{submitting ? '送出中…' : authorActive ? 'AI 任務進行中' : '送出訊息'}</button></div>
    </form>
    {submitError ? <Notice message={submitError} /> : null}
    {note ? <p className="action-message" role="status">{note}</p> : null}
  </section>;
}

function ConversationMessage({ message, scripts, draft, runs, apiBase, onRefreshRuns, onUseCandidate, candidateDisabled }: {
  message: Message; scripts: Record<number, string>; draft: Draft; runs: Run[]; apiBase: string;
  onRefreshRuns: () => void; onUseCandidate: (script: string) => boolean; candidateDisabled: boolean;
}) {
  const [appliedToEditor, setAppliedToEditor] = useState(false);
  const run = runs.find((item) => item.id === message.runId);
  const validation = runs.find((item) => item.id === message.validationRunId);
  const before = message.baseScript ?? (message.baseRevision == null ? undefined : scripts[message.baseRevision]);
  const after = message.proposedScript ?? (message.appliedRevision == null ? undefined : scripts[message.appliedRevision]);
  const hasScript = message.proposedScript !== undefined || message.appliedRevision !== undefined;
  const isCandidate = message.proposedScript !== undefined && message.appliedRevision == null;
  return <li className={`conversation-message ${message.role}`}>
    <div className="message-heading"><strong>{message.role === 'user' ? '你' : 'AI 助手'}</strong><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></div>
    <p className="message-content">{message.content}</p>
    {message.baseRevision != null ? <p className="inline-hint">基於 revision {message.baseRevision}{message.appliedRevision != null ? ` · 已套用至 revision ${message.appliedRevision}` : ''}</p> : null}
    {message.role === 'assistant' && hasScript ? <>
      <p className="script-outcome">{isCandidate ? '候選腳本尚未套用，不會覆蓋目前草稿。' : `已套用至草稿 revision ${message.appliedRevision}，尚未自動發佈。`}</p>
      <details className="script-comparison"><summary>查看腳本前後對照</summary><div className="code-comparison">
        <section><h4>變更前 · revision {message.baseRevision ?? '未知'}</h4>{before === undefined ? <p className="muted">此歷史訊息未附原始腳本快照，本分頁無法還原。未使用目前腳本冒充舊稿。</p> : <pre>{before || '（空腳本）'}</pre>}</section>
        <section><h4>{isCandidate ? '候選腳本 · 未套用' : `變更後 · revision ${message.appliedRevision}`}</h4>{after === undefined ? <p className="muted">此歷史 revision 的腳本未由 API 提供；目前草稿為 revision {draft.revision}。</p> : <pre>{after || '（空腳本）'}</pre>}</section>
      </div></details>
      {isCandidate ? <><button className="button secondary compact" disabled={candidateDisabled || run?.status !== 'succeeded'} onClick={() => { if (onUseCandidate(message.proposedScript!)) setAppliedToEditor(true); }}>將候選腳本帶入編輯器</button>
        <p className="inline-hint">只帶入本機編輯器，請確認最新草稿後儲存並重新驗證；失敗或取消的任務不能套用。</p>
        {appliedToEditor ? <p className="action-message" role="status">已帶入編輯器，尚未儲存或發佈。</p> : null}</> : null}
    </> : null}
    {message.role === 'assistant' && !hasScript ? <p className="inline-hint">此回覆未提供腳本變更，草稿保持原樣。</p> : null}
    {message.validationRunId ? <div className="message-validation"><strong>續接驗證</strong>{validation ? <><RunStatusBadge run={validation} /><ReportLink reportUrl={validation.reportUrl} apiBase={apiBase} label="查看續接驗證報告" />{validation.error ? <pre className="run-error">{validation.error}</pre> : null}</> : <button className="button quiet compact" onClick={onRefreshRuns}>重新整理驗證紀錄</button>}</div> : null}
  </li>;
}
