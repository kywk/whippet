import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Loading, Notice } from './components';
import { WorkspaceConversation } from './WorkspaceConversation';
import { WorkspaceAvailability } from './WorkspaceSettings';
import { TestWorkspace } from './TestWorkspace';
import { useResource } from './hooks';
import type { DevUser, Test, WhippetApi, WorkspaceDetail } from './types';

interface AppProps {
  api: WhippetApi;
  apiBase: string;
  mock: boolean;
}

interface EditingGuard {
  onDirtyChange: (dirty: boolean) => void;
  confirmNavigation: () => boolean;
}

export function App({ api, apiBase, mock }: AppProps) {
  const [user, setUser] = useState<DevUser>();
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string>();
  const loginLock = useRef(false);
  const draftDirty = useRef(false);
  const settingsDirty = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { draftDirty.current = dirty; }, []);
  const onSettingsDirtyChange = useCallback((dirty: boolean) => { settingsDirty.current = dirty; }, []);
  const confirmTestNavigation = useCallback(() => !draftDirty.current || window.confirm('目前有未儲存的腳本、未送出的訊息或進行中的操作。確定離開此測試？本機未儲存內容將會遺失，已送出的任務仍可能繼續。'), []);
  const confirmNavigation = useCallback(() => (!draftDirty.current && !settingsDirty.current) || window.confirm('目前有未儲存的腳本、訊息、Workspace 設定或進行中的操作。確定離開？本機未儲存內容將會遺失，已送出的請求仍可能完成。'), []);

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
        <a className="brand" href="/" aria-label="Whippet 首頁" onClick={(event) => { if (!confirmNavigation()) event.preventDefault(); }}><BrandMark />Whippet</a>
        <span className="header-caption">測試工作台</span>
        {user ? <div className="session"><span>{user.id} · {user.role}</span>
          <button className="button quiet" onClick={() => { if (confirmNavigation()) setUser(undefined); }}>返回登入</button>
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
      ) : <WorkspaceView api={api} apiBase={apiBase} onDirtyChange={onDirtyChange} confirmNavigation={confirmNavigation} onSettingsDirtyChange={onSettingsDirtyChange} confirmTestNavigation={confirmTestNavigation} />}
    </>
  );
}

