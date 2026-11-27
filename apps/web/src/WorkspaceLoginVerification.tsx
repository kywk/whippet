import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { formatDate, Notice } from './components';
import { WORKSPACE_VERIFICATION_REASONS } from './types';
import type { WhippetApi, WorkspaceProposal, WorkspaceSiteAccountVerification, WorkspaceVerificationReason } from './types';
import { loginStateLabels, loginVerificationReasons } from './workspaceLogin';

function verificationError(cause: unknown) {
  if (cause instanceof ApiError) {
    if (WORKSPACE_VERIFICATION_REASONS.some((reason) => reason === cause.code)) return loginVerificationReasons[cause.code as WorkspaceVerificationReason];
    if (cause.status === 403) return '你沒有管理此登入驗證的權限。';
    if (cause.code === 'security_unavailable') return '執行服務目前無法提供登入驗證，請稍後再試。';
    if (cause.status === 409) return '提案、憑證版本或登入驗證狀態已變更。請檢視最新狀態。';
  }
  return '登入驗證操作待確認。請檢視最新狀態後再操作。';
}

export function WorkspaceLoginVerification({ api, proposal, blocked, onBusyChange, onRefresh }: {
  api: WhippetApi; proposal: WorkspaceProposal; blocked: boolean;
  onBusyChange: (busy: boolean) => void; onRefresh: (proposalId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => () => controller.current?.abort(), []);
  const targets = proposal.content.targets.filter((site) => site.testScope === 'authenticated' || site.testScope === 'both');
  const accounts = new Map(proposal.content.testAccounts.map((account) => [account.accountId, account]));
  const credentials = new Map(proposal.accountCredentials?.map((entry) => [entry.accountId, entry]));

  function canVerify(result: WorkspaceSiteAccountVerification) {
    return proposal.scopeConfirmed && credentials.get(result.accountId)?.configured === true
      && (result.state === 'failed' || (result.state === 'pending' && result.reason === null));
  }

  async function act(targetOrigin: string, result: WorkspaceSiteAccountVerification) {
    if (blocked || controller.current) return;
    const runId = result.state === 'running' ? result.runId : null;
    if (runId ? !window.confirm('取消這一站、這個帳號的登入驗證？') : !canVerify(result)) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(undefined); setNote(undefined);
    try {
      if (runId) {
        const run = await api.cancelRun(runId, request.signal);
        if (run.id !== runId || run.workspaceId !== proposal.workspaceId || run.kind !== 'workspace_login_verification' || run.testId !== null) {
          throw new ApiError('登入驗證回應不符。', 'WORKSPACE_CONFLICT');
        }
      } else {
        await api.verifyWorkspaceProposalLogin(proposal.workspaceId, proposal.id, {
          baseRevision: proposal.baseRevision, requestId: crypto.randomUUID(), accountId: result.accountId, targetOrigin,
        }, request.signal);
      }
      if (!request.signal.aborted) setNote(runId ? '已送出取消請求。' : '已排入登入驗證。');
    } catch (cause) {
      if (!request.signal.aborted) setError(verificationError(cause));
    } finally {
      if (!request.signal.aborted) {
        try { await onRefresh(proposal.id); } catch { if (!request.signal.aborted) setError('登入驗證狀態同步失敗。請重新載入設定對話。'); }
      }
      controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  if (!targets.length) return null;
  return <section aria-labelledby="workspace-login-verification-title">
    <h4 id="workspace-login-verification-title">逐站登入驗證</h4>
    <ul className="workspace-snapshot-sites">{targets.map((target) => {
      const site = proposal.siteReadiness.find((entry) => entry.targetOrigin === target.origin && entry.testScope === target.testScope);
      return <li key={target.origin}>
        <strong>{target.name}</strong><p>{target.origin}</p>
        {site?.accounts.length ? <ul className="workspace-login-results">{site.accounts.map((result) => {
          const account = accounts.get(result.accountId);
          if (!account?.sites.some((entry) => entry.targetOrigin === target.origin)) return null;
          const reason = result.reason && loginVerificationReasons[result.reason];
          const cancel = result.state === 'running' && Boolean(result.runId);
          const action = cancel ? '取消驗證' : result.state === 'failed' ? '重試登入驗證' : '驗證登入';
          return <li key={result.accountId}>
            <p>{account.name} · {account.role}</p>
            <p role="status">{loginStateLabels[result.state]}{result.verifiedAt ? ` · ${formatDate(result.verifiedAt)}` : ''}</p>
            {reason ? <p className="inline-hint">{reason}</p> : null}
            {result.state !== 'verified' ? <button type="button" className="button secondary compact"
              aria-label={`${action} · ${target.name} · ${account.name}`} disabled={blocked || busy || (!cancel && !canVerify(result))}
              onClick={() => { void act(target.origin, result); }}>{action}</button> : null}
          </li>;
        })}</ul> : <p className="blocked-hint">請在訪談中為此站指定測試帳號與登入成功條件。</p>}
      </li>;
    })}</ul>
    {error ? <Notice message={error} /> : null}
    <p className="action-message" role="status">{note}</p>
  </section>;
}
