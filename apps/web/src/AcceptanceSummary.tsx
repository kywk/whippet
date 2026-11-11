import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, resolveReportUrl } from './api';
import { Notice, RunStatusBadge, StatusBadge } from './components';
import { CancelRunButton } from './TestActions';
import { isActiveRun } from './types';
import type { Draft, EditingSession, Run, WhippetApi } from './types';

interface Props {
  api: WhippetApi; apiBase: string; testId: string; session: EditingSession; draft: Draft; runs: Run[]; blocked: boolean;
  onRun: (run: Run) => void; onRefresh: () => Promise<EditingSession | undefined>; onBusyChange: (busy: boolean) => void;
}

export function AcceptanceSummaryCard({ api, apiBase, testId, session, draft, runs, blocked, onRun, onRefresh, onBusyChange }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [requested, setRequested] = useState<Run>();
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const attempted = useRef(new Set<string>());
  const summary = session.summary;
  const matching = summary?.revision === draft.revision && summary.validationRunId === draft.validationRunId;
  const ready = session.status === 'active' && draft.validationStatus === 'succeeded' && Boolean(draft.validationRunId && resolveReportUrl(draft.reportUrl, apiBase, window.location.href));
  const key = `${session.id}:${session.contextRevision ?? ''}:${draft.revision}:${draft.validationRunId ?? ''}:${summary?.runId ?? 'none'}`;
  const statusRunId = requested?.id ?? summary?.runId;
  const run = runs.find((item) => item.id === statusRunId) ?? requested;
  const failed = matching && summary && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(summary.status);
  const valid = matching && summary?.status === 'succeeded' && summary.validForCurrentDraft && Boolean(summary.description?.trim() && summary.backgroundSummary?.trim());
  const running = Boolean((run && isActiveRun(run)) || (summary && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(summary.status)));
  useEffect(() => { onBusyChange(pending); return () => onBusyChange(false); }, [pending, onBusyChange]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setError(undefined); }, [key]);
  useEffect(() => { if (requested?.id === summary?.runId) setRequested(undefined); }, [requested?.id, summary?.runId]);

  const request = useCallback(async () => {
    if (lock.current || blocked || !ready || !draft.validationRunId) return;
    lock.current = true; attempted.current.add(key); setPending(true); setError(undefined);
    const requestController = new AbortController(); controller.current = requestController;
    try {
      const next = await api.requestSummary(testId, session.id, draft.revision, draft.validationRunId, requestController.signal);
      if (requestController.signal.aborted) return;
      setRequested(next); onRun(next); await onRefresh();
    } catch (cause) {
      if (!requestController.signal.aborted) {
        setError(`${errorMessage(cause)} 摘要不會自動重送；請確認目前狀態後明確重試。成功驗證不會因此重跑。`);
        void onRefresh().catch(() => undefined);
      }
    } finally { if (!requestController.signal.aborted) setPending(false); lock.current = false; }
  }, [api, testId, session.id, draft.revision, draft.validationRunId, blocked, ready, key, onRun, onRefresh]);

  useEffect(() => {
    if (!ready || blocked || pending || running || failed || valid || error || attempted.current.has(key)) return;
    const timer = setTimeout(() => { void request(); }, 0);
    return () => clearTimeout(timer);
  }, [ready, blocked, pending, running, failed, valid, error, key, request]);

  return <section className="acceptance-summary" aria-labelledby="acceptance-summary-title">
    <div className="section-heading"><h4 id="acceptance-summary-title">驗收摘要</h4>{run ? <RunStatusBadge run={run} /> : summary ? <StatusBadge status={summary.status} /> : <span className="muted">尚未產生</span>}</div>
    <p className="inline-hint">目前 revision 驗證成功且報告就緒後，建立一次摘要任務。摘要失敗可獨立重試，不重跑成功驗證。</p>
    {error ? <Notice message={error} /> : null}
    {run?.error ? <pre className="run-error">{run.error}</pre> : null}
    {summary?.status === 'succeeded' ? <>
      {!valid ? <p className="blocked-hint">此摘要已過期或內容不完整，不能用於目前草稿的發佈。</p> : <p className="action-message">驗收摘要已就緒，請檢視說明、背景與驗證報告後確認發佈。</p>}
      {summary.name ? <p className="summary-name">候選名稱：{summary.name}</p> : null}
      <h5>版本說明</h5><p className="summary-content">{summary.description || '尚未提供版本說明。'}</p>
      <details><summary>查看背景摘要</summary><p className="summary-content">{summary.backgroundSummary || '尚未提供背景摘要。'}</p></details>
    </> : null}
    {!ready ? <p className="muted">等待目前草稿驗證通過且報告就緒。</p> : null}
    <div className="action-row"><button className="button secondary" disabled={!ready || blocked || pending || running || Boolean(valid)} onClick={() => { void request(); }}>{pending ? '摘要送出中…' : failed || error ? '重試驗收摘要' : running ? '摘要進行中' : '產生驗收摘要'}</button>
      {run ? <CancelRunButton api={api} run={run} onUpdated={onRun} /> : null}</div>
  </section>;
}
