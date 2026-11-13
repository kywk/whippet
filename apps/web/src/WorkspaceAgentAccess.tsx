import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage } from './api';
import { formatDate, Notice } from './components';
import type { AgentToken, AgentToolAudit, WhippetApi } from './types';

type Availability = 'loading' | 'ready' | 'disabled' | 'unavailable';

const decisionLabel: Record<AgentToolAudit['decision'], string> = {
  allowed: '允許', denied: '拒絕', rate_limited: '限流', failed: '失敗',
};

function accessError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return '管理 session 已失效，請登出後重新輸入管理 key。';
  return errorMessage(error);
}

export function WorkspaceAgentAccess({ api, workspaceId, active }: { api: WhippetApi; workspaceId: string; active: boolean }) {
  const [availability, setAvailability] = useState<Availability>('loading');
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [audit, setAudit] = useState<AgentToolAudit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [plainToken, setPlainToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [auditError, setAuditError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const createRequest = useRef<AbortController | null>(null);
  const createGeneration = useRef(0);
  const createLock = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const reload = useCallback(async () => {
    if (!api.listAgentTokens || !api.listAgentToolAudit) { setAvailability('unavailable'); return; }
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const turn = ++generation.current;
    setAvailability('loading'); setError(undefined); setAuditError(undefined);
    try {
      const [nextTokens, nextAudit] = await Promise.all([
        api.listAgentTokens(workspaceId, controller.signal),
        api.listAgentToolAudit(workspaceId, undefined, controller.signal),
      ]);
      if (controller.signal.aborted || turn !== generation.current) return;
      setTokens(nextTokens); setAudit(nextAudit.items); setCursor(nextAudit.nextCursor); setAvailability('ready');
    } catch (cause) {
      if (controller.signal.aborted || turn !== generation.current) return;
      setAvailability(cause instanceof ApiError && cause.status === 503 && cause.code === 'disabled' ? 'disabled' : 'unavailable');
      if (!(cause instanceof ApiError && cause.status === 503 && cause.code === 'disabled')) setError(accessError(cause));
    }
  }, [api, workspaceId]);

  useEffect(() => {
    if (active) { setBusy(false); void reload(); }
    else { request.current?.abort(); ++generation.current; setBusy(false); setPlainToken(''); setName(''); }
    return () => {
      request.current?.abort(); ++generation.current;
      ++createGeneration.current;
      createRequest.current?.abort();
      createRequest.current = null;
      createLock.current = false;
    };
  }, [active, reload]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!api.createAgentToken || createLock.current || !activeRef.current) return;
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 100) { setError('名稱需為 1 至 100 個字元。'); return; }
    const controller = new AbortController();
    const turn = ++createGeneration.current;
    createRequest.current = controller;
    createLock.current = true;
    setBusy(true); setError(undefined); setPlainToken('');
    try {
      const created = await api.createAgentToken(workspaceId, trimmed, controller.signal);
      if (controller.signal.aborted || turn !== createGeneration.current || !activeRef.current) return;
      setPlainToken(created.token);
      setTokens((previous) => [created.agentToken, ...previous.filter((item) => item.id !== created.agentToken.id)]);
      setName('');
    } catch (cause) {
      if (!controller.signal.aborted && turn === createGeneration.current && activeRef.current) setError(`${accessError(cause)} 若結果不明，請先重新載入清單確認，避免重複建立。`);
    } finally {
      if (turn === createGeneration.current) {
        createRequest.current = null;
        createLock.current = false;
        setBusy(false);
      }
    }
  }

  async function revoke(tokenId: string) {
    if (!api.revokeAgentToken || busy || !window.confirm('撤銷後這個 Agent Token 會立即失效。確定撤銷？')) return;
    setBusy(true); setError(undefined); setPlainToken('');
    try {
      await api.revokeAgentToken(workspaceId, tokenId);
      if (!activeRef.current) return;
      // 以 Server 清單確認撤銷狀態，不在前端猜測 revokedAt。
      const next = await api.listAgentTokens?.(workspaceId);
      if (next) setTokens(next);
    } catch (cause) { if (activeRef.current) setError(`${accessError(cause)} 請重新載入清單確認撤銷狀態。`); }
    finally { setBusy(false); }
  }

  async function moreAudit() {
    if (!cursor || !api.listAgentToolAudit || auditBusy) return;
    setAuditBusy(true); setAuditError(undefined);
    try {
      const next = await api.listAgentToolAudit(workspaceId, cursor);
      if (!activeRef.current) return;
      setAudit((previous) => [...previous, ...next.items.filter((item) => !previous.some((prior) => prior.id === item.id))]);
      setCursor(next.nextCursor);
    } catch (cause) { if (activeRef.current) setAuditError(accessError(cause)); }
    finally { setAuditBusy(false); }
  }

  return <section className="workspace-agent-access" aria-labelledby="agent-access-title">
    <h3 id="agent-access-title">外部 Agent 存取</h3>
    <p className="inline-hint">管理 key 用來登入 Web 管理介面；下列 Agent Token 專供外部 Agent 連接 MCP，兩者不能互用。</p>
    {availability === 'loading' ? <p role="status">正在讀取 Agent Token 與工具稽核…</p> : null}
    {availability === 'disabled' ? <p className="settings-impact">管理 gate 尚未設定，MCP 與 Agent Token 管理未啟用；既有 Web 流程可照常使用。</p> : null}
    {availability === 'unavailable' ? <>{error ? <Notice message={error} /> : <p className="inline-hint">此介面目前無法使用。</p>}<button className="button secondary compact" onClick={() => { void reload(); }}>重新載入</button></> : null}
    {availability === 'ready' ? <>
      <form className="agent-token-form" onSubmit={(event) => { void create(event); }}>
        <label className="settings-field">Token 名稱
          <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" maxLength={200} disabled={busy} required />
        </label>
        <button className="button primary compact" type="submit" disabled={busy || !name.trim()}>{busy ? '處理中…' : '建立 Agent Token'}</button>
      </form>
      {plainToken ? <div className="agent-token-once" role="status">
        <strong>請現在保存 Token；離開此頁或清除後無法再查看明文。</strong>
        <label className="settings-field">新建 Agent Token（僅顯示一次）<input className="text-input mono" type="text" value={plainToken} readOnly spellCheck={false} autoComplete="off" onFocus={(event) => event.currentTarget.select()} /></label>
        <button className="button secondary compact" type="button" onClick={() => setPlainToken('')}>清除明文</button>
      </div> : null}
      {error ? <Notice message={error} /> : null}
      <div className="agent-access-heading"><h4>Agent Token</h4><button className="button quiet compact" disabled={busy} onClick={() => { setPlainToken(''); void reload(); }}>重新載入</button></div>
      {tokens.length ? <ul className="agent-token-list">{tokens.map((token) => <li key={token.id}>
        <div><strong>{token.name}</strong><p className="settings-meta">建立：{formatDate(token.createdAt)} · 最後使用：{token.lastUsedAt ? formatDate(token.lastUsedAt) : '尚未使用'}</p><p className="settings-meta">{token.revokedAt ? `已撤銷：${formatDate(token.revokedAt)}` : '有效'}</p></div>
        {!token.revokedAt ? <button className="button secondary compact" disabled={busy} onClick={() => { void revoke(token.id); }}>撤銷</button> : null}
      </li>)}</ul> : <p className="inline-hint">尚未建立 Agent Token。</p>}
      <h4>工具稽核</h4>
      {audit.length ? <ul className="agent-audit-list">{audit.map((item) => <li key={item.id}><strong>{item.toolName}</strong><span>{decisionLabel[item.decision]}</span><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time><small>Token ID：{item.tokenId}</small></li>)}</ul> : <p className="inline-hint">目前沒有工具呼叫紀錄。</p>}
      {auditError ? <Notice message={auditError} /> : null}
      {cursor ? <button className="button secondary compact" disabled={auditBusy} onClick={() => { void moreAudit(); }}>{auditBusy ? '載入中…' : '載入更多稽核'}</button> : null}
    </> : null}
  </section>;
}
