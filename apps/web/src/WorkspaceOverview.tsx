import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { useActivity } from './activity';
import { Loading, Notice, ReportLink, RunStatusBadge } from './components';
import { BookIcon, CheckIcon, ChevronRightIcon, GearIcon, HomeIcon, PlayIcon, PlusIcon, RefreshIcon, ReportIcon } from './icons';
import { WorkspaceAvailability } from './WorkspaceSettings';
import { WorkspaceAccountDescriptions } from './WorkspaceTestAccounts';
import type { Test, WorkspaceDetail, WorkspaceRunActivity } from './types';
import './workspace-overview.css';

interface Props {
  workspace: WorkspaceDetail;
  titleRef: RefObject<HTMLHeadingElement | null>;
  tests: Test[];
  testsLoading: boolean;
  testsError?: string;
  onRefreshTests: () => void;
  runHistory: ReturnType<typeof useActivity>['runHistory'];
  apiBase: string;
  creating: boolean;
  createError?: string;
  onCreate?: () => void;
  onSettings?: () => void;
  onOpenTest: (test: Test) => void;
}

const weekMs = 7 * 24 * 60 * 60 * 1000;
const runsPerPage = 10;
const runDate = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
const number = new Intl.NumberFormat('zh-TW');
const scopeLabels = { confirmed: '範圍已確認', unconfirmed: '範圍待確認', revoking: '正在撤回範圍' };

