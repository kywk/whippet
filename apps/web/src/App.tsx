import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { DEFAULT_DEV_USER, DEV_IDENTITIES, readSiteManagementRoute, siteManagementHref, siteRoleNames } from './access';
import type { SiteManagementRoute } from './access';
import { ApiError, errorMessage } from './api';
import { BackgroundNotices, Loading, Notice, SurfaceBoundary } from './components';
import { WorkspaceOverview } from './WorkspaceOverview';
import { TestWorkspace } from './TestWorkspace';
import { useActivity } from './activity';
import type { BackgroundCompletion } from './activity';
import { useLegacyTestTags } from './tags';
import { MiniTrail } from './trail';
import { useResource } from './hooks';
import { ArchiveIcon, ArrowRightIcon, BellIcon, BookIcon, CheckIcon, ChevronDownIcon, CloseIcon, FilterIcon, GearIcon, LogOutIcon, MenuIcon, PlusIcon, RefreshIcon, SearchIcon, SidebarIcon, UsersIcon } from './icons';
import whippetIcon from './assets/whippet-icon.png';
import whippetIllustration from './assets/whippet-illustration.webp';
import type { DevUser, Test, WhippetApi, WorkspaceDetail } from './types';

const WorkspaceConversation = lazy(() => import('./WorkspaceConversation').then(({ WorkspaceConversation }) => ({ default: WorkspaceConversation })));
const SiteManagement = lazy(() => import('./SiteManagement').then(({ SiteManagement }) => ({ default: SiteManagement })));
const WorkspaceMembers = lazy(() => import('./UserAccess').then(({ WorkspaceMembers }) => ({ default: WorkspaceMembers })));
const ModuleCatalog = lazy(() => import('./ModuleCatalog').then(({ ModuleCatalog }) => ({ default: ModuleCatalog })));
const ArchivedTests = lazy(() => import('./ArchivedTests').then(({ ArchivedTests }) => ({ default: ArchivedTests })));
const ArchivedTestDetail = lazy(() => import('./ArchivedTests').then(({ ArchivedTestDetail }) => ({ default: ArchivedTestDetail })));

interface AppProps {
  api: WhippetApi;
  apiBase: string;
  mock: boolean;
}

interface EditingGuard {
  onDirtyChange: (dirty: boolean) => void;
  confirmNavigation: () => boolean;
}

type Surface = 'overview' | 'tests' | 'settings' | 'catalog' | 'members' | 'archive';
type NavigationSurface = Exclude<Surface, 'tests' | 'settings'>;

