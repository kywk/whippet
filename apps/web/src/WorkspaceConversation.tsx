import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage } from './api';
import { formatDate, Loading, Notice, RunStatusBadge } from './components';
import { CancelRunButton } from './TestActions';
import { WorkspaceAvailability, WorkspaceSettings } from './WorkspaceSettings';
import { WorkspaceProposalCard } from './WorkspaceProposal';
import { WorkspaceCredentials } from './WorkspaceCredentials';
import { isActiveRun } from './types';
import type { Run, WhippetApi, WorkspaceConversationData, WorkspaceDetail, WorkspaceProposal } from './types';

interface Props {
  api: WhippetApi; apiBase: string; workspace?: WorkspaceDetail; active: boolean;
  onReturn: () => void; onDirtyChange: (dirty: boolean) => void;
  onCreated: (workspace: WorkspaceDetail) => void; onWorkspaceUpdated: (workspace: WorkspaceDetail) => void;
  onRefreshList: () => void;
}

export function WorkspaceConversation(props: Props) {
  return props.workspace ? <WorkspaceInterview {...props} workspace={props.workspace} /> : <CreateWorkspace {...props} />;
}

function CreateWorkspace({ api, onReturn, onCreated, onDirtyChange, onRefreshList }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useLeaveGuard(Boolean(name) || busy, onDirtyChange);
  useEffect(() => () => controller.current?.abort(), []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (new TextEncoder().encode(name.trim()).length > 200) { setError('Workspace 名稱最多 200 UTF-8 bytes，請縮短名稱。'); return; }
    lock.current = true; setBusy(true); setError(undefined);
    const request = new AbortController(); controller.current = request;
    try { const workspace = await api.createWorkspace(name.trim() || undefined, request.signal); if (!request.signal.aborted) onCreated(workspace); }
    catch (cause) { if (!request.signal.aborted) setError(`${errorMessage(cause)} 若結果不明，請先重新載入 Workspace 列表確認，避免重複建立。`); }
    finally { lock.current = false; if (!request.signal.aborted) setBusy(false); }
  }
  return <section id="workspace-conversation" className="workspace-conversation" aria-labelledby="workspace-create-title">
    <div className="workspace-conversation-heading"><div><h2 id="workspace-create-title">建立 Workspace</h2><p>先建立未啟用的工作區，再透過獨立對話整理目標與背景。</p></div><button className="button secondary" disabled={busy} onClick={onReturn}>返回測試工作台</button></div>
    <form className="workspace-create-form" onSubmit={(event) => { void create(event); }}><label className="settings-field">Workspace 名稱（選填）<input className="text-input" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} autoComplete="off" /></label><p className="inline-hint">建立本身不啟用設定、不探索網站，也不執行測試。</p><div className="action-row"><button className="button primary" type="submit" disabled={busy}>{busy ? '建立中…' : '建立並開始訪談'}</button><button className="button quiet" type="button" disabled={busy} onClick={onRefreshList}>重新載入 Workspace 列表</button></div></form>
    {error ? <Notice message={error} /> : null}
  </section>;
}

