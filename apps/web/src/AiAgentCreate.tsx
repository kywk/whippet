import { useCallback, useId, useRef, useState } from 'react';
import { isProtectedCredentialTransport } from './api';
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
  const [review, setReview] = useState<{ draft: AiAgentDraft; requestId: string }>();
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
    {review ? <ReviewAgent api={api} draft={review.draft} requestId={review.requestId} workspaceName={workspace?.name ?? workspaceId}
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
        <div className="settings-field"><label htmlFor={`${fieldId}-name`}>Agent 名稱</label>
          <input id={`${fieldId}-name`} className="text-input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </div>
        {workspace ? <Configuration key={workspace.id} api={api} workspaceId={workspace.id} name={name} disabled={!protectedTransport}
          onReview={(draft) => setReview({ draft, requestId: crypto.randomUUID() })} /> : null}
      </section> : null}
    </div>
  </>;
}

function Configuration({ api, workspaceId, name, disabled, onReview }: {
  api: AiAdminApi; workspaceId: string; name: string; disabled: boolean; onReview: (draft: AiAgentDraft) => void;
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
  const profile = options.data?.managed.find((item) => item.profileId === profileId);
  const engineOption = options.data?.selfManaged.find((item) => item.engine === engine);
  const selectedProvider = engineOption?.providers.find((item) => item === provider);

  function review() {
    if (disabled || options.loading || !options.data) return;
    const trimmedName = name.trim();
    if (!trimmedName || new TextEncoder().encode(trimmedName).length > 200) {
      setError('Agent 名稱去除前後空白後須為 1 至 200 UTF-8 bytes。');
      return;
    }
    if (mode === 'managed' && profile) {
      onReview({ workspaceId, name: trimmedName, mode, engine: profile.engine, provider: profile.provider, model: profile.model, profileId: profile.profileId });
    } else if (mode === 'self_managed' && engineOption && selectedProvider) {
      const trimmedModel = model.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(trimmedModel)) {
        setError('請輸入有效的模型識別，最多 128 字元。');
        return;
      }
      onReview({ workspaceId, name: trimmedName, mode, engine: engineOption.engine, provider: selectedProvider, model: trimmedModel });
    }
  }

  if (options.loading) return <Loading text="正在載入可用的執行設定…" />;
  if (options.error) return <Notice message={options.error} retry={options.retry} />;
  return <form className="ai-stack" onSubmit={(event) => { event.preventDefault(); setError(undefined); review(); }}>
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
  </form>;
}

function profileLabel(profile: AiOptions['managed'][number]): string {
  return `${profile.profileId} · ${engineLabels[profile.engine]} · ${providerLabels[profile.provider]} · ${profile.model}`;
}

function ReviewAgent({ api, draft, requestId, workspaceName, available, onBack, onCreated, onAccessChanged }: {
  api: AiAdminApi; draft: AiAgentDraft; requestId: string; workspaceName: string; available: boolean; onBack: () => void;
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
