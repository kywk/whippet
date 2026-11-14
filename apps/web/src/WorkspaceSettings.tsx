import { capabilityReason } from './capabilities';
import type { WorkspaceCapability, WorkspaceConfig, WorkspaceDetail } from './types';

export function CapabilityStatus({ label, capability }: { label: string; capability: WorkspaceCapability | undefined }) {
  return <p className="capability-state"><strong>{label}：{capability ? capability.available ? '可用' : '尚未就緒' : '未知'}</strong><span className="inline-hint">{capabilityReason(capability)}</span></p>;
}

export function WorkspaceAvailability({ workspace }: { workspace: WorkspaceDetail }) {
  return <section className="workspace-capability" aria-label="Workspace 能力狀態">
    <h3>Workspace 能力</h3>
    <CapabilityStatus label="AI 探索" capability={workspace.capabilities?.aiExploration} />
    <CapabilityStatus label="AI 腳本執行" capability={workspace.capabilities?.aiExecution} />
    <CapabilityStatus label="工程師腳本執行" capability={workspace.capabilities?.manualExecution} />
    <CapabilityStatus label="角色登入" capability={workspace.capabilities?.credentialLogin} />
    <p className="inline-hint">能力由 Server 回報，各次任務仍須核對來源、快照與角色。訪談與離線改稿不需要 AI 探索可用。</p>
    {workspace.scopeStatus === 'revoking' ? <p className="blocked-hint">許可正在撤回，尚未確認所有既有任務已停止。</p> : null}
  </section>;
}

export function WorkspaceConfigView({ config }: { config: WorkspaceConfig }) {
  return <div className="workspace-config-view">
    <dl className="workspace-snapshot-meta"><div><dt>名稱</dt><dd>{config.name}</dd></div><div><dt>驗測目的</dt><dd>{config.purpose || '尚未提供'}</dd></div><div><dt>非機密背景</dt><dd>{config.backgroundSummary || '尚未提供'}</dd></div></dl>
    <h4>目標網站</h4>{config.targets.length ? <ul className="workspace-snapshot-sites">{config.targets.map((site) => <li key={site.origin}><strong>{site.name}</strong><p>{site.origin}</p><p>用途：{site.purpose || '尚未提供'}</p></li>)}</ul> : <p className="muted">尚無目標網站。</p>}
    <h4>必要相依服務</h4>{config.dependencies.length ? <ul className="workspace-snapshot-sites">{config.dependencies.map((site) => <li key={site.origin}><strong>{site.name}</strong><p>{site.origin}</p><p>用途：{({ login: '登入', api: 'API', cdn: 'CDN' })[site.purpose]}</p></li>)}</ul> : <p className="muted">未列相依服務。</p>}
    <h4>排除範圍</h4><p className="summary-content">{config.excludedOrigins.length ? config.excludedOrigins.join('\n') : '未列排除 origin。'}</p><p className="summary-content">{config.exclusions || '未提供其他排除說明。'}</p><p className="inline-hint">文字排除事項提供背景，不代表能以自然語言強制隔離。</p>
    <h4>登入角色定義</h4>{config.loginRoles.length ? <ul className="workspace-snapshot-sites">{config.loginRoles.map((role, index) => <li key={role.roleId ?? index}><strong>{role.name}</strong><p>表單登入 · {role.loginOrigin}</p><p className="inline-hint">角色：{role.roleId ?? '待 Server 分配'}</p></li>)}</ul> : <p className="muted">未列登入角色。</p>}
    <dl className="workspace-snapshot-meta"><div><dt>預設 URL</dt><dd>{config.defaultTestUrl || '未設定'}</dd></div><div><dt>執行逾時</dt><dd>{config.timeoutMs.toLocaleString('zh-TW')} 毫秒</dd></div></dl>
  </div>;
}

export function WorkspaceSettings({ workspace }: { workspace: WorkspaceDetail }) {
  return <section className="workspace-snapshot" aria-labelledby="workspace-snapshot-title">
    <h3 id="workspace-snapshot-title">目前正式設定（唯讀）</h3>
    <p className="settings-meta">{workspace.name} · revision {workspace.revision} · {({ draft: '建立中', needs_confirmation: '舊資料待確認', active: '已啟用' })[workspace.lifecycle]}</p>
    {workspace.settings ? <WorkspaceConfigView config={workspace.settings} /> : <>
      <p className="inline-hint">尚無已確認設定。以下為既有設定快照；網站清單不代表已授權範圍，也不自動分類為目標或相依服務。</p>
      <dl className="workspace-snapshot-meta"><div><dt>預設 URL</dt><dd>{workspace.defaultTestUrl || '未設定'}</dd></div><div><dt>執行逾時</dt><dd>{workspace.timeoutMs.toLocaleString('zh-TW')} 毫秒</dd></div></dl>
      {workspace.sites.length ? <ul className="workspace-snapshot-sites">{workspace.sites.map((site, index) => <li key={index}><strong>{site.name}</strong><p>{site.url}</p><p className="inline-hint">用途與目標／相依分類尚未提供。</p></li>)}</ul> : <p className="muted">未提供既有網站資料。</p>}
    </>}
    <p className="settings-impact">網站範圍與背景的修改經設定提案與明確確認；AI 撰寫引擎由下方獨立設定，兩者都只影響後續任務。</p>
  </section>;
}
