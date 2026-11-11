import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, resolveReportUrl } from './api';
import { useResource, useRuns } from './hooks';
import { isActiveRun, STATUS_LABELS } from './types';
import type { DevUser, Run, WhippetApi, Workspace } from './types';

interface AppProps {
  api: WhippetApi;
  apiBase: string;
  mock: boolean;
}

export function App({ api, apiBase, mock }: AppProps) {
  const [user, setUser] = useState<DevUser>();
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string>();
  const loginLock = useRef(false);

  async function login() {
    if (loginLock.current) return;
    loginLock.current = true;
    setLoggingIn(true);
    setLoginError(undefined);
    try { setUser(await api.login()); }
    catch (error) { setLoginError(errorMessage(error)); }
    finally { setLoggingIn(false); loginLock.current = false; }
  }

  return (
    <>
      <a className="skip-link" href="#main">跳至主要內容</a>
      <header className="app-header">
        <a className="brand" href="/" aria-label="Whippet 首頁"><BrandMark />Whippet</a>
        <span className="header-caption">測試工作台</span>
        {user ? <div className="session"><span>{user.id} · {user.role}</span>
          <button className="button quiet" onClick={() => setUser(undefined)}>返回登入</button>
        </div> : <span className="header-note">Self-hosted Playwright</span>}
      </header>
      {mock ? <div className="mock-notice" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</div> : null}
      {!user ? (
        <main id="main" className="login-layout">
          <section className="login-panel" aria-labelledby="login-title">
            <BrandMark />
            <h1 id="login-title">讓測試開始跑。</h1>
            <p>選擇已發佈的測試，執行並追蹤結果。每次執行的報告，都在同一個工作台。</p>
            <button className="button primary login-button" disabled={loggingIn} onClick={login}>
              {loggingIn ? '登入中…' : '以開發管理員登入'}<ArrowIcon />
            </button>
            {loginError ? <Notice message={loginError} /> : null}
            <p className="fine-print">M1 開發入口 · 不需帳號密碼<br />由 Server 提供固定 Superadmin 身分。</p>
          </section>
        </main>
      ) : <WorkspaceView api={api} apiBase={apiBase} />}
    </>
  );
}

