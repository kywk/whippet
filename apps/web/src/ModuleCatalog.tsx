import { useCallback, useState } from 'react';
import { ApiError } from './api';
import { Loading, Notice, StatusBadge } from './components';
import { useResource } from './hooks';
import type { WhippetApi } from './types';
import './platform-preview.css';

export function ModuleCatalog({ api, workspaceId }: { api: WhippetApi; workspaceId: string }) {
  const load = useCallback((signal: AbortSignal) => {
    if (!api.listCatalog) return Promise.reject(new ApiError('此連線尚未提供真實 Catalog，沒有使用合成資料替代。', 'UNAVAILABLE'));
    return api.listCatalog(workspaceId, signal);
  }, [api, workspaceId]);
  const catalog = useResource(load);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const filtered = (catalog.data ?? []).filter((item) => `${item.name} ${item.module.slug} ${item.module.moduleKind}`.toLowerCase().includes(query.toLowerCase()));
  const selected = filtered.find((item) => item.versionId === selectedId) ?? filtered[0];
  return <div className="platform-preview" aria-label="Workspace Module Catalog">
    <header className="platform-heading"><div><h1>Module 模組庫</h1><p className="muted">目前 Workspace 的真實已發佈版本 · 唯讀</p></div><button className="button secondary" disabled={catalog.loading} onClick={catalog.retry}>重新載入</button></header>
    {catalog.loading ? <Loading text="正在查詢 Catalog…" /> : null}
    {catalog.error ? <Notice message={`Catalog 尚未取得，無法確認模組是否可用。${catalog.error}`} retry={catalog.retry} /> : null}
    {catalog.data ? <><label className="platform-field">搜尋模組<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名稱、slug 或類型" /></label>
      {filtered.length === 0 ? <p>{catalog.data.length ? '沒有符合的模組。' : '此 Workspace 尚無已發佈模組。'}</p> : null}
      {selected ? <div className="platform-catalog"><section className="platform-card"><h2>已發佈 Module</h2><ul className="platform-modules">{filtered.map((item) => <li key={item.versionId}><button aria-pressed={item.versionId === selected.versionId} onClick={() => setSelectedId(item.versionId)}><strong>{item.name}</strong><code>@lib/{item.module.slug}</code><span>{item.module.moduleKind}</span><code>{item.versionId}</code></button></li>)}</ul></section>
        <section className="platform-card"><h2>{selected.name}</h2><p>{selected.description || '未提供說明。'}</p><p className="identifier">固定版本：{selected.versionId}</p><code className="platform-signature">{selected.module.signature}</code>
          <dl className="platform-facts"><dt>輸入</dt><dd>{selected.module.inputs || '未提供'}</dd><dt>回傳</dt><dd>{selected.module.returns || '未提供'}</dd><dt>前置狀態</dt><dd>{selected.module.preconditions || '未提供'}</dd><dt>後置狀態</dt><dd>{selected.module.postconditions || '未提供'}</dd><dt>驗證</dt><dd>{selected.validationStatus ? <StatusBadge status={selected.validationStatus} /> : <span className="muted">未提供驗證狀態</span>}{selected.validationRunId ? <p className="identifier">Run {selected.validationRunId}</p> : <p className="muted">未提供驗證 Run</p>}</dd></dl>
          <h3>引用者與版本</h3>{selected.referencedBy.length ? <ul>{selected.referencedBy.map((ref) => <li className="identifier" key={`${ref.testId}:${ref.versionId}`}>Test {ref.testId} · 版本 {ref.versionId}</li>)}</ul> : <p className="muted">尚無引用者。</p>}
          <p className="muted">Module 升版不會變更既有固定引用；需另開草稿並重新驗證。</p>
        </section></div> : null}</> : null}
  </div>;
}
