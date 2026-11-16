import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isActiveRun } from './types';
import type { Run } from './types';
import { CheckIcon, CloseIcon } from './icons';
import { TypingDots } from './chat';

export type StageState = 'done' | 'active' | 'todo' | 'failed';
export interface Stage { key: 'author' | 'validate' | 'summary' | 'publish'; label: string; state: StageState; detail: string; at?: string; runId?: string }
export interface TrailSummary { stages: Stage[]; headline: string; step: number; running: boolean; failed: boolean; awaitingPublish: boolean }

export interface AuthorProgressStep {
  key: string;
  label: string;
  state: 'running' | 'done' | 'failed';
}

const TOOL_LABELS: Record<string, { running: string; done: string; failed: string }> = {
  read_draft: {
    running: '正在讀取目前草稿內容…',
    done: '已讀取目前草稿內容',
    failed: '讀取草稿失敗',
  },
  read_validation_report: {
    running: '正在檢視最新驗證報告與錯誤診斷…',
    done: '已檢視最新驗證報告與錯誤診斷',
    failed: '讀取驗證報告失敗',
  },
  read_conversation_history: {
    running: '正在回顧歷史對話背景…',
    done: '已回顧歷史對話背景',
    failed: '回顧歷史對話未完成',
  },
  browser_navigate: {
    running: '正在開啟瀏覽器並導覽至目標頁面…',
    done: '已開啟瀏覽器並導覽至目標頁面',
    failed: '目標頁面導覽失敗（正在檢測環境或範圍限制）',
  },
  browser_snapshot: {
    running: '正在擷取頁面 DOM 結構與可用選擇器…',
    done: '已擷取頁面結構與可用選擇器',
    failed: '擷取頁面結構失敗',
  },
  browser_click: {
    running: '正在瀏覽器點擊頁面元素並觀察變化…',
    done: '已在瀏覽器點擊元素並觀察反應',
    failed: '瀏覽器點擊操作未通過',
  },
  browser_fill: {
    running: '正在瀏覽器填入表單欄位…',
    done: '已在瀏覽器填入表單欄位',
    failed: '瀏覽器填表操作未通過',
  },
  browser_login: {
    running: '正在使用 Workspace 角色執行登入流程…',
    done: '已完成 Workspace 角色登入操作',
    failed: '角色登入操作未通過',
  },
  update_draft: {
    running: '正在啟動 Playwright 自我試跑並驗證候選草稿…',
    done: '已完成候選草稿自我試跑檢查',
    failed: '候選草稿試跑檢查未通過',
  },
  request_validation: {
    running: '正在排入正式無金鑰驗證佇列…',
    done: '已排入正式驗證佇列',
    failed: '排入驗證佇列失敗',
  },
  unknown: {
    running: '正在執行輔助操作…',
    done: '已完成輔助操作',
    failed: '操作未受支援，已略過',
  },
};

export function parseAuthorProgress(events?: string[], mode: 'edit' | 'workspace' = 'edit'): { headline: string; steps: AuthorProgressStep[] } {
  const defaultHeadline = mode === 'workspace' ? 'AI 正在分析需求並整理設定訪談…' : 'AI 正在分析需求與準備環境…';
  if (!events || events.length === 0) {
    return { headline: defaultHeadline, steps: [] };
  }
  const map = new Map<string, AuthorProgressStep>();
  for (const raw of events) {
    const match = /^author:(model|tool):(\d+):(?:([a-z_]+):)?(started|succeeded|failed|heartbeat)$/.exec(raw);
    if (!match) continue;
    const [, kind, indexStr, toolName, status] = match;
    const index = Number(indexStr);
    const key = kind === 'model' ? `model:${index}` : `tool:${index}:${toolName ?? 'unknown'}`;
    const state: 'running' | 'done' | 'failed' = status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : 'running';
    let label: string;
    if (kind === 'model') {
      if (state === 'running') {
        label = index === 1
          ? (mode === 'workspace' ? 'AI 正在分析網站需求與規劃步驟（第 1 輪）…' : 'AI 正在分析測試需求與規劃步驟（第 1 輪）…')
          : `AI 正在分析觀察結果並擬定下一步（第 ${index} 輪）…`;
      } else if (state === 'done') {
        label = index === 1 ? '已完成初步需求分析與步驟規劃（第 1 輪）' : `已完成第 ${index} 輪分析與決策`;
      } else {
        label = `第 ${index} 輪模型推理中斷`;
      }
    } else {
      const labels = TOOL_LABELS[toolName ?? 'unknown'] ?? TOOL_LABELS.unknown;
      label = labels[state];
    }
    map.set(key, { key, label, state });
  }
  const steps = Array.from(map.values());
  const runningStep = [...steps].reverse().find((s) => s.state === 'running');
  const lastStep = steps[steps.length - 1];
  const headline = runningStep
    ? runningStep.label
    : lastStep
      ? (mode === 'workspace' ? 'AI 正在整理設定提案與回覆內容…' : 'AI 正在彙整試跑結果並撰寫回覆…')
      : defaultHeadline;
  return { headline, steps };
}