function WorkspaceView({ api, apiBase }: Pick<AppProps, 'api' | 'apiBase'>) {
  const workspaces = useResource(api.listWorkspaces);
  const [selectedId, setSelectedId] = useState('');
  const workspace = workspaces.data?.find((item) => item.id === selectedId) ?? workspaces.data?.[0];
  return (
    <main id="main" className="workspace-layout">
      <div className="workspace-heading">
        <div><h1>測試</h1><p>選擇測試，查看詳情與執行結果。</p></div>
        {workspace ? <label className="workspace-select">Workspace
          <select value={workspace.id} onChange={(event) => setSelectedId(event.target.value)}>
            {workspaces.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label> : null}
      </div>
      {workspaces.loading ? <Loading text="正在載入 Workspace…" /> : null}
      {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
      {workspaces.data?.length === 0 ? <Empty title="尚無 Workspace" text="請確認 Server 已完成 M1 種子資料初始化，再重新載入。" retry={workspaces.retry} /> : null}
      {workspace ? <TestBrowser key={workspace.id} workspace={workspace} api={api} apiBase={apiBase} /> : null}
    </main>
  );
}

function TestBrowser({ workspace, api, apiBase }: { workspace: Workspace } & Pick<AppProps, 'api' | 'apiBase'>) {
  const loadTests = useCallback((signal: AbortSignal) => api.listTests(workspace.id, signal), [api, workspace.id]);
  const tests = useResource(loadTests);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const selected = tests.data?.find((item) => item.id === selectedId) ?? tests.data?.[0];
  const filtered = tests.data?.filter((test) => `${test.name} ${test.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  return (
    <div className="test-browser">
      <aside className="test-sidebar" aria-label="Workspace 測試列表">
        <div className="section-heading"><h2>測試列表 <span className="count">{tests.data?.length ?? '—'}</span></h2>
          <button className="button quiet compact" disabled={tests.loading} onClick={tests.retry}>重新載入</button>
        </div>
        <label className="search-label"><span className="sr-only">搜尋測試</span>
          <SearchIcon /><input type="search" value={search} placeholder="搜尋名稱或描述" onChange={(event) => setSearch(event.target.value)} />
        </label>
        {tests.loading ? <Loading text="正在載入測試…" /> : null}
        {tests.error ? <Notice message={tests.error} retry={tests.retry} /> : null}
        {tests.data?.length === 0 ? <Empty title="還沒有測試" text="M1 固定測試由 Server 建立，請確認種子資料已就緒。" /> : null}
        {tests.data?.length && filtered?.length === 0 ? <p className="list-empty">找不到符合的測試，請調整搜尋內容。</p> : null}
        <ul className="test-list">
          {filtered?.map((test) => <li key={test.id}>
            <button className={`test-item${selected?.id === test.id ? ' selected' : ''}`} aria-current={selected?.id === test.id ? 'true' : undefined} onClick={() => setSelectedId(test.id)}>
              <span className="test-name">{test.name}<ChevronIcon /></span>
              <span className="test-description">{test.description || '尚無測試描述'}</span>
              <span className="version-label">{test.publishedVersionId ? '已發佈' : '尚未發佈'}</span>
            </button>
          </li>)}
        </ul>
      </aside>
      <section className="detail-panel" aria-label="測試詳情">
        {selected ? <TestDetail key={selected.id} testId={selected.id} api={api} apiBase={apiBase} />
          : <Empty title="在這裡查看測試" text="從左側列表選擇一個測試，查看版本、執行狀態與報告。" />}
      </section>
    </div>
  );
}

function TestDetail({ testId, api, apiBase }: { testId: string } & Pick<AppProps, 'api' | 'apiBase'>) {
  const loadTest = useCallback((signal: AbortSignal) => api.getTest(testId, signal), [api, testId]);
  const test = useResource(loadTest);
  const history = useRuns(api, testId);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const submitLock = useRef(false);
  const submitController = useRef<AbortController | null>(null);
  useEffect(() => () => submitController.current?.abort(), []);

  async function runTest() {
    if (submitLock.current || !test.data?.publishedVersionId) return;
    submitLock.current = true;
    setSubmitting(true);
    setSubmitError(undefined);
    const controller = new AbortController();
    submitController.current = controller;
    try {
      const run = await api.createRun(testId, controller.signal);
      if (!controller.signal.aborted) history.addRun(run);
    } catch (error) {
      if (!controller.signal.aborted) setSubmitError(`${errorMessage(error)} 若請求已送達，任務可能已建立；請先重新整理執行紀錄，再決定是否重試。`);
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
      submitLock.current = false;
    }
  }

  const latest = history.runs[0];
  return (
    <>
      {test.loading ? <Loading text="正在載入測試詳情…" /> : null}
      {test.error ? <Notice message={test.error} retry={test.retry} /> : null}
      {test.data ? <>
        <div className="detail-heading"><div><h2>{test.data.name}</h2><p className="detail-description">{test.data.description || '尚無測試描述。'}</p></div>
          <button className="button primary run-button" disabled={submitting || !test.data.publishedVersionId} onClick={runTest}>
            <PlayIcon />{submitting ? '送出中…' : '執行測試'}
          </button>
        </div>
        <dl className="test-metadata"><div><dt>發佈版本</dt><dd className="identifier">{test.data.publishedVersionId || '尚未發佈'}</dd></div>
          <div><dt>測試 ID</dt><dd className="identifier">{test.data.id}</dd></div></dl>
        {!test.data.publishedVersionId ? <p className="inline-hint">此測試尚未發佈，暫時無法執行。M1 固定測試版本由 Server 建立。</p> : null}
      </> : null}
      {submitError ? <Notice message={submitError} retry={history.refresh} retryLabel="重新整理執行紀錄" /> : null}
      <section className="latest-section" aria-labelledby="latest-title">
        <div className="section-heading"><h3 id="latest-title">最近一次執行</h3>
          <span className="refresh-status" role="status">{history.loading ? '正在讀取狀態…' : history.error ? '同步暫時中斷' : history.polling ? '每 2 秒更新狀態' : '狀態已同步'}</span>
        </div>
        {latest ? <div className="latest-run" aria-live="polite" aria-atomic="true">
          <div className="latest-summary"><StatusBadge run={latest} /><span>{formatDate(latest.createdAt)}</span><ReportLink run={latest} apiBase={apiBase} /></div>
          <p className="run-id">Run <span className="identifier">{latest.id}</span></p>
          {latest.error ? <pre className="run-error">{latest.error}</pre> : null}
          {isActiveRun(latest) ? <p className="inline-hint">{latest.status === 'queued' ? '任務已排入佇列，正在等待執行節點。' : '任務正在處理中，結果會自動更新。'}</p> : null}
          {!isActiveRun(latest) && !latest.reportUrl ? <p className="inline-hint">Server 尚未提供報告連結，請重新整理執行紀錄。</p> : null}
        </div> : !history.loading && !history.error ? <p className="muted">還沒有執行紀錄。按「執行測試」開始第一次執行。</p> : null}
      </section>
      <section className="history-section" aria-labelledby="history-title">
        <div className="section-heading"><h3 id="history-title">執行紀錄 <span className="count">{history.runs.length}</span></h3>
          <button className="button secondary compact" disabled={history.loading} onClick={history.refresh}>{history.loading ? '更新中…' : '重新整理'}</button>
        </div>
        {history.error ? <Notice message={history.error} retry={history.refresh} /> : null}
        {history.loading ? <Loading text="正在載入執行紀錄…" /> : null}
        {history.runs.length ? <div className="table-scroll"><table>
          <caption className="sr-only">測試執行歷史，最新紀錄在前</caption>
          <thead><tr><th scope="col">狀態／Run</th><th scope="col">建立時間</th><th scope="col">執行耗時</th><th scope="col">報告</th></tr></thead>
          <tbody>{history.runs.map((run) => <tr key={run.id}>
            <td><StatusBadge run={run} /><span className="table-run-id identifier" title={run.id}>{run.id.slice(0, 8)}</span>
              {run.error ? <details className="error-details"><summary>查看錯誤</summary><pre className="run-error">{run.error}</pre></details> : null}
            </td><td><time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time></td><td>{duration(run)}</td><td><ReportLink run={run} apiBase={apiBase} /></td>
          </tr>)}</tbody>
        </table></div> : null}
        {history.updatedAt ? <p className="updated-at">最後同步：{history.updatedAt.toLocaleTimeString('zh-TW', { hour12: false })}</p> : null}
      </section>
    </>
  );
}

function StatusBadge({ run }: { run: Run }) {
  const tone = run.status === 'succeeded' ? 'success'
    : ['failed', 'timed_out', 'interrupted'].includes(run.status) ? 'danger'
      : isActiveRun(run) ? 'active' : 'neutral';
  return <span className={`status-badge ${tone}`}><span className="status-dot" aria-hidden="true" />{STATUS_LABELS[run.status]}</span>;
}

function ReportLink({ run, apiBase }: { run: Run; apiBase: string }) {
  const href = resolveReportUrl(run.reportUrl, apiBase, window.location.href);
  return href ? <a className="report-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={`開啟 Run ${run.id} 的報告（新分頁）`}>開啟報告<ExternalIcon /></a>
    : <span className="muted">{run.reportUrl ? '報告連結無效' : '尚無報告'}</span>;
}

function Notice({ message, retry, retryLabel = '重試' }: { message: string; retry?: () => void; retryLabel?: string }) {
  return <div className="notice" role="alert"><p>{message}</p>{retry ? <button className="button secondary compact" onClick={retry}>{retryLabel}</button> : null}</div>;
}

function Empty({ title, text, retry }: { title: string; text: string; retry?: () => void }) {
  return <div className="empty-state"><h3>{title}</h3><p>{text}</p>{retry ? <button className="button secondary" onClick={retry}>重新載入</button> : null}</div>;
}

function Loading({ text }: { text: string }) {
  return <div className="loading-state" role="status"><p>{text}</p><div className="loading-line" /><div className="loading-line short" /></div>;
}

const dateFormatter = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間未知' : dateFormatter.format(date);
}

function duration(run: Run): string {
  if (!run.startedAt) return '—';
  if (!run.finishedAt) return isActiveRun(run) ? '執行中' : '—';
  const milliseconds = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(milliseconds) ? `${Math.max(0, milliseconds / 1000).toFixed(1)} 秒` : '—';
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m5 9 5 15 6-12 6 12 5-15M12 5h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function PlayIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 4 9 6-9 6V4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}
function ArrowIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ChevronIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ExternalIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M11 4h5v5m0-5-8 8M8 4H4v12h12v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function SearchIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
