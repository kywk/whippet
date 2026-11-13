import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from './api';
import { ModuleCatalog } from './ModuleCatalog';
import { Loading, Notice } from './components';
import { WorkspaceConversation } from './WorkspaceConversation';
import { WorkspaceAvailability } from './WorkspaceSettings';
import { TestWorkspace } from './TestWorkspace';
import { useActivity } from './activity';
import { useAllTestTags } from './tags';
import { MiniTrail } from './trail';
import { useResource } from './hooks';
import { ArrowRightIcon, BellIcon, BrandMark, ChevronDownIcon, CloseIcon, GearIcon, MenuIcon, PlusIcon, RefreshIcon, SearchIcon, SidebarIcon } from './icons';
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

type Surface = 'tests' | 'settings' | 'catalog';

export function App({ api, apiBase, mock }: AppProps) {
  const [user, setUser] = useState<DevUser>();
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string>();
  const loginLock = useRef(false);
  const draftDirty = useRef(false);
  const settingsDirty = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { draftDirty.current = dirty; }, []);
  const onSettingsDirtyChange = useCallback((dirty: boolean) => { settingsDirty.current = dirty; }, []);
  // AI 任務在背景進行，離開不需要確認；只有「真的會遺失的內容」才詢問：
  // 未儲存的手動腳本、尚未送達的請求、未保存的帳密。未送出的訊息會自動保留為草稿。
  const confirmTestNavigation = useCallback(() => !draftDirty.current || window.confirm('有未儲存的腳本修改或尚未送達的操作。確定離開？未儲存的內容會遺失；AI 任務與已送出的請求會在背景繼續。'), []);
  const confirmNavigation = useCallback(() => (!draftDirty.current && !settingsDirty.current) || window.confirm('有未儲存的腳本修改、帳密或尚未送達的操作。確定離開？未儲存的內容會遺失；AI 任務與已送出的請求會在背景繼續。'), []);

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
      {!user ? (
        <main id="main" className="login-layout">
          <section className="login-brand" aria-hidden="true">
            <BrandMark className="login-mark" />
            <ol className="login-trail">
              {['改稿', '驗證', '摘要', '發佈'].map((label, index) => <li key={label} style={{ ['--i' as string]: index }}><span className="node">{index + 1}</span><span>{label}</span></li>)}
            </ol>
          </section>
          <section className="login-panel" aria-labelledby="login-title">
            <h1 id="login-title">Whippet</h1>
            <a href="?preview=m10">M10 合成資料預覽</a>
            <p>用對話建立 Playwright 測試。AI 改稿、真實驗證、你確認發佈，執行與報告都在同一個工作台。</p>
            <button className="button primary login-button" disabled={loggingIn} onClick={login}>
              {loggingIn ? '登入中…' : '以開發管理員登入'}<ArrowRightIcon />
            </button>
            {loginError ? <Notice message={loginError} /> : null}
            <p className="fine-print">M1 開發入口 · 不需帳號密碼<br />由 Server 提供固定 Superadmin 身分。</p>
            {mock ? <p className="mock-note" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</p> : null}
          </section>
        </main>
      ) : <WorkspaceView api={api} apiBase={apiBase} mock={mock} user={user} onLogout={() => { if (confirmNavigation()) setUser(undefined); }} onDirtyChange={onDirtyChange} confirmNavigation={confirmNavigation} onSettingsDirtyChange={onSettingsDirtyChange} confirmTestNavigation={confirmTestNavigation} />}
    </>
  );
}

interface ViewProps extends Pick<AppProps, 'api' | 'apiBase' | 'mock'>, EditingGuard {
  user: DevUser; onLogout: () => void;
  onSettingsDirtyChange: (dirty: boolean) => void; confirmTestNavigation: () => boolean;
}

