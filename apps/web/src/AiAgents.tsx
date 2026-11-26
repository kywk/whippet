import { useCallback, useId, useRef, useState } from 'react';
import { isProtectedCredentialTransport } from './api';
import { agentReason, AgentStatus, AiDialog, AiHeading, AiKeyInput, AiLink, collectAiPages, engineLabels, providerLabels, TokenReceipt, useAiMutation, useAiRefresh, validAiKey } from './AiManagerUI';
import type { AiNavigate, AiWorkspaceDirectory } from './AiManagerUI';
import type { AiAdminApi } from './aiAdminTypes';
import { formatDate, Loading, Notice } from './components';
import { useResource } from './hooks';
import { PlusIcon, RefreshIcon } from './icons';
import { AGENT_RUNTIME_SKILL_LABELS } from './types';

export function AiAgents({ api, workspaces, onNavigate }: { api: AiAdminApi; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate }) {
  const filterId = useId();
  const [workspaceId, setWorkspaceId] = useState('');
  const load = useCallback(async (signal: AbortSignal) => ({ workspaceId, agents: await collectAiPages((after) => api.listAgents(workspaceId || null, after, signal)) }), [api, workspaceId]);
  const agents = useResource(load, true);
  const current = agents.data?.workspaceId === workspaceId ? agents.data.agents : undefined;
  useAiRefresh(agents.retry, Boolean(current) && !agents.loading, 10000);

  return <>
    <AiHeading title="Agent 清單" actions={<>
      <button type="button" className="button secondary" disabled={agents.loading} onClick={agents.retry}><RefreshIcon />重新載入</button>
      <AiLink className="button primary" route={{ view: 'create' }} onNavigate={onNavigate}><PlusIcon />建立 Agent</AiLink>
    </>} />
    <div className="settings-field ai-filter"><label htmlFor={filterId}>依 Workspace 篩選</label>
      <select id={filterId} className="text-input" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
        <option value="">所有 Workspace</option>
        {workspaceId && !workspaces.data?.some((entry) => entry.id === workspaceId) ? <option value={workspaceId}>{workspaceId}</option> : null}
        {workspaces.data?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </div>
    {agents.error ? <Notice message={agents.error} retry={agents.retry} /> : null}
    {!current && !agents.error ? <Loading text="正在載入 Agent…" /> : null}
    {current?.length ? <ul className="access-list ai-list">{current.map((agent) => <li key={agent.id}>
      <div className="ai-row-info"><strong>{agent.name}</strong><p>{workspaces.data?.find((item) => item.id === agent.workspaceId)?.name ?? agent.workspaceId}</p>
        <p>{agent.mode === 'managed' ? '平台代管' : '自管 MCP'} · {engineLabels[agent.engine]} · {agent.model}</p>
        {agent.reason ? <p>{agentReason(agent.reason)}</p> : null}
      </div>
      <div className="action-row ai-actions"><AgentStatus status={agent.status} />
        <AiLink className="button secondary" aria-label={`查看 Agent（${agent.name}）`} route={{ view: 'agent', id: agent.id }} onNavigate={onNavigate}>查看 Agent</AiLink>
      </div>
    </li>)}</ul> : current ? <p className="muted">目前沒有 Agent。</p> : null}
  </>;
}

export function AiAgentDetail({ api, apiBase, id, workspaces, onNavigate, onAccessChanged }: {
  api: AiAdminApi; apiBase: string; id: string; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  const load = useCallback((signal: AbortSignal) => api.getAgent(id, signal), [api, id]);
  const detail = useResource(load, true);
  const [keyAction, setKeyAction] = useState<'rotate' | 'revoke'>();
  const [note, setNote] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  const mutation = useAiMutation(onAccessChanged, detail.retry);
  const agent = detail.data;
  const workspace = workspaces.data?.find((item) => item.id === agent?.workspaceId);
  const activeWorkspace = workspace?.management.state === 'active';
  const transport = isProtectedCredentialTransport(apiBase, window.location.href);
  const keyVersion = agent?.modelKey?.version ?? 0;
  const configured = agent?.modelKey?.configured ?? false;
  const canTalkToRuntime = agent?.mode === 'managed' ? configured : Boolean(agent?.tokenId && agent.reason !== 'token_revoked');
  const canRetry = activeWorkspace && canTalkToRuntime && agent?.status !== 'verifying';
  const busy = detail.loading || mutation.busy;
  useAiRefresh(detail.retry, Boolean(agent) && !busy && !keyAction);

  function mutate(action: 'retry' | 'rotate' | 'revoke') {
    if (!agent || busy) return;
    const apiKey = keyInput.current?.value ?? '';
    if (action === 'retry' && !canRetry) return;
    if (action === 'rotate' && (!activeWorkspace || !transport || !validAiKey(apiKey))) {
      mutation.setError('請使用受保護連線，並輸入 1 至 4096 個可列印且不含空白的 ASCII 字元。');
      return;
    }
    if (action === 'revoke' && (!transport || !configured)) return;
    setNote('');
    void mutation.submit(async (signal) => {
      const next = action === 'retry' ? await api.retryAgent(id, agent.revision, signal)
        : action === 'rotate' ? await api.rotateKey(id, keyVersion, apiKey, signal) : await api.revokeKey(id, keyVersion, signal);
      if (signal.aborted) return;
      if (keyInput.current) keyInput.current.value = '';
      detail.updateData(() => next);
      setNote(action === 'rotate' ? '模型金鑰已更新。請重新驗證 Agent。' : action === 'revoke' ? '模型金鑰已撤銷。'
        : next.status === 'verifying' ? '已開始驗證。' : next.status === 'waiting_connection' ? '正在等候接單端重新連線。' : '已取得最新驗證結果。');
      setKeyAction(undefined);
    });
  }

  function closeKeyAction() { mutation.setError(undefined); setKeyAction(undefined); }

  return <>
    <AiHeading title={agent?.name ?? 'Agent 詳情'} actions={<>
      <AiLink className="button quiet" route={{ view: 'agents' }} onNavigate={onNavigate}>返回 Agent 清單</AiLink>
      <button type="button" className="button secondary" disabled={busy} onClick={detail.retry}><RefreshIcon />重新載入</button>
    </>} />
    {detail.error ? <Notice message={detail.error} retry={detail.retry} /> : null}
    {detail.loading && !agent ? <Loading text="正在載入 Agent…" /> : null}
    {!keyAction && mutation.error ? <Notice message={mutation.error} /> : null}
    <p className="access-note" role="status">{note}</p>
    {agent ? <>
      <section className="ai-panel ai-stack" aria-label="執行設定">
        <header className="ai-heading"><h3>執行設定</h3><AgentStatus status={agent.status} /></header>
        {agent.reason ? <p role="status">{agentReason(agent.reason)}</p> : null}
        <dl className="ai-meta">
          <div><dt>Agent ID</dt><dd className="identifier">{agent.id}</dd></div>
          <div><dt>Workspace</dt><dd>{workspace?.name ?? agent.workspaceId}</dd></div>
          <div><dt>模式與引擎</dt><dd>{agent.mode === 'managed' ? '平台代管' : '自管 MCP'} · {engineLabels[agent.engine]}</dd></div>
          <div><dt>供應商與模型</dt><dd>{providerLabels[agent.provider]}<br /><span className="identifier">{agent.model}</span></dd></div>
          {agent.profileId ? <div><dt>部署設定</dt><dd className="identifier">{agent.profileId}</dd></div> : null}
          <div><dt>已驗證能力</dt><dd>{agent.skills.length ? agent.skills.map((skill) => AGENT_RUNTIME_SKILL_LABELS[skill]).join('、') : '尚無驗證證據'}</dd></div>
          <div><dt>驗證時間</dt><dd>{agent.verifiedAt ? formatDate(agent.verifiedAt) : '尚未驗證'}</dd></div>
          {agent.probeId ? <div><dt>最近驗證識別</dt><dd className="identifier">{agent.probeId}</dd></div> : null}
        </dl>
        <div className="action-row ai-actions">
          {canRetry ? <button type="button" className="button secondary" disabled={busy} onClick={() => mutate('retry')}>重新驗證</button> : null}
          <AiLink className="button secondary" route={{ view: 'routing', workspaceId: agent.workspaceId }} onNavigate={onNavigate}>Workspace 選用</AiLink>
        </div>
      </section>
      {agent.mode === 'managed' ? <section className="ai-panel ai-stack">
        <h3>模型金鑰</h3>
        <p>{configured ? `已配置，版本 ${keyVersion}` : keyVersion ? `已撤銷，版本 ${keyVersion}` : '尚未配置'}</p>
        {!transport ? <Notice message="金鑰管理需要 HTTPS 或雙端 loopback 連線。" /> : null}
        {!activeWorkspace && !workspaces.loading ? <p className="muted">輪替及驗證需在使用中的 Workspace 操作。</p> : null}
        <div className="action-row ai-actions">
          {activeWorkspace ? <button type="button" className="button secondary" disabled={busy || !transport} onClick={() => { mutation.setError(undefined); setKeyAction('rotate'); }}>{configured ? '輪替模型金鑰' : '設定模型金鑰'}</button> : null}
          {configured ? <button type="button" className="button danger-outline" disabled={busy || !transport} onClick={() => { mutation.setError(undefined); setKeyAction('revoke'); }}>撤銷模型金鑰</button> : null}
        </div>
      </section> : <>
        <TokenReceipt apiBase={apiBase} />
        {agent.tokenId ? <AiLink className="button secondary ai-fit" route={{ view: 'resource', id: `mcp:${agent.tokenId}` }} onNavigate={onNavigate}>管理 MCP Token</AiLink> : null}
      </>}
      {keyAction ? <AiDialog title={keyAction === 'rotate' ? configured ? '輪替模型金鑰' : '設定模型金鑰' : '撤銷模型金鑰'}
        text={keyAction === 'rotate' ? `目前金鑰版本 ${keyVersion}。保存後，舊版憑證失效，需重新驗證 Agent。` : `將撤銷第 ${keyVersion} 版模型金鑰並停止此 Agent 接受新工作。`}
        busy={mutation.busy} error={mutation.error} onClose={closeKeyAction}>
        <form className="ai-dialog-form" onSubmit={(event) => { event.preventDefault(); mutate(keyAction); }}>
          {keyAction === 'rotate' ? <AiKeyInput inputRef={keyInput} disabled={busy} label="新的模型 API Key" /> : null}
          <div className="action-row ai-actions">
            <button type="button" data-dialog-cancel className="button secondary" disabled={mutation.busy} onClick={closeKeyAction}>返回</button>
            <button type="submit" className={`button ${keyAction === 'revoke' ? 'danger-button' : 'primary'}`} disabled={busy || !transport || (keyAction === 'rotate' ? !activeWorkspace : !configured)}>
              {mutation.busy ? '送出中…' : keyAction === 'revoke' ? '確認撤銷' : '儲存新金鑰'}
            </button>
          </div>
        </form>
      </AiDialog> : null}
    </> : null}
  </>;
}
