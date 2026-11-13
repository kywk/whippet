import { useState } from 'react';
import './platform-preview.css';

// UI-only view models. These are intentionally not API wire contracts.
const modules = [
  { slug: 'login', name: '登入帳號', kind: 'setup', version: 3, signature: 'login(page: Page, roleId: string): Promise<User>', input: 'page：目前頁面；roleId：登入角色識別', output: 'User：id、displayName', before: '位於登入頁', after: '已登入且顯示首頁', users: ['購物結帳 v2 → login v3', '會員資料 v1 → login v2'] },
  { slug: 'search-product', name: '搜尋商品', kind: 'step', version: 2, signature: 'searchProduct(page: Page, query: string): Promise<Product>', input: 'page：目前頁面；query：搜尋字詞', output: 'Product：id、name、price', before: '已登入', after: '商品結果可見', users: ['購物結帳 v2 → search-product v2'] },
  { slug: 'checkout-page', name: '結帳頁面', kind: 'page', version: 1, signature: 'checkoutPage(page: Page): CheckoutPage', input: 'page：目前頁面', output: 'CheckoutPage：結帳頁定位與操作', before: '購物車已有商品', after: '不改變頁面狀態', users: [] },
];
const stages = [
  { title: '登入', action: '複用', ref: '@lib/login · v3（固定）', params: 'roleId = buyer', binding: 'user', },
  { title: '搜尋商品', action: '複用', ref: '@lib/search-product · v2（固定）', params: 'query = 合成商品', binding: 'product', },
  { title: '建立訂單', action: '修改', ref: '@lib/checkout-page · 基底 v1 → 待驗證草稿', params: 'productId = product.id', binding: 'order', },
  { title: '驗證訂單', action: '新建', ref: '@lib/assert-order · 待新建驗證模組', params: 'expectedOrderId = order.id', binding: '無', },
];
type Scenario = 'draft' | 'running' | 'partial' | 'stopped';
const labels: Record<Scenario, string> = { draft: '待確認', running: '執行中', partial: '預算耗盡・partial', stopped: '已停止' };