export function WorkspaceOverview({ workspace, titleRef, tests, testsLoading, testsError, onRefreshTests, runHistory, apiBase, creating, createError, onCreate, onSettings, onOpenTest }: Props) {
  const [runPage, setRunPage] = useState(1);

  const { runsByTest, failedRunLoads, refreshingRuns, refreshRuns } = runHistory;
  const testsReady = !testsLoading && !testsError;
  const historyFailed = tests.some(test => failedRunLoads.has(test.id));
  const runsPending = testsLoading || tests.some(test => !runsByTest[test.id] && !failedRunLoads.has(test.id));
  const runsReady = testsReady && !runsPending && !historyFailed;
  const setupNeeded = workspace.scopeStatus !== 'confirmed';

  let cases = 0;
  let publishedCases = 0;
  let modules = 0;
  let publishedModules = 0;
  let weeklyRuns = 0;
  let passed = 0;
  let unsuccessful = 0;
  const now = Date.now();
  const recent: { test: Test; run: WorkspaceRunActivity; timestamp: number }[] = [];
  for (const test of tests) {
    if (test.kind === 'module') {
      modules += 1;
      if (test.publishedVersionId) publishedModules += 1;
    } else {
      cases += 1;
      if (test.publishedVersionId) publishedCases += 1;
    }
    for (const run of runsByTest[test.id] ?? []) {
      if (run.kind && run.kind !== 'run') continue;
      const timestamp = Date.parse(run.createdAt) || 0;
      recent.push({ test, run, timestamp });
      if (timestamp < now - weekMs || timestamp > now) continue;
      weeklyRuns += 1;
      if (run.status === 'succeeded') passed += 1;
      if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'interrupted') unsuccessful += 1;
    }
  }
  recent.sort((a, b) => b.timestamp - a.timestamp);
  const pageCount = Math.max(1, Math.ceil(recent.length / runsPerPage));
  const currentPage = Math.min(runPage, pageCount);
  if (runPage !== currentPage) setRunPage(currentPage);
  const pageStart = (currentPage - 1) * runsPerPage;
  const completed = passed + unsuccessful;
  const passRate = runsReady && completed ? Math.round(passed / completed * 100) : undefined;

  return <section className="workspace-overview" aria-labelledby="workspace-overview-title">
    <div className="workspace-overview-frame">
      <header className="workspace-masthead">
        <div className="workspace-masthead-identity">
          <div className="workspace-masthead-context"><HomeIcon /><span>Workspace 概覽</span><span className={`chip ${setupNeeded ? 'warm' : 'ok'}`}>{scopeLabels[workspace.scopeStatus]}</span></div>
          <h1 id="workspace-overview-title" ref={titleRef} tabIndex={-1}>{workspace.name}</h1>
          <p>{workspace.settings?.purpose.trim() || '尚未設定驗測目的。'}</p>
        </div>
        {onCreate || onSettings ? <div className="workspace-masthead-actions">
          {onCreate ? <button type="button" className={`button ${setupNeeded && onSettings ? 'secondary' : 'primary'}`} disabled={creating} onClick={onCreate}><PlusIcon />{creating ? '正在建立…' : '建立測試案例'}</button> : null}
          {onSettings ? <button type="button" className={`button ${setupNeeded ? 'primary' : 'secondary'}`} onClick={onSettings}><GearIcon />管理 Workspace</button> : null}
        </div> : null}
      </header>

      {createError ? <Notice message={createError} /> : null}
      {testsError ? <Notice message={`無法載入測試列表。${testsError}`} retry={onRefreshTests} /> : null}
      <dl className="workspace-metrics" aria-label="Workspace 統計" aria-busy={runsPending}>
        <Metric label="測試案例" icon={<ReportIcon />} value={testsReady ? number.format(cases) : '—'} detail={testsReady ? `已發佈 ${number.format(publishedCases)} 個` : '測試與 Use Case'} />
        <Metric label="已發佈模組" icon={<BookIcon />} value={testsReady ? number.format(publishedModules) : '—'} detail={testsReady ? `共 ${number.format(modules)} 個模組` : 'Workspace 模組庫'} />
        <Metric label="正式執行" icon={<PlayIcon />} value={runsReady ? number.format(weeklyRuns) : '—'} detail="近 7 天建立的執行" />
        <Metric label="正式執行通過率" icon={<CheckIcon />} value={passRate === undefined ? '—' : `${passRate}%`} detail={runsReady ? completed ? `近 7 天 · 通過 ${number.format(passed)}／${number.format(completed)} 次` : '近 7 天尚無可計算結果' : '近 7 天 · 排除取消與進行中'} />
      </dl>

      <div className="workspace-overview-panels">
        <section className="workspace-home-panel" aria-labelledby="workspace-recent-title">
          <header className="workspace-home-panel-head">
            <div><h2 id="workspace-recent-title">近期正式執行</h2><p>每頁 {runsPerPage} 筆，最新在前</p></div>
            <button type="button" className="button secondary compact" disabled={testsLoading || Boolean(testsError) || refreshingRuns || !tests.length} onClick={refreshRuns}><RefreshIcon />{refreshingRuns ? '更新中…' : '更新執行紀錄'}</button>
          </header>
          {historyFailed ? <p className="workspace-history-note" role="status">部分執行紀錄更新失敗，請重新整理以補齊統計。</p> : null}
          {!recent.length && runsPending ? <div className="workspace-home-empty"><Loading text="正在載入執行紀錄…" /></div> : null}
          {!recent.length && runsReady ? <div className="workspace-home-empty"><PlayIcon /><p>尚無正式執行紀錄</p><span>執行已發佈的測試後，結果會出現在這裡。</span></div> : null}
          {pageCount > 1 ? <nav className="workspace-run-pages" aria-label="近期正式執行分頁">
            <p role="status">第 {number.format(currentPage)}／{number.format(pageCount)} 頁 · 共 {number.format(recent.length)} 筆</p>
            <div>
              <button type="button" className="button secondary compact" disabled={currentPage === 1} onClick={() => setRunPage(currentPage - 1)}>上一頁</button>
              <button type="button" className="button secondary compact" disabled={currentPage === pageCount} onClick={() => setRunPage(currentPage + 1)}>下一頁</button>
            </div>
          </nav> : null}
          {recent.length ? <ol className="workspace-recent-list" start={pageStart + 1}>
            {recent.slice(pageStart, pageStart + runsPerPage).map(({ test, run, timestamp }) => <li key={run.id}>
              <button type="button" className="workspace-run-test" disabled={creating} onClick={() => onOpenTest(test)}><span>{test.name}</span><ChevronRightIcon /></button>
              {timestamp ? <time className="workspace-run-time" dateTime={run.createdAt}>{runDate.format(timestamp)}</time> : <span className="workspace-run-time">時間未知</span>}
              <RunStatusBadge run={run} />
              <div className="workspace-run-report">{run.reportUrl ? <ReportLink reportUrl={run.reportUrl} apiBase={apiBase} label="報告" /> : null}</div>
            </li>)}
          </ol> : null}
        </section>

        <div className="workspace-overview-context">
          <WorkspaceScope workspace={workspace} />
          <WorkspaceAccountDescriptions workspace={workspace} />
          <WorkspaceAvailability workspace={workspace} heading="h2" />
        </div>
      </div>
    </div>
  </section>;
}

