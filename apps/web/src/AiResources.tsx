import { useCallback, useId, useState } from 'react';
import { isProtectedCredentialTransport } from './api';
import { AiDialog, AiHeading, AiLink, collectAiPages, engineLabels, outcomeUncertain, TokenReceipt, useAiMutation, useAiRefresh } from './AiManagerUI';
import type { AiNavigate, AiWorkspaceDirectory } from './AiManagerUI';
import type { AiAccessReceipt, AiAdminApi, AiResource, AiResourceAction, AiResourceChange } from './aiAdminTypes';
import { formatDate, Loading, Notice } from './components';
import { useResource } from './hooks';
import { RefreshIcon } from './icons';
import { AGENT_RUNTIME_SKILL_LABELS, STATUS_LABELS } from './types';

const connectionLabels = { waiting_connection: '等待連線', online: '已連線', offline: '離線' };
const controlLabels = { enabled: '啟用', paused: '已暫停', draining: '排空中', removed: '已移出', revoked: '已撤銷' };
const modeLabels = { managed: '平台代管', mcp_interactive: 'MCP 互動', mcp_claim: 'MCP 接單' };
const leaseLabels = { opening: '開啟中', ready: '已就緒', closing: '關閉中', reclaim_pending: '等待回收' };
const actionLabels: Record<AiResourceAction, string> = {
  assign: '指派 Workspace', pause_dispatch: '暫停派工', resume_dispatch: '恢復派工', drain_remove: '排空並移出',
  pause_claim: '暫停接單', resume_claim: '恢復接單', cancel_run: '取消任務', close_browser: '結束瀏覽器租約',
  revoke_access: '撤銷 Token', reissue_access: '換發 Token',
};

function workspaceName(directory: AiWorkspaceDirectory, id: string): string {
  return directory.data?.find((entry) => entry.id === id)?.name ?? id;
}

function workspaceScope(resource: AiResource, workspaces: AiWorkspaceDirectory): string {
  if (resource.workspaceIds === null) return '所有使用中的 Workspace';
  return resource.workspaceIds.length ? resource.workspaceIds.map((id) => workspaceName(workspaces, id)).join('、') : '未指派';
}

function resourceSource(resource: AiResource): string {
  if (resource.source === 'manager') return '受管 Manager';
  const modes = resource.capabilities.modes.map((mode) => modeLabels[mode]);
  return `${modes.length ? modes.join('／') : 'MCP 憑證'} · 依憑證彙整`;
}

function ResourceStatus({ resource }: { resource: AiResource }) {
  return <><span className={`chip ${resource.connection === 'online' ? 'ok' : 'neutral'}`}>{connectionLabels[resource.connection]}</span>
    <span className={`chip ${resource.control === 'draining' ? 'warm' : 'neutral'}`}>{controlLabels[resource.control]}</span></>;
}