export function PlatformPreview() {
  const [selected, setSelected] = useState(modules[0].slug);
  const [query, setQuery] = useState('');
  const [scenario, setScenario] = useState<Scenario>('draft');
  const [goal, setGoal] = useState('登入 → 搜尋商品 → 下單 → 驗證訂單');
  const [notice, setNotice] = useState('');
  const module = modules.find((item) => item.slug === selected)!;
  const filtered = modules.filter((item) => `${item.name} ${item.slug} ${item.kind}`.toLowerCase().includes(query.toLowerCase()));
  function simulate(next: Scenario, message: string) { setScenario(next); setNotice(message); }
  return <main id="main" className="platform-preview">
    <header className="platform-heading"><div><p className="muted">Whippet / M10.7</p><h1>Module 與 Use Case 工作台</h1></div><a className="button secondary" href="/">返回 Whippet</a></header>
    <aside className="platform-warning"><strong>合成資料預覽 · 尚未串接 API</strong><p>所有名稱、版本、引用者與執行結果皆為合成資料，不屬於任何真實 Workspace。操作只改變本頁預覽，重新整理即重設；不會儲存、執行、驗證或發佈。</p></aside>
    <div className="platform-catalog">
      <section className="platform-card" aria-labelledby="catalog-title"><h2 id="catalog-title">Module 列表 <span className="muted">/ Catalog</span></h2>
        <label className="platform-field">搜尋模組<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名稱、slug 或類型" /></label>
        <ul className="platform-modules">{filtered.map((item) => <li key={item.slug}><button aria-pressed={selected === item.slug} onClick={() => setSelected(item.slug)}><strong>{item.name}</strong><span>{item.kind} · v{item.version}</span><code>@lib/{item.slug}</code></button></li>)}</ul>
        {filtered.length === 0 ? <p role="status">沒有符合的合成模組。</p> : null}
      </section>
      <section className="platform-card" aria-labelledby="module-title"><p className="muted">Module 詳情 · 合成資料</p><h2 id="module-title">{module.name} · v{module.version}</h2><code className="platform-signature">{module.signature}</code>
        <dl className="platform-facts"><dt>輸入</dt><dd>{module.input}</dd><dt>回傳</dt><dd>{module.output}</dd><dt>前置狀態</dt><dd>{module.before}</dd><dt>後置狀態</dt><dd>{module.after}</dd><dt>Harness</dt><dd>示例：自我試跑通過（非真實驗證）</dd></dl>
        <h3>引用者與固定版本</h3>{module.users.length ? <ul>{module.users.map((user) => <li key={user}>{user}</li>)}</ul> : <p className="muted">此合成模組尚無引用者。</p>}
        <p className="muted">新版本不會更新既有引用；升版需另開草稿並重新驗證。</p>
      </section>
    </div>
    <section className="platform-card" aria-labelledby="plan-title"><div className="platform-heading"><div><p className="muted">Use Case：購物結帳 · 合成資料</p><h2 id="plan-title">Plan 確認卡</h2></div><label>預覽情境 <select value={scenario} onChange={(event) => { setScenario(event.target.value as Scenario); setNotice(''); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label className="platform-field">任務目標（僅本頁）<input value={goal} disabled={scenario !== 'draft'} onChange={(event) => setGoal(event.target.value)} /></label>
      <p>2 個複用、1 個修改、1 個新建。確認後才可排入產稿；此處僅演示確認後畫面。</p>
      <div className="platform-actions"><button className="button primary" disabled={scenario !== 'draft' || !goal.trim()} onClick={() => simulate('running', '已切換為執行中示例；未送出 Plan 或排入 Run。')}>模擬確認 Plan</button><button className="button secondary" disabled={scenario === 'stopped'} onClick={() => simulate('stopped', '已停止本頁示例；未取消任何真實任務。')}>模擬取消</button><button className="button secondary" disabled={scenario === 'draft'} onClick={() => simulate('draft', '已回到可修改的預覽；未更新 Server Plan。')}>返回修改預覽</button></div>
      <p role="status" className="platform-status">{notice || `目前為${labels[scenario]}示例，尚未送出任何請求。`}</p>
    </section>
    <section className="platform-card" aria-labelledby="stages-title"><h2 id="stages-title">Use Case Stage 與進度</h2><p className="muted">線性執行 · 參數與回傳綁定 · {scenario === 'draft' ? '0' : '2'} / 4 階段完成（合成狀態）</p>
      <ol className="platform-stages">{stages.map((stage, index) => {
        const status = scenario === 'draft' ? '待確認' : index < 2 ? '完成（示例）' : index === 2 ? scenario === 'running' ? '產稿中（示例）' : scenario === 'partial' ? 'partial・等待繼續' : '已停止' : '尚未開始';
        return <li key={stage.title}><div className="platform-heading"><h3>{index + 1}. {stage.title} <span className="platform-chip">{stage.action}</span></h3><strong>{status}</strong></div><code>{stage.ref}</code><p>參數：{stage.params} → 回傳綁定：<code>{stage.binding}</code></p></li>;
      })}</ol>
    </section>
    {scenario === 'partial' ? <section className="platform-card platform-partial" aria-labelledby="partial-title"><h2 id="partial-title">partial：保留候選結果，等待繼續</h2><p>合成 Run：demo-author-03 · 階段 3「建立訂單」</p><p>原因：模型請求預算耗盡。示例 checkpoint r2 的 Module Harness 自我試跑通過；不代表 Use Case 已驗證或可發佈。</p><p><strong>下一步：</strong>補齊訂單回傳值，再組合並驗證完整 Use Case。</p><button className="button primary" onClick={() => simulate('running', '已切換繼續後的產稿示例；未恢復 checkpoint、未建立 Run。')}>模擬繼續</button></section> : null}
    <footer className="platform-card"><h2>Compose 與人工發佈</h2><p>等待真實 Stage 結果、Use Case 驗證與摘要。API 串接後由 Server 核對版本並原子發佈。</p><button className="button secondary" disabled>尚未串接，無法發佈</button></footer>
  </main>;
}
