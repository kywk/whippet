#!/usr/bin/env node
// M2 API smoke（黑箱）：僅依契約走 HTTP，不加認證，不刪資料，不重試寫入。
// Node22 原生 fetch。Base 取 WHIPPET_API_URL，預設 http://server:8080。
// 整體 5 分鐘，每個 run 最多輪詢 2 分鐘。失敗非零退出，只印必要 id/status。
'use strict';

const BASE = (process.env.WHIPPET_API_URL || 'http://server:8080').replace(/\/$/, '');
const OVERALL_MS = 5 * 60 * 1000;
const RUN_MS = 2 * 60 * 1000;
const POLL_MS = 2000;
const t0 = Date.now();

const SCRIPT_V1 = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>M2</h1>');await expect(page.getByRole('heading')).toHaveText('M2')});`;
const SCRIPT_V2 = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>M2 v2</h1>');await expect(page.getByRole('heading')).toHaveText('M2 v2')});`;
const SCRIPT_V3 = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>M2 v3</h1>');await expect(page.getByRole('heading')).toHaveText('M2 v3')});`;

function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) {
    console.error(`FAIL overall-timeout step=${step}`);
    process.exit(1);
  }
}

async function api(method, path, body) {
  checkOverall(`${method} ${path}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { http: res.status, json, text: text.slice(0, 500) };
}

function need(cond, msg, evidence) {
  if (!cond) {
    console.error(`FAIL ${msg}${evidence ? ` evidence=${JSON.stringify(evidence).slice(0, 500)}` : ''}`);
    process.exit(1);
  }
}

async function pollRun(runId) {
  const start = Date.now();
  for (;;) {
    checkOverall(`poll ${runId}`);
    if (Date.now() - start > RUN_MS) {
      console.error(`FAIL run-timeout id=${runId}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    const r = await api('GET', `/api/runs/${runId}`);
    need(r.http === 200, 'get-run-status', { http: r.http, body: r.text });
    const run = r.json && (r.json.run || r.json);
    const st = run && run.status;
    console.log(`run id=${runId} status=${st}`);
    if (['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(st)) return run;
  }
}

async function main() {
  // 1. 新增測試：先取 workspace
  let r = await api('GET', '/api/workspaces');
  need(r.http === 200, 'list-workspaces', { http: r.http });
  const ws = r.json && r.json.items && r.json.items[0];
  need(ws && ws.id, 'no-workspace', { body: r.text });
  console.log(`workspace id=${ws.id}`);

  // 2. 新增測試
  const name = `m2-smoke-${Date.now()}`;
  r = await api('POST', `/api/workspaces/${ws.id}/tests`, { name, description: 'm2 smoke' });
  need(r.http === 201, 'create-test', { http: r.http, body: r.text });
  const test = r.json && (r.json.test || r.json);
  const testId = test && test.id;
  need(testId, 'create-test-noid', { body: r.text });
  console.log(`test id=${testId}`);

  // 3. 存成功腳本（先取 draft 拿 revision，再 PUT）
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-1', { http: r.http, body: r.text });
  const rev1 = r.json && r.json.revision;
  need(rev1 !== undefined, 'draft-no-revision', { body: r.text });
  r = await api('PUT', `/api/tests/${testId}/draft`, { revision: rev1, script: SCRIPT_V1 });
  need(r.http === 200, 'put-draft-v1', { http: r.http, body: r.text });
  const draftV1 = r.json && (r.json.draft || r.json);
  const revV1 = draftV1 && draftV1.revision;
  need(revV1 !== undefined, 'put-v1-no-revision', { body: r.text });
  console.log(`draft rev=${revV1}`);
  // GET draft 重開保留 script
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200 && r.json && r.json.script === SCRIPT_V1, 'draft-persist-v1', { http: r.http });

  // 4. 驗證前 publish 應拒絕（409 或 400）
  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revV1, confirmed: true });
  need([400, 409].includes(r.http), 'publish-before-validate-should-reject', { http: r.http, body: r.text });
  console.log(`publish-before-validate rejected http=${r.http}`);

  // 5. validate 並輪詢 succeeded/reportUrl
  r = await api('POST', `/api/tests/${testId}/draft/validate`, { revision: revV1 });
  need(r.http === 202, 'validate-v1', { http: r.http, body: r.text });
  const vr1 = r.json && (r.json.run || r.json);
  need(vr1 && vr1.id, 'validate-v1-norun', { body: r.text });
  console.log(`validate run id=${vr1.id}`);
  const run1 = await pollRun(vr1.id);
  need(run1.status === 'succeeded', 'validate-v1-status', { id: vr1.id, status: run1.status });
  need(run1.reportUrl, 'validate-v1-report', { id: vr1.id, status: run1.status });
  console.log(`validate ok id=${vr1.id} status=succeeded`);

  // 6. 修改草稿到新 revision
  r = await api('PUT', `/api/tests/${testId}/draft`, { revision: revV1, script: SCRIPT_V2 });
  need([200, 201].includes(r.http), 'put-draft-v2', { http: r.http, body: r.text });
  const draftV2 = r.json && (r.json.draft || r.json);
  const revV2 = draftV2 && draftV2.revision;
  need(revV2 !== undefined && revV2 !== revV1, 'put-v2-revision', { revV1, revV2 });
  console.log(`draft rev=${revV2}`);
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200 && r.json && r.json.script === SCRIPT_V2, 'draft-persist-v2', { http: r.http });

  // 7. 舊 revision publish 拒絕，且新 revision 未驗證也拒絕
  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revV1, confirmed: true });
  need([400, 409].includes(r.http), 'publish-old-should-reject', { http: r.http, body: r.text });
  console.log(`publish-old rejected http=${r.http}`);
  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revV2, confirmed: true });
  need([400, 409].includes(r.http), 'publish-unvalidated-should-reject', { http: r.http, body: r.text });
  console.log(`publish-unvalidated rejected http=${r.http}`);

  // 8. 新 revision validate 成功
  r = await api('POST', `/api/tests/${testId}/draft/validate`, { revision: revV2 });
  need(r.http === 202, 'validate-v2', { http: r.http, body: r.text });
  const vr2 = r.json && (r.json.run || r.json);
  need(vr2 && vr2.id, 'validate-v2-norun', { body: r.text });
  console.log(`validate run id=${vr2.id}`);
  const run2 = await pollRun(vr2.id);
  need(run2.status === 'succeeded', 'validate-v2-status', { id: vr2.id, status: run2.status });
  console.log(`validate ok id=${vr2.id} status=succeeded`);

  // 9. publish
  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revV2, confirmed: true });
  need([200, 201].includes(r.http), 'publish-v2', { http: r.http, body: r.text });
  const ver = r.json && (r.json.version || r.json);
  need(ver && ver.id, 'publish-noid', { body: r.text });
  console.log(`version id=${ver.id} revision=${ver.revision}`);
  const publishedScript = ver.script;

  // 10. 再次修改草稿
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-3', { http: r.http, body: r.text });
  const revCur = r.json && r.json.revision;
  r = await api('PUT', `/api/tests/${testId}/draft`, { revision: revCur, script: SCRIPT_V3 });
  need([200, 201].includes(r.http), 'put-draft-v3', { http: r.http, body: r.text });
  console.log('draft updated v3');

  // 11. 確認版本 script 仍等於已發佈快照
  r = await api('GET', `/api/tests/${testId}/versions`);
  need(r.http === 200, 'list-versions', { http: r.http, body: r.text });
  const items = (r.json && r.json.items) || [];
  const found = items.find((v) => v.id === ver.id) || items[items.length - 1];
  need(found && found.script === publishedScript && publishedScript === SCRIPT_V2, 'version-snapshot', { versionId: ver.id });
  console.log(`version snapshot ok id=${ver.id}`);

  // 12. 執行正式版本成功
  r = await api('POST', `/api/tests/${testId}/runs`);
  need(r.http === 202, 'run-published', { http: r.http, body: r.text });
  const pr = r.json && (r.json.run || r.json);
  need(pr && pr.id, 'run-published-norun', { body: r.text });
  console.log(`published run id=${pr.id}`);
  const run3 = await pollRun(pr.id);
  need(run3.status === 'succeeded', 'published-run-status', { id: pr.id, status: run3.status });
  console.log(`published run ok id=${pr.id} status=succeeded`);

  console.log(`DONE test=${testId} version=${ver.id}`);
}

main().catch((e) => {
  console.error(`FAIL exception ${e && e.message || e}`);
  process.exit(1);
});
