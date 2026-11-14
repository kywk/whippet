import type { AuthorEngine, RunStatus } from './types';

const AUTHOR_STATUS: Record<RunStatus, string> = {
  queued: '接單中',
  dispatched: '接單中',
  running: '作業中',
  collecting: '作業中',
  succeeded: '完成',
  failed: '失敗',
  cancelling: '取消中',
  cancelled: '已取消',
  timed_out: '失敗',
  interrupted: '失敗',
};

const BUILTIN_WAITING: Partial<Record<RunStatus, string>> = {
  queued: '等待執行',
  dispatched: '準備中',
};

export function AuthorEngineStatus({ engine, status }: { engine: AuthorEngine; status: RunStatus }) {
  const source = engine === 'external' ? '外部 Agent' : '內建引擎';
  const label = engine === 'external' ? AUTHOR_STATUS[status] : BUILTIN_WAITING[status] ?? AUTHOR_STATUS[status];
  return <span className="author-engine-status" role="status" aria-label={`AI 來源：${source}，${label}`}>
    <span className="chip neutral">AI 來源：{source}</span>
    <span className="chip neutral">{label}</span>
  </span>;
}