function WorkspaceView({ api, apiBase, mock, user, onLogout, onDirtyChange, confirmNavigation, onSettingsDirtyChange, confirmTestNavigation }: ViewProps) {
  const workspaces = useResource(api.listWorkspaces);
  const [selectedId, setSelectedId] = useState('');
  const [surface, setSurface] = useState<Surface>('tests');
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
    if (!same && setupDirty.current && !window.confirm('切換設定對話會放棄尚未送出的 Workspace 帳密內容，確定繼續？')) return;
    if (!same) setSetupTarget(target);
    setSurface('settings');
  }
  const switchWorkspace = (id: string) => { if (id === workspace?.id || !confirmNavigation()) return; setSelectedId(id); setSetupTarget(undefined); setSurface('tests'); };

  const setupView = setupTarget ? <div className="workspace-setup-view" hidden={surface !== 'settings'} data-surface="workspace"><WorkspaceConversation key={setupTarget === 'create' ? 'create' : setupTarget.id} api={api} apiBase={apiBase} active={surface === 'settings'} workspace={setupTarget === 'create' ? undefined : setupTarget} onReturn={() => setSurface('tests')} onDirtyChange={reportSetupGuard} onCreated={createdWorkspace} onWorkspaceUpdated={updateWorkspace} onRefreshList={workspaces.retry} /></div> : null;

  if (!workspace) {
    return <div className="app-shell">
      <nav className="rail" aria-label="導覽"><RailHead user={user} onLogout={onLogout} />
        <button className="button rail-primary" onClick={() => openSetup(true)}><PlusIcon />建立 Workspace</button></nav>
      <main id="main" className="main-pane" tabIndex={-1}>
        {mock ? <div className="mock-banner" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</div> : null}
        {workspaces.loading ? <Loading text="正在載入 Workspace…" /> : null}
        {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
        {setupView}
        {surface === 'tests' && !workspaces.loading && !workspaces.error ? <Empty title="尚無 Workspace" text="先建立 Workspace，透過對話整理驗測目的與網站範圍，再開始建立測試。" action={<button className="button primary" onClick={() => openSetup(true)}>建立 Workspace</button>} /> : null}
      </main>
    </div>;
  }
  return <TestBrowser key={workspace.id} api={api} apiBase={apiBase} mock={mock} user={user} onLogout={onLogout} workspace={workspace} workspaces={allWorkspaces} switchWorkspace={switchWorkspace} openSetup={openSetup} surface={surface} setSurface={setSurface} setupTarget={setupTarget} onDirtyChange={onDirtyChange} confirmNavigation={confirmTestNavigation} initialSelectedId={selectedTests.current[workspace.id] ?? ''} onSelected={rememberTest} setupView={setupView} onOpenCatalog={() => { if (confirmNavigation()) setSurface('catalog'); }} />;
}

function RailHead({ user, onLogout, onCollapse }: { user: DevUser; onLogout: () => void; onCollapse?: () => void }) {
  return <div className="rail-head">
    <a className="brand" href="/" aria-label="Whippet 首頁"><BrandMark />Whippet</a>
    <div className="rail-head-actions">
      <button className="rail-link" onClick={onLogout} title={`${user.id} · ${user.role}`}>登出</button>
      {onCollapse ? <button type="button" className="rail-icon-button small rail-collapse-btn" aria-label="收合左側欄" title="收合左側欄" onClick={onCollapse}><SidebarIcon /></button> : null}
    </div>
  </div>;
}

interface BrowserProps extends Pick<AppProps, 'api' | 'apiBase' | 'mock'>, EditingGuard {
  user: DevUser; onLogout: () => void; workspace: WorkspaceDetail; workspaces: WorkspaceDetail[];
  switchWorkspace: (id: string) => void; openSetup: (create?: boolean) => void;
  surface: Surface; setSurface: (surface: Surface) => void; setupTarget?: WorkspaceDetail | 'create';
  initialSelectedId: string; onSelected: (id: string) => void; setupView: ReactNode; onOpenCatalog: () => void;
}

