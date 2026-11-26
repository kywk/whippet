import { useCallback, useId, useRef, useState } from 'react';
import { AI_AGENT_MODEL_PATTERN, AI_AGENT_PROPOSAL_MAX_BYTES, ApiError, isProtectedCredentialTransport } from './api';
import { agentReason, AgentStatus, AiHeading, AiKeyInput, AiLink, engineLabels, outcomeUncertain, providerLabels, TokenReceipt, useAiMutation, validAiKey } from './AiManagerUI';
import type { AiNavigate, AiWorkspaceDirectory } from './AiManagerUI';
import type { AiAdminApi, AiAgent, AiAgentDraft, AiMode, AiOptions } from './aiAdminTypes';
import { Loading, Notice } from './components';
import { useResource } from './hooks';

export function AiAgentCreate({ api, apiBase, workspaces, onNavigate, onAccessChanged }: {
  api: AiAdminApi; apiBase: string; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  const fieldId = useId();
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [review, setReview] = useState<{ draft: AiAgentDraft; requestId: string; reloadOptions?: () => void }>();
  const [receipt, setReceipt] = useState<{ agent: AiAgent; token?: string }>();
  const active = workspaces.data?.filter((workspace) => workspace.management.state === 'active') ?? [];
  const workspace = active.find((entry) => entry.id === workspaceId);
  const protectedTransport = isProtectedCredentialTransport(apiBase, window.location.href);

  if (receipt) return <>
    <AiHeading title={`已建立 ${receipt.agent.name}`} actions={<AiLink className="button secondary" route={{ view: 'agent', id: receipt.agent.id }} onNavigate={onNavigate}>查看 Agent</AiLink>} />
    <AgentStatus status={receipt.agent.status} />
    <TokenReceipt token={receipt.token} apiBase={apiBase} onClear={() => setReceipt((current) => current ? { agent: current.agent } : undefined)} />
  </>;

  return <>
    {review ? <ReviewAgent api={api} draft={review.draft} requestId={review.requestId} reloadOptions={review.reloadOptions} workspaceName={workspace?.name ?? workspaceId}
      available={Boolean(workspace) && protectedTransport} onBack={() => setReview(undefined)} onAccessChanged={onAccessChanged}
      onCreated={(result) => {
        setReview(undefined);
        if (result.agent.mode === 'self_managed') setReceipt(result);
        else onNavigate({ view: 'agent', id: result.agent.id });
      }} /> : null}
    <div className="ai-stack" hidden={Boolean(review)}>
      {!review ? <AiHeading title="建立 Agent" /> : null}
      {!protectedTransport ? <Notice message="建立 Agent 與核發憑證需要 HTTPS 或雙端 loopback 連線。" /> : null}
      {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
      {workspaces.loading && !workspaces.data ? <Loading text="正在載入 Workspace…" /> : null}
      {workspaces.data && !active.length ? <p className="muted">目前沒有使用中的 Workspace。</p> : null}
      {active.length ? <section className="ai-panel ai-stack">
        <div className="settings-field"><label htmlFor={`${fieldId}-workspace`}>Workspace</label>
          <select id={`${fieldId}-workspace`} className="text-input" value={workspace?.id ?? ''} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">選擇 Workspace</option>{active.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
        {workspace ? <Configuration key={workspace.id} api={api} workspaceId={workspace.id} initialName={name} disabled={!protectedTransport}
          onNameChange={setName} onAccessChanged={onAccessChanged}
          onReview={(draft, reloadOptions) => setReview({ draft, reloadOptions, requestId: crypto.randomUUID() })} /> : <div className="settings-field">
          <label htmlFor={`${fieldId}-name`}>Agent 名稱</label>
          <input id={`${fieldId}-name`} className="text-input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </div>}
      </section> : null}
    </div>
  </>;
}

function Configuration({ api, workspaceId, initialName, disabled, onNameChange, onAccessChanged, onReview }: {
  api: AiAdminApi; workspaceId: string; initialName: string; disabled: boolean; onNameChange: (name: string) => void;
  onAccessChanged: () => void; onReview: (draft: AiAgentDraft, reloadOptions?: () => void) => void;
}) {
  const ids = useId();
  const load = useCallback((signal: AbortSignal) => api.getOptions(workspaceId, signal), [api, workspaceId]);
  const options = useResource(load);
  const [mode, setMode] = useState<AiMode>('managed');
  const [profileId, setProfileId] = useState('');
  const [engine, setEngine] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string>();
  const [instruction, setInstruction] = useState('');
  const [name, setName] = useState(initialName);
  const [proposalApplied, setProposalApplied] = useState(false);
  const [proposalNote, setProposalNote] = useState('');
  const proposalRequest = useAiMutation(onAccessChanged, options.retry);
  const profile = options.data?.managed.find((item) => item.profileId === profileId);
  const engineOption = options.data?.selfManaged.find((item) => item.engine === engine);
  const selectedProvider = engineOption?.providers.find((item) => item === provider);

  function propose() {
    if (!instruction.trim() || proposalRequest.busy) return;
    setProposalNote('');
    void proposalRequest.submit(async (signal) => {
      const proposal = await api.proposeAgent(workspaceId, instruction, signal);
      if (signal.aborted) return;
      const currentOptions = await api.getOptions(workspaceId, signal);
      if (signal.aborted) return;
      options.updateData(() => currentOptions);
      if (!matchesOptions(proposal, currentOptions)) throw new ApiError('提案中的執行設定目前無法選用。請重產提案或手動設定。', 'OPTIONS_CHANGED');
      setError(undefined);
      setName(proposal.name);
      setMode(proposal.mode);
      if (proposal.mode === 'managed') setProfileId(proposal.profileId);
      else { setEngine(proposal.engine); setProvider(proposal.provider); setModel(proposal.model); }
      setProposalApplied(true);
      setProposalNote('已將提案填入表單。你可以修改後再檢視設定。');
    });
  }

  function review() {
    if (disabled || options.loading || !options.data || proposalRequest.busy) return;
    const trimmedName = name.trim();
    if (!trimmedName || new TextEncoder().encode(trimmedName).length > 200) {
      setError('Agent 名稱去除前後空白後須為 1 至 200 UTF-8 bytes。');
      return;
    }
    const reloadOptions = proposalApplied ? options.retry : undefined;
    if (mode === 'managed' && profile) {
      onReview({ workspaceId, name: trimmedName, mode, engine: profile.engine, provider: profile.provider, model: profile.model, profileId: profile.profileId }, reloadOptions);
    } else if (mode === 'self_managed' && engineOption && selectedProvider) {
      const trimmedModel = model.trim();
      if (!AI_AGENT_MODEL_PATTERN.test(trimmedModel)) {
        setError('請輸入有效的模型識別，最多 128 字元。');
        return;
      }
      onReview({ workspaceId, name: trimmedName, mode, engine: engineOption.engine, provider: selectedProvider, model: trimmedModel }, reloadOptions);
    }
  }

  if (options.loading) return <Loading text="正在載入可用的執行設定…" />;
  if (options.error) return <Notice message={options.error} retry={options.retry} />;
  return <>
    <form className="ai-stack ai-proposal-form" onSubmit={(event) => { event.preventDefault(); propose(); }}>
      <div className="settings-field">
        <label htmlFor={`${ids}-instruction`}>描述要建立的 Agent</label>
        <p className="muted" id={`${ids}-proposal-hint`}>可描述用途、執行方式或引擎偏好。請勿輸入 API Key、Token 或密碼。</p>
        <textarea id={`${ids}-instruction`} className="text-input" rows={3} maxLength={AI_AGENT_PROPOSAL_MAX_BYTES} required autoComplete="off"
          aria-describedby={`${ids}-proposal-hint`} disabled={proposalRequest.busy} value={instruction}
          placeholder="例如：建立名為「付款驗收」的代管 Agent，優先使用內建引擎"
          onChange={(event) => { setInstruction(event.target.value); proposalRequest.setError(undefined); setProposalNote(''); }} />
      </div>
      <div className="action-row ai-actions">
        <button type="submit" className="button secondary" disabled={proposalRequest.busy || !instruction.trim()}>{proposalRequest.busy ? '提案產生中…' : '請 AI Manager 提案'}</button>
        {proposalRequest.busy ? <button type="button" className="button quiet" onClick={() => { proposalRequest.cancel(); setProposalNote('已取消提案請求。'); }}>取消提案</button> : null}
      </div>
      {proposalRequest.error ? <Notice message={proposalRequest.error} /> : null}
      <p className="access-note" role="status">{proposalRequest.busy ? 'AI Manager 正在產生提案。' : proposalNote}</p>
    </form>
    <form className="ai-stack" onSubmit={(event) => { event.preventDefault(); setError(undefined); review(); }}>
      <fieldset className="ai-stack ai-configuration-controls" disabled={proposalRequest.busy}>
        <legend className="sr-only">Agent 設定</legend>
        <div className="settings-field"><label htmlFor={`${ids}-name`}>Agent 名稱</label>
          <input id={`${ids}-name`} className="text-input" value={name} autoComplete="off"
            onChange={(event) => { setName(event.target.value); onNameChange(event.target.value); }} />
        </div>
        <fieldset className="ai-fieldset"><legend>執行方式</legend>
          <label><input type="radio" name={`${ids}-mode`} checked={mode === 'managed'} onChange={() => setMode('managed')} />平台代管</label>
          <label><input type="radio" name={`${ids}-mode`} checked={mode === 'self_managed'} onChange={() => setMode('self_managed')} />自管 MCP</label>
        </fieldset>
        {mode === 'managed' ? <>
          {options.data?.managed.length ? <div className="settings-field"><label htmlFor={`${ids}-profile`}>代管設定</label>
            <select id={`${ids}-profile`} className="text-input" required value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              <option value="">選擇部署設定</option>
              {options.data.managed.map((entry) => <option key={entry.profileId} value={entry.profileId}>{profileLabel(entry)}</option>)}
            </select>
          </div> : <p className="muted">目前沒有可選用的代管部署設定。</p>}
          {profile ? <div className="ai-inline-note">
            <p>符合設定的 Manager {profile.managerIds.length ? profile.managerIds.join('、') : '無'}</p>
            {profile.reason ? <p>{agentReason(profile.reason)} 可先儲存設定，待資源可用後再重新驗證。</p> : null}
          </div> : null}
        </> : options.data?.selfManaged.length ? <div className="ai-fields">
          <div className="settings-field"><label htmlFor={`${ids}-engine`}>執行引擎</label>
            <select id={`${ids}-engine`} className="text-input" required value={engine} onChange={(event) => { setEngine(event.target.value); setProvider(''); }}>
              <option value="">選擇引擎</option>{options.data.selfManaged.map((entry) => <option key={entry.engine} value={entry.engine}>{engineLabels[entry.engine]}</option>)}
            </select>
          </div>
          <div className="settings-field"><label htmlFor={`${ids}-provider`}>模型供應商</label>
            <select id={`${ids}-provider`} className="text-input" required disabled={!engineOption} value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">選擇供應商</option>{engineOption?.providers.map((entry) => <option key={entry} value={entry}>{providerLabels[entry]}</option>)}
            </select>
          </div>
          <div className="settings-field"><label htmlFor={`${ids}-model`}>模型識別</label><input id={`${ids}-model`} className="text-input" value={model} onChange={(event) => setModel(event.target.value)} required maxLength={128} spellCheck={false} autoComplete="off" /></div>
        </div> : <p className="muted">目前沒有可用的自管 MCP 設定。</p>}
        {error ? <Notice message={error} /> : null}
        <div className="action-row ai-actions"><button type="submit" className="button primary" disabled={disabled || (mode === 'managed' ? !profile : !engineOption || !selectedProvider)}>檢視設定</button></div>
      </fieldset>
    </form>
  </>;
}

function profileLabel(profile: AiOptions['managed'][number]): string {
  return `${profile.profileId} · ${engineLabels[profile.engine]} · ${providerLabels[profile.provider]} · ${profile.model}`;
}

function matchesOptions(draft: AiAgentDraft, options: AiOptions): boolean {
  return draft.mode === 'managed' ? options.managed.some((profile) => profile.profileId === draft.profileId && profile.engine === draft.engine &&
    profile.provider === draft.provider && profile.model === draft.model)
    : options.selfManaged.some((option) => option.engine === draft.engine && option.providers.includes(draft.provider));
}

function ReviewAgent({ api, draft, requestId, reloadOptions, workspaceName, available, onBack, onCreated, onAccessChanged }: {
  api: AiAdminApi; draft: AiAgentDraft; requestId: string; workspaceName: string; available: boolean; onBack: () => void;
  reloadOptions?: () => void;
  onCreated: (result: { agent: AiAgent; token?: string }) => void; onAccessChanged: () => void;
}) {
  const keyInput = useRef<HTMLInputElement>(null);
  const [uncertain, setUncertain] = useState(false);
  const mutation = useAiMutation(onAccessChanged);
  const managed = draft.mode === 'managed';

  function create() {
    if (!available && !uncertain) return;
    const apiKey = keyInput.current?.value ?? '';
    if (managed && !validAiKey(apiKey)) { mutation.setError('API Key 須為 1 至 4096 個可列印且不含空白的 ASCII 字元。'); return; }
    void mutation.submit(async (signal) => {
      // Uncertain creation retries keep the original request even if the available options have changed.
      if (reloadOptions && !uncertain) {
        const options = await api.getOptions(draft.workspaceId, signal);
        if (signal.aborted) return;
        if (!matchesOptions(draft, options)) {
          if (keyInput.current) keyInput.current.value = '';
          reloadOptions();
          throw new ApiError('可用設定已變更。請返回表單重新選擇，再確認建立。', 'OPTIONS_CHANGED');
        }
      }
      try {
        const result = await api.createAgent(draft.mode === 'managed' ? { ...draft, requestId, apiKey } : { ...draft, requestId }, signal);
        if (signal.aborted) return;
        if (keyInput.current) keyInput.current.value = '';
        onCreated(result);
      } catch (cause) {
        if (!signal.aborted && outcomeUncertain(cause)) setUncertain(true);
        throw cause;
      }
    });
  }

  return <>
    <AiHeading title="確認 Agent 設定" />
    <form className="ai-panel ai-stack" onSubmit={(event) => { event.preventDefault(); create(); }}>
      <dl className="ai-meta">
        <div><dt>Workspace</dt><dd>{workspaceName}</dd></div><div><dt>名稱</dt><dd>{draft.name}</dd></div>
        <div><dt>執行方式</dt><dd>{managed ? '平台代管' : '自管 MCP'}</dd></div><div><dt>引擎</dt><dd>{engineLabels[draft.engine]}</dd></div>
        <div><dt>模型供應商</dt><dd>{providerLabels[draft.provider]}</dd></div><div><dt>模型</dt><dd className="identifier">{draft.model}</dd></div>
        {draft.mode === 'managed' ? <div><dt>部署設定</dt><dd className="identifier">{draft.profileId}</dd></div> : null}
      </dl>
      {managed ? <AiKeyInput inputRef={keyInput} disabled={mutation.busy || uncertain} /> : <p>確認後會核發此 Workspace 的 MCP 接入 Token。請在自管執行端設定模型 API Key。</p>}
      {mutation.error ? <Notice message={mutation.error} /> : null}
      {uncertain ? <p>建立結果尚未確認。重送會沿用同一請求編號與設定。</p> : !available ? <Notice message="Workspace 目前無法建立 Agent。" /> : null}
      <div className="action-row ai-actions">
        <button type="submit" className="button primary" disabled={mutation.busy || (!available && !uncertain)}>{mutation.busy ? '建立中…' : uncertain ? '重送同一請求' : '確認建立 Agent'}</button>
        <button type="button" className="button secondary" disabled={mutation.busy || uncertain} onClick={onBack}>返回設定</button>
      </div>
    </form>
  </>;
}
