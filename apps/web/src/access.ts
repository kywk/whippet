import type { SiteRole, WorkspaceMemberRole } from './types';

export const DEV_IDENTITIES: readonly { id: string; name: string }[] = [
  { id: 'dev-admin', name: 'Super Admin' },
  { id: 'dev-site-admin', name: 'Site Manager' },
  { id: 'dev-workspace-admin', name: 'Workspace Admin' },
  { id: 'dev-qa', name: 'QA User' },
];
export const DEFAULT_DEV_USER = 'dev-qa';

export const siteRoleNames: Record<SiteRole, string> = {
  superadmin: 'Super Admin',
  site_admin: 'Site Manager',
  none: '無全站角色',
};

export const workspaceMemberRoleNames: Record<WorkspaceMemberRole, string> = {
  workspace_admin: 'Workspace Admin',
  qa: 'Workspace User',
  none: '未加入',
};

export type AiManagementRoute = { view: 'resources' | 'agents' | 'create' }
  | { view: 'resource' | 'agent'; id: string }
  | { view: 'routing'; workspaceId?: string };
export type SiteManagementRoute = { page: 'workspaces' | 'create' | 'roles' }
  | { page: 'workspace' | 'members'; workspaceId: string }
  | { page: 'ai'; route: AiManagementRoute };

export function readSiteManagementRoute(): SiteManagementRoute | undefined {
  const params = new URLSearchParams(window.location.search);
  const page = params.get('admin');
  if (page === 'ai') {
    const view = params.get('view');
    if (view === 'agent' || view === 'resource') return { page, route: { view, id: params.get('id') ?? '' } };
    if (view === 'routing') return { page, route: { view, workspaceId: params.get('workspace') ?? undefined } };
    return { page, route: { view: view === 'agents' || view === 'create' ? view : 'resources' } };
  }
  if (page === 'workspace' || page === 'members') return { page, workspaceId: params.get('workspace') ?? '' };
  if (page === 'workspaces' || page === 'create' || page === 'roles') return { page };
}

export function siteManagementHref(route?: SiteManagementRoute): string {
  if (!route) return window.location.pathname;
  const params = new URLSearchParams({ admin: route.page });
  if ('workspaceId' in route) params.set('workspace', route.workspaceId);
  if (route.page === 'ai') {
    const ai = route.route;
    if (ai.view !== 'resources') params.set('view', ai.view);
    if ('id' in ai) params.set('id', ai.id);
    if (ai.view === 'routing' && ai.workspaceId) params.set('workspace', ai.workspaceId);
  }
  return `?${params}`;
}
