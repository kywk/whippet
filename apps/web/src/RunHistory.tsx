import type { ReactNode } from 'react';
import { formatDate, Loading, Notice, ReportLink, RunProblem, RunStatusBadge, runKindLabel } from './components';
import { RunArtifacts } from './RunArtifacts';
import { CancelRunButton } from './TestActions';
import { scriptOriginLabel } from './capabilities';
import { AuthorEngineStatus } from './AuthorEngineStatus';
import { RefreshIcon } from './icons';
import { isBadStatus } from './trail';
import { canWatchRun, isActiveRun } from './types';
import type { Run, WhippetApi } from './types';

interface Props {
  api: WhippetApi;
  apiBase: string;
  runs: Run[];
  group: 'formal' | 'editing';
  loading: boolean;
  error?: string;
  polling: boolean;
  onRefresh: () => void;
  onRun?: (run: Run) => void;
  onWatch?: (run: Run) => void;
  liveView?: ReactNode;
}

export function RunHistory({ api, apiBase, runs, group, loading, error, polling, onRefresh, onRun, onWatch, liveView }: Props) {
  const formal = group === 'formal';
  const latest = runs[0];
  const latestTitle = formal ? '最近一次正式執行' : '最近編輯結果';
  const historyTitle = formal ? '正式執行歷史' : 'AI 與草稿驗證紀錄';
  return <section className={`run-history${formal ? ' overview-history' : ''}`} aria-labelledby={`${group}-history-title`}>
    <div className="section-heading run-history-heading">
      <h2 id={`${group}-history-title`}>{historyTitle} <span className="count">{runs.length}</span></h2>
      <button className="button secondary compact" disabled={loading} onClick={onRefresh}><RefreshIcon />{loading ? '更新中…' : '重新整理紀錄'}</button>
    </div>
    {error ? <Notice message={error} retry={onRefresh} /> : null}
    {loading && !latest ? <Loading text={`正在載入${historyTitle}…`} /> : null}
    {latest ? <section className="latest-section" aria-labelledby={`${group}-latest-title`}>
      <div className="section-heading"><h3 id={`${group}-latest-title`}>{latestTitle}</h3>{polling && runs.some(isActiveRun) ? <span className="refresh-status" role="status">自動更新中</span> : null}</div>
      <div className="latest-run">
        <div className="latest-summary">
          <RunStatusBadge run={latest} />
          {formal ? null : <span>{runKindLabel(latest)}</span>}
          {latest.kind === 'author' ? <AuthorEngineStatus engine={latest.authorEngine ?? 'builtin'} status={latest.status} /> : null}
          <time dateTime={latest.createdAt}>{formatDate(latest.createdAt)}</time>
          {formal && latest.startedAt ? <span className="latest-duration">{duration(latest)}</span> : null}
          {latest.kind === 'author' ? <span>{latest.authorMode === 'summary' ? '結果見驗收摘要' : '撰寫結果見對話'}</span> : <ReportLink reportUrl={latest.reportUrl} apiBase={apiBase} />}
          <FeedbackReportLink url={latest.feedbackReportUrl} />
        </div>
        <RunProblem run={latest} />
        {latest.kind !== 'author' && latest.error ? <details className="error-details"><summary>查看技術細節</summary><pre className="run-error">{latest.error}</pre></details> : null}
        {isActiveRun(latest) && (onWatch || onRun) ? <div className="action-row">
          {onWatch && canWatchRun(latest) ? <button className="button secondary compact" onClick={() => onWatch(latest)}>開始監看</button> : null}
          {onRun ? <CancelRunButton api={api} run={latest} onUpdated={onRun} /> : null}
        </div> : null}
      </div>
    </section> : null}
    {liveView}
    {runs.length ? <div className="table-scroll"><table><caption className="sr-only">{historyTitle}，最新紀錄在前</caption>
        <thead><tr><th scope="col">狀態／Run</th>{formal ? null : <th scope="col">種類</th>}<th scope="col">建立時間</th><th scope="col" className="run-duration-col">耗時</th><th scope="col">報告／操作</th></tr></thead>
        <tbody>{runs.map((run) => <tr key={run.id} data-run-id={run.id}>
          <td>
            <RunStatusBadge run={run} /><span className="table-run-id identifier mono" title={run.id}>{shortRunId(run.id)}</span>
            <span className="run-origin">{scriptOriginLabel(run.scriptOrigin)}</span>
            {run.kind === 'author' ? <AuthorEngineStatus engine={run.authorEngine ?? 'builtin'} status={run.status} /> : null}
            {isBadStatus(run.status) ? <details className="error-details">
              <summary>查看處理建議</summary>
              <RunProblem run={run} />
              {run.kind !== 'author' && run.error ? <pre className="run-error">{run.error}</pre> : null}
            </details> : null}
          </td>
          {formal ? null : <td className="col-nowrap">{runKindLabel(run)}</td>}
          <td><time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>{formal && run.startedAt ? <span className="run-mobile-duration">{duration(run)}</span> : null}</td>
          <td className="run-duration-col col-nowrap">{duration(run)}</td>
          <td><div className="run-actions">
            {run.kind === 'author' ? <span className="muted col-nowrap">{run.authorMode === 'summary' ? '結果見驗收摘要' : '撰寫結果見對話'}</span> : <>
              <ReportLink reportUrl={run.reportUrl} apiBase={apiBase} />
              <FeedbackReportLink url={run.feedbackReportUrl} />
              {isBadStatus(run.status) ? <RunArtifacts api={api} apiBase={apiBase} runId={run.id} /> : null}
            </>}
            {isActiveRun(run) ? <>
              {onWatch && canWatchRun(run) ? <button className="button secondary compact" aria-label={`開始監看 Run ${run.id}`} onClick={() => onWatch(run)}>開始監看</button> : null}
              {onRun ? <CancelRunButton api={api} run={run} onUpdated={onRun} /> : null}
            </> : null}
          </div></td>
        </tr>)}</tbody>
      </table></div> : !loading && !error ? <p className="run-history-empty muted">{formal ? '尚無正式執行紀錄。' : '尚無 AI 撰寫或草稿驗證紀錄。'}</p> : null}
  </section>;
}

function FeedbackReportLink({ url }: { url?: string }) {
  if (!url) return null;
  try {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password ||
        target.search || target.hash) return null;
    return <a className="report-link" href={target.href} target="_blank" rel="noopener noreferrer" aria-label="查看回饋單（新分頁）">查看回饋單</a>;
  } catch {
    return null;
  }
}

function shortRunId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…` : id;
}

function duration(run: Run): string {
  if (!run.startedAt) return '—';
  if (!run.finishedAt) return isActiveRun(run) ? '執行中' : '—';
  const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(elapsed) ? `${Math.max(0, elapsed / 1000).toFixed(1)} 秒` : '—';
}
