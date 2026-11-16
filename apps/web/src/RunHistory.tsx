import type { ReactNode } from 'react';
import { formatDate, Loading, Notice, ReportLink, RunStatusBadge, runKindLabel } from './components';
import { RunArtifacts } from './RunArtifacts';
import { CancelRunButton } from './TestActions';
import { scriptOriginLabel } from './capabilities';
import { AuthorEngineStatus } from './AuthorEngineStatus';
import { isActiveRun } from './types';
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
  onRun: (run: Run) => void;
  onWatch: (run: Run) => void;
  liveView?: ReactNode;
}

export function RunHistory({ api, apiBase, runs, group, loading, error, polling, onRefresh, onRun, onWatch, liveView }: Props) {
  const formal = group === 'formal';
  const latest = runs[0];
  const latestTitle = formal ? '最近一次正式執行' : '最近編輯結果';
  const historyTitle = formal ? '正式執行歷史' : 'AI 與草稿驗證紀錄';
  return <>
    <section className="latest-section" aria-labelledby={`${group}-latest-title`}>
      <div className="section-heading"><h3 id={`${group}-latest-title`}>{latestTitle}</h3><span className="refresh-status" role="status">{loading ? '正在讀取狀態…' : error ? '同步暫時中斷' : polling && runs.some(isActiveRun) ? '每 2 秒更新狀態' : '狀態已同步'}</span></div>
      {loading && !latest ? <Loading text={`正在載入${latestTitle}…`} /> : null}
      {latest ? <article className="latest-run" aria-label={latestTitle}>
        <div className="latest-summary"><RunStatusBadge run={latest} /><span>{runKindLabel(latest)}</span>{latest.kind === 'author' ? <AuthorEngineStatus engine={latest.authorEngine ?? 'builtin'} status={latest.status} /> : null}<time dateTime={latest.createdAt}>{formatDate(latest.createdAt)}</time>{latest.kind === 'author' ? <span className="muted">{latest.authorMode === 'summary' ? '結果見驗收摘要' : '撰寫結果見對話'}</span> : <ReportLink reportUrl={latest.reportUrl} apiBase={apiBase} />}</div>
        <p className="run-id">Run <span className="identifier">{latest.id}</span></p>
        <p className="inline-hint">任務快照來源：{scriptOriginLabel(latest.scriptOrigin)}</p>
        {latest.error ? <details className="error-details"><summary>查看錯誤</summary><pre className="run-error">{latest.error}</pre></details> : null}
        {isActiveRun(latest) ? <div className="action-row">{latest.authorMode !== 'summary' && latest.authorEngine !== 'external' ? <button className="button secondary compact" onClick={() => onWatch(latest)}>開始監看</button> : null}<CancelRunButton api={api} run={latest} onUpdated={onRun} /></div> : null}
        {latest.kind !== 'author' ? <RunArtifacts key={latest.id} api={api} apiBase={apiBase} runId={latest.id} /> : null}
      </article> : !loading && !error ? <p className="mode-empty">{formal ? '尚無正式執行紀錄。發佈後可執行目前正式版本。' : '尚無 AI 撰寫或草稿驗證紀錄，先在對話中說明需求。'}</p> : null}
    </section>
    {liveView}
    <section className="history-section" aria-labelledby={`${group}-history-title`}>
      <div className="section-heading"><h3 id={`${group}-history-title`}>{historyTitle} <span className="count">{runs.length}</span></h3><button className="button secondary compact" disabled={loading} onClick={onRefresh}>{loading ? '更新中…' : '重新整理紀錄'}</button></div>
      {error ? <Notice message={error} retry={onRefresh} /> : null}
      {runs.length ? <div className="table-scroll"><table><caption className="sr-only">{historyTitle}，最新紀錄在前</caption>
        <thead><tr><th scope="col">狀態／Run</th>{formal ? null : <th scope="col">種類</th>}<th scope="col">建立時間</th><th scope="col">耗時</th><th scope="col">報告／操作</th></tr></thead>
        <tbody>{runs.map((run) => <tr key={run.id} data-run-id={run.id}>
          <td><RunStatusBadge run={run} /><span className="table-run-id identifier mono" title={run.id}>{shortRunId(run.id)}</span><span className="run-origin">{scriptOriginLabel(run.scriptOrigin)}</span>{run.kind === 'author' ? <AuthorEngineStatus engine={run.authorEngine ?? 'builtin'} status={run.status} /> : null}{run.error ? <details className="error-details"><summary>查看錯誤</summary><pre className="run-error">{run.error}</pre></details> : null}</td>
          {formal ? null : <td className="col-nowrap">{runKindLabel(run)}</td>}<td><time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time></td><td className="col-nowrap">{duration(run)}</td>
          <td><div className="run-actions">{run.kind === 'author' ? <span className="muted col-nowrap">{run.authorMode === 'summary' ? '結果見驗收摘要' : '撰寫結果見對話'}</span> : <><ReportLink reportUrl={run.reportUrl} apiBase={apiBase} /><RunArtifacts api={api} apiBase={apiBase} runId={run.id} /></>}{isActiveRun(run) ? <>{run.authorMode !== 'summary' && run.authorEngine !== 'external' ? <button className="button secondary compact" aria-label={`開始監看 Run ${run.id}`} onClick={() => onWatch(run)}>開始監看</button> : null}<CancelRunButton api={api} run={run} onUpdated={onRun} /></> : null}</div></td>
        </tr>)}</tbody>
      </table></div> : !loading && !error ? <p className="muted">{formal ? '沒有正式執行紀錄。AI 撰寫與草稿驗證會顯示在編輯模式。' : '後續的撰寫與驗證結果會保留在這裡。'}</p> : null}
    </section>
  </>;
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
