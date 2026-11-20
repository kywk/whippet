import { Component, Suspense, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { BackgroundCompletion } from './activity';
import { resolveReportUrl } from './api';
import { BellIcon } from './icons';
import { STATUS_LABELS } from './types';
import type { Run, RunStatus } from './types';

export function Notice({ message, retry, retryLabel = '重試' }: { message: string; retry?: () => void; retryLabel?: string }) {
  return <div className="notice" role="alert"><p>{message}</p>{retry ? <button className="button secondary compact" onClick={retry}>{retryLabel}</button> : null}</div>;
}

export function Loading({ text }: { text: string }) {
  return <div className="loading-state" role="status"><p>{text}</p><div className="loading-line" /><div className="loading-line short" /></div>;
}

interface SurfaceBoundaryProps {
  children: ReactNode;
  loadingText: string;
  confirmReload?: () => boolean;
}

export class SurfaceBoundary extends Component<SurfaceBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    const { children, confirmReload, loadingText } = this.props;
    if (this.state.failed) return <Notice message="無法開啟此頁面。請重新整理後再試。" retryLabel="重新整理頁面"
      retry={() => { if (!confirmReload || confirmReload()) window.location.reload(); }} />;
    return <Suspense fallback={<Loading text={loadingText} />}>{children}</Suspense>;
  }
}

export function BackgroundNotices({ completions, onExpire }: { completions: BackgroundCompletion[]; onExpire: (id: string) => void }) {
  return <div className="background-notices" aria-live="polite" aria-relevant="additions">
    {completions.slice(0, 3).map(completion => <BackgroundNotice key={completion.id} completion={completion} onExpire={onExpire} />)}
  </div>;
}

function BackgroundNotice({ completion, onExpire }: { completion: BackgroundCompletion; onExpire: (id: string) => void }) {
  useEffect(() => {
    let timer: number | undefined;
    function startTimer() {
      if (document.hidden || timer !== undefined) return;
      timer = window.setTimeout(() => onExpire(completion.id), 5_000);
    }
    startTimer();
    document.addEventListener('visibilitychange', startTimer);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', startTimer);
    };
  }, [completion.id, onExpire]);

  return <div className="background-notice"><BellIcon /><div><strong>{completion.message}</strong><p>{completion.testName}</p></div></div>;
}

export function SuggestedTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return <div className="summary-tags">
    <h5>AI 建議標籤</h5>
    <ul className="tag-list" aria-label="AI 建議標籤">{tags.map((tag) => <li key={tag} className="tag-pill">#{tag}</li>)}</ul>
  </div>;
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const tone = status === 'succeeded' ? 'success'
    : ['failed', 'timed_out', 'interrupted'].includes(status) ? 'danger'
      : ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(status) ? 'active' : 'neutral';
  return <span className={`status-badge ${tone}`}><span className="status-dot" aria-hidden="true" />{STATUS_LABELS[status]}</span>;
}

export function RunStatusBadge({ run }: { run: Run }) {
  if (run.kind === 'author' && run.authorPartial) return <span className="status-badge active">部分完成 · {run.authorPartial.reason === 'checkpoint_saved' ? '已保存候選' : '預算耗盡'}</span>;
  return run.kind === 'author' && run.status === 'succeeded'
    ? <span className="status-badge success"><span className="status-dot" aria-hidden="true" />{run.authorMode === 'workspace' ? '訪談完成' : run.authorMode === 'summary' ? '摘要完成' : '撰寫完成'}</span>
    : <StatusBadge status={run.status} />;
}

export function runKindLabel(run: Run): string {
  return run.kind === 'author' ? run.authorMode === 'workspace' ? 'Workspace 訪談' : run.authorMode === 'summary' ? '驗收摘要' : 'AI 撰寫' : run.kind === 'validation' ? `草稿驗證 · r${run.draftRevision ?? '—'}` : '正式執行';
}

export function RunProblem({ run }: { run: Pick<Run, 'id' | 'status' | 'kind' | 'authorMode' | 'reportUrl'> }) {
  const outcome = run.status === 'failed' ? '未完成'
    : run.status === 'timed_out' ? '逾時'
      : run.status === 'interrupted' ? '中斷'
        : run.status === 'cancelled' ? '已取消' : undefined;
  if (!outcome) return null;

  let task = run.kind === 'validation' ? '草稿驗證' : '測試執行';
  let next = run.reportUrl
    ? '請查看報告，確認哪個步驟出了問題。'
    : '請確認測試網站可開啟，再試一次。';
  if (run.kind === 'author') {
    if (run.authorMode === 'summary') {
      task = '驗收摘要';
      next = '可使用「重試驗收摘要」。已通過的驗證與報告會保留。';
    } else if (run.authorMode === 'workspace') {
      task = '設定對話';
      next = '已儲存的對話仍在。可以重送訊息，或補充網站網址和要測的範圍後再送出。';
    } else {
      task = 'AI 回覆';
      next = '已儲存的對話與草稿仍在。可以重送訊息，或補充操作步驟與預期結果後再送出。';
    }
  }
  return <div className="notice run-problem">
    <strong>{task}{outcome}</strong>
    <p>{next}</p>
    {run.status !== 'cancelled' ? <p>若問題持續，請把任務編號 <code className="identifier">{run.id}</code> 提供給工程師。</p> : null}
  </div>;
}

export function ReportLink({ reportUrl, label = '開啟報告', apiBase }: { reportUrl?: string; label?: string; apiBase: string }) {
  const href = resolveReportUrl(reportUrl, apiBase, window.location.href);
  return href ? <a className="report-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label}（新分頁）`}>{label}
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M11 4h5v5m0-5-8 8M8 4H4v12h12v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </a> : <span className="muted">{reportUrl ? '報告連結無效' : '尚無報告'}</span>;
}

const dateFormatter = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間未知' : dateFormatter.format(date);
}