export function App({ api, apiBase, mock }: AppProps) {
  const [user, setUser] = useState<DevUser | null>();
  const [identity, setIdentity] = useState<string>(DEFAULT_DEV_USER);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loginError, setLoginError] = useState<string>();
  const [adminKeyInput, setAdminKeyInput] = useState('');
  const loginLock = useRef(false);
  const draftDirty = useRef(false);
  const settingsDirty = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { draftDirty.current = dirty; }, []);
  const onSettingsDirtyChange = useCallback((dirty: boolean) => { settingsDirty.current = dirty; }, []);
  // AI 任務在背景進行，離開不需要確認；只有「真的會遺失的內容」才詢問：
  // 未儲存的手動腳本、尚未送達的請求、未保存的帳密。未送出的訊息會自動保留為草稿。
  const confirmTestNavigation = useCallback(() => !draftDirty.current || window.confirm('有未儲存的腳本修改或尚未送達的操作。確定離開？未儲存的內容會遺失；AI 任務與已送出的請求會在背景繼續。'), []);
  const confirmNavigation = useCallback(() => (!draftDirty.current && !settingsDirty.current) || window.confirm('有未儲存的腳本修改、帳密或尚未送達的操作。確定離開？未儲存的內容會遺失；AI 任務與已送出的請求會在背景繼續。'), []);

  useEffect(() => {
    const controller = new AbortController();
    void api.getMe(controller.signal).then((current) => {
      if (!controller.signal.aborted) setUser(current);
    }, (cause) => {
      if (controller.signal.aborted) return;
      setUser(null);
      if (!(cause instanceof ApiError && cause.status === 401)) setLoginError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [api]);

  async function login() {
    if (loginLock.current) return;
    loginLock.current = true;
    setLoggingIn(true);
    setLoginError(undefined);
    api.setAdminToken?.(adminKeyInput);
    try { setUser(await api.login(identity)); setAdminKeyInput(''); }
    catch (error) {
      setLoginError(error instanceof ApiError && error.status === 401 ? '管理 gate 已啟用：請輸入正確的管理 key 再登入。' : errorMessage(error));
    }
    finally { api.setAdminToken?.(''); setLoggingIn(false); loginLock.current = false; }
  }

  const sessionChanged = useCallback(() => {
    setUser(null);
    setIdentity(DEFAULT_DEV_USER);
    setLoginError('登入身分已變更或過期。請重新選擇開發身分登入。');
  }, []);

  async function logout() {
    if (!confirmNavigation()) return;
    setUser(null);
    setIdentity(DEFAULT_DEV_USER);
    setAdminKeyInput('');
    api.setAdminToken?.('');
    setLoginError(undefined);
    setLoggingOut(true);
    try { await api.logout?.(); }
    catch (error) { setLoginError(`登出請求未確認：${errorMessage(error)} 請關閉此分頁並確認 Server session 已失效。`); }
    finally { setLoggingOut(false); }
  }

  return (
    <>
      <a className="skip-link" href="#main">跳至主要內容</a>
      {user === undefined ? <main id="main" tabIndex={-1}><Loading text="正在確認登入狀態…" /></main> : !user ? (
        <main id="main" className="login-layout">
          <section className="login-brand" aria-hidden="true">
            <img className="login-illustration" src={whippetIllustration} width={640} height={640} alt="" />
            <ol className="login-trail">
              {['改稿', '驗證', '摘要', '發佈'].map((label, index) => <li key={label} style={{ ['--i' as string]: index }}><span className="node">{index + 1}</span><span>{label}</span></li>)}
            </ol>
          </section>
          <section className="login-panel" aria-labelledby="login-title">
            <h1 id="login-title">Whippet</h1>
            <a href="?preview=m10">M10 合成資料預覽</a>
            <p>用對話建立 Playwright 測試。AI 改稿、真實驗證、你確認發佈，執行與報告都在同一個工作台。</p>
            <form className="login-form" onSubmit={(event) => { event.preventDefault(); void login(); }}>
              <div className="settings-field">
                <label htmlFor="dev-identity">開發身分</label>
                <select id="dev-identity" className="text-input" value={identity} disabled={loggingIn || loggingOut} onChange={(event) => setIdentity(event.target.value)}>
                  {DEV_IDENTITIES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                </select>
              </div>
              {!mock ? <label className="settings-field">管理 key（管理 gate 啟用時必填）
                <input className="text-input" type="password" value={adminKeyInput} onChange={(event) => setAdminKeyInput(event.target.value)} autoComplete="off" spellCheck={false} disabled={loggingIn || loggingOut} />
              </label> : null}
              <button type="submit" className="button primary login-button" disabled={loggingIn || loggingOut}>
                {loggingOut ? '登出中…' : loggingIn ? '登入中…' : '登入'}<ArrowRightIcon />
              </button>
            </form>
            {loginError ? <Notice message={loginError} /> : null}
            <p className="fine-print">開發身分供開發與驗收使用。</p>
            {mock ? <p className="mock-note" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</p> : null}
          </section>
        </main>
      ) : <WorkspaceView key={user.id} api={api} apiBase={apiBase} mock={mock} user={user} onUserUpdated={setUser} onSessionChanged={sessionChanged}
        onLogout={() => { void logout(); }} onDirtyChange={onDirtyChange} confirmNavigation={confirmNavigation} onSettingsDirtyChange={onSettingsDirtyChange} confirmTestNavigation={confirmTestNavigation} />}
    </>
  );
}

interface ViewProps extends Pick<AppProps, 'api' | 'apiBase' | 'mock'>, EditingGuard {
  user: DevUser; onLogout: () => void;
  onUserUpdated: (user: DevUser) => void; onSessionChanged: () => void;
  onSettingsDirtyChange: (dirty: boolean) => void; confirmTestNavigation: () => boolean;
}

function WorkspaceView({ api, apiBase, mock, user, onLogout, onUserUpdated, onSessionChanged, onDirtyChange, confirmNavigation, onSettingsDirtyChange, confirmTestNavigation }: ViewProps) {
  const loadWorkspaces = useCallback(async (signal: AbortSignal) => {
    try {
      const [current, items] = await Promise.all([api.getMe(signal), api.listWorkspaces(signal)]);
      if (signal.aborted) return items;
      if (current.id !== user.id) {
        onSessionChanged();
        return [];
      }
      onUserUpdated(current);
      return items;
    } catch (cause) {
      if (!signal.aborted && cause instanceof ApiError && cause.status === 401) onSessionChanged();
      throw cause;
    }
  }, [api, user.id, onUserUpdated, onSessionChanged]);
  const workspaces = useResource(loadWorkspaces, true);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') workspaces.retry(); };
    const timer = setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [workspaces.retry]);
  const [selectedId, setSelectedId] = useState('');
  const [surface, setSurface] = useState<Surface>('overview');
  const [siteRoute, setSiteRoute] = useState(readSiteManagementRoute);
  const [setupTarget, setSetupTarget] = useState<string>();
  const [completions, setCompletions] = useState<BackgroundCompletion[]>([]);
  const addCompletions = useCallback((batch: BackgroundCompletion[]) => setCompletions(current => [...current, ...batch]), []);
  const expireCompletion = useCallback((id: string) => setCompletions(current => current.filter(item => item.id !== id)), []);
  const rail = useRailDrawer();
  const setupReturnSurface = useRef<Exclude<Surface, 'settings'>>('overview');
  const setupDirty = useRef(false);
  const reportSetupGuard = useCallback((dirty: boolean) => { setupDirty.current = dirty; onSettingsDirtyChange(dirty); }, [onSettingsDirtyChange]);
  const allWorkspaces = workspaces.data ?? [];
  const workspace = allWorkspaces.find((item) => item.id === selectedId) ?? allWorkspaces[0];
  const setupWorkspace = allWorkspaces.find((item) => item.id === setupTarget);
  const canShowSetup = setupTarget === 'create' ? user.permissions.createWorkspace : setupWorkspace?.permissions.manageSettings;
  const canOpenSiteManagement = user.permissions.manageSiteWorkspaces || user.permissions.manageSiteRoles;
  const canManageTests = workspace?.permissions.manageTests;
  const canManageMembers = workspace?.permissions.manageMembers;
  const surfaceAllowed = {
    overview: true, settings: canShowSetup, members: canManageMembers,
    tests: canManageTests, catalog: canManageTests, archive: canManageTests,
  }[surface];
  const visibleSurface = surfaceAllowed ? surface : 'overview';
  const overviewTitle = useRef<HTMLHeadingElement>(null);
  const previousView = useRef<{ workspaceId?: string; surface: Surface }>({ surface: 'overview' });
  const workspaceId = workspace?.id;
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = { workspaceId, surface: visibleSurface };
    // Keep the browser's focus order on arrival. Announce subsequent overview navigation.
    if (previous.workspaceId && visibleSurface === 'overview' &&
        (previous.workspaceId !== workspaceId || previous.surface !== visibleSurface)) {
      overviewTitle.current?.focus({ preventScroll: true });
    }
  }, [workspaceId, visibleSurface]);
  useEffect(() => {
    if (!workspaces.data) return;
    if (!surfaceAllowed) setSurface('overview');
    if (setupTarget && !canShowSetup) setSetupTarget(undefined);
  }, [workspaces.data, surfaceAllowed, setupTarget, canShowSetup]);
  useEffect(() => {
    function syncSiteRoute() {
      const next = readSiteManagementRoute();
      if (next && !siteRoute) {
        if (!confirmNavigation()) {
          window.history.pushState(null, '', siteManagementHref());
          return;
        }
        rail.close();
        setSetupTarget(undefined);
        setSurface('overview');
      }
      setSiteRoute(next);
    }
    window.addEventListener('popstate', syncSiteRoute);
    return () => window.removeEventListener('popstate', syncSiteRoute);
  }, [siteRoute, confirmNavigation, rail.close]);

  const updateWorkspace = useCallback((next: WorkspaceDetail) => {
    workspaces.updateData((items) => items?.map((item) => item.id === next.id ? { ...next, permissions: item.permissions } : item));
  }, [workspaces.updateData]);
  const addWorkspace = useCallback((next: WorkspaceDetail) => {
    workspaces.updateData((items) => [...(items ?? []).filter((item) => item.id !== next.id), next]);
    workspaces.retry();
  }, [workspaces.updateData, workspaces.retry]);
  const createdWorkspace = useCallback((next: WorkspaceDetail) => {
    setupReturnSurface.current = 'overview';
    addWorkspace(next);
    setSelectedId(next.id);
    setSetupTarget(next.id);
    setSurface('settings');
  }, [addWorkspace]);
  const refreshAccess = useCallback((current?: DevUser) => {
    if (current) onUserUpdated(current);
    workspaces.retry();
  }, [onUserUpdated, workspaces.retry]);
  function openSetup(create = false) {
    if (create ? !user.permissions.createWorkspace : !workspace?.permissions.manageSettings) return;
    if (visibleSurface !== 'settings' && !confirmTestNavigation()) return;
    const target = create ? 'create' : workspace?.id;
    const same = target === setupTarget;
    if (!same && setupDirty.current && !window.confirm('切換設定對話會放棄尚未送出的 Workspace 帳密內容，確定繼續？')) return;
    if (!same) setSetupTarget(target);
    if (visibleSurface !== 'settings') setupReturnSurface.current = visibleSurface;
    setSurface('settings');
  }
  function switchWorkspace(id: string) {
    if (id === workspace?.id) { rail.close(); return; }
    if (!confirmNavigation()) return;
    rail.close();
    setSelectedId(id);
    setSetupTarget(undefined);
    setSurface('overview');
  }
  function openSurface(next: NavigationSurface) {
    if (visibleSurface !== next && confirmNavigation()) setSurface(next);
  }
  function navigateSiteManagement(next?: SiteManagementRoute) {
    const href = siteManagementHref(next);
    if (new URL(href, window.location.href).href !== window.location.href) window.history.pushState(null, '', href);
    setSiteRoute(next);
  }
  function openSiteManagement() {
    if (!canOpenSiteManagement || !confirmNavigation()) return;
    rail.close();
    setSetupTarget(undefined);
    setSurface('overview');
    navigateSiteManagement({ page: user.permissions.manageSiteWorkspaces ? 'workspaces' : 'roles' });
  }

  if (siteRoute) return <main id="main" className="site-management" tabIndex={-1}>
    <SurfaceBoundary loadingText="正在開啟全站管理…" confirmReload={confirmNavigation}>
      <SiteManagement api={api} user={user} mock={mock} route={siteRoute}
        onNavigate={navigateSiteManagement} onLogout={onLogout} onCreated={addWorkspace} onAccessChanged={refreshAccess}
        onOpenWorkspace={(id) => { setSelectedId(id); setSurface('overview'); navigateSiteManagement(); }} />
    </SurfaceBoundary>
  </main>;

  const setupView = canShowSetup ? <div className="workspace-setup-view" hidden={visibleSurface !== 'settings'} data-surface="workspace">
    <SurfaceBoundary key={setupTarget} loadingText="正在開啟 Workspace 設定…" confirmReload={confirmNavigation}>
      <WorkspaceConversation api={api} apiBase={apiBase} active={visibleSurface === 'settings'} workspace={setupWorkspace}
        onReturn={() => setSurface(setupReturnSurface.current)} onDirtyChange={reportSetupGuard} onCreated={createdWorkspace} onWorkspaceUpdated={updateWorkspace} onRefreshList={workspaces.retry} />
    </SurfaceBoundary>
  </div> : null;
  const membersView = visibleSurface === 'members' && workspace ? <SurfaceBoundary key={workspace.id} loadingText="正在開啟 Workspace 成員管理…" confirmReload={confirmNavigation}>
    <WorkspaceMembers api={api} workspace={workspace} userId={user.id} onAccessChanged={workspaces.retry} />
  </SurfaceBoundary> : null;

  if (!workspace) {
    return <div className={`app-shell${rail.open ? ' rail-open' : ''}`}>
      {rail.open ? <div className="rail-backdrop" aria-hidden="true" onClick={rail.close} /> : null}
      <nav id="app-rail" className="rail" aria-label="導覽" onKeyDown={rail.onKeyDown}>
        <RailHead name="工作區" onHome={() => { openSurface('overview'); rail.close(); }}>
          <button type="button" ref={rail.dismiss} className="rail-icon-button small rail-mobile-close" aria-label="關閉選單" onClick={rail.close}><CloseIcon /></button>
        </RailHead>
        {user.permissions.createWorkspace ? <button type="button" className="button rail-primary" onClick={() => { openSetup(true); rail.close(); }}><PlusIcon />建立 Workspace</button> : null}
        <div className="rail-foot">
          <RailTools user={user} onLogout={onLogout} panel={rail.tools}>
            {canOpenSiteManagement ? <div className="rail-tools-section">
              <button type="button" className="rail-link wide" onClick={openSiteManagement}><UsersIcon />全站管理</button>
            </div> : null}
          </RailTools>
        </div>
      </nav>
      <main id="main" className="main-pane" tabIndex={-1} inert={rail.open}>
        <div className="mobile-bar"><button type="button" ref={rail.trigger} className="button quiet compact" aria-expanded={rail.open} aria-controls="app-rail" onClick={rail.show}><MenuIcon />選單</button><span>{user.name}</span></div>
        {mock ? <div className="mock-banner" role="status">示範模式：使用本機 mock 資料，不會啟動 Playwright；重新整理後資料會清除。</div> : null}
        {workspaces.loading ? <Loading text="正在載入 Workspace…" /> : null}
        {workspaces.error ? <Notice message={workspaces.error} retry={workspaces.retry} /> : null}
        {setupView}
        {visibleSurface === 'overview' && !workspaces.loading && !workspaces.error ? <Empty title="尚無可使用的 Workspace"
          text={user.permissions.createWorkspace ? '建立 Workspace 後，指定驗測目的與網站範圍。' : '請聯絡 Workspace Admin 加入成員。'}
          action={user.permissions.createWorkspace ? <button className="button primary" onClick={() => openSetup(true)}>建立 Workspace</button> : undefined} /> : null}
      </main>
    </div>;
  }
  return <>
    <TestBrowser key={workspace.id} api={api} apiBase={apiBase} mock={mock} user={user} onLogout={onLogout}
      workspace={workspace} workspaces={allWorkspaces} overviewTitle={overviewTitle} switchWorkspace={switchWorkspace} openSetup={openSetup} rail={rail}
      surface={visibleSurface} setSurface={setSurface} setupTarget={setupTarget} onDirtyChange={onDirtyChange} confirmNavigation={confirmTestNavigation} confirmReload={confirmNavigation}
      administration={<>{setupView}{membersView}</>} onOpenSurface={openSurface} onOpenSiteManagement={canOpenSiteManagement ? openSiteManagement : undefined}
      onBackgroundCompletion={addCompletions} />
    <BackgroundNotices completions={completions} onExpire={expireCompletion} />
  </>;
}

