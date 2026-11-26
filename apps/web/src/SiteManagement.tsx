import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { siteManagementHref } from './access';
import type { SiteManagementRoute } from './access';
import { Loading, Notice } from './components';
import { useResource } from './hooks';
import { LogOutIcon, PlusIcon, RefreshIcon } from './icons';
import { SiteWorkspaceDetail } from './SiteWorkspaceDetail';
import { SiteUsers, WorkspaceMembers } from './UserAccess';
import { WorkspaceNameForm } from './WorkspaceNameForm';
import type { DevUser, ManagedWorkspaceApi, WhippetApi, WorkspaceDetail, WorkspaceManagementState } from './types';
import './access.css';

interface Props {
  api: WhippetApi;
  user: DevUser;
  mock: boolean;
  route: SiteManagementRoute;
  onNavigate: (next?: SiteManagementRoute) => void;
  onLogout: () => void;
  onCreated: (workspace: WorkspaceDetail) => void;
  onAccessChanged: (user?: DevUser) => void;
  onOpenWorkspace: (id: string) => void;
}

const workspaceListRoute = { page: 'workspaces' } as const;
const rolesRoute = { page: 'roles' } as const;

function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  navigate();
}

export function SiteManagement({ api, user, mock, route, onNavigate, onLogout, onCreated, onAccessChanged, onOpenWorkspace }: Props) {
  const { manageSiteWorkspaces: workspaceAccess, manageSiteRoles: rolesAccess } = user.permissions;
  const adminApi = api.adminWorkspaces;
  const allowed = route.page === 'roles' ? rolesAccess : workspaceAccess && (route.page !== 'create' || user.permissions.createWorkspace);
  let content: ReactNode;

  if (!allowed) {
    content = <section className="access-view"><ManagementHeading>無法開啟管理頁面</ManagementHeading>
      <Notice message={route.page === 'roles' ? '全站角色由 Super Admin 管理。'
        : route.page === 'create' && workspaceAccess ? '目前登入的身分無法建立 Workspace。' : '目前登入的身分沒有全站 Workspace 管理權限。'} />
    </section>;
  } else if (route.page === 'roles') {
    content = <SiteUsers api={api} user={user} onAccessChanged={onAccessChanged} />;
  } else if (!adminApi) {
    content = <section className="access-view"><ManagementHeading>Workspace 管理</ManagementHeading>
      <Notice message="目前無法連線至 Workspace 管理介面。" />
    </section>;
  } else if (route.page === 'create') {
    content = <section className="access-view">
      <ManagementHeading>建立 Workspace</ManagementHeading>
      <p>建立後可指派成員，再到 Workspace 設定確認驗測範圍。</p>
      <WorkspaceNameForm action="create" onCancel={() => onNavigate(workspaceListRoute)} onAccessChanged={onAccessChanged} onSave={async (name, signal) => {
        const created = await api.createWorkspace(name, signal);
        if (signal.aborted) return;
        onCreated(created);
        onNavigate({ page: 'members', workspaceId: created.id });
      }} />
    </section>;
  } else if (route.page === 'workspace') {
    const { workspaceId } = route;
    content = workspaceId ? <SiteWorkspaceDetail key={workspaceId} api={adminApi} workspaceId={workspaceId}
      onMembers={() => onNavigate({ page: 'members', workspaceId })} onOpenWorkspace={() => onOpenWorkspace(workspaceId)}
      onAccessChanged={onAccessChanged} /> : <section className="access-view"><ManagementHeading>Workspace 詳情</ManagementHeading>
      <Notice message="找不到此 Workspace。" />
    </section>;
  } else if (route.page === 'members') {
    const { workspaceId } = route;
    content = <SiteWorkspaceMembers key={workspaceId} api={api} adminApi={adminApi} workspaceId={workspaceId} userId={user.id}
      onNavigate={onNavigate} onAccessChanged={onAccessChanged} />;
  } else {
    content = <SiteWorkspaceList api={adminApi} canCreate={user.permissions.createWorkspace} onNavigate={onNavigate} />;
  }

  return <>
    <header className="site-management-bar">
      <div className="site-management-bar-inner">
        <strong>全站管理</strong>
        <div className="site-management-account">
          <a href={siteManagementHref()} onClick={(event) => followLink(event, () => onNavigate())}>返回測試工作台</a>
          <button type="button" className="rail-link" onClick={onLogout}><LogOutIcon />登出</button>
        </div>
      </div>
    </header>
    {mock ? <div className="mock-banner" role="status">示範模式：使用本機 mock 資料，重新整理後資料會清除。</div> : null}
    {workspaceAccess || rolesAccess ? <nav aria-label="全站管理導覽" className="site-management-nav">
      {workspaceAccess ? <a href={siteManagementHref(workspaceListRoute)} aria-current={route.page === 'workspaces' ? 'page' : undefined}
        className={route.page !== 'roles' ? 'current' : undefined} onClick={(event) => followLink(event, () => onNavigate(workspaceListRoute))}>Workspace 管理</a> : null}
      {rolesAccess ? <a href={siteManagementHref(rolesRoute)} aria-current={route.page === 'roles' ? 'page' : undefined}
        className={route.page === 'roles' ? 'current' : undefined} onClick={(event) => followLink(event, () => onNavigate(rolesRoute))}>全站角色</a> : null}
    </nav> : null}
    {content}
  </>;
}

function ManagementHeading({ children }: { children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [children]);
  return <h1 ref={heading} tabIndex={-1}>{children}</h1>;
}

