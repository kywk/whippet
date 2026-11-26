import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { siteRoleNames, workspaceMemberRoleNames } from './access';
import { ApiError, errorMessage } from './api';
import { Loading, Notice } from './components';
import { RefreshIcon } from './icons';
import { SITE_ROLES, WORKSPACE_MEMBER_ROLES } from './types';
import type { DevUser, WhippetApi, WorkspaceDetail } from './types';
import { useResource } from './hooks';
import './access.css';
import './management-directory.css';

type RoleEntry<Role extends string> = { id: string; name: string; role: Role };

export function SiteUsers({ api, user, onAccessChanged }: { api: WhippetApi; user: DevUser; onAccessChanged: (user?: DevUser) => void }) {
  async function save(id: string, role: DevUser['role'], signal: AbortSignal) {
    const updated = await api.updateUserRole(id, role, signal);
    if (!signal.aborted && id === user.id) onAccessChanged(updated);
    return updated;
  }
  return <RoleDirectory title="全站角色管理" scope="全站角色" roleNames={siteRoleNames} roles={SITE_ROLES} currentUserId={user.id}
    load={api.listUsers} save={save} onAccessChanged={onAccessChanged} />;
}

export function WorkspaceMembers({ api, workspace, userId, onAccessChanged }: { api: WhippetApi; workspace: Pick<WorkspaceDetail, 'id' | 'name' | 'permissions'>; userId: string; onAccessChanged: () => void }) {
  const load = useCallback((signal: AbortSignal) => api.listMembers(workspace.id, signal), [api, workspace.id]);
  const roles = workspace.permissions.manageWorkspaceAdmins ? WORKSPACE_MEMBER_ROLES : WORKSPACE_MEMBER_ROLES.filter((role) => role !== 'workspace_admin');
  return <RoleDirectory title="Workspace 成員管理" subtitle={workspace.name} scope="Workspace 角色" roleNames={workspaceMemberRoleNames} roles={roles}
    currentUserId={userId} load={load} save={(id, role, signal) => api.updateMember(workspace.id, id, role, signal)} onAccessChanged={onAccessChanged} />;
}

interface DirectoryProps<Role extends string> {
  title: string;
  subtitle?: string;
  scope: string;
  roleNames: Record<Role, string>;
  roles: readonly Role[];
  currentUserId: string;
  load: (signal: AbortSignal) => Promise<RoleEntry<Role>[]>;
  save: (id: string, role: Role, signal: AbortSignal) => Promise<RoleEntry<Role>>;
  onAccessChanged: () => void;
}

function RoleDirectory<Role extends string>({ title, subtitle, scope, roleNames, roles, currentUserId, load, save, onAccessChanged }: DirectoryProps<Role>) {
  const directory = useResource(load, true);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchId = useId();
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [note, setNote] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const entries = directory.data?.filter((entry) =>
    (!filterRole || entry.role === filterRole) &&
    (entry.name.toLocaleLowerCase().includes(query) || entry.id.toLocaleLowerCase().includes(query)));
  useEffect(() => { heading.current?.focus(); }, []);

  function handleSave(entry: RoleEntry<Role>) {
    directory.updateData((current) => current?.map((row) => row.id === entry.id ? entry : row));
    directory.retry();
    setNote(`已儲存 ${entry.name} 的角色（${roleNames[entry.role]}）。`);
    onAccessChanged();
  }

  return <section className="access-view role-directory" aria-labelledby="access-title">
    <header className="access-view-header">
      <div><h1 id="access-title" ref={heading} tabIndex={-1}>{title}</h1>{subtitle ? <p className="access-subtitle muted">{subtitle}</p> : null}</div>
      <button type="button" className="button secondary compact" disabled={directory.loading} onClick={() => { setNote(''); directory.retry(); }}>
        <RefreshIcon />重新載入
      </button>
    </header>
    {directory.error ? <Notice message={directory.error} retry={directory.retry} /> : null}
    {directory.loading && !directory.data ? <Loading text="正在載入角色…" /> : null}
    {entries ? <>
      <div className="directory-tools">
        <div className="settings-field access-search">
          <label htmlFor={searchId}>搜尋帳號</label>
          <input id={searchId} type="search" className="text-input" placeholder="輸入名稱或帳號" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <label className="settings-field">篩選角色
          <select className="text-input" value={filterRole} onChange={(event) => setFilterRole(event.target.value)}>
            <option value="">全部角色</option>
            {(Object.keys(roleNames) as Role[]).map((role) => <option key={role} value={role}>{roleNames[role]}</option>)}
          </select>
        </label>
        <span role="status" className="directory-count">{entries.length} 個帳號</span>
      </div>
      {entries.length ? <ul className="access-list">
        {entries.map((entry) => <li key={entry.id}>
          <div className="access-person">
            <span className="directory-avatar" aria-hidden="true">{Array.from(entry.name.trim() || entry.id)[0]}</span>
            <div className="access-person-label"><strong>{entry.name}</strong><span className="identifier muted">{entry.id}</span></div>
            <span className="chip neutral"><span className="sr-only">目前角色 </span>{roleNames[entry.role]}</span>
            {entry.id === currentUserId ? <span className="chip neutral">目前登入</span> : null}
          </div>
          {roles.includes(entry.role) ? <RoleForm entry={entry} scope={scope} roleNames={roleNames} roles={roles} save={save}
            onSaving={() => setNote('')} onSaved={handleSave} onPermissionChanged={onAccessChanged} /> : null}
        </li>)}
      </ul> : <p className="muted" role="status">{query || filterRole ? '找不到符合的帳號，請調整搜尋條件或角色。' : '目前沒有可管理的帳號。'}</p>}
    </> : null}
    <p className="access-note" role="status">{note}</p>
  </section>;
}

function RoleForm<Role extends string>({ entry, scope, roleNames, roles, save, onSaving, onSaved, onPermissionChanged }: {
  entry: RoleEntry<Role>;
  scope: string;
  roleNames: Record<Role, string>;
  roles: readonly Role[];
  save: DirectoryProps<Role>['save'];
  onSaving: () => void;
  onSaved: (entry: RoleEntry<Role>) => void;
  onPermissionChanged: () => void;
}) {
  const labelId = useId();
  const [selection, setSelection] = useState<{ current: Role; next: Role }>();
  const selectedRole = selection?.current === entry.role ? selection.next : entry.role;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function submit() {
    if (selectedRole === entry.role || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    onSaving();
    try {
      const updated = await save(entry.id, selectedRole, controller.signal);
      if (!controller.signal.aborted) {
        setSelection(undefined);
        onSaved(updated);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof ApiError && cause.code === 'last_super_admin' ? '至少需要保留一位 Super Admin。' : errorMessage(cause));
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onPermissionChanged();
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <form className="access-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label htmlFor={labelId} className="settings-field">{scope}<span className="sr-only">（{entry.name}）</span></label>
    <select id={labelId} className="text-input" value={selectedRole} disabled={busy} onChange={(event) => setSelection({ current: entry.role, next: event.target.value as Role })}>
      {roles.map((role) => <option key={role} value={role}>{roleNames[role]}</option>)}
    </select>
    <button type="submit" className={`button ${selectedRole === entry.role ? 'secondary' : 'primary'} compact`} disabled={busy || selectedRole === entry.role} aria-label={busy ? `正在儲存 ${entry.name} 的角色` : `儲存 ${entry.name} 的角色`}>
      {busy ? '儲存中…' : '儲存'}
    </button>
    {error ? <Notice message={error} /> : null}
  </form>;
}
