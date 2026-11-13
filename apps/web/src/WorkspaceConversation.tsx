import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ApiError, errorMessage } from './api';
import { Loading, Notice, RunStatusBadge } from './components';
import { AssistantTurn, ChatScroll, Composer, UserTurn, useStoredText } from './chat';
import { CancelRunButton } from './TestActions';
import { AuthorLiveStatus } from './trail';
import { LiveView } from './LiveView';
import { WorkspaceAvailability, WorkspaceSettings } from './WorkspaceSettings';
import { WorkspaceProposalCard } from './WorkspaceProposal';
import { WorkspaceCredentials } from './WorkspaceCredentials';
import { isActiveRun } from './types';
import { ArrowRightIcon, CloseIcon, EyeIcon, PanelIcon, RefreshIcon } from './icons';
import type { Run, WhippetApi, WorkspaceConversationData, WorkspaceDetail, WorkspaceProposal } from './types';

interface Props {
  api: WhippetApi; apiBase: string; workspace?: WorkspaceDetail; active: boolean;
  onReturn: () => void; onDirtyChange: (dirty: boolean) => void;
  onCreated: (workspace: WorkspaceDetail) => void; onWorkspaceUpdated: (workspace: WorkspaceDetail) => void;
  onRefreshList: () => void;
}

type WsSideTab = 'proposal' | 'credentials' | 'settings';

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
  return <section id="workspace-conversation" className="workspace-create-wrap" aria-labelledby="workspace-create-title">
    <div className="workspace-create-card">
      <div className="workspace-create-head">
        <div><h1 id="workspace-create-title">建立 Workspace</h1><p>先建立未啟用的工作區，再透過對話整理驗測目標、網站範圍與登入角色。</p></div>
        <button className="button secondary compact" disabled={busy} onClick={onReturn}>返回測試工作台</button>
      </div>
      <form className="workspace-create-form" onSubmit={(event) => { void create(event); }}>
        <label className="settings-field">Workspace 名稱（選填）<input className="text-input" value={name} disabled={busy} placeholder="例如：電商結帳 QA" onChange={(event) => setName(event.target.value)} autoComplete="off" /></label>
        <p className="inline-hint">建立本身不啟用設定、不探索網站，也不執行測試。</p>
        <div className="action-row">
          <button className="button primary" type="submit" disabled={busy}>{busy ? '建立中…' : '建立並開始訪談'}<ArrowRightIcon /></button>
          <button className="button quiet" type="button" disabled={busy} onClick={onRefreshList}>重新載入 Workspace 列表</button>
        </div>
      </form>
      {error ? <Notice message={error} /> : null}
    </div>
  </section>;
}