export function AiResources({ api, workspaces, onNavigate }: { api: AiAdminApi; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate }) {
  const load = useCallback((signal: AbortSignal) => collectAiPages((after) => api.listResources(after, signal)), [api]);
  const list = useResource(load, true);
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const visible = list.data?.filter((resource) =>
    [resource.name, resource.id, resourceSource(resource), workspaceScope(resource, workspaces)]
      .some((value) => value.toLowerCase().includes(term))) ?? [];
  useAiRefresh(list.retry, !list.loading, 10000);

  function total(source: AiResource['source']) {
    let available = 0;
    let unknown = 0;
    for (const resource of list.data ?? []) {
      if (resource.source !== source) continue;
      if (resource.capacity.available === null) unknown += 1;
      else available += resource.capacity.available;
    }
    return <><strong>{available}</strong> 個{unknown ? <span className="muted"> · {unknown} 筆容量未知</span> : null}</>;
  }

  return <>
    <AiHeading title="執行資源" actions={<button type="button" className="button secondary" disabled={list.loading} onClick={list.retry}><RefreshIcon />重新載入</button>} />
    {list.error ? <Notice message={list.error} retry={list.retry} /> : null}
    {list.loading && !list.data ? <Loading text="正在載入 AI 執行資源…" /> : null}
    {list.data ? <>
      <dl className="ai-meta ai-capacity-summary">
        <div><dt>Manager 已知可用名額</dt><dd>{total('manager')}</dd></div>
        <div><dt>MCP 已知可接單名額</dt><dd>{total('mcp')}</dd></div>
      </dl>
      {list.data.length > 0 && <div className="ai-list-toolbar">
        <label className="settings-field ai-filter">搜尋資源
          <input className="text-input" type="search" placeholder="名稱、識別碼或 Workspace" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <span className="muted" role="status">顯示 {visible.length} / {list.data.length} 筆</span>
      </div>}
      {visible.length ? <ul className="access-list ai-list">{visible.map((resource) => <li key={resource.id}>
        <div className="ai-row-info">
          <strong>{resource.name}</strong><span className="identifier muted">{resource.id}</span>
          <p>{resourceSource(resource)} · {workspaceScope(resource, workspaces)}</p>
          <p>引擎 {resource.capabilities.engines?.map((engine) => engineLabels[engine]).join('、') || '未知'}</p>
          <p>最近活動 {resource.lastActivityAt ? formatDate(resource.lastActivityAt) : '尚無紀錄'} · 瀏覽器租約 {resource.browserLeases.length} · 可用 {resource.capacity.available ?? '未知'}</p>
        </div>
        <div className="action-row ai-actions"><ResourceStatus resource={resource} />
          <AiLink className="button secondary" aria-label={`查看資源（${resource.name}）`} route={{ view: 'resource', id: resource.id }} onNavigate={onNavigate}>查看資源</AiLink>
        </div>
      </li>)}</ul> : <div className="ai-panel">{list.data.length ? <><p>找不到符合「{query}」的資源。</p><button type="button" className="button secondary" onClick={() => setQuery('')}>清除搜尋</button></> : <p>目前沒有執行資源。</p>}</div>}
    </> : null}
  </>;
}

type ResourceDialogAction = { action: 'assign' | 'drain_remove' | 'revoke_access' | 'reissue_access' }
  | Extract<AiResourceChange, { action: 'close_browser' | 'cancel_run' }>;

