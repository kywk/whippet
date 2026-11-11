import { resolveReportUrl } from './api';
import { STATUS_LABELS } from './types';
import type { Run, RunStatus } from './types';

export function Notice({ message, retry, retryLabel = '重試' }: { message: string; retry?: () => void; retryLabel?: string }) {
  return <div className="notice" role="alert"><p>{message}</p>{retry ? <button className="button secondary compact" onClick={retry}>{retryLabel}</button> : null}</div>;
}

export function Loading({ text }: { text: string }) {
  return <div className="loading-state" role="status"><p>{text}</p><div className="loading-line" /><div className="loading-line short" /></div>;
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const tone = status === 'succeeded' ? 'success'
    : ['failed', 'timed_out', 'interrupted'].includes(status) ? 'danger'
      : ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(status) ? 'active' : 'neutral';
  return <span className={`status-badge ${tone}`}><span className="status-dot" aria-hidden="true" />{STATUS_LABELS[status]}</span>;
}

export function RunStatusBadge({ run }: { run: Run }) {
  return run.kind === 'author' && run.status === 'succeeded'
    ? <span className="status-badge success"><span className="status-dot" aria-hidden="true" />撰寫完成</span>
    : <StatusBadge status={run.status} />;
}

export function runKindLabel(run: Run): string {
  return run.kind === 'author' ? 'AI 撰寫' : run.kind === 'validation' ? `草稿驗證 · r${run.draftRevision ?? '—'}` : '正式執行';
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