function TestBrowser({ workspace, workspaces, api, apiBase, mock, user, onLogout, switchWorkspace, openSetup, surface, setSurface, setupTarget, onDirtyChange, confirmNavigation, initialSelectedId, onSelected, setupView, onOpenCatalog }: BrowserProps) {
  const loadTests = useCallback((signal: AbortSignal) => api.listTests(workspace.id, signal), [api, workspace.id]);
  const tests = useResource(loadTests);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>();
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem('whippet.railCollapsed.v1') === '1'; } catch { return false; }
  });
  const toggleRailCollapsed = useCallback((next?: boolean) => {
    setRailCollapsed((current) => {
      const value = next ?? !current;
      try { localStorage.setItem('whippet.railCollapsed.v1', value ? '1' : '0'); } catch { /* ignore */ }
      return value;
    });
  }, []);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [autoEditId, setAutoEditId] = useState<string>();
  const [testModes, setTestModes] = useState<Record<string, 'general' | 'editing'>>({});
  const { tagsByTest, addTagForTest, removeTagForTest } = useAllTestTags();
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
  const workspaceTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of allTests) {
      for (const tag of tagsByTest[item.id] ?? []) set.add(tag);
    }
    return [...set];
  }, [allTests, tagsByTest]);
  useEffect(() => {
    if (selectedTag && !workspaceTags.includes(selectedTag)) setSelectedTag(undefined);
  }, [selectedTag, workspaceTags]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = allTests.filter((test) => {
    const testTags = tagsByTest[test.id] ?? [];
    if (selectedTag && !testTags.includes(selectedTag)) return false;
    if (!query) return true;
    const tagSearchText = testTags.map((tag) => `#${tag} ${tag}`).join(' ');
    return `${test.name} ${test.description} ${tagSearchText}`.toLocaleLowerCase().includes(query);
  });
  const updateTest = useCallback((test: Test) => setOverrides((current) => ({ ...current, [test.id]: test })), []);
  const { activity, running, unread, permission, enableNotifications } = useActivity(api, allTests, surface === 'tests' ? selected?.id : undefined);
  const handleModeChange = useCallback((testId: string, mode: 'general' | 'editing') => {
    setTestModes((current) => current[testId] === mode ? current : { ...current, [testId]: mode });
  }, []);

  async function createTest(kind: 'test' | 'usecase' = 'test') {
    if (createLock.current || !confirmNavigation()) return;
    createLock.current = true; setCreating(true); setCreateError(undefined);
    const controller = new AbortController(); createController.current = controller;
    try {
      const test = await api.createTest(workspace.id, kind === 'usecase' ? { kind } : {}, controller.signal);
      if (controller.signal.aborted) return;
      updateTest(test); setSelectedId(test.id); onSelected(test.id); setAutoEditId(test.id);
      setTestModes((current) => ({ ...current, [test.id]: 'editing' }));
      setSearch(''); setSelectedTag(undefined); setSurface('tests'); setRailOpen(false);
    } catch (cause) { if (!controller.signal.aborted) setCreateError(`${errorMessage(cause)} 若結果不明，請先重新載入列表確認是否已建立，避免重複新增。`); }
    finally { if (!controller.signal.aborted) setCreating(false); createLock.current = false; }
  }
  function pick(test: Test) {
    if (surface === 'tests' && selected?.id === test.id) { setRailOpen(false); return; }
    if (!confirmNavigation()) return;
    const info = activity[test.id];
    const hasActiveConversation = Boolean(test.activeEditingSession) || Boolean(info?.running && !test.publishedVersionId);
    if (info?.running && test.activeEditingSession) {
      setTestModes((current) => ({ ...current, [test.id]: 'editing' }));
    }
    setSelectedId(test.id); onSelected(test.id);
    setAutoEditId(hasActiveConversation && testModes[test.id] !== 'general' ? test.id : undefined);
    setSurface('tests'); setRailOpen(false);
  }

  const selectedInfo = selected ? activity[selected.id] : undefined;
  const selectedPreferredMode = selected
    ? (selectedInfo?.running && selected.activeEditingSession
      ? 'editing'
      : testModes[selected.id] ?? (selected.activeEditingSession ? 'editing' : undefined))
    : undefined;
  const shouldInitialEdit = Boolean(
    selected && (
      autoEditId === selected.id ||
      selectedPreferredMode === 'editing' ||
      (selected.activeEditingSession && selectedPreferredMode !== 'general')
    )
  );

  return (
    <div className={`app-shell${railOpen ? ' rail-open' : ''}${railCollapsed ? ' rail-collapsed' : ''}`}>
      {railOpen ? <div className="rail-backdrop" aria-hidden="true" onClick={() => setRailOpen(false)} /> : null}
      <nav id="app-rail" className="rail" aria-label="Workspace 與測試">
        <div className="rail-mobile-close"><button className="rail-icon-button" aria-label="關閉測試選單" onClick={() => setRailOpen(false)}><CloseIcon /></button></div>
        <RailHead user={user} onLogout={onLogout} onCollapse={() => toggleRailCollapsed(true)} />
        <div className="rail-workspace">
          <label className="workspace-select"><span className="sr-only">Workspace</span>
            <select value={workspace.id} onChange={(event) => { switchWorkspace(event.target.value); setRailOpen(false); }}>
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select><ChevronDownIcon />
          </label>
          <button className="rail-icon-button" aria-label="Workspace 設定" title="Workspace 設定" aria-pressed={surface === 'settings' && setupTarget !== 'create'} onClick={() => { openSetup(); setRailOpen(false); }}><GearIcon /></button>
        </div>
        <button className="button rail-primary" disabled={creating} onClick={() => { void createTest(); }}><PlusIcon />{creating ? '正在建立測試…' : '新增測試'}</button>
        <button className="button rail-primary" disabled={creating} onClick={() => { void createTest('usecase'); }}>新增 Use Case</button>
        {createError ? <Notice message={createError} /> : null}
        <label className="search-label"><span className="sr-only">搜尋測試</span>
          <SearchIcon /><input type="search" value={search} placeholder="搜尋測試名稱或 #標籤" onChange={(event) => setSearch(event.target.value)} />
        </label>
        {workspaceTags.length > 0 ? (
          <div className="rail-tags" role="group" aria-label="依標籤篩選測試">
            <button type="button" className={`rail-tag-filter${!selectedTag ? ' active' : ''}`} onClick={() => setSelectedTag(undefined)}>全部</button>
            {workspaceTags.map((tag) => (
              <button key={tag} type="button" className={`rail-tag-filter${selectedTag === tag ? ' active' : ''}`} onClick={() => setSelectedTag((current) => current === tag ? undefined : tag)}>#{tag}</button>
            ))}
          </div>
        ) : null}
        <div className="rail-section">
          <h2>測試 <span className="count">{filtered.length !== allTests.length ? `${filtered.length}/${allTests.length}` : allTests.length}</span></h2>
          <button className="rail-icon-button small" aria-label="重新載入測試列表" title="重新載入測試列表" disabled={tests.loading || creating} onClick={() => { if (confirmNavigation()) tests.retry(); }}><RefreshIcon /></button>
        </div>
        <div className="rail-scroll">
          {tests.loading ? <Loading text="正在載入測試…" /> : null}
          {tests.error ? <Notice message={tests.error} retry={tests.retry} /> : null}
          {tests.data && allTests.length === 0 ? <p className="rail-empty">還沒有測試。按「新增測試」，用一句話開始。</p> : null}
          {allTests.length > 0 && filtered.length === 0 ? <p className="rail-empty">找不到符合的測試。</p> : null}
          <ul className="test-list">
            {filtered.map((test) => {
              const info = activity[test.id];
              const testTags = tagsByTest[test.id] ?? [];
              const isSelected = surface === 'tests' && selected?.id === test.id;
              return <li key={test.id}>
                <button className={`test-item${isSelected ? ' selected' : ''}${info?.running ? ' running' : ''}${info?.unread ? ' unread' : ''}`} disabled={creating} aria-current={isSelected ? 'true' : undefined} onClick={() => pick(test)}>
                  <span className="test-name"><span>{test.name}</span>{info?.unread ? <span className="unread-light" role="img" aria-label="有新的結果" /> : null}</span>
                  {testTags.length > 0 ? <span className="test-item-tags">{testTags.map((tag) => <span key={tag} className="test-item-tag">#{tag}</span>)}</span> : null}
                  {info ? <MiniTrail stages={info.stages} bad={info.bad} /> : null}
                  <span className={`test-state${info?.bad ? ' bad' : ''}`}>{info?.label ?? (test.publishedVersionId ? '已發佈' : '尚未發佈')}</span>
                </button>
              </li>;
            })}
          </ul>
        </div>
        <div className="rail-foot">
          <button className="rail-link wide" aria-pressed={surface === 'catalog'} onClick={() => { onOpenCatalog(); setRailOpen(false); }}>Module 模組庫</button>
          <a className="rail-link wide" href="?preview=m10" onClick={(event) => { if (!confirmNavigation()) event.preventDefault(); }}>Module / Use Case 合成預覽</a>
          <details className="rail-caps"><summary>Workspace 能力</summary><WorkspaceAvailability workspace={workspace} /></details>
          {permission === 'default' ? <button className="rail-link wide" onClick={() => { void enableNotifications(); }}><BellIcon />背景完成時通知我</button> : permission === 'granted' ? <p className="rail-note"><BellIcon />背景完成通知已開啟</p> : null}
          <button className="rail-link wide" onClick={() => { openSetup(true); setRailOpen(false); }}><PlusIcon />建立 Workspace</button>
          <p className="rail-note" aria-live="polite">{running ? `${running} 項任務在背景進行` : '沒有背景任務'}{unread ? ` · ${unread} 項新結果` : ''}</p>
        </div>
      </nav>
      <main id="main" className="main-pane" tabIndex={-1}>
        <div className="mobile-bar">
          <button className="button quiet compact" aria-expanded={railOpen} aria-controls="app-rail" onClick={() => setRailOpen(true)}><MenuIcon />測試列表{unread ? <span className="unread-light inline" aria-label={`${unread} 項新結果`} /> : null}</button>
          <span className="mobile-workspace">{workspace.name}</span>
        </div>
        {railCollapsed && (surface !== 'tests' || !selected) ? (
          <div className="rail-collapsed-bar">
            <button type="button" className="button secondary compact" onClick={() => toggleRailCollapsed(false)}>
              <SidebarIcon />展開測試列表{unread ? <span className="unread-light inline" aria-label={`${unread} 項新結果`} /> : null}
            </button>
            <span className="muted">{workspace.name}</span>
          </div>
        ) : null}
        {mock ? <div className="mock-banner" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</div> : null}
        {setupView}
        {surface === 'catalog' ? <ModuleCatalog key={workspace.id} api={api} workspaceId={workspace.id} /> : null}
        {surface === 'tests' ? (selected
          ? <TestWorkspace
              key={selected.id}
              testId={selected.id}
              api={api}
              apiBase={apiBase}
              onDirtyChange={reportEditorGuard}
              onTestUpdated={updateTest}
              settingsRefresh={0}
              initialEditing={shouldInitialEdit}
              preferredMode={selectedPreferredMode}
              onModeChange={(mode) => handleModeChange(selected.id, mode)}
              railCollapsed={railCollapsed}
              onExpandRail={() => toggleRailCollapsed(false)}
              unreadCount={unread}
              tags={tagsByTest[selected.id] ?? []}
              workspaceTags={workspaceTags}
              onAddTag={(raw) => addTagForTest(selected.id, raw)}
              onRemoveTag={(tag) => removeTagForTest(selected.id, tag)}
              capabilities={workspace.capabilities}
            />
          : tests.loading ? null : <Empty title="選一個測試，或新增測試" text="從左側選擇測試查看版本與報告，或按「新增測試」，用對話描述要驗證的流程。" action={<button className="button primary" disabled={creating} onClick={() => { void createTest(); }}><PlusIcon />新增測試</button>} />) : null}
      </main>
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2><p>{text}</p>{action}</div>;
}