export function AuthorLiveStatus({ run, mode = 'edit' }: { run?: Run; mode?: 'edit' | 'workspace' }) {
  const external = run?.authorEngine === 'external';
  const { headline, steps } = external ? { headline: '', steps: [] } : parseAuthorProgress(run?.progressEvents, mode);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startIso = run?.startedAt ?? run?.createdAt;
  useEffect(() => {
    if (!startIso) {
      setElapsedSec(0);
      return;
    }
    const startMs = Date.parse(startIso);
    if (Number.isNaN(startMs)) return;
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startIso]);

  const statusText = !run ? '正在同步任務狀態…'
    : external ? run.status === 'queued' || run.status === 'dispatched' ? '等待外部 Agent 接單…'
      : run.status === 'running' || run.status === 'collecting' ? '外部 Agent 正在處理需求…'
        : '正在同步任務狀態…'
      : run.status === 'queued' ? '已在佇列中等待 Worker 啟動…'
        : run.status === 'dispatched' && steps.length === 0 ? '正在啟動隔離 Worker 容器與執行環境…'
          : headline;

  return <div className="author-live-status" role="status" aria-live="polite">
    <div className="author-live-head">
      <span className="pending-line"><TypingDots /><strong>{statusText}</strong></span>
      <span className="author-live-meta">
        <span className="live-conn-dot" aria-hidden="true" />{external ? '任務經過' : '連線保持中'}{elapsedSec > 0 ? ` · ${elapsedSec}s` : ''}
      </span>
    </div>
    {steps.length > 0 ? <ol className="author-live-steps" aria-label="AI 執行與分析步驟">
      {steps.slice(-6).map((step) => <li key={step.key} className={`author-step ${step.state}`}>
        <span className="author-step-icon" aria-hidden="true">
          {step.state === 'done' ? <CheckIcon /> : step.state === 'failed' ? <CloseIcon /> : <span className="step-pulse" />}
        </span>
        <span className="author-step-text">{step.label}</span>
      </li>)}
    </ol> : null}
  </div>;
}

const BAD = ['failed', 'cancelled', 'timed_out', 'interrupted'];
const byNewest = (a: Run, b: Run) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
const stamp = (run?: Run) => run ? run.finishedAt ?? run.startedAt ?? run.createdAt : undefined;

function stateOf(run: Run | undefined): StageState {
  if (!run) return 'todo';
  if (isActiveRun(run)) return 'active';
  return run.status === 'succeeded' ? 'done' : 'failed';
}

/**
 * 由 Run 紀錄推導一次編輯週期目前停在哪一站。只是畫面摘要：
 * 發佈資格仍以 Server 的驗證、報告與摘要判定為準。
 */
