import { useCallback, useId, useState } from 'react';
import { AiHeading, AiLink, collectAiPages, engineLabels, useAiMutation } from './AiManagerUI';
import type { AiNavigate, AiWorkspaceDirectory } from './AiManagerUI';
import type { AiAdminApi } from './aiAdminTypes';
import { Loading, Notice } from './components';
import { useResource } from './hooks';
import { RefreshIcon } from './icons';
import { AGENT_RUNTIME_SKILL_LABELS, AGENT_RUNTIME_SKILLS } from './types';
import type { AgentRuntimeSkill } from './types';

export function AiRouting({ api, workspaceId, workspaces, onNavigate, onAccessChanged }: {
  api: AiAdminApi; workspaceId?: string; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  const id = useId();
  const workspace = workspaces.data?.find((entry) => entry.id === workspaceId);
  return <>
    <AiHeading title="Workspace 選用" />
    <div className="settings-field ai-filter"><label htmlFor={id}>Workspace</label>
      <select id={id} className="text-input" value={workspaceId ?? ''} onChange={(event) => onNavigate({ view: 'routing', workspaceId: event.target.value || undefined })}>
        <option value="">選擇 Workspace</option>
        {workspaceId && !workspace ? <option value={workspaceId}>{workspaceId}</option> : null}
        {workspaces.data?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </div>
    {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
    {workspaceId ? <Assignments key={workspaceId} api={api} workspaceId={workspaceId} active={workspace?.management.state === 'active'}
      onNavigate={onNavigate} onAccessChanged={onAccessChanged} /> : <p className="muted">選擇 Workspace 後，可為各主技能設定 Agent。</p>}
  </>;
}

function Assignments({ api, workspaceId, active, onNavigate, onAccessChanged }: {
  api: AiAdminApi; workspaceId: string; active: boolean; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  const ids = useId();
  const load = useCallback(async (signal: AbortSignal) => {
    const [routing, agents] = await Promise.all([
      api.getRouting(workspaceId, signal), collectAiPages((after) => api.listAgents(workspaceId, after, signal)),
    ]);
    return { routing, agents };
  }, [api, workspaceId]);
  const detail = useResource(load, true);
  const [draft, setDraft] = useState<{ skillId: AgentRuntimeSkill; agentId: string | null }>();
  const [note, setNote] = useState('');
  const mutation = useAiMutation(onAccessChanged, detail.retry);
  const data = detail.data;
  const busy = detail.loading || mutation.busy;

  function save(skillId: AgentRuntimeSkill) {
    if (!data || !active || busy || draft?.skillId !== skillId) return;
    if (draft.agentId && !data.agents.some((agent) => agent.id === draft.agentId && agent.status === 'ready' && agent.skills.includes(skillId))) return;
    setNote('');
    void mutation.submit(async (signal) => {
      const routing = await api.changeRouting(workspaceId, { revision: data.routing.revision, ...draft }, signal);
      if (signal.aborted) return;
      detail.updateData((current) => current && { ...current, routing });
      setDraft(undefined);
      setNote(`已儲存「${AGENT_RUNTIME_SKILL_LABELS[skillId]}」的 Agent 選用。`);
    });
  }

  return <section className="ai-panel ai-stack">
    <header className="ai-heading"><h3>主技能的 Agent</h3><button type="button" className="button secondary" disabled={busy} onClick={detail.retry}><RefreshIcon />重新載入</button></header>
    <p className="muted">變更會套用到新的工作。可選用同一 Workspace 中已驗證此技能的 Agent。</p>
    {!active ? <p className="muted">只有使用中的 Workspace 可以變更選用。</p> : null}
    {detail.error ? <Notice message={detail.error} retry={detail.retry} /> : null}
    {detail.loading && !data ? <Loading text="正在載入選用設定…" /> : null}
    {mutation.error ? <Notice message={mutation.error} /> : null}
    {data ? <ul className="ai-details-list ai-routing-list">{AGENT_RUNTIME_SKILLS.map((skillId) => {
      const current = data.routing.agents[skillId] ?? null;
      const saved = data.agents.find((agent) => agent.id === current);
      const value = draft?.skillId === skillId ? draft.agentId : current;
      const eligible = data.agents.filter((agent) => agent.status === 'ready' && agent.skills.includes(skillId));
      const available = !value || eligible.some((agent) => agent.id === value);
      return <li key={skillId}>
        <div className="ai-row-info"><strong>{AGENT_RUNTIME_SKILL_LABELS[skillId]}</strong>
          {current ? <AiLink route={{ view: 'agent', id: current }} onNavigate={onNavigate}>{saved?.name ?? current}</AiLink> : <p>沿用 Workspace 預設</p>}
        </div>
        <form className="ai-routing-form" onSubmit={(event) => { event.preventDefault(); save(skillId); }}>
          <label className="sr-only" htmlFor={`${ids}-${skillId}`}>{AGENT_RUNTIME_SKILL_LABELS[skillId]} Agent</label>
          <select id={`${ids}-${skillId}`} className="text-input" value={value ?? ''} disabled={!active || busy}
            onChange={(event) => { setDraft({ skillId, agentId: event.target.value || null }); mutation.setError(undefined); }}>
            <option value="">沿用 Workspace 預設</option>
            {value && !available ? <option value={value} disabled>{data.agents.find((agent) => agent.id === value)?.name ?? value}（目前不可用）</option> : null}
            {eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {engineLabels[agent.engine]}</option>)}
          </select>
          <button type="submit" className="button secondary" disabled={!active || busy || value === current || !available}
            aria-label={`儲存${AGENT_RUNTIME_SKILL_LABELS[skillId]}選用`}>儲存</button>
        </form>
      </li>;
    })}</ul> : null}
    <p className="access-note" role="status">{note}</p>
  </section>;
}
