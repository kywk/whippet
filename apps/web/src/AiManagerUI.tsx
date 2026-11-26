import { useEffect, useId, useRef, useState } from 'react';
import type { AnchorHTMLAttributes, ReactNode, RefObject } from 'react';
import type { AiManagementRoute } from './access';
import { siteManagementHref } from './access';
import { ApiError, errorMessage, resolveMcpEndpoint } from './api';
import type { AiAgent, AiPage, AiProvider, AiReason } from './aiAdminTypes';
import type { AgentRuntimeEngine, WorkspaceDetail } from './types';
import { Notice } from './components';

export type AiNavigate = (route: AiManagementRoute) => void;
export type AiWorkspaceDirectory = { data?: WorkspaceDetail[]; loading: boolean; error?: string; retry: () => void };

export const engineLabels: Record<AgentRuntimeEngine, string> = { builtin: '內建', vercel: 'Vercel', pi: 'Pi' };
export const providerLabels: Record<AiProvider, string> = { opencode: 'OpenCode', 'openai-responses': 'OpenAI Responses' };
export const agentStatus = { waiting_connection: '等待連線', verifying: '驗證中', ready: '就緒', failed: '驗證失敗', disabled: '已停用' };
const reasonLabels: Record<AiReason, string> = {
  manager_unavailable: '目前沒有符合設定且可派工的 Manager。', no_capacity: '符合條件的 Manager 目前沒有可用名額。',
  engine_mismatch: '執行端登錄的引擎或設定與 Agent 不符。', worker_changed: 'Worker 版本已變更，需要重新驗證。',
  heartbeat_timeout: '執行端心跳逾時。', provider_auth_failed: '模型供應商拒絕憑證，請更新模型金鑰。',
  provider_unavailable: '目前無法連線至模型供應商。', probe_failed: '模型回覆未通過驗證。', probe_timed_out: '模型驗證逾時。',
  cleanup_pending: '等待執行資源回收。', key_missing: '模型金鑰尚未配置或已撤銷。', verification_required: '設定已變更，需要重新驗證。',
  token_revoked: '接入 Token 已撤銷。', workspace_archiving: 'Workspace 正在封存。', workspace_archived: 'Workspace 已封存。',
};

export function agentReason(reason: AiReason): string { return reasonLabels[reason]; }

export function AgentStatus({ status }: { status: AiAgent['status'] }) {
  const tone = status === 'ready' ? 'ok' : status === 'verifying' || status === 'failed' ? 'warm' : 'neutral';
  return <span className={`chip ${tone}`}>{agentStatus[status]}</span>;
}

export function AiLink({ route, onNavigate, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  route: AiManagementRoute; onNavigate: AiNavigate;
}) {
  return <a {...props} href={siteManagementHref({ page: 'ai', route })} onClick={(event) => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(route);
  }}>{children}</a>;
}

export function AiHeading({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <header className="ai-heading"><h2 ref={ref} tabIndex={-1}>{title}</h2>{actions ? <div className="action-row ai-actions">{actions}</div> : null}</header>;
}

export async function collectAiPages<T extends { id: string }>(load: (after: string | null) => Promise<AiPage<T>>): Promise<T[]> {
  const items = new Map<string, T>();
  const seen = new Set<string>();
  let after: string | null = null;
  do {
    const page = await load(after);
    for (const item of page.items) items.set(item.id, item);
    after = page.nextAfter;
    if (after !== null) {
      if (!after || seen.has(after)) throw new ApiError('AI 管理清單的分頁識別重複。', 'INVALID_RESPONSE');
      seen.add(after);
    }
  } while (after !== null);
  return [...items.values()];
}

export function useAiRefresh(retry: () => void, enabled: boolean, interval = 5000) {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) retry(); }, interval);
    return () => window.clearInterval(timer);
  }, [enabled, interval, retry]);
}

export function useAiMutation(onAccessChanged: () => void, refresh?: () => void) {
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => request.current?.abort(), []);

  async function submit(task: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try { await task(controller.signal); }
    catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
      if (cause instanceof ApiError) {
        if (cause.status === 401 || cause.status === 403) onAccessChanged();
        if (cause.status === 409) refresh?.();
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, setError, submit };
}

export function outcomeUncertain(cause: unknown): boolean {
  return cause instanceof ApiError && !['INSECURE_TRANSPORT', 'secrets_unavailable', 'disabled'].includes(cause.code) &&
    (cause.status === 0 || cause.status >= 500 || cause.code === 'INVALID_RESPONSE');
}

export function AiDialog({ title, text, busy, error, onClose, children }: {
  title: string; text: string; busy: boolean; error?: string; onClose: () => void; children: ReactNode;
}) {
  const titleId = useId();
  const textId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('[data-dialog-cancel]')?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="script-edit-dialog ai-dialog" aria-labelledby={titleId} aria-describedby={textId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{title}</h2><p id={textId}>{text}</p>
    {error ? <Notice message={error} /> : null}
    {children}
  </dialog>;
}

export function AiKeyInput({ inputRef, disabled, label = '模型 API Key' }: {
  inputRef: RefObject<HTMLInputElement | null>; disabled: boolean; label?: string;
}) {
  const id = useId();
  return <div className="settings-field">
    <label htmlFor={id}>{label}</label>
    <input ref={inputRef} id={id} className="text-input" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={4096} required disabled={disabled} />
  </div>;
}

export function validAiKey(value: string): boolean { return value.length > 0 && value.length <= 4096 && !/[^!-~]/.test(value); }

export function TokenReceipt({ token, apiBase, onClear }: { token?: string; apiBase: string; onClear?: () => void }) {
  const [note, setNote] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const mcpUrl = resolveMcpEndpoint(apiBase, window.location.href);

  useEffect(() => {
    if (!token || !onClear) return;
    function clearBeforeLeaving() {
      if (field.current) field.current.value = '';
      onClear?.();
    }
    window.addEventListener('pagehide', clearBeforeLeaving);
    return () => window.removeEventListener('pagehide', clearBeforeLeaving);
  }, [token, onClear]);

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      onClear?.();
      setNote('已複製 Token，明文已從此頁清除。');
    } catch {
      field.current?.focus();
      field.current?.select();
      setNote('無法使用剪貼簿，請手動複製選取的 Token。');
    }
  }

  return <section className="ai-panel ai-token-receipt">
    <h3>MCP 接入</h3>
    {mcpUrl ? <p>將 <code>WHIPPET_MCP_URL</code> 設為 <code className="identifier">{mcpUrl}</code>。</p> : <p>請向部署管理員取得完整 MCP URL。</p>}
    <p>在支援 v14 登錄的接單端設定 <code>WHIPPET_AGENT_TOKEN</code>，並另行設定該 Agent 的模型 API Key。</p>
    {token ? <>
      <p>Token 明文只在這次核發時顯示。複製或清除後可從資源頁換發。</p>
      <div className="settings-field"><label htmlFor={id}>一次性接入 Token</label><input ref={field} id={id} className="text-input identifier" autoComplete="off" spellCheck={false} readOnly value={token} /></div>
      <div className="action-row ai-actions">
        <button type="button" className="button primary" onClick={() => { void copy(); }}>複製 Token</button>
        <button type="button" className="button secondary" onClick={() => { onClear?.(); setNote('已清除 Token 明文。'); }}>清除明文</button>
      </div>
    </> : note ? null : <p>此回應沒有 Token 明文。若需要新的憑證，請到執行資源換發。</p>}
    <p className="access-note" role="status">{note}</p>
  </section>;
}
