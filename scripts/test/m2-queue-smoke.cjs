#!/usr/bin/env node
// M2 queue / kill / cancel 單一代表整合測試（黑箱）。
// MAX_WORKERS=2 前提：同 revision 連續 validate x3，前二跑、第三 queued；
// 寫 ready 檔後由總指揮在外部 kill 第一個 run 容器；再另建一次驗證並 cancel。
// Node22 原生 fetch + fs，無認證，不 docker，不刪資料，不重試寫入，不加 dependencies。
// ready 檔只含三個 runId，不含秘密。
'use strict';

const fs = require('node:fs');
const BASE = (process.env.WHIPPET_API_URL || 'http://server:8080').replace(/\/$/, '');
const READY_PATH = '/private/tmp/whippet-m2-queue-ready.json';
const OVERALL_MS = 10 * 60 * 1000;
const PHASE_MS = 3 * 60 * 1000;
const POLL_MS = 2000;
const t0 = Date.now();

const QUEUE_SCRIPT = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>queue</h1>');await page.waitForTimeout(25000);await expect(page.getByRole('heading')).toHaveText('queue')});`;

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

async function getStatus(runId) {
  const r = await api('GET', `/api/runs/${runId}`);
  need(r.http === 200, 'get-run', { id: runId, http: r.http, body: r.text });
  const run = r.json && (r.json.run || r.json);
  need(run && run.status, 'run-no-status', { id: runId });
  return run.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 新增測試 + 存草稿
  let r = await api('GET', '/api/workspaces');
  need(r.http === 200, 'list-workspaces', { http: r.http });
  const ws = r.json && r.json.items && r.json.items[0];
  need(ws && ws.id, 'no-workspace', {});
  console.log(`workspace id=${ws.id}`);

  const name = `m2-queue-${Date.now()}`;
  r = await api('POST', `/api/workspaces/${ws.id}/tests`, { name, description: 'm2 queue smoke' });
  need(r.http === 201, 'create-test', { http: r.http, body: r.text });
  const test = r.json && (r.json.test || r.json);
  const testId = test && test.id;
  need(testId, 'create-test-noid', {});
  console.log(`test id=${testId}`);

  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft', { http: r.http });
  const rev0 = r.json && r.json.revision;
  need(rev0 !== undefined, 'draft-no-revision', {});
  r = await api('PUT', `/api/tests/${testId}/draft`, { revision: rev0, script: QUEUE_SCRIPT });
  need([200, 201].includes(r.http), 'put-draft', { http: r.http, body: r.text });
  const draft = r.json && (r.json.draft || r.json);
  const rev = draft && draft.revision;
  need(rev !== undefined, 'put-no-revision', {});
  console.log(`draft revision=${rev}`);
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200 && r.json && r.json.script === QUEUE_SCRIPT, 'draft-persist', { http: r.http });

  // 同 revision 連續 validate x3（不重試寫入）
  const runIds = [];
  for (let i = 0; i < 3; i++) {
    checkOverall(`validate-${i + 1}`);
    const v = await api('POST', `/api/tests/${testId}/draft/validate`, { revision: rev });
    need(v.http === 202, `validate-${i + 1}`, { http: v.http, body: v.text });
    const run = v.json && (v.json.run || v.json);
    need(run && run.id, `validate-${i + 1}-norun`, {});
    runIds.push(run.id);
    console.log(`validate ${i + 1} run id=${run.id} status=${run.status || ''}`);
  }

  // 輪詢確認：前二 running/collecting，第三 queued（上限 3 分鐘）
  const ACTIVE = new Set(['running', 'collecting']);
  let queueEvidence = null;
  {
    const start = Date.now();
    for (;;) {
      checkOverall('queue-shape');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL queue-shape-timeout ids=${runIds.join(',')}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const s = [await getStatus(runIds[0]), await getStatus(runIds[1]), await getStatus(runIds[2])];
      console.log(`queue poll status=${s.join('/')}`);
      if (ACTIVE.has(s[0]) && ACTIVE.has(s[1]) && s[2] === 'queued') {
        queueEvidence = { runIds: [...runIds], status: [...s] };
        console.log(`queue evidence run1=${s[0]} run2=${s[1]} run3=${s[2]}`);
        break;
      }
    }
  }

  // 寫 ready 檔（只含三個 runId），等外部 kill 第一個容器
  fs.writeFileSync(READY_PATH, JSON.stringify({ runIds }, null, 2) + '\n');
  console.log(`ready ${READY_PATH} runIds=${runIds.join(',')}`);
  console.log('waiting external kill of run1 container');

  // 等待：第三個離開 queued、第一個終態 failed，第二/三最後 succeeded（上限 3 分鐘）
  {
    const start = Date.now();
    let leftQueued = false;
    for (;;) {
      checkOverall('kill-effect');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL kill-effect-timeout ids=${runIds.join(',')}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const s = [await getStatus(runIds[0]), await getStatus(runIds[1]), await getStatus(runIds[2])];
      if (s[2] !== 'queued') leftQueued = true;
      console.log(`kill poll status=${s.join('/')} leftQueued=${leftQueued}`);
      if (leftQueued && s[0] === 'failed' && s[1] === 'succeeded' && s[2] === 'succeeded') break;
      // 終態衝突早停：run1 已終態但非 failed，或 run2/run3 已終態但非 succeeded
      const term = (x) => ['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(x);
      if (term(s[0]) && s[0] !== 'failed') {
        console.error(`FAIL run1 expected failed got=${s[0]} id=${runIds[0]}`);
        process.exit(1);
      }
      if ((term(s[1]) && s[1] !== 'succeeded') || (term(s[2]) && s[2] !== 'succeeded' && s[2] !== 'queued')) {
        console.error(`FAIL run2/run3 expected succeeded got=${s[1]}/${s[2]}`);
        process.exit(1);
      }
    }
    console.log(`kill evidence run1=failed run2=succeeded run3=succeeded leftQueued=${leftQueued}`);
  }
  void queueEvidence;

  // 另建一次同草稿驗證，等 running 後 cancel，確認 cancelled
  r = await api('POST', `/api/tests/${testId}/draft/validate`, { revision: rev });
  need(r.http === 202, 'validate-cancel', { http: r.http, body: r.text });
  const cr = r.json && (r.json.run || r.json);
  need(cr && cr.id, 'validate-cancel-norun', {});
  const cancelId = cr.id;
  console.log(`cancel run id=${cancelId}`);
  {
    const start = Date.now();
    for (;;) {
      checkOverall('wait-running');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL wait-running-timeout id=${cancelId}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const s = await getStatus(cancelId);
      console.log(`cancel poll status=${s}`);
      if (s === 'running' || s === 'collecting') break;
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(s)) {
        console.error(`FAIL cancel-too-late status=${s} id=${cancelId}`);
        process.exit(1);
      }
    }
  }
  r = await api('POST', `/api/runs/${cancelId}/cancel`);
  need([200, 202].includes(r.http), 'post-cancel', { http: r.http, body: r.text });
  console.log(`cancel posted id=${cancelId} http=${r.http}`);
  {
    const start = Date.now();
    for (;;) {
      checkOverall('wait-cancelled');
      if (Date.now() - start > PHASE_MS) {
        console.error(`FAIL wait-cancelled-timeout id=${cancelId}`);
        process.exit(1);
      }
      await sleep(POLL_MS);
      const s = await getStatus(cancelId);
      console.log(`cancelled poll status=${s}`);
      if (s === 'cancelled') break;
      if (['succeeded', 'failed', 'timed_out', 'interrupted'].includes(s)) {
        console.error(`FAIL cancel-expected-cancelled got=${s} id=${cancelId}`);
        process.exit(1);
      }
    }
  }
  console.log(`cancel evidence id=${cancelId} status=cancelled`);

  console.log(`DONE test=${testId} runs=${runIds.join(',')},${cancelId}`);
}

main().catch((e) => {
  console.error(`FAIL exception ${e && e.message || e}`);
  process.exit(1);
});