export function trailFromRuns(runs: Run[], session: { id?: string; draftRevision?: number; latestTurnChangedDraft?: boolean }): TrailSummary {
  const own = runs.filter((run) => !session.id || run.editingSessionId === session.id).sort(byNewest);
  const author = own.find((run) => run.kind === 'author' && run.authorMode !== 'summary');
  const validation = own.find((run) => run.kind === 'validation' && (session.draftRevision == null || run.draftRevision === session.draftRevision));
  const summary = own.find((run) => run.kind === 'author' && run.authorMode === 'summary' && (!validation || Date.parse(run.createdAt) >= Date.parse(validation.createdAt)));
  if (author?.authorPartial && (!validation || Date.parse(validation.createdAt) <= Date.parse(author.createdAt))) {
    const stages: Stage[] = [
      { key: 'author', label: '改稿', state: 'todo', detail: '預算耗盡，保留部分結果；請檢視下一步', runId: author.id, at: stamp(author) },
      { key: 'validate', label: '驗證', state: 'todo', detail: '自我試跑不等於正式驗證' },
      { key: 'summary', label: '摘要', state: 'todo', detail: '等待正式驗證' },
      { key: 'publish', label: '發佈', state: 'todo', detail: 'partial 不可直接發佈' },
    ];
    return { stages, headline: '部分完成，等待繼續', step: 1, running: false, failed: false, awaitingPublish: false };
  }
  const aState = stateOf(author);
  const vState = validation ? stateOf(validation) : 'todo';
  const sState = validation?.status === 'succeeded' ? stateOf(summary) : 'todo';
  const publishReady = sState === 'done';
  const conversationalReply = session.latestTurnChangedDraft === false && aState === 'done';
  const activeAuthorProgress = aState === 'active' && author?.authorEngine !== 'external' ? parseAuthorProgress(author?.progressEvents, 'edit').headline : undefined;
  const externalAuthorDetail = author?.status === 'queued' || author?.status === 'dispatched' ? '等待外部 Agent 接單'
    : author?.status === 'running' || author?.status === 'collecting' ? '外部 Agent 正在處理需求'
      : author?.status === 'cancelling' ? '取消中' : undefined;
  const stages: Stage[] = [
    { key: 'author', label: '改稿', state: author ? aState : 'done', detail: !author ? '腳本已儲存' : aState === 'active' ? (externalAuthorDetail ?? activeAuthorProgress ?? 'AI 分析與試跑中') : aState === 'done' ? (conversationalReply ? 'AI 已回覆，草稿維持原樣' : author.authorEngine === 'external' ? '外部 Agent 已完成，請檢視草稿與正式驗證' : '試跑完成，已套用草稿') : '處理未成功', at: stamp(author), runId: author?.id },
    { key: 'validate', label: '驗證', state: vState, detail: !validation ? '尚未驗證目前 revision' : vState === 'active' ? '正在真實執行腳本' : vState === 'done' ? '驗證通過，報告已保存' : '驗證未通過', at: stamp(validation), runId: validation?.id },
    { key: 'summary', label: '摘要', state: sState, detail: sState === 'todo' ? '驗證通過後自動產生' : sState === 'active' ? summary?.authorEngine === 'external' ? summary.status === 'queued' || summary.status === 'dispatched' ? '等待外部 Agent 接單' : '外部 Agent 正在撰寫摘要' : 'AI 撰寫驗收摘要' : sState === 'done' ? '版本說明已就緒' : '摘要未成功，可重試', at: stamp(summary), runId: summary?.id },
    { key: 'publish', label: '發佈', state: publishReady ? 'active' : 'todo', detail: publishReady ? '請檢視 Server 發佈資格後確認' : 'AI 不會自動發佈', at: undefined },
  ];
  // 若改稿正在進行，後面各站都屬於舊 revision，一律退回待辦。
  if (aState === 'active') for (const stage of stages.slice(1)) { stage.state = 'todo'; stage.at = undefined; stage.runId = undefined; stage.detail = stage.key === 'publish' ? 'AI 不會自動發佈' : stage.key === 'summary' ? '驗證通過後自動產生' : '改稿完成後驗證'; }
  const failedStage = stages.find((stage) => stage.state === 'failed');
  const activeIndex = stages.findIndex((stage) => stage.state === 'active');
  const nextIndex = stages.findIndex((stage) => stage.state === 'todo');
  const step = failedStage ? stages.indexOf(failedStage) + 1 : activeIndex >= 0 ? activeIndex + 1 : nextIndex >= 0 ? nextIndex + 1 : 4;
  const running = stages.some((stage) => stage.state === 'active' && stage.key !== 'publish');
  const headline = failedStage ? `${failedStage.label}未成功` : running ? `${stages[activeIndex].label}進行中` : publishReady ? '摘要完成，請檢視發佈資格' : validation?.status === 'succeeded' ? '驗證通過，產生摘要中' : conversationalReply ? 'AI 已回覆' : author ? '改稿完成，待驗證' : '草稿進行中';
  return { stages, headline, step, running, failed: Boolean(failedStage), awaitingPublish: publishReady && !failedStage };
}

export const publishedTrail: Stage[] = (['author', 'validate', 'summary', 'publish'] as const).map((key, index) => ({ key, label: ['改稿', '驗證', '摘要', '發佈'][index], state: 'done' as const, detail: '' }));

export function isBadStatus(status: string): boolean { return BAD.includes(status); }

/** 左欄用的四段迷你軌跡。 */
export function MiniTrail({ stages, bad }: { stages: Stage[]; bad?: boolean }) {
  return <span className={`mini-trail${bad ? ' bad' : ''}`} aria-hidden="true">{stages.map((stage) => <span key={stage.key} className={`seg ${stage.state}`} />)}</span>;
}

const timeFormatter = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function formatClock(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : timeFormatter.format(date);
}

/** 對話中的「貨態軌跡」卡：一輪工作停在哪一站、各站時間與下一步。 */
export function TrailCard({ trail, title = '這一輪的進度', footer, compact = false }: { trail: TrailSummary; title?: string; footer?: ReactNode; compact?: boolean }) {
  const body = <ol className="trail-stations">
    {trail.stages.map((stage, index) => <li key={stage.key} className={`station ${stage.state}`} aria-current={stage.state === 'active' ? 'step' : undefined}>
      <span className="node" aria-hidden="true">{stage.state === 'done' ? <CheckIcon /> : stage.state === 'failed' ? <CloseIcon /> : index + 1}</span>
      <span className="station-main"><strong>{stage.label}{stage.state === 'active' && stage.key !== 'publish' ? '中' : stage.state === 'failed' ? '未成功' : ''}</strong><small>{stage.detail}</small></span>
      <time className="station-time">{formatClock(stage.at) || '—'}</time>
    </li>)}
  </ol>;
  return <section className={`artifact trail-card ${trail.running ? 'is-running' : ''} ${trail.failed ? 'is-failed' : ''}`} aria-label={title}>
    <header className="artifact-head">
      <strong>{title}</strong>
      <span className={`trail-pill ${trail.failed ? 'failed' : trail.running ? 'running' : trail.awaitingPublish ? 'waiting' : 'idle'}`}>{trail.headline} · 第 {trail.step}／4 站</span>
    </header>
    {compact ? <details className="trail-collapse"><summary>展開各站</summary>{body}</details> : body}
    {footer ? <footer className="artifact-foot">{footer}</footer> : null}
  </section>;
}