export function AiResourceDetail({ api, apiBase, id, workspaces, onNavigate, onAccessChanged }: {
  api: AiAdminApi; apiBase: string; id: string; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  const load = useCallback((signal: AbortSignal) => api.getResource(id, signal), [api, id]);
  const detail = useResource(load, true);
  const mutation = useAiMutation(onAccessChanged, detail.retry);
  const [dialog, setDialog] = useState<ResourceDialogAction>();
  const [receipt, setReceipt] = useState<AiAccessReceipt>();
  const [note, setNote] = useState('');
  const resource = detail.data;
  const busy = detail.loading || mutation.busy;
  const protectedTransport = isProtectedCredentialTransport(apiBase, window.location.href);
  useAiRefresh(detail.retry, !busy && !dialog && !receipt);

  function change(input: AiResourceChange) {
    if (busy || !resource?.allowedActions.includes(input.action)) return;
    setNote('');
    void mutation.submit(async (signal) => {
      const updated = await api.changeResource(id, input, signal);
      if (signal.aborted) return;
      detail.updateData(() => updated);
      setNote(`${actionLabels[input.action]}已送出。`);
      setDialog(undefined);
    });
  }

  function open(action: ResourceDialogAction) {
    mutation.setError(undefined);
    setDialog(action);
  }

  if (receipt) return <>
    <AiHeading title="MCP Token 換發完成" actions={<AiLink className="button secondary" route={{ view: 'resource', id: receipt.resource.id }} onNavigate={onNavigate}>查看新憑證</AiLink>} />
    <p>目標 Workspace {receipt.resource.workspaceIds?.map((workspace) => workspaceName(workspaces, workspace)).join('、')}</p>
    <TokenReceipt token={receipt.token} apiBase={apiBase} onClear={() => setReceipt((current) => current ? { resource: current.resource, agent: current.agent } : undefined)} />
  </>;

  return <>
    <AiHeading title={resource?.name ?? '執行資源詳情'} actions={<>
      <AiLink className="button quiet" route={{ view: 'resources' }} onNavigate={onNavigate}>返回執行資源</AiLink>
      <button type="button" className="button secondary" disabled={busy} onClick={detail.retry}><RefreshIcon />重新載入</button>
    </>} />
    {detail.error ? <Notice message={detail.error} retry={detail.retry} /> : null}
    {detail.loading && !resource ? <Loading text="正在載入資源詳情…" /> : null}
    {!dialog && mutation.error ? <Notice message={mutation.error} /> : null}
    <p className="access-note" role="status">{note}</p>
    {resource ? <>
      <section className="ai-panel ai-stack" aria-label="資源狀態">
        <header className="ai-heading"><h3>資源狀態</h3><div className="action-row ai-actions"><ResourceStatus resource={resource} /></div></header>
        <dl className="ai-meta">
          <div><dt>資源識別</dt><dd className="identifier">{resource.id}</dd></div><div><dt>來源</dt><dd>{resourceSource(resource)}</dd></div>
          <div><dt>Workspace 指派</dt><dd>{workspaceScope(resource, workspaces)}</dd></div>
          <div><dt>執行引擎</dt><dd>{resource.capabilities.engines?.map((engine) => engineLabels[engine]).join('、') || '未知'}</dd></div>
          <div><dt>能力</dt><dd>{resource.capabilities.skills?.map((skill) => AGENT_RUNTIME_SKILL_LABELS[skill]).join('、') || '未知'}</dd></div>
          <div><dt>容量</dt><dd>可用 {resource.capacity.available ?? '未知'} · 占用 {resource.capacity.occupied} · 上限 {resource.capacity.total ?? '未知'}</dd></div>
          <div><dt>最近活動</dt><dd>{resource.lastActivityAt ? formatDate(resource.lastActivityAt) : '尚無紀錄'}</dd></div>
          {resource.source === 'mcp' ? <><div><dt>最近互動</dt><dd>{resource.interactiveAt ? formatDate(resource.interactiveAt) : '尚無紀錄'}</dd></div>
            <div><dt>最近接單活動</dt><dd>{resource.claimAt ? formatDate(resource.claimAt) : '尚無紀錄'}</dd></div></> : null}
        </dl>
        {resource.agentId ? <AiLink className="button quiet ai-fit" route={{ view: 'agent', id: resource.agentId }} onNavigate={onNavigate}>查看綁定 Agent</AiLink> : null}
        <div className="action-row ai-actions">
          {resource.allowedActions.map((action) => {
            if (action === 'cancel_run' || action === 'close_browser') return null;
            const immediate = action === 'pause_dispatch' || action === 'resume_dispatch' || action === 'pause_claim' || action === 'resume_claim';
            return <button type="button" key={action} className={`button ${action === 'revoke_access' || action === 'drain_remove' ? 'danger-outline' : 'secondary'}`}
              disabled={busy || (action === 'reissue_access' && !protectedTransport)} onClick={() => immediate
                ? change({ action, revision: resource.revision }) : open({ action })}>{actionLabels[action]}</button>;
          })}
        </div>
        {!protectedTransport && resource.allowedActions.includes('reissue_access') ? <p className="muted">換發需要 HTTPS 或雙端 loopback 連線。</p> : null}
      </section>
      <section className="ai-panel ai-stack">
        <h3>執行中的工作</h3>
        {resource.attempts.length ? <ul className="ai-details-list">{resource.attempts.map((attempt) => <li key={attempt.attemptId}>
          <div className="ai-row-info"><strong>{workspaceName(workspaces, attempt.workspaceId)} · {STATUS_LABELS[attempt.status]}</strong>
            <p>Run <code className="identifier">{attempt.runId}</code></p><p>Attempt <code className="identifier">{attempt.attemptId}</code></p>
            {attempt.leaseId ? <p>接單租約 <code className="identifier">{attempt.leaseId}</code></p> : null}
            {attempt.agentId ? <p>Agent <code className="identifier">{attempt.agentId}</code></p> : null}
          </div>
          {resource.allowedActions.includes('cancel_run') && attempt.leaseId ? <button type="button" className="button danger-outline" disabled={busy}
            onClick={() => attempt.leaseId && open({ action: 'cancel_run', runId: attempt.runId, attemptId: attempt.attemptId, leaseId: attempt.leaseId })}>取消任務</button> : null}
        </li>)}</ul> : <p className="muted">目前沒有執行中的工作。</p>}
      </section>
      <section className="ai-panel ai-stack">
        <h3>瀏覽器租約</h3>
        {resource.browserLeases.length ? <ul className="ai-details-list">{resource.browserLeases.map((lease) => <li key={lease.leaseId}>
          <div className="ai-row-info"><strong>{workspaceName(workspaces, lease.workspaceId)} · {leaseLabels[lease.state]}</strong>
            <p>Session <code className="identifier">{lease.sessionId}</code></p><p>租約 <code className="identifier">{lease.leaseId}</code></p>
            <p>{lease.runId ? <>Run <code className="identifier">{lease.runId}</code></> : '獨立互動'} · 到期 {formatDate(lease.deadlineAt)}</p>
          </div>
          {resource.allowedActions.includes('close_browser') ? <button type="button" className="button danger-outline" disabled={busy}
            onClick={() => open({ action: 'close_browser', leaseId: lease.leaseId, sessionId: lease.sessionId })}>結束租約</button> : null}
        </li>)}</ul> : <p className="muted">目前沒有瀏覽器租約。</p>}
      </section>
      {dialog ? <ResourceActionDialog action={dialog} resource={resource} workspaces={workspaces} busy={busy} sending={mutation.busy} error={mutation.error}
        submit={mutation.submit} onClose={() => { mutation.setError(undefined); setDialog(undefined); }} onChange={change}
        onReissue={async (input, signal) => {
          const next = await api.reissueAccess(id, input, signal);
          if (!signal.aborted) { setReceipt(next); setDialog(undefined); }
        }} /> : null}
    </> : null}
  </>;
}

const descriptions: Record<ResourceDialogAction['action'], string> = {
  assign: '調整可服務的 Workspace。新的派工會套用此範圍，已執行的工作保留原指派。',
  drain_remove: '停止新的派工，等候既有工作、瀏覽器租約及配置回收後移出資源池。',
  revoke_access: '撤銷會立即阻止後續接入並使相關接單停止。Server 會關閉此憑證的瀏覽器租約。',
  reissue_access: '新 Token 綁定所選 Workspace，舊 Token 立即失效。跨 Workspace 換發時，原 Agent 會停用。',
  cancel_run: '取消此接單並關閉關聯瀏覽器。請確認要取消的 Run。',
  close_browser: '要求關閉此瀏覽器租約。是否已回收依 Server 回報顯示。',
};

type ReissueInput = Parameters<AiAdminApi['reissueAccess']>[1];

function ResourceActionDialog({ action, resource, workspaces, busy, sending, error, submit, onClose, onChange, onReissue }: {
  action: ResourceDialogAction; resource: AiResource; workspaces: AiWorkspaceDirectory; busy: boolean; sending: boolean; error?: string;
  submit: (task: (signal: AbortSignal) => Promise<void>) => Promise<void>; onClose: () => void; onChange: (change: AiResourceChange) => void;
  onReissue: (input: ReissueInput, signal: AbortSignal) => Promise<void>;
}) {
  const workspaceId = useId();
  const active = workspaces.data?.filter((entry) => entry.management.state === 'active') ?? [];
  const [all, setAll] = useState(resource.workspaceIds === null);
  const [assigned, setAssigned] = useState(() => resource.workspaceIds?.filter((id) => active.some((entry) => entry.id === id)) ?? []);
  const [target, setTarget] = useState(() => active.find((entry) => entry.id === resource.workspaceIds?.[0])?.id ?? '');
  const [pending, setPending] = useState<ReissueInput>();
  const targetPresent = action.action === 'cancel_run' ? resource.attempts.some((attempt) =>
    attempt.runId === action.runId && attempt.attemptId === action.attemptId && attempt.leaseId === action.leaseId)
    : action.action === 'close_browser' ? resource.browserLeases.some((lease) => lease.leaseId === action.leaseId && lease.sessionId === action.sessionId) : true;
  const allowed = Boolean(pending) || (targetPresent && resource.allowedActions.includes(action.action));
  const assignable = all || (assigned.length > 0 && assigned.length <= 100 && assigned.every((id) => active.some((entry) => entry.id === id)));
  const targetAvailable = Boolean(pending) || active.some((entry) => entry.id === target);
  const blocked = busy || !allowed || (action.action === 'assign' && !assignable) || (action.action === 'reissue_access' && !targetAvailable);

  function confirm() {
    if (blocked) return;
    if (action.action === 'reissue_access') {
      const input = pending ?? { workspaceId: target, revision: resource.revision, requestId: crypto.randomUUID() };
      void submit(async (signal) => {
        try { await onReissue(input, signal); }
        catch (cause) { if (!signal.aborted && outcomeUncertain(cause)) setPending(input); throw cause; }
      });
    } else if (action.action === 'assign') onChange({ action: action.action, workspaceIds: all ? null : assigned, revision: resource.revision });
    else if (action.action === 'cancel_run' || action.action === 'close_browser') onChange(action);
    else onChange({ action: action.action, revision: resource.revision });
  }

  return <AiDialog title={actionLabels[action.action]} text={descriptions[action.action]} busy={sending} error={error} onClose={onClose}>
    <form className="ai-dialog-form" onSubmit={(event) => { event.preventDefault(); confirm(); }}>
      {!allowed ? <Notice message="資源狀態已更新，此操作目前不可用。" /> : null}
      {action.action === 'assign' ? <>
        <fieldset className="ai-fieldset" disabled={sending || !allowed}><legend>指派方式</legend>
          <label><input type="radio" name="workspace-scope" checked={all} onChange={() => setAll(true)} />全站指派</label>
          <label><input type="radio" name="workspace-scope" checked={!all} onChange={() => setAll(false)} />指定 Workspace</label>
        </fieldset>
        {!all ? <fieldset className="ai-fieldset ai-workspace-options" disabled={sending || !allowed}><legend>選擇可使用的 Workspace</legend>
          {active.map(({ id, name }) => <label key={id}><input type="checkbox" checked={assigned.includes(id)} onChange={(event) => setAssigned((current) =>
            event.target.checked ? [...current, id] : current.filter((entry) => entry !== id))} />{name}</label>)}
          {!active.length ? <p className="muted">目前沒有使用中的 Workspace。</p> : <p className="muted">已選 {assigned.length} 個，最多 100 個。</p>}
        </fieldset> : null}
      </> : null}
      {action.action === 'reissue_access' ? <div className="settings-field"><label htmlFor={workspaceId}>目標 Workspace</label>
        <select id={workspaceId} className="text-input" value={target} disabled={sending || Boolean(pending)} required onChange={(event) => setTarget(event.target.value)}>
          <option value="">選擇目標</option>{active.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </div> : null}
      {action.action === 'cancel_run' ? <p className="identifier">{action.runId}</p> : action.action === 'close_browser' ? <p className="identifier">{action.sessionId}</p> : null}
      {pending ? <p>換發結果尚未確認。重送會沿用同一請求編號及目標。</p> : null}
      <div className="action-row ai-actions">
        <button type="button" className="button secondary" data-dialog-cancel disabled={sending} onClick={onClose}>返回</button>
        <button type="submit" className={`button ${action.action === 'assign' ? 'primary' : 'danger-button'}`} disabled={blocked}>
          {sending ? '送出中…' : pending ? '重送同一請求' : `確認${actionLabels[action.action]}`}
        </button>
      </div>
    </form>
  </AiDialog>;
}
