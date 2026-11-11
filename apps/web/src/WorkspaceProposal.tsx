import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Notice } from './components';
import { CapabilityStatus, WorkspaceConfigView } from './WorkspaceSettings';
import type { WhippetApi, WorkspaceDetail, WorkspaceProposal as Proposal } from './types';

export function WorkspaceProposalCard({ api, workspace, proposal, contextRevision, blocked, onUpdated, onBusyChange, onRefresh }: {
  api: WhippetApi; workspace: WorkspaceDetail; proposal: Proposal; contextRevision: number; blocked: boolean;
  onUpdated: (proposal: Proposal, workspace?: WorkspaceDetail) => void; onBusyChange: (busy: boolean) => void; onRefresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'scope' | 'apply' | 'cancel'>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const current = proposal.status === 'pending' && proposal.baseRevision === workspace.revision && proposal.contextRevision === contextRevision;
  const complete = proposal.content.targets.length > 0 && Boolean(proposal.content.purpose.trim() && proposal.content.backgroundSummary.trim());
  useEffect(() => { setConfirmed(false); setConflict(false); setError(undefined); }, [proposal, workspace.revision, contextRevision]);
  useEffect(() => { onBusyChange(Boolean(busy)); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => () => controller.current?.abort(), []);
  async function act(kind: 'scope' | 'apply' | 'cancel') {
    if (lock.current || blocked || !current || conflict || (kind !== 'cancel' && !confirmed) || (kind === 'apply' && !complete)) return;
    if (kind === 'cancel' && !window.confirm('取消這份設定提案？暫時範圍確認會撤回，現行正式設定與歷史資料保留。')) return;
    lock.current = true; setBusy(kind); setError(undefined); setNote(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      if (kind === 'apply') {
        const result = await api.confirmWorkspaceProposal(workspace.id, proposal.id, proposal.baseRevision, request.signal);
        if (request.signal.aborted) return;
        onUpdated(result.proposal, result.workspace);
        setNote(`提案已套用，正式設定 revision ${result.workspace.revision}。現有草稿需重新驗證，歷史版本與 Run 保留原快照。`);
      } else {
        const next = kind === 'scope' ? await api.confirmWorkspaceScope(workspace.id, proposal.id, proposal.baseRevision, request.signal) : await api.cancelWorkspaceProposal(workspace.id, proposal.id, proposal.baseRevision, request.signal);
        if (request.signal.aborted) return;
        onUpdated(next); setNote(kind === 'scope' ? 'Server 已保存本提案的範圍確認；這不代表網站已被探索或設定已啟用。' : '提案已取消，現行正式設定未被取代。');
      }
      setConfirmed(false);
      try { await onRefresh(); } catch { setError('操作已回應，但重新載入狀態失敗。請先重新載入設定對話，勿直接重送。'); setConflict(true); }
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      setConfirmed(false); setError(`${errorMessage(cause)} 請重新載入設定對話確認最新提案，不會自動重送。`);
    } finally { lock.current = false; if (!request.signal.aborted) setBusy(undefined); }
  }
  return <section className="workspace-proposal" aria-labelledby="workspace-proposal-title" data-proposal-id={proposal.id}>
    <div className="section-heading"><h3 id="workspace-proposal-title">設定提案（待審內容）</h3><span className="status-badge">{({ pending: '待確認', applied: '已套用', cancelled: '已取消', stale: '已過期', superseded: '已被取代' })[proposal.status]}</span></div>
    <p className="inline-hint">基於設定 revision {proposal.baseRevision} · 對話版本 {proposal.contextRevision}</p>
    <p className="identifier version-id">{proposal.id}</p>
    <p className="summary-content">範圍確認：{proposal.scopeConfirmed ? 'Server 已確認此提案範圍' : '尚未確認'}。確認範圍不代表已完成探索。</p>
    <CapabilityStatus label="AI 探索工具" capability={workspace.capabilities?.aiExploration} />
    <WorkspaceConfigView config={proposal.content} />
    {proposal.invalidationReason ? <p className="blocked-hint">提案失效原因：{proposal.invalidationReason}</p> : null}
    {!current && proposal.status === 'pending' ? <p className="blocked-hint">提案與目前設定或對話版本不一致，請重新載入後取得新提案。</p> : null}
    {proposal.appliedRevision !== null ? <p className="action-message">已套用於正式設定 revision {proposal.appliedRevision}</p> : null}
    {current ? <>
      <p className="settings-impact">確認套用會更新正式設定與許可，現有草稿需重新驗證；已發布版本與既有 Run 保留原快照。相依服務不會成為可任意驗測的目標。</p>
      {!complete ? <p className="blocked-hint">確認套用需要至少一個目標、非空驗測目的與背景。請在設定對話中要求補齊提案；前端不會代填或刪除欄位。</p> : null}
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={blocked || Boolean(busy) || conflict} onChange={(event) => setConfirmed(event.target.checked)} />我已檢視目標、相依範圍、角色與設定提案</label>
      <div className="action-row"><button className="button secondary" disabled={blocked || Boolean(busy) || conflict || !confirmed || proposal.scopeConfirmed || !proposal.content.targets.length} onClick={() => { void act('scope'); }}>{busy === 'scope' ? '確認中…' : '確認提案範圍'}</button><button className="button primary" disabled={blocked || Boolean(busy) || conflict || !confirmed || !complete} onClick={() => { void act('apply'); }}>{busy === 'apply' ? '套用中…' : '確認並套用提案'}</button><button className="button quiet" disabled={blocked || Boolean(busy) || conflict} onClick={() => { void act('cancel'); }}>取消提案</button></div>
    </> : null}
    {error ? <Notice message={error} /> : null}{note ? <p className="action-message" role="status">{note}</p> : null}
  </section>;
}