function WorkspaceInterview({ api, apiBase, workspace, active, onReturn, onDirtyChange, onWorkspaceUpdated }: Props & { workspace: WorkspaceDetail }) {
  const [current, setCurrent] = useState(workspace);
  const [conversation, setConversation] = useState<WorkspaceConversationData>();
  const [content, setContent] = useStoredText(`workspace-${workspace.id}`);
  const [run, setRun] = useState<Run>();
  const [liveSelection, setLiveSelection] = useState<Run>();
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [credentialGuard, setCredentialGuard] = useState({ dirty: false, busy: false });
  const [loadError, setLoadError] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const [sideTab, setSideTab] = useState<WsSideTab>('proposal');
  const [sideOpen, setSideOpen] = useState(false);
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
  const explorationAvailable = current.capabilities?.aiExploration?.available === true;
  const liveRun = liveSelection?.id === run?.id ? run : liveSelection;

  useEffect(() => {
    setLiveSelection((selected) => {
      if (!selected || !active) return undefined;
      const updated = selected.id === run?.id ? run : selected;
      return updated && (!explorationAvailable && isActiveRun(updated)) ? undefined : updated;
    });
  }, [active, explorationAvailable, run]);

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
  // 背景執行的訪談與一般未送出的草稿文字不綁住頁面切換，只保護正在送出的請求或未保存帳密。
  useLeaveGuard(mutating || credentialGuard.dirty, onDirtyChange);
  const reportCredentialGuard = useCallback((state: { dirty: boolean; busy: boolean }) => setCredentialGuard(state), []);
  const canSend = Boolean(fresh && conversation && !refreshing && !mutating && !runActive && !credentialGuard.dirty);

  async function send() {
    if (sendLock.current || !canSend || !conversation || !content.trim() || Array.from(content).length > 16_000) return;
    sendLock.current = true; setSending(true); setSendError(undefined); setNote(undefined); setFresh(false); ++sequence.current;
    const request = new AbortController(); controllers.current.add(request);
    try {
      const result = await api.sendWorkspaceMessage(workspace.id, { content: content.trim(), revision: current.revision, contextRevision: conversation.contextRevision }, request.signal);
      if (request.signal.aborted) return;
      if (result.conversationId !== conversation.id) throw new ApiError('回應的設定對話不符。', 'WORKSPACE_CONFLICT');
      setContent(''); setRun(result.run); setConversation((previous) => previous ? { ...previous, activeRunId: result.run.id } : previous); setCurrent((previous) => ({ ...previous, activeRunId: result.run.id })); setNote('訊息已保存並排入設定任務。AI 只能依 Server 已確認範圍與工具許可探索；未取得許可時只進行訪談，不會自動套用提案。');
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
    setLiveSelection(undefined);
    onReturn();
  }

  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const pendingTurn = runActive && (!lastMessage || lastMessage.role === 'user');
  const lifecycleLabel = ({ draft: '建立中', needs_confirmation: '舊資料待確認', active: '已啟用' })[current.lifecycle];
  const reason = runActive ? '設定訪談正在背景進行。你可以先編輯下一則，或返回測試工作台，完成後會保存。'
    : credentialGuard.dirty ? '右側有未保存的帳密欄位，請先保存或清空後再送出對話。'
      : !fresh && loadError ? '對話尚未同步，請先重新載入。' : undefined;

  const tabs: [WsSideTab, string][] = [['proposal', '設定提案'], ['credentials', '登入資料'], ['settings', '正式設定與能力']];
  const sideBadge: Record<WsSideTab, ReactNode> = {
    proposal: current.currentProposal?.status === 'pending' ? <span className="tab-dot warm" role="img" aria-label="有待確認提案" /> : null,
    credentials: credentialGuard.dirty ? <span className="tab-dot warm" role="img" aria-label="有未保存帳密" /> : null,
    settings: current.scopeStatus === 'revoking' ? <span className="tab-dot run" role="img" aria-label="許可撤回中" /> : null,
  };
  const focusTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex(([id]) => id === sideTab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    setSideTab(next); document.getElementById(`ws-tab-${next}`)?.focus();
  };

  return <section id="workspace-conversation" className="test-view workspace-view" aria-labelledby="workspace-conversation-title">
    <header className="test-head">
      <div className="test-title">
        <h1 id="workspace-conversation-title">Workspace：{current.name}</h1>
        <div className="test-chips">
          <span className={`chip ${current.lifecycle === 'active' ? 'ok' : 'warm'}`}>{lifecycleLabel}</span>
          <span className="chip neutral">設定 revision <span className="mono">{current.revision}</span></span>
        </div>
      </div>
      <div className="test-actions">
        <button className="button secondary compact" disabled={mutating} onClick={returnToTests}>返回測試工作台</button>
      </div>
    </header>
    <div className={`studio${sideOpen ? ' side-open' : ''}`}>
      {sideOpen ? <div className="side-backdrop" aria-hidden="true" onClick={() => setSideOpen(false)} /> : null}
      <section className="studio-chat" aria-labelledby="workspace-chat-title">
        <div className="chat-bar">
          <h2 id="workspace-chat-title" className="chat-bar-title">Workspace 設定對話</h2>
          <span className="chat-bar-spacer" />
          <button className="button quiet compact side-toggle" aria-expanded={sideOpen} onClick={() => setSideOpen((open) => !open)}><PanelIcon />{sideOpen ? '收合設定面板' : '提案與登入資料'}</button>
          <button className="rail-icon-button light small" aria-label="重新載入設定對話" title="重新載入設定對話" disabled={refreshing || mutating} onClick={() => { void refresh().catch(() => undefined); }}><RefreshIcon /></button>
        </div>
        <ChatScroll watch={`${messages.length}:${pendingTurn}:${trackedId}:${run?.status}:${Boolean(liveRun)}`} label="Workspace 設定對話">
          {!conversation && refreshing ? <Loading text="正在載入持久設定對話…" /> : null}
          {loadError ? <Notice message={loadError} /> : null}
          {conversation && messages.length === 0 && !pendingTurn ? <div className="chat-empty">
            <h2>設定這個 Workspace 的目標與範圍</h2>
            <p>描述要測試的網站用途、主要流程、目標網址與非機密背景。AI 會先訪談並提出結構化設定提案，經你確認後才生效。</p>
            <p className="inline-hint">請勿在對話中輸入帳號、密碼或 token；登入資料請統一由右側「登入資料」欄位保存。</p>
          </div> : null}
          <ol className="turns" aria-label="已儲存的 Workspace 訊息">
            {messages.map((message) => message.role === 'user'
              ? <UserTurn key={message.id} message={message} />
              : <AssistantTurn key={message.id} name="Workspace 助手" time={message.createdAt}><p className="message-content">{message.content}</p></AssistantTurn>)}
            {pendingTurn ? <AssistantTurn name="Workspace 助手" pending><AuthorLiveStatus run={run} mode="workspace" /></AssistantTurn> : null}
          </ol>
          {trackedId ? <section className={`artifact trail-card ${run && isActiveRun(run) ? 'is-running' : run?.status === 'failed' ? 'is-failed' : ''}`} aria-live="polite" aria-label="設定訪談狀態">
            <header className="artifact-head">
              <strong>設定訪談狀態</strong>
              {run?.id === trackedId ? <RunStatusBadge run={run} /> : <span className="muted">讀取中…</span>}
            </header>
            <div className="artifact-body">
              <p className="run-id">Run <span className="identifier">{trackedId}</span></p>
              {run?.error ? <pre className="run-error">{run.error}</pre> : null}
              {run?.status === 'failed' ? <p className="blocked-hint">請依任務錯誤修正需求或設定提案；origin 集合衝突不會由前端自動移除、合併或放寬。</p> : null}
              <p className="inline-hint">訪談完成不代表已探索網站或執行測試；具瀏覽器工具的 Workspace 任務才提供唯讀監看。</p>
            </div>
            <footer className="artifact-foot">
              <span className="foot-note">離開此頁不會取消任務。</span>
              <span className="foot-actions">
                {run?.id === trackedId ? <CancelRunButton api={api} run={run} onUpdated={(next) => { setRun(next); void refresh().catch(() => undefined); }} /> : null}
                {run?.id === trackedId && isActiveRun(run) && explorationAvailable ? <button className="button secondary compact" disabled={liveSelection?.id === run.id} aria-label={`開始監看 Workspace Run ${run.id}`} onClick={() => setLiveSelection(run)}><EyeIcon />開始監看</button> : null}
              </span>
            </footer>
          </section> : null}
          {active && liveRun && (explorationAvailable || !isActiveRun(liveRun)) ? <LiveView key={liveRun.id} run={liveRun} apiBase={apiBase} onClose={() => setLiveSelection(undefined)} /> : null}
          {runError ? <Notice message={runError} /> : null}
        </ChatScroll>
        <div className="composer-dock">
          {sendError ? <Notice message={sendError} /> : null}
          <Composer id="workspace-message" label="Workspace 需求或修改訊息" value={content} onChange={setContent} onSubmit={() => { void send(); }} placeholder="描述目標網站 URL、驗測目的或需要調整的範圍（請勿填帳密）…" sending={sending} canSend={canSend} reason={reason ?? (note && !content ? note : undefined)} helper={`設定 revision ${current.revision} · 對話版本 ${conversation?.contextRevision ?? '尚未取得'} · 請勿填帳密`} />
        </div>
      </section>
      <aside className="studio-side" aria-label="Workspace 設定與提案">
        <div className="side-tabs" role="tablist" aria-label="Workspace 面板">
          {tabs.map(([id, label]) => <button key={id} id={`ws-tab-${id}`} role="tab" aria-selected={sideTab === id} aria-controls={`ws-panel-${id}`} tabIndex={sideTab === id ? 0 : -1} className={sideTab === id ? 'on' : ''} onClick={() => setSideTab(id)} onKeyDown={focusTab}>{label}{sideBadge[id]}</button>)}
          <button className="rail-icon-button light small side-close" aria-label="關閉右側面板" onClick={() => setSideOpen(false)}><CloseIcon /></button>
        </div>
        <div id="ws-panel-proposal" role="tabpanel" aria-labelledby="ws-tab-proposal" className="side-panel" hidden={sideTab !== 'proposal'}>
          {current.currentProposal && conversation ? <WorkspaceProposalCard key={current.currentProposal.id} api={api} workspace={current} proposal={current.currentProposal} contextRevision={conversation.contextRevision} blocked={!fresh || refreshing || sending || runActive || credentialGuard.busy || credentialGuard.dirty || Boolean(content)} onUpdated={proposalUpdated} onBusyChange={setProposalBusy} onRefresh={refresh} /> : <section className="workspace-proposal" aria-label="設定提案"><h3>設定提案</h3><p className="mode-empty">尚未取得提案。正式設定保持原樣，請先透過訪談說明目標與必要資訊。</p></section>}
        </div>
        <div id="ws-panel-credentials" role="tabpanel" aria-labelledby="ws-tab-credentials" className="side-panel" hidden={sideTab !== 'credentials'}>
          {active ? <WorkspaceCredentials api={api} apiBase={apiBase} workspace={current} blocked={!fresh || refreshing || sending || proposalBusy} onGuardChange={reportCredentialGuard} onRefresh={refresh} /> : null}
        </div>
        <div id="ws-panel-settings" role="tabpanel" aria-labelledby="ws-tab-settings" className="side-panel" hidden={sideTab !== 'settings'}>
          <WorkspaceAvailability workspace={current} />
          <WorkspaceSettings workspace={current} />
          {conversation?.conversationSummary ? <section className="session-background" aria-label="Workspace 對話背景"><h4>Workspace 對話背景</h4><p className="summary-content">{conversation.conversationSummary}</p></section> : null}
        </div>
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
