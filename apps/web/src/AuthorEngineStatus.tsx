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

export function AuthorEngineStatus({ engine, status }: { engine: AuthorEngine; status: RunStatus }) {
  const source = engine === 'external' ? '外部 Agent' : '內建引擎';
  return <span className="author-engine-status" role="status" aria-label={`AI 來源：${source}，${AUTHOR_STATUS[status]}`}>
    <span className="chip neutral">AI 來源：{source}</span>
    <span className="chip neutral">{AUTHOR_STATUS[status]}</span>
  </span>;
}