function useRailDrawer() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    tools.current?.hidePopover();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const narrow = window.matchMedia('(max-width: 960px)');
    const closeOnDesktop = (event: MediaQueryListEvent) => { if (!event.matches) close(); };
    dismiss.current?.focus();
    narrow.addEventListener('change', closeOnDesktop);
    return () => {
      narrow.removeEventListener('change', closeOnDesktop);
      if (narrow.matches) trigger.current?.focus();
    };
  }, [open, close]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (open && event.key === 'Escape' && !event.defaultPrevented && !tools.current?.matches(':popover-open')) {
      event.preventDefault();
      close();
    }
  }

  return { open, trigger, dismiss, tools, show: () => setOpen(true), close, onKeyDown };
}

function RailHead({ name, children, onHome }: { name: string; children: ReactNode; onHome: () => void }) {
  return <div className="rail-head">
    <button type="button" className="rail-home" aria-label={`${name} · Workspace 首頁`} title={`${name} · Workspace 首頁`} onClick={onHome}>
      <img className="rail-logo" src={whippetIcon} width={24} height={24} alt="" />
      <span>{name}</span>
    </button>
    {children}
  </div>;
}

function RailTools({ user, onLogout, panel, children }: { user: DevUser; onLogout: () => void; panel: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return <>
    <button type="button" className="rail-link rail-tools-trigger" popoverTarget="rail-tools">更多功能<ChevronDownIcon /></button>
    <div id="rail-tools" className="rail-tools-panel" role="group" aria-label="更多功能" popover="auto" ref={panel}>
      {children}
      <div className="rail-tools-section rail-tools-account">
        <p className="rail-identity"><span className="sr-only">登入身分 </span>{user.name}{user.role !== 'none' && siteRoleNames[user.role] !== user.name ? ` · ${siteRoleNames[user.role]}` : ''}</p>
        <button type="button" className="rail-link" onClick={onLogout}><LogOutIcon />登出</button>
      </div>
    </div>
  </>;
}

interface BrowserProps extends Pick<AppProps, 'api' | 'apiBase' | 'mock'>, EditingGuard {
  user: DevUser; onLogout: () => void; workspace: WorkspaceDetail; workspaces: WorkspaceDetail[];
  overviewTitle: RefObject<HTMLHeadingElement | null>;
  switchWorkspace: (id: string) => void; openSetup: (create?: boolean) => void;
  surface: Surface; setSurface: (surface: Surface) => void; setupTarget?: string;
  confirmReload: () => boolean;
  administration: ReactNode; onOpenSurface: (surface: NavigationSurface) => void;
  onOpenSiteManagement?: () => void;
  rail: ReturnType<typeof useRailDrawer>;
  onBackgroundCompletion: (batch: BackgroundCompletion[]) => void;
}

function TestBrowser({ workspace, workspaces, overviewTitle, api, apiBase, mock, user, onLogout, switchWorkspace, openSetup, surface, setSurface, setupTarget, onDirtyChange, confirmNavigation, confirmReload, administration, onOpenSurface, onOpenSiteManagement, rail, onBackgroundCompletion }: BrowserProps) {
  const { manageTests, manageSettings, manageMembers } = workspace.permissions;
  const loadTests = useCallback((signal: AbortSignal) => manageTests ? api.listTests(workspace.id, signal) : Promise.resolve([]), [api, workspace.id, manageTests]);
  const tests = useResource(loadTests, true);
  const [selectedId, setSelectedId] = useState<string>();
  const [archivedTest, setArchivedTest] = useState<Test>();
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>();
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
  const [moduleForm, setModuleForm] = useState(false);
  const [moduleInput, setModuleInput] = useState({ slug: '', name: '', description: '' });
  const [createError, setCreateError] = useState<string>();
  const [autoEditId, setAutoEditId] = useState<string>();
  const [similarEdit, setSimilarEdit] = useState<{ testId: string; sessionId: string; content: string }>();
  const [testModes, setTestModes] = useState<Record<string, 'general' | 'editing'>>({});
  const [visibleConversationTestId, setVisibleConversationTestId] = useState<string>();
  const legacyTagsByTest = useLegacyTestTags();
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
  const [overrides, setOverrides] = useState<Record<string, Test | null>>({});
  const allTests = useMemo(() => manageTests ? [...new Map<string, Test | null>([
    ...(tests.data ?? []).map((test) => [test.id, test] as const),
    ...Object.entries(overrides),
  ]).values()].filter((test) => test !== null) : [], [tests.data, overrides, manageTests]);
  const selected = allTests.find((item) => item.id === selectedId);
  const showOverview = surface === 'overview' || (surface === 'tests' && !selected && !tests.loading);
  const workspaceTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of allTests) {
      for (const tag of item.tags ?? legacyTagsByTest[item.id] ?? []) set.add(tag);
    }
    return [...set];
  }, [allTests, legacyTagsByTest]);
  useEffect(() => {
    if (selectedTag && !workspaceTags.includes(selectedTag)) setSelectedTag(undefined);
  }, [selectedTag, workspaceTags]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = allTests.filter((test) => {
    const testTags = test.tags ?? legacyTagsByTest[test.id] ?? [];
    if (selectedTag && !testTags.includes(selectedTag)) return false;
    if (!query) return true;
    const tagSearchText = testTags.map((tag) => `#${tag} ${tag}`).join(' ');
    return `${test.name} ${test.description} ${tagSearchText}`.toLocaleLowerCase().includes(query);
  });
  const updateTest = useCallback((test: Test) => {
    setOverrides((current) => current[test.id] === null ? current : { ...current, [test.id]: test.archived ? null : test });
  }, []);
  const removeTest = useCallback((id: string) => {
    setOverrides((current) => ({ ...current, [id]: null }));
    setSelectedId(undefined);
    setAutoEditId(undefined);
    setSurface('overview');
  }, [setSurface]);
  const onArchive = useCallback((test: Test) => {
    setOverrides((current) => ({ ...current, [test.id]: null }));
    setSelectedId(undefined);
    setAutoEditId(undefined);
    setArchivedTest({ ...test, archived: true });
    setSurface('archive');
  }, [setSurface]);
  const selectedTestId = selected?.id;
  const viewedTestId = surface === 'tests' ? selectedTestId : undefined;
  const viewedAuthorTestId = viewedTestId && (viewedTestId === visibleConversationTestId || !selected?.activeEditingSession) ? viewedTestId : undefined;
  const { activity, running, unread, permission, enableNotifications, runHistory } = useActivity(
    api, workspace.id, allTests, { testId: viewedTestId, authorTestId: viewedAuthorTestId }, user.id, onBackgroundCompletion,
  );
  const reportConversationVisibility = useCallback((visible: boolean) => {
    setVisibleConversationTestId(visible ? selectedTestId : undefined);
  }, [selectedTestId]);
  // Session closure effects depend on this callback; keep its identity stable
  // across Test refreshes so switching to general mode cannot trigger a retry loop.
  const handleModeChange = useCallback((mode: 'general' | 'editing') => {
    if (!selectedTestId) return;
    setTestModes((current) => current[selectedTestId] === mode ? current : { ...current, [selectedTestId]: mode });
  }, [selectedTestId]);

  function openCreatedTest(test: Test, edit = true) {
    setSimilarEdit(undefined);
    setModuleForm(false); setModuleInput({ slug: '', name: '', description: '' });
    updateTest(test); setSelectedId(test.id); setAutoEditId(edit ? test.id : undefined);
    setTestModes((current) => ({ ...current, [test.id]: edit ? 'editing' : 'general' }));
    setSearch(''); setSelectedTag(undefined); setSurface('tests'); rail.close();
  }

  function openSimilarTest(test: Test, content: string) {
    const session = test.activeEditingSession;
    if (!session || test.workspaceId !== workspace.id) throw new ApiError('相似測試不在目前的 Workspace 或編輯週期。', 'INVALID_RESPONSE');
    openCreatedTest(test);
    setSimilarEdit({ testId: test.id, sessionId: session.id, content });
  }

  async function createTest(kind: 'module' | 'usecase' = 'usecase') {
    if (!manageTests || createLock.current || !confirmNavigation()) return;
    createLock.current = true; setCreating(true); setCreateError(undefined);
    const controller = new AbortController(); createController.current = controller;
    try {
      const test = await api.createTest(workspace.id, kind === 'module' ? { kind, ...moduleInput } : { kind }, controller.signal);
      if (controller.signal.aborted) return;
      openCreatedTest(test);
    } catch (cause) { if (!controller.signal.aborted) setCreateError(`${errorMessage(cause)} 若結果不明，請先重新載入列表確認是否已建立，避免重複新增。`); }
    finally { if (!controller.signal.aborted) setCreating(false); createLock.current = false; }
  }
  function pick(test: Test) {
    if (!manageTests) return;
    if (surface === 'tests' && selected?.id === test.id) { rail.close(); return; }
    if (!confirmNavigation()) return;
    setSimilarEdit(undefined);
    const info = activity[test.id];
    const hasActiveConversation = !test.publishedVersionId && Boolean(test.activeEditingSession || info?.running);
    if (hasActiveConversation && info?.running && test.activeEditingSession) {
      setTestModes((current) => ({ ...current, [test.id]: 'editing' }));
    }
    setSelectedId(test.id);
    setAutoEditId(hasActiveConversation && testModes[test.id] !== 'general' ? test.id : undefined);
    setSurface('tests'); rail.close();
  }

  function openRailSurface(next: NavigationSurface) {
    if (next === 'archive') setArchivedTest(undefined);
    onOpenSurface(next);
    rail.close();
  }

  const selectedInfo = selected ? activity[selected.id] : undefined;
  const selectedPreferredMode = selected?.publishedVersionId ? 'general' : selected
    ? (selectedInfo?.running && selected.activeEditingSession
      ? 'editing'
      : testModes[selected.id] ?? (selected.activeEditingSession ? 'editing' : undefined))
    : undefined;
  const shouldInitialEdit = Boolean(
    selected && !selected.publishedVersionId && (
      autoEditId === selected.id ||
      selectedPreferredMode === 'editing' ||
      (selected.activeEditingSession && selectedPreferredMode !== 'general')
    )
  );

  return (
    <div className={`app-shell${rail.open ? ' rail-open' : ''}${railCollapsed ? ' rail-collapsed' : ''}`}>
      {rail.open ? <div className="rail-backdrop" aria-hidden="true" onClick={rail.close} /> : null}
      <nav id="app-rail" className="rail" aria-label="Workspace 與測試" onKeyDown={rail.onKeyDown}>
        <RailHead name={workspace.name} onHome={() => openRailSurface('overview')}>
          <button type="button" className="rail-icon-button small rail-collapse-btn" aria-label="收合左側欄" title="收合左側欄" onClick={() => toggleRailCollapsed(true)}><SidebarIcon /></button>
          <button type="button" ref={rail.dismiss} className="rail-icon-button small rail-mobile-close" aria-label="關閉測試選單" onClick={rail.close}><CloseIcon /></button>
        </RailHead>
        {manageTests ? <>
          <div className="rail-test-controls">
            <h2 id="rail-test-title" className="sr-only">測試案例</h2>
            <div className="rail-filters">
              <label className="search-label"><span className="sr-only">搜尋測試</span>
                <SearchIcon /><input type="search" value={search} placeholder="搜尋測試" onChange={(event) => setSearch(event.target.value)} />
              </label>
              {workspaceTags.length > 0 ? <label className={`rail-tag-select${selectedTag ? ' active' : ''}`} title={selectedTag ? `#${selectedTag}` : '依標籤篩選'}>
                <span className="sr-only">依標籤篩選測試</span>
                <FilterIcon />
                <select value={selectedTag ?? ''} onChange={(event) => setSelectedTag(event.target.value || undefined)}>
                  <option value="">全部標籤</option>
                  {workspaceTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
                </select>
              </label> : null}
              <button type="button" className="rail-link rail-refresh" aria-label="重整測試列表" title="重整測試列表" disabled={tests.loading || creating} onClick={() => { if (confirmNavigation()) tests.retry(); }}><RefreshIcon />重整</button>
            </div>
            {query || selectedTag ? <p className="rail-filter-summary" role="status">{selectedTag ? `#${selectedTag} · ` : ''}{filtered.length}／{allTests.length} 筆</p> : null}
          </div>
          <div className="rail-scroll">
            {createError && !showOverview && surface !== 'catalog' ? <Notice message={createError} /> : null}
            {tests.loading && !tests.data ? <Loading text="正在載入測試…" /> : null}
            {tests.error ? <Notice message={tests.error} retry={tests.retry} /> : null}
            {tests.data && allTests.length === 0 ? <p className="rail-empty">還沒有測試。按「新增測試」，用一句話開始。</p> : null}
            {allTests.length > 0 && filtered.length === 0 ? <p className="rail-empty">找不到符合的測試。</p> : null}
            <ul className="test-list" aria-labelledby="rail-test-title">
              {filtered.map((test) => {
                const info = activity[test.id];
                const isSelected = surface === 'tests' && selected?.id === test.id;
                return <li key={test.id}>
                  <button type="button" className={`test-item${isSelected ? ' selected' : ''}${info?.running ? ' running' : ''}${info?.unread ? ' unread' : ''}`} disabled={creating} aria-current={isSelected ? 'true' : undefined} onClick={() => pick(test)}>
                    <span className="test-name"><span title={test.name}>{test.name}</span>
                      {info?.unreadAuthor ? <span className="case-result-bell" role="img" aria-label={`${info.unreadAuthor}，尚未查看`} title={`${info.unreadAuthor}，尚未查看`}><BellIcon /></span>
                        : info?.unread ? <span className="unread-light" role="img" aria-label="有新的結果" /> : null}
                    </span>
                    <span className="test-meta">
                      <span className={`test-state${info?.bad ? ' bad' : ''}`}>{info?.label ?? (test.publishedVersionId ? '已發佈' : '尚未發佈')}</span>
                      {info?.stages.length ? <MiniTrail stages={info.stages} bad={info.bad} /> : null}
                    </span>
                  </button>
                </li>;
              })}
            </ul>
          </div>
        </> : null}
        <div className="rail-foot">
          <RailTools user={user} onLogout={onLogout} panel={rail.tools}>
            <div className="rail-tools-section rail-workspace-switch" role="group" aria-label="切換 Workspace">
              <p>切換 Workspace</p>
              <ul>{workspaces.map((item) => <li key={item.id}>
                <button type="button" className="rail-link wide rail-workspace-option" aria-current={item.id === workspace.id ? 'true' : undefined} title={item.name} onClick={() => switchWorkspace(item.id)}>
                  <span>{item.name}</span>{item.id === workspace.id ? <CheckIcon /> : null}
                </button>
              </li>)}</ul>
            </div>
            {manageTests ? <div className="rail-tools-section" role="group" aria-label="測試資產">
              <button type="button" className="rail-link wide" aria-current={surface === 'catalog' ? 'page' : undefined} onClick={() => openRailSurface('catalog')}><BookIcon />Module 模組庫</button>
              <button type="button" className="rail-link wide" aria-current={surface === 'archive' ? 'page' : undefined} onClick={() => openRailSurface('archive')}><ArchiveIcon />已封存測試</button>
              <a className="rail-link wide rail-tools-text-link" href="?preview=m10" onClick={(event) => { if (!confirmNavigation()) event.preventDefault(); }}>Module / Use Case 合成預覽</a>
            </div> : null}
            {manageSettings || manageMembers || onOpenSiteManagement || user.permissions.createWorkspace ? <div className="rail-tools-section" role="group" aria-label="管理">
              {manageSettings ? <button type="button" className="rail-link wide" aria-current={surface === 'settings' && setupTarget !== 'create' ? 'page' : undefined} onClick={() => { openSetup(); rail.close(); }}><GearIcon />Workspace 設定</button> : null}
              {manageMembers ? <button type="button" className="rail-link wide" aria-current={surface === 'members' ? 'page' : undefined} onClick={() => openRailSurface('members')}><UsersIcon />Workspace 成員管理</button> : null}
              {onOpenSiteManagement ? <button type="button" className="rail-link wide" onClick={onOpenSiteManagement}><UsersIcon />全站管理</button> : null}
              {user.permissions.createWorkspace ? <button type="button" className="rail-link wide" onClick={() => { openSetup(true); rail.close(); }}><PlusIcon />建立 Workspace</button> : null}
            </div> : null}
            {permission === 'default' || permission === 'granted' ? <div className="rail-tools-section">
              {permission === 'default' ? <button type="button" className="rail-link wide" onClick={() => { void enableNotifications(); }}><BellIcon />啟用瀏覽器通知</button>
                : <p className="rail-note"><BellIcon />瀏覽器通知已開啟</p>}
            </div> : null}
          </RailTools>
          <p className="rail-activity" aria-live="polite">
            {running ? <span>{running} 項進行中</span> : null}
            {unread ? <span className="rail-new-results">{unread} 項新結果</span> : null}
          </p>
          {manageTests ? <button type="button" className="button rail-primary" disabled={creating} onClick={() => { void createTest(); }}><PlusIcon />{creating ? '建立中…' : '新增測試'}</button> : null}
        </div>
      </nav>
      <main id="main" className="main-pane" tabIndex={-1} inert={rail.open}>
        <div className="mobile-bar">
          <button type="button" ref={rail.trigger} className="button quiet compact" aria-expanded={rail.open} aria-controls="app-rail" onClick={rail.show}><MenuIcon />測試列表{unread ? <span className="unread-light inline" aria-label={`${unread} 項新結果`} /> : null}</button>
          <button type="button" className="mobile-workspace" aria-label={`${workspace.name} · Workspace 首頁`} title={workspace.name} onClick={() => openRailSurface('overview')}>{workspace.name}</button>
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
        {administration}
        {showOverview ? <WorkspaceOverview
          workspace={workspace}
          titleRef={overviewTitle}
          tests={allTests}
          testsLoading={tests.loading}
          testsError={tests.error}
          onRefreshTests={tests.retry}
          runHistory={runHistory}
          apiBase={apiBase}
          creating={creating}
          createError={createError}
          onCreate={manageTests ? () => { void createTest(); } : undefined}
          onSettings={manageSettings ? () => openSetup() : undefined}
          onOpenTest={pick}
        /> : null}
        {manageTests && surface === 'catalog' ? <SurfaceBoundary loadingText="正在開啟 Module 模組庫…" confirmReload={confirmReload}>
          <ModuleCatalog api={api} workspaceId={workspace.id}>
            <button className="button secondary" disabled={creating} aria-expanded={moduleForm} onClick={() => setModuleForm(value => !value)}>手動建立模組</button>
            {moduleForm ? <form className="module-create" onSubmit={event => { event.preventDefault(); void createTest('module'); }}>
              <p>建立真實 Module 草稿，尚未驗證或發佈。</p>
              <label htmlFor="new-module-slug">slug（不可修改）</label>
              <input id="new-module-slug" required pattern="[a-z][a-z0-9\-]{0,63}" maxLength={64} value={moduleInput.slug} disabled={creating} onChange={event => setModuleInput({ ...moduleInput, slug: event.target.value })} />
              <label htmlFor="new-module-name">名稱</label>
              <input id="new-module-name" required value={moduleInput.name} disabled={creating} onChange={event => setModuleInput({ ...moduleInput, name: event.target.value })} />
              <label htmlFor="new-module-description">說明</label>
              <textarea id="new-module-description" value={moduleInput.description} disabled={creating} onChange={event => setModuleInput({ ...moduleInput, description: event.target.value })} />
              <p>slug 使用小寫英文字母開頭，可含數字與連字號，Workspace 內不可重複。</p>
              <button className="button secondary" disabled={creating || !moduleInput.name.trim()} type="submit">{creating ? '建立中…' : '建立 Module 草稿'}</button>
              <button className="button secondary" disabled={creating} type="button" onClick={() => setModuleForm(false)}>取消</button>
            </form> : null}
            {createError ? <Notice message={createError} /> : null}
          </ModuleCatalog>
        </SurfaceBoundary> : null}
        {manageTests && surface === 'archive' ? <SurfaceBoundary key={archivedTest?.id} loadingText="正在開啟已封存測試…" confirmReload={confirmReload}>
          {archivedTest ? <ArchivedTestDetail api={api} apiBase={apiBase} archivedTest={archivedTest} onReturn={() => setArchivedTest(undefined)} />
            : <ArchivedTests api={api} workspace={workspace} onOpenTest={setArchivedTest} />}
        </SurfaceBoundary> : null}
        {manageTests && surface === 'tests' && selected ? <TestWorkspace
              key={selected.id}
              testId={selected.id}
              api={api}
              apiBase={apiBase}
              onDirtyChange={reportEditorGuard}
              confirmReload={confirmReload}
              onTestUpdated={updateTest}
              onTestRemoved={removeTest}
              onArchived={onArchive}
              onTestCreated={(test) => openCreatedTest(test, Boolean(test.activeEditingSession))}
              onEditSimilarTest={openSimilarTest}
              settingsRefresh={0}
              initialEditing={shouldInitialEdit}
              editHandoff={similarEdit?.testId === selected.id ? similarEdit : undefined}
              preferredMode={selectedPreferredMode}
              onModeChange={handleModeChange}
              onConversationVisibilityChange={reportConversationVisibility}
              unreadAuthor={selectedInfo?.unreadAuthor}
              railCollapsed={railCollapsed}
              onExpandRail={() => toggleRailCollapsed(false)}
              unreadCount={unread}
              tags={selected.tags ?? legacyTagsByTest[selected.id] ?? []}
              workspaceTags={workspaceTags}
              capabilities={workspace.capabilities}
              authorEngine={workspace.authorEngine}
            /> : null}
      </main>
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2><p>{text}</p>{action}</div>;
}