function Metric({ label, icon, value, detail }: { label: string; icon: ReactNode; value: string; detail: string }) {
  return <div className="workspace-metric">
    <dt>{icon}{label}</dt>
    <dd className="workspace-metric-value">{value}</dd>
    <dd className="workspace-metric-detail">{detail}</dd>
  </div>;
}

function WorkspaceScope({ workspace }: { workspace: WorkspaceDetail }) {
  const config = workspace.settings;
  const targets = config?.targets ?? [];
  const hasExclusions = Boolean(config && (config.exclusions.trim() || config.excludedOrigins.length));

  return <section className="workspace-home-panel workspace-scope-panel" aria-labelledby="workspace-scope-title">
    <header className="workspace-home-panel-head"><h2 id="workspace-scope-title">驗測範圍</h2></header>
    <div className="workspace-scope-body">
      {config?.backgroundSummary.trim() ? <div className="workspace-scope-group"><h3>測試背景</h3><p className="workspace-scope-copy">{config.backgroundSummary}</p></div> : null}
      <div className="workspace-scope-group">
        <h3>{!config && workspace.sites.length ? '既有網站（待確認）' : '目標網站'}</h3>
        {targets.length ? <ul className="workspace-targets">
          {targets.map(target => <li key={target.origin}><strong>{target.name}</strong><span>{target.origin}</span>{target.purpose ? <p>{target.purpose}</p> : null}</li>)}
        </ul> : !config && workspace.sites.length ? <ul className="workspace-targets">
          {workspace.sites.map((site, index) => <li key={index}><strong>{site.name}</strong><span>{site.url}</span></li>)}
        </ul> : <p className="muted">尚未設定目標網站。</p>}
      </div>
      {hasExclusions && config ? <div className="workspace-scope-group">
        <h3>排除範圍</h3>
        {config.exclusions.trim() ? <p className="workspace-scope-copy">{config.exclusions}</p> : null}
        {config.excludedOrigins.length ? <ul className="workspace-excluded-origins">{config.excludedOrigins.map(origin => <li key={origin}>{origin}</li>)}</ul> : null}
      </div> : null}
      <dl className="workspace-scope-meta">
        <div className="workspace-scope-url"><dt>預設測試網址</dt><dd>{workspace.defaultTestUrl || '尚未設定'}</dd></div>
        <div><dt>單次執行逾時</dt><dd>{number.format(workspace.timeoutMs / 1000)} 秒</dd></div>
        {config ? <>
          <div><dt>必要相依服務</dt><dd>{number.format(config.dependencies.length)} 個</dd></div>
          {config.testAccounts.length ? <div><dt>測試帳號</dt><dd>{number.format(config.testAccounts.length)} 組</dd></div>
            : <div><dt>登入角色</dt><dd>{number.format(config.loginRoles.length)} 個</dd></div>}
        </> : null}
      </dl>
    </div>
  </section>;
}
