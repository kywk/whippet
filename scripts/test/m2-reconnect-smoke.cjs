#!/usr/bin/env node
// M2 reconnect 單一情境（黑箱）：建 test/draft/validate 一次，等 running 後寫 ready，
// 總指揮重啟 Server（非 Manager）造成 WS 斷線重連；腳本只續輪詢同 run 至 succeeded + reportUrl。
// 重啟期間 GET 輪詢短暫連線錯誤或 502/503 視為暫態重試（原 3 分鐘 deadline 內）；POST/PUT 絕不重試。
// 未重跑由總指揮另以 Docker started event / attempt ID 檢查。
// Node22 原生 fetch + fs，無認證，不 docker，不刪資料，不加 dependencies。
'use strict';

const fs = require('node:fs');
const BASE = (process.env.WHIPPET_API_URL || 'http://server:8080').replace(/\/$/, '');
const READY_PATH = '/private/tmp/whippet-m2-reconnect-ready.json';
const OVERALL_MS = 8 * 60 * 1000;
const PHASE_MS = 3 * 60 * 1000;
const POLL_MS = 2000;
const t0 = Date.now();

const RECONNECT_SCRIPT = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>reconnect</h1>');await page.waitForTimeout(25000);await expect(page.getByRole('heading')).toHaveText('reconnect')});`;

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
    console.error(`FAIL ${msg}${evidence ? ` evidence=${JSON.stringify(evidence).slice(0, 300)}` : ''}`);
    process.exit(1);
  }
}

// 輪詢用：連線錯誤或 502/503 回 transient，其餘照常嚴格失敗。僅 GET 讀取可重試。
async function getRunPoll(runId) {
  try {
    const r = await api('GET', `/api/runs/${runId}`);
    if (r.http === 502 || r.http === 503) return { transient: true, http: r.http };
    if (r.http !== 200) need(false, 'get-run', { id: runId, http: r.http, body: r.text });
    const run = r.json && (r.json.run || r.json);
    if (!run || !run.status) need(false, 'run-no-status', { id: runId });
    return { run };
  } catch (e) {
    return { transient: true, error: String((e && e.message) || e).slice(0, 200) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let r = await api('GET', '/api/workspaces');
  need(r.http === 200, 'list-workspaces', { http: r.http });
  const ws = r.json && r.json.items && r.json.items[0];
  need(ws && ws.id, 'no-workspace', {});
  console.log(`workspace id=${ws.id}`);

  const name = `m2-reconnect-${Date.now()}`;
  r = await api('POST', `/api/workspaces/${ws.id}/tests`, { name, description: 'm2 reconnect smoke' });
  need(r.http === 201, 'create-test', { http: r.http, body: r.text });
  const test = r.json && (r.json.test || r.json);
  const testId = test && test.id;
  need(testId, 'create-test-noid', {});
  console.log(`test id=${testId}`);

  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft', { http: r.http });
  const rev0 = r.json && r.json.revision;
  need(rev0 !== undefined, 'draft-no-revision', {});
  r = await api('PUT', `/api/tests/${testId}/draft`, { revision: rev0, script: RECONNECT_SCRIPT });
  need([200, 201].includes(r.http), 'put-draft', { http: r.http, body: r.text });
  const draft = r.json && (r.json.draft || r.json);
  const rev = draft && draft.revision;
  need(rev !== undefined, 'put-no-revision', {});
  console.log(`draft revision=${rev}`);
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200 && r.json && r.json.script === RECONNECT_SCRIPT, 'draft-persist', { http: r.http });

  r = await api('POST', `/api/tests/${testId}/draft/validate`, { revision: rev });
  need(r.http === 202, 'validate', { http: r.http, body: r.text });
  const vr = r.json && (r.json.run || r.json);
  need(vr && vr.id, 'validate-norun', {});
  const runId = vr.id;
  console.log(`validate run id=${runId}`);

  // 等 running 後寫 ready（接受 running/collecting，避免錯過短暫 running）
  // 重啟前一般無暫態，但同樣容忍 GET 502/503/連線錯誤。
  {
    const start = Date.now();
    for (;;) {
      checkOverall('wait-running');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL wait-running-timeout id=${runId}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const out = await getRunPoll(runId);
      if (out.transient) {
        console.log(`poll transient id=${runId} http=${out.http || ''} err=${out.error || ''}`);
        continue;
      }
      const run = out.run;
      console.log(`poll id=${runId} status=${run.status}`);
      if (run.status === 'running' || run.status === 'collecting') break;
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(run.status)) {
        console.error(`FAIL too-late status=${run.status} id=${runId}`);
        process.exit(1);
      }
    }
  }
  fs.writeFileSync(READY_PATH, JSON.stringify({ runId }, null, 2) + '\n');
  console.log(`ready ${READY_PATH} runId=${runId}`);
  console.log('waiting external server restart; polling same run');

  // 續輪詢同 run 至 succeeded + reportUrl（3 分鐘；暫態 GET 重試）
  {
    const start = Date.now();
    for (;;) {
      checkOverall('wait-succeeded');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL wait-succeeded-timeout id=${runId}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const out = await getRunPoll(runId);
      if (out.transient) {
        console.log(`poll transient id=${runId} http=${out.http || ''} err=${out.error || ''}`);
        continue;
      }
      const run = out.run;
      console.log(`poll id=${runId} status=${run.status}`);
      if (run.status === 'succeeded') {
        need(run.reportUrl, 'no-reportUrl', { id: runId, status: run.status });
        break;
      }
      if (['failed', 'timed_out', 'cancelled', 'interrupted'].includes(run.status)) {
        console.error(`FAIL expected-succeeded got=${run.status} id=${runId}`);
        process.exit(1);
      }
    }
  }
  console.log(`DONE test=${testId} run=${runId} status=succeeded`);
}

main().catch((e) => {
  console.error(`FAIL exception ${e && e.message || e}`);
  process.exit(1);
});
