import type { ReactNode } from 'react';
import type { AiManagementRoute } from './access';
import { AiAgentCreate } from './AiAgentCreate';
import { AiAgentDetail, AiAgents } from './AiAgents';
import { AiHeading, AiLink } from './AiManagerUI';
import type { AiNavigate, AiWorkspaceDirectory } from './AiManagerUI';
import { AiResourceDetail, AiResources } from './AiResources';
import { AiRouting } from './AiRouting';
import type { AiAdminApi } from './aiAdminTypes';
import { Notice } from './components';
import { GearIcon, PanelIcon, ScriptIcon } from './icons';
import './ai-manager.css';

const sections = [
  { view: 'resources', label: '執行資源', icon: PanelIcon },
  { view: 'agents', label: 'Agent 清單', icon: ScriptIcon },
  { view: 'routing', label: 'Workspace 選用', icon: GearIcon },
] as const;

export function AiManager({ api, apiBase, route, workspaces, onNavigate, onAccessChanged }: {
  api: AiAdminApi; apiBase: string; route: AiManagementRoute; workspaces: AiWorkspaceDirectory; onNavigate: AiNavigate; onAccessChanged: () => void;
}) {
  let content: ReactNode;
  const listProps = { api, workspaces, onNavigate };
  const detailProps = { ...listProps, apiBase, onAccessChanged };
  switch (route.view) {
    case 'resources': content = <AiResources {...listProps} />; break;
    case 'agents': content = <AiAgents {...listProps} />; break;
    case 'create': content = <AiAgentCreate {...detailProps} />; break;
    case 'routing': content = <AiRouting {...listProps} workspaceId={route.workspaceId} onAccessChanged={onAccessChanged} />; break;
    case 'resource': content = route.id ? <AiResourceDetail key={route.id} {...detailProps} id={route.id} /> : <AiMissingResource />; break;
    case 'agent': content = route.id ? <AiAgentDetail key={route.id} {...detailProps} id={route.id} /> : <AiMissingResource />; break;
  }
  const active = route.view === 'resource' ? 'resources' : route.view === 'create' || route.view === 'agent' ? 'agents' : route.view;
  return <section className="access-view ai-view" aria-labelledby="ai-manager-title">
    <h1 id="ai-manager-title">AI Manager</h1>
    <nav className="ai-navigation" aria-label="AI Manager 導覽">
      {sections.map(({ view, label, icon: Icon }) => (
        <AiLink key={view} className="ai-section-link" route={{ view }} onNavigate={onNavigate}
          aria-current={active === view ? (route.view === view ? 'page' : 'location') : undefined}>
          <Icon /><span>{label}</span>
        </AiLink>
      ))}
    </nav>
    <div className="ai-stack">{content}</div>
  </section>;
}

function AiMissingResource() {
  return <><AiHeading title="找不到資源" /><Notice message="連結缺少資源識別。請從管理清單重新選擇。" /></>;
}
