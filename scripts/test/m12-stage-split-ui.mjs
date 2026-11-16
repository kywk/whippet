// One UI flow against a candidate Server and caller-owned disposable PostgreSQL.
// No Manager, real credentials, paid model, baseline state or automatic retries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../runtimes/worker/node_modules/playwright/index.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(process.argv[2]), out = resolve(process.argv[3]);
assert.ok(process.env.TEST_DATABASE_URL?.startsWith('postgres://postgres@127.0.0.1:'));
await mkdir(out, { recursive: true });
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiURL = `http://127.0.0.1:${await port()}`, webURL = `http://127.0.0.1:${await port()}`;
const admin = randomUUID() + randomUUID();
const processes = [];
const html = resolve(repo, 'apps/web/dist/m12-wave9-ui.html'), jsx = resolve(repo, 'apps/web/dist/m12-wave9-ui.jsx');
let browser;
async function ready(url, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('candidate_not_ready');
}
async function request(path, method = 'GET', body) {
  const r = await fetch(apiURL + '/api' + path, { method, headers: { 'content-type': 'application/json', 'X-Whippet-Admin-Token': admin }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(r.ok, `fixture_http_${r.status}`); return r.json();
}
try {
  const server = spawn(binary, [], { cwd: repo, stdio: 'ignore', env: { PATH: process.env.PATH, PORT: new URL(apiURL).port, WHIPPET_BIND_HOST: '127.0.0.1', DATABASE_URL: process.env.TEST_DATABASE_URL,
    MANAGER_TOKEN: randomUUID() + randomUUID(), WHIPPET_ADMIN_TOKEN: admin, WHIPPET_PUBLIC_ORIGIN: webURL,
    ARTIFACT_DIR: resolve(out, 'artifacts'), WHIPPET_SKILLS_PATH: resolve(repo, 'runtimes/worker/skills'), WHIPPET_TOOL_REGISTRY_PATH: resolve(repo, 'contracts/tools/registry.json') } });
  processes.push(server); await ready(apiURL + '/readyz', server);
  const workspace = await request('/workspaces', 'POST', { name: 'Wave9 UI fixture' });
  const test = await request(`/workspaces/${workspace.id}/tests`, 'POST', { name: 'Stage split UI', kind: 'usecase', description: 'Synthetic data only' });
  const { session } = await request(`/tests/${test.id}/editing-session`, 'POST', {});
  const source = { id: 'order', title: '保留全部訂單斷言', action: 'create', module: { slug: 'whole-order', moduleKind: 'step', description: '保留目標與訂單證據' }, args: {} };
  let { plan } = await request(`/tests/${test.id}/plan`, 'PUT', { editingSessionId: session.id, revision: session.draft.revision, planRevision: 0, stages: [source] });
  await writeFile(html, '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/dist/m12-wave9-ui.jsx"></script></html>');
  await writeFile(jsx, `import React from 'react';import {createRoot} from 'react-dom/client';import {PlanPanel} from '../src/PlanPanel';import {createHttpApi} from '../src/api';import '../src/styles.css';
    const f=window.splitFixture,api=createHttpApi('/api');api.setAdminToken(f.admin);const noop=()=>{};
    createRoot(document.getElementById('root')).render(<PlanPanel api={api} testId={f.test.id} session={f.session} draft={f.session.draft} runs={[]} authorEngine="builtin" blocked={false} onGuardChange={noop} onRun={noop} onPublished={noop} onRefresh={noop}/>);`);
  const web = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(webURL).port], { cwd: resolve(repo, 'apps/web'), stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, WHIPPET_API_PROXY_TARGET: apiURL } });
  processes.push(web); await ready(webURL, web);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.addInitScript(f => { window.splitFixture = f; }, { admin, test, session });
  let posts = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/stages/order/split')) posts++; });
  await page.goto(webURL + '/dist/m12-wave9-ui.html');
  const open = page.getByRole('button', { name: '拆分此 Stage 並保留進度', exact: true });
  await open.waitFor(); await open.click();
  const form = page.getByRole('region', { name: '拆分 Stage', exact: true });
  const editor = form.getByLabel('子 Stage JSON'); const originalText = await editor.inputValue();
  const save = form.getByRole('button', { name: '儲存拆分並保留進度', exact: true });
  assert.equal(await save.isDisabled(), true);
  await form.getByRole('checkbox').check();
  // Real concurrent edit causes a real CAS conflict; the editor keeps old CAS.
  ({ plan } = await request(`/tests/${test.id}/plan`, 'PUT', { editingSessionId: session.id, revision: session.draft.revision, planRevision: plan.revision, stages: [{ ...source, title: '他人更新後的訂單斷言' }] }));
  await save.click(); await form.getByRole('alert').waitFor();
  assert.equal(await editor.inputValue(), originalText); assert.equal(posts, 1);
  await form.getByRole('button', { name: '取消編輯', exact: true }).click();
  await page.getByRole('button', { name: '重新載入', exact: true }).click();
  await open.waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '拆分此 Stage 並保留進度' && !b.disabled));
  await open.click(); await form.getByRole('checkbox').check(); await save.click();
  await page.getByText('已儲存拆分並保留前段成果；尚未開始執行，請檢視各段額度後逐段確認。', { exact: true }).waitFor();
  const current = (await request(`/tests/${test.id}/plan?editingSessionId=${session.id}`)).plan;
  assert.equal(current.stages.length, 2); assert.equal(current.status, 'draft');
  assert.equal(current.stages[1].id, 'order'); assert.equal(current.stages[0].decomposition.budget.maxModelRequests, 4);
  assert.equal(current.stages.every(s => !s.authorRunId), true); assert.equal(posts, 2);
  await page.getByText(/上限 4 次模型請求、6 次工具、90 秒/).first().waitFor();
  await page.screenshot({ path: resolve(out, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('region', { name: 'Use Case Plan 與整批發佈', exact: true }).count(), 1);
  await page.evaluate(async () => { window.scrollTo(0, 0); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(out, 'narrow.png'), fullPage: true });
  const result = { status: 'PASS', realAPI: true, casConflictRetainsEditor: true, splitSavedAndReread: true, explicitConfirmation: true,
    posts, authorRunsQueued: 0, paidModelRequests: 0, smallViewportFits: true };
  await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await browser?.close();
  for (const p of processes.reverse()) {
    if (p.exitCode !== null) continue;
    p.kill('SIGTERM'); await Promise.race([new Promise(r => p.once('exit', r)), new Promise(r => setTimeout(r, 3000))]);
    if (p.exitCode === null) p.kill('SIGKILL');
  }
  await rm(html, { force: true }); await rm(jsx, { force: true });
}