function WorkspaceInterview({ api, apiBase, workspace, active, onReturn, onDirtyChange, onWorkspaceUpdated }: Props & { workspace: WorkspaceDetail }) {
  const [current, setCurrent] = useState(workspace);
  const [conversation, setConversation] = useState<WorkspaceConversationData>();
  const [content, setContent] = useState('');
  const [run, setRun] = useState<Run>();
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [credentialGuard, setCredentialGuard] = useState({ dirty: false, busy: false });
  const [loadError, setLoadError] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const sequence = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const sendLock = useRef(false);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);
  const refresh = useCallback(async () => {
    const request = new AbortController(); controllers.current.add(request);
    const turn = ++sequence.current; setRefreshing(true);
    try {
      const [next, messages] = await Promise.all([api.getWorkspace(workspace.id, request.signal), api.getWorkspaceConversation(workspace.id, request.signal)]);
      if (messages.id !== next.conversationId || (next.currentProposal && next.currentProposal.conversationId !== messages.id)) throw new ApiError('設定對話或提案關聯不符。', 'WORKSPACE_CONFLICT');
      if (!request.signal.aborted && turn === sequence.current) { setCurrent(next); setConversation(messages); setLoadError(undefined); setFresh(true); onWorkspaceUpdated(next); }
    } catch (cause) {
      if (!request.signal.aborted && turn === sequence.current) { setLoadError(errorMessage(cause)); setFresh(false); }
      throw cause;
    } finally { controllers.current.delete(request); if (!request.signal.aborted && turn === sequence.current) setRefreshing(false); }
  }, [api, workspace.id, onWorkspaceUpdated]);
  useEffect(() => { if (active) void refresh().catch(() => undefined); }, [active, refresh]);
  const recentRunId = [...(conversation?.messages ?? [])].reverse().find((message) => message.runId)?.runId;
  const trackedId = conversation?.activeRunId ?? current.activeRunId ?? recentRunId ?? run?.id ?? current.currentProposal?.sourceRunId;
  const runActive = Boolean(trackedId && (!run || run.id !== trackedId || isActiveRun(run)));
  useEffect(() => {
    if (!trackedId) return;
    const request = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await api.getRun(trackedId!, request.signal);
        if (next.workspaceId !== workspace.id || next.testId !== null || next.authorMode !== 'workspace') throw new ApiError('設定任務所屬 Workspace 不符。', 'WORKSPACE_CONFLICT');
        if (request.signal.aborted) return;
        setRun(next); setRunError(undefined);
        if (isActiveRun(next)) timer = setTimeout(poll, 2_000);
        else await refresh();
      } catch (cause) { if (!request.signal.aborted) { setRunError(`任務狀態同步失敗。${errorMessage(cause)}`); timer = setTimeout(poll, 2_000); } }
    }
    void poll();
    return () => { request.abort(); clearTimeout(timer); };
  }, [api, workspace.id, trackedId, refresh]);
  const mutating = sending || proposalBusy || credentialGuard.busy;
  useLeaveGuard(Boolean(content) || mutating || credentialGuard.dirty || runActive, onDirtyChange);
  const reportCredentialGuard = useCallback((state: { dirty: boolean; busy: boolean }) => setCredentialGuard(state), []);
  const canSend = fresh && conversation && !refreshing && !mutating && !runActive && !credentialGuard.dirty;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (sendLock.current || !canSend || !conversation || !content.trim() || Array.from(content).length > 16_000) return;
    sendLock.current = true; setSending(true); setSendError(undefined); setNote(undefined); setFresh(false); ++sequence.current;
    const request = new AbortController(); controllers.current.add(request);
    try {
      const result = await api.sendWorkspaceMessage(workspace.id, { content: content.trim(), revision: current.revision, contextRevision: conversation.contextRevision }, request.signal);
      if (request.signal.aborted) return;
      if (result.conversationId !== conversation.id) throw new ApiError('回應的設定對話不符。', 'WORKSPACE_CONFLICT');
      setContent(''); setRun(result.run); setConversation((previous) => previous ? { ...previous, activeRunId: result.run.id } : previous); setCurrent((previous) => ({ ...previous, activeRunId: result.run.id })); setNote('訊息已保存並排入設定訪談。AI 只會提出候選設定，不會自動確認、探索或啟用。');
      try { await refresh(); } catch { setSendError('訊息已送出，但對話同步失敗。請先重新載入，不要直接重送。'); }
    } catch (cause) {
      if (!request.signal.aborted) { setSendError(`${errorMessage(cause)} 輸入已保留；請先重新載入對話與任務狀態，不會自動重送。`); void refresh().catch(() => undefined); }
    } finally { controllers.current.delete(request); sendLock.current = false; if (!request.signal.aborted) setSending(false); }
  }
  function proposalUpdated(proposal: WorkspaceProposal, next?: WorkspaceDetail) {
    ++sequence.current; setRefreshing(false);
    const updated = next ?? { ...current, currentProposal: proposal }; setCurrent(updated); onWorkspaceUpdated(updated);
    setNote(proposal.status === 'applied' ? `提案已套用於正式設定 revision ${proposal.appliedRevision}。` : proposal.status === 'cancelled' ? 'Server 已取消提案，正式設定未被取代。' : proposal.scopeConfirmed ? 'Server 已保存提案範圍確認；這不代表已探索網站。' : '提案狀態已更新。');
    setFresh(false);
  }
  function returnToTests() {
    if (mutating) return;
    if (credentialGuard.dirty && !window.confirm('返回測試工作台會清除尚未保存的帳密；一般未送出訊息會保留。確定繼續？')) return;
    onReturn();
  }
  return <section id="workspace-conversation" className="workspace-conversation" aria-labelledby="workspace-conversation-title">
    <div className="workspace-conversation-heading"><div><h2 id="workspace-conversation-title">Workspace 對話：{current.name}</h2><p>獨立持久訪談 · 設定 revision {current.revision} · {({ draft: '建立中', needs_confirmation: '舊資料待確認', active: '已啟用' })[current.lifecycle]}</p></div><button className="button secondary" disabled={mutating} onClick={returnToTests}>返回測試工作台</button></div>
    <WorkspaceAvailability workspace={current} />
    <div className="action-row"><button className="button secondary compact" disabled={refreshing || mutating} onClick={() => { void refresh().catch(() => undefined); }}>{refreshing ? '載入中…' : '重新載入設定對話'}</button></div>
    {loadError ? <Notice message={loadError} /> : null}
    <div className="workspace-conversation-layout">
      <section className="workspace-interview" aria-labelledby="workspace-chat-title"><h3 id="workspace-chat-title">Workspace 設定對話</h3>
        {!conversation && refreshing ? <Loading text="正在載入持久設定對話…" /> : null}
        {conversation?.messages.length === 0 ? <p className="conversation-empty">描述網站用途、驗測目標與非機密背景。AI 會先訪談，再提出可供確認的設定提案。</p> : null}
        <ol className="message-list" aria-label="已儲存的 Workspace 訊息">{conversation?.messages.map((message) => <li key={message.id} className={`conversation-message ${message.role}`}><div className="message-heading"><strong>{message.role === 'user' ? '你' : 'Workspace 助手'}</strong><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></div><p className="message-content">{message.content}</p></li>)}</ol>
        {trackedId ? <div className="author-state" aria-live="polite"><div className="validation-summary"><strong>設定訪談狀態</strong>{run?.id === trackedId ? <><RunStatusBadge run={run} /><CancelRunButton api={api} run={run} onUpdated={(next) => { setRun(next); void refresh().catch(() => undefined); }} /></> : <span>讀取中…</span>}</div><p className="identifier version-id">Run {trackedId}</p>{run?.error ? <pre className="run-error">{run.error}</pre> : null}<p className="inline-hint">訪談完成不代表已探索網站或執行測試；失敗後需明確送出訊息重試，不會自動重跑。</p></div> : null}
        {run?.status === 'failed' ? <p className="blocked-hint">請依任務錯誤修正需求或設定提案；origin 集合衝突不會由前端自動移除、合併或放寬。</p> : null}
        {runError ? <Notice message={runError} /> : null}
        <form className="conversation-composer" onSubmit={(event) => { void send(event); }}><label className="field-label" htmlFor="workspace-message">Workspace 需求或修改訊息</label><textarea id="workspace-message" className="text-input" rows={4} value={content} disabled={sending} onChange={(event) => setContent(event.target.value)} aria-describedby="workspace-message-help" /><p id="workspace-message-help" className="inline-hint">請勿填帳密、token 或 API key；登入資料只用右側專用欄位。使用設定 revision {current.revision}、對話版本 {conversation?.contextRevision ?? '尚未取得'}。</p><p className="inline-hint">{Array.from(content).length.toLocaleString('zh-TW')} / 16,000 字元 · 返回測試工作台保留一般未送出文字，秘密欄位會清空。</p><div className="action-row"><button className="button primary" disabled={!canSend || !content.trim() || Array.from(content).length > 16_000}>{sending ? '送出中…' : runActive ? '設定訪談進行中' : '送出 Workspace 訊息'}</button></div></form>
        {sendError ? <Notice message={sendError} /> : null}{note ? <p className="action-message" role="status">{note}</p> : null}
        {conversation?.conversationSummary ? <details className="session-background"><summary>查看 Workspace 對話背景</summary><p className="summary-content">{conversation.conversationSummary}</p></details> : null}
      </section>
      <aside className="workspace-proposal-side" aria-label="Workspace 設定與提案">
        {current.currentProposal && conversation ? <WorkspaceProposalCard key={current.currentProposal.id} api={api} workspace={current} proposal={current.currentProposal} contextRevision={conversation.contextRevision} blocked={!fresh || refreshing || sending || runActive || credentialGuard.busy || credentialGuard.dirty || Boolean(content)} onUpdated={proposalUpdated} onBusyChange={setProposalBusy} onRefresh={refresh} /> : <section className="workspace-proposal" aria-label="設定提案"><h3>設定提案</h3><p className="mode-empty">尚未取得提案。正式設定保持原樣，請先透過訪談說明目標與必要資訊。</p></section>}
        {active ? <WorkspaceCredentials api={api} apiBase={apiBase} workspace={current} blocked={!fresh || refreshing || sending || proposalBusy} onGuardChange={reportCredentialGuard} onRefresh={refresh} /> : null}
        <details className="workspace-current-details"><summary>查看目前正式設定（唯讀）</summary><WorkspaceSettings workspace={current} /></details>
      </aside>
    </div>
  </section>;
}

function useLeaveGuard(guarded: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(guarded);
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    if (guarded) window.addEventListener('beforeunload', beforeUnload);
    return () => { onDirtyChange(false); window.removeEventListener('beforeunload', beforeUnload); };
  }, [guarded, onDirtyChange]);
}