function WorkspaceView({ api, apiBase, onDirtyChange, confirmNavigation, onSettingsDirtyChange, confirmTestNavigation }: Pick<AppProps, 'api' | 'apiBase'> & EditingGuard & { onSettingsDirtyChange: (dirty: boolean) => void; confirmTestNavigation: () => boolean }) {
  const workspaces = useResource(api.listWorkspaces);
  const [selectedId, setSelectedId] = useState('');
  const [surface, setSurface] = useState<'tests' | 'settings'>('tests');
  const [setupTarget, setSetupTarget] = useState<WorkspaceDetail | 'create'>();
  const [workspaceOverrides, setWorkspaceOverrides] = useState<Record<string, WorkspaceDetail>>({});
  const setupDirty = useRef(false);
  const reportSetupGuard = useCallback((dirty: boolean) => { setupDirty.current = dirty; onSettingsDirtyChange(dirty); }, [onSettingsDirtyChange]);
  const selectedTests = useRef<Record<string, string>>({});
  const allWorkspaces = [...new Map([...(workspaces.data ?? []), ...Object.values(workspaceOverrides)].map((item) => [item.id, item])).values()];
  const workspace = allWorkspaces.find((item) => item.id === selectedId) ?? allWorkspaces[0];
  const updateWorkspace = useCallback((next: WorkspaceDetail) => {
    setWorkspaceOverrides((previous) => ({ ...previous, [next.id]: next }));
    setSetupTarget((previous) => previous !== 'create' && previous?.id === next.id ? next : previous);
  }, []);
  const createdWorkspace = useCallback((next: WorkspaceDetail) => {
    setWorkspaceOverrides((previous) => ({ ...previous, [next.id]: next })); setSelectedId(next.id); setSetupTarget(next); setSurface('settings'); workspaces.retry();
  }, [workspaces.retry]);
  const rememberTest = useCallback((id: string) => { if (workspace) selectedTests.current[workspace.id] = id; }, [workspace?.id]);
  function openSetup(create = false) {
    if (surface === 'tests' && !confirmTestNavigation()) return;
    const target = create ? 'create' : workspace;
    if (!target) return;
    const same = target === 'create' ? setupTarget === 'create' : setupTarget !== 'create' && setupTarget?.id === target.id;
    if (!same && setupDirty.current && !window.confirm('切換設定對話會放棄目前未送出的 Workspace 內容；尚未保存的文字將遺失，確定繼續？')) return;
    if (!same) setSetupTarget(target);
    setSurface('settings');
  }
  return (
    <main id="main" className="workspace-layout">
      <div className="workspace-heading">
        <div><h1>{surface === 'tests' ? '測試' : 'Workspace 對話設定'}</h1><p>{surface === 'tests' ? '選擇測試，查看詳情與執行結果。' : '先整理目標與背景，再確認範圍和設定提案。'}</p></div>
        <div className="workspace-controls">{workspace ? <label className="workspace-select">Workspace
          <select value={workspace.id} onChange={(event) => { if (event.target.value === workspace.id || !confirmNavigation()) return; setSelectedId(event.target.value); setSetupTarget(undefined); setSurface('tests'); }}>
            {allWorkspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label> : null}<button className="button secondary" aria-controls="workspace-conversation" aria-expanded={surface === 'settings' && setupTarget === 'create'} onClick={() => openSetup(true)}>建立 Workspace</button>{workspace ? <button className="button secondary" aria-controls="workspace-conversation" aria-expanded={surface === 'settings' && setupTarget !== 'create'} onClick={() => openSetup()}>Workspace 設定</button> : null}</div>
      </div>
      {workspaces.loading ? <Loading text="正在載入 Workspace…" /> : null}
      {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
      {surface === 'tests' && !workspaces.loading && !allWorkspaces.length && !workspaces.error ? <Empty title="尚無 Workspace" text="按「建立 Workspace」，開始獨立的設定訪談。" retry={workspaces.retry} /> : null}
      {setupTarget ? <div className="workspace-setup-view" hidden={surface !== 'settings'} data-surface="workspace"><WorkspaceConversation key={setupTarget === 'create' ? 'create' : setupTarget.id} api={api} apiBase={apiBase} active={surface === 'settings'} workspace={setupTarget === 'create' ? undefined : setupTarget} onReturn={() => setSurface('tests')} onDirtyChange={reportSetupGuard} onCreated={createdWorkspace} onWorkspaceUpdated={updateWorkspace} onRefreshList={workspaces.retry} /></div> : null}
      {surface === 'tests' && workspace ? <WorkspaceAvailability workspace={workspace} /> : null}
      {surface === 'tests' && workspace ? <TestBrowser key={workspace.id} workspace={workspace} api={api} apiBase={apiBase} onDirtyChange={onDirtyChange} confirmNavigation={confirmTestNavigation} settingsRefresh={0} initialSelectedId={selectedTests.current[workspace.id] ?? ''} onSelected={rememberTest} /> : null}
    </main>
  );
}

function TestBrowser({ workspace, api, apiBase, onDirtyChange, confirmNavigation, settingsRefresh, initialSelectedId, onSelected }: { workspace: WorkspaceDetail; settingsRefresh: number; initialSelectedId: string; onSelected: (id: string) => void } & Pick<AppProps, 'api' | 'apiBase'> & EditingGuard) {
  const loadTests = useCallback((signal: AbortSignal) => api.listTests(workspace.id, signal), [api, workspace.id]);
  const tests = useResource(loadTests);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [autoEditId, setAutoEditId] = useState<string>();
  const editorDirty = useRef(false);
  const creationPending = useRef(false);
  const reportEditorGuard = useCallback((guarded: boolean) => { editorDirty.current = guarded; onDirtyChange(guarded || creationPending.current); }, [onDirtyChange]);
  useEffect(() => {
    creationPending.current = creating;
    onDirtyChange(creating || editorDirty.current);
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    if (creating) window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [creating, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const createLock = useRef(false);
  const createController = useRef<AbortController | null>(null);
  useEffect(() => () => createController.current?.abort(), []);
  const [overrides, setOverrides] = useState<Record<string, Test>>({});
  const allTests = [...new Map([...(tests.data ?? []), ...Object.values(overrides)].map((test) => [test.id, test])).values()];
  const selected = allTests.find((item) => item.id === selectedId) ?? allTests[0];
  const filtered = allTests.filter((test) => `${test.name} ${test.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const updateTest = useCallback((test: Test) => setOverrides((current) => ({ ...current, [test.id]: test })), []);
  async function createTest() {
    if (createLock.current || !confirmNavigation()) return;
    createLock.current = true; setCreating(true); setCreateError(undefined);
    const controller = new AbortController(); createController.current = controller;
    try {
      const test = await api.createTest(workspace.id, {}, controller.signal);
      if (controller.signal.aborted) return;
      updateTest(test); setSelectedId(test.id); onSelected(test.id); setAutoEditId(test.id); setSearch('');
    } catch (cause) { if (!controller.signal.aborted) setCreateError(`${errorMessage(cause)} 若結果不明，請先重新載入列表確認是否已建立，避免重複新增。`); }
    finally { if (!controller.signal.aborted) setCreating(false); createLock.current = false; }
  }

  return (
    <div className="test-browser">
      <aside className="test-sidebar" aria-label="Workspace 測試列表">
        <div className="section-heading"><h2>測試列表 <span className="count">{allTests.length}</span></h2>
          <button className="button quiet compact" disabled={tests.loading || creating} onClick={() => { if (confirmNavigation()) tests.retry(); }}>重新載入</button>
        </div>
        <button className="button secondary new-test-button" disabled={creating} onClick={createTest}>{creating ? '正在建立測試…' : '新增測試'}</button>
        {createError ? <Notice message={createError} /> : null}
        <label className="search-label"><span className="sr-only">搜尋測試</span>
          <SearchIcon /><input type="search" value={search} placeholder="搜尋名稱或描述" onChange={(event) => setSearch(event.target.value)} />
        </label>
        {tests.loading ? <Loading text="正在載入測試…" /> : null}
        {tests.error ? <Notice message={tests.error} retry={tests.retry} /> : null}
        {tests.data && allTests.length === 0 ? <Empty title="還沒有測試" text="按「新增測試」，建立第一份草稿。" /> : null}
        {allTests.length > 0 && filtered.length === 0 ? <p className="list-empty">找不到符合的測試，請調整搜尋內容。</p> : null}
        <ul className="test-list">
          {filtered?.map((test) => <li key={test.id}>
            <button className={`test-item${selected?.id === test.id ? ' selected' : ''}`} disabled={creating} aria-current={selected?.id === test.id ? 'true' : undefined} onClick={() => { if (selected?.id === test.id || !confirmNavigation()) return; setSelectedId(test.id); onSelected(test.id); setAutoEditId(undefined); }}>
              <span className="test-name">{test.name}<ChevronIcon /></span>
              <span className="test-description">{test.description || '尚無測試描述'}</span>
              <span className="version-label">{test.publishedVersionId ? '已發佈' : '尚未發佈'}</span>
            </button>
          </li>)}
        </ul>
      </aside>
      <section className="detail-panel" aria-label="測試詳情">
        {selected ? <TestWorkspace key={selected.id} testId={selected.id} api={api} apiBase={apiBase} onDirtyChange={reportEditorGuard} onTestUpdated={updateTest} settingsRefresh={settingsRefresh} initialEditing={autoEditId === selected.id} capabilities={workspace.capabilities} />
          : <Empty title="在這裡查看測試" text="從左側列表選擇一個測試，查看版本、執行狀態與報告。" />}
      </section>
    </div>
  );
}

function Empty({ title, text, retry }: { title: string; text: string; retry?: () => void }) {
  return <div className="empty-state"><h3>{title}</h3><p>{text}</p>{retry ? <button className="button secondary" onClick={retry}>重新載入</button> : null}</div>;
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m5 9 5 15 6-12 6 12 5-15M12 5h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ArrowIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ChevronIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function SearchIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