const stateLabels = { all: '所有狀態', active: '使用中', archiving: '封存中', archived: '已封存' } satisfies Record<'all' | WorkspaceManagementState, string>;

function SiteWorkspaceList({ api, canCreate, onNavigate }: Pick<Props, 'onNavigate'> & {
  api: ManagedWorkspaceApi;
  canCreate: boolean;
}) {
  const createRoute = { page: 'create' } as const;
  const stateFilterId = useId();
  const [filter, setFilter] = useState<keyof typeof stateLabels>('all');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const after = cursors.at(-1) ?? null;
  const load = useCallback(async (signal: AbortSignal) => ({ ...await api.list(filter, after, signal), filter, after }), [api, filter, after]);
  const directory = useResource(load);
  const page = directory.data?.filter === filter && directory.data.after === after ? directory.data : undefined;
  const list = page?.items;
  const { error, retry } = directory;
  const loading = directory.loading || (!page && !error);
  const nextAfter = page?.nextAfter;

  return <section className="access-view">
    <header className="access-view-header">
      <ManagementHeading>Workspace 管理</ManagementHeading>
      <div className="action-row site-workspace-actions">
        <button type="button" className="button secondary" disabled={loading} onClick={retry}><RefreshIcon />重新載入</button>
        {canCreate ? <a className="button primary" href={siteManagementHref(createRoute)} onClick={(event) => followLink(event, () => onNavigate(createRoute))}><PlusIcon />建立 Workspace</a> : null}
      </div>
    </header>
    <div className="settings-field access-search">
      <label htmlFor={stateFilterId}>Workspace 狀態</label>
      <select id={stateFilterId} className="text-input" value={filter} onChange={(event) => {
        setFilter(event.target.value as keyof typeof stateLabels);
        setCursors([null]);
      }}>
        {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    {error ? <Notice message={error} retry={retry} /> : null}
    {loading && !list ? <Loading text="正在載入 Workspace…" /> : null}
    {list?.length ? <ul className="access-list">
      {list.map((workspace) => {
        const workspaceRoute = { page: 'workspace', workspaceId: workspace.id } as const;
        const membersRoute = { page: 'members', workspaceId: workspace.id } as const;
        const state = workspace.management.state;
        return <li key={workspace.id}>
          <div className="access-person">
            <div className="access-person-label"><strong>{workspace.name}</strong><span className="identifier muted">{workspace.id}</span></div>
            <span className={`chip ${state === 'archiving' ? 'warm' : state === 'archived' ? 'neutral' : 'ok'}`}>
              {stateLabels[state]}
            </span>
            {state === 'active' && workspace.lifecycle !== 'active' ? <span className="muted">{workspace.lifecycle === 'draft' ? '尚待設定' : '待確認'}</span> : null}
          </div>
          <div className="action-row site-workspace-actions">
            <a className="button secondary" href={siteManagementHref(workspaceRoute)}
              aria-label={`查看詳情（${workspace.name}）`} onClick={(event) => followLink(event, () => onNavigate(workspaceRoute))}>查看詳情</a>
            {workspace.permissions.manageMembers ? <a className="button secondary" href={siteManagementHref(membersRoute)}
              aria-label={`管理成員（${workspace.name}）`} onClick={(event) => followLink(event, () => onNavigate(membersRoute))}>管理成員</a> : null}
          </div>
        </li>;
      })}
    </ul> : list ? <p className="muted" role="status">{filter === 'all' ? '尚無 Workspace。' : '沒有符合目前狀態的 Workspace。'}</p> : null}
    {cursors.length > 1 || nextAfter ? <div className="action-row site-workspace-actions site-workspace-pagination">
      <button type="button" className="button secondary" disabled={loading || cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>上一頁</button>
      <span className="muted" role="status">第 {cursors.length} 頁</span>
      <button type="button" className="button secondary" disabled={loading || !nextAfter} onClick={() => {
        if (nextAfter && nextAfter !== after) setCursors((current) => [...current, nextAfter]);
      }}>下一頁</button>
    </div> : null}
  </section>;
}

function SiteWorkspaceMembers({ api, adminApi, workspaceId, userId, onNavigate, onAccessChanged }: Pick<Props, 'api' | 'onNavigate' | 'onAccessChanged'> & {
  adminApi: ManagedWorkspaceApi;
  workspaceId: string;
  userId: string;
}) {
  const load = useCallback(async (signal: AbortSignal) => workspaceId ? (await adminApi.get(workspaceId, signal)).workspace : undefined, [adminApi, workspaceId]);
  const detail = useResource(load);
  const { data: workspace, error, loading, retry } = detail;
  const detailRoute = { page: 'workspace', workspaceId } as const;

  return workspace?.permissions.manageMembers ? <>
    <div className="site-management-breadcrumb"><a href={siteManagementHref(detailRoute)} onClick={(event) => followLink(event, () => onNavigate(detailRoute))}>返回 Workspace 詳情</a></div>
    <WorkspaceMembers api={api} workspace={workspace} userId={userId} onAccessChanged={onAccessChanged} />
  </> : <section className="access-view"><ManagementHeading>Workspace 成員管理</ManagementHeading>
    {error ? <Notice message={error} retry={retry} />
      : loading ? <Loading text="正在載入 Workspace…" />
      : <Notice message="找不到此 Workspace，或目前登入的身分沒有成員管理權限。" />}
  </section>;
}
