import type { SiteRole, WorkspaceMemberRole } from './types';

export const DEV_IDENTITIES = [
  { id: 'dev-admin', name: 'Super Admin' },
  { id: 'dev-site-admin', name: 'Site Admin' },
  { id: 'dev-workspace-admin', name: 'Workspace Admin' },
  { id: 'dev-qa', name: 'QA User' },
] as const;
export const DEFAULT_DEV_USER = 'dev-qa';

export const siteRoleNames: Record<SiteRole, string> = {
  superadmin: 'Super Admin',
  site_admin: 'Site Admin',
  none: '無全站角色',
};

export const workspaceMemberRoleNames: Record<WorkspaceMemberRole, string> = {
  workspace_admin: 'Workspace Admin',
  qa: 'QA／RD',
  none: '未加入',
};
