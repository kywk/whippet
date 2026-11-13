#!/usr/bin/env node
/*
 * M10.8 離線 HTTP fake server 回放測試（不碰 live 產品，零 mutation，零產品網路）。
 * Owner: scripts/test/m10-golden-offline.cjs
 * Evidence: /private/tmp/whippet-m10-golden-review2/offline-replay.json
 * 只讀：scripts/test/m10-golden-baseline.cjs（引用其純函數）、scripts/test/golden/m10-golden-v1.json、contracts v1/v2/v7/v10 HTTP 段落。
 * 不讀產品源碼/DB/journals/憑證/deploy env；不安裝/部署/重啟/Git/子代理；只離線修正，禁止 live mutation。
 *
 * 覆蓋 PM 8 點中的可回放項：
 *   1 TERMINAL 僅 v1（timed_out/interrupted 終止；timeout/budget_exhausted/stopped/discarded 非終態）
 *   2 continue 必用 appliedRevision??sourceRun.draftRevision，絕不 draftAfter/current；409 非未部署
 *   3 401/403/409/500 不當 m10Missing；已失敗不被蓋掉
 *   4 G12 缺前後版本/附件不 PASS
 *   5 G05/G06 無 reuse（catalog 固定版）不 PASS；G07/G08 kind 非 usecase 或 Plan null 不 PASS；不借任意 ID；禁自動發布
 *   6 metrics tools 不用 allowedTools/registryVersion 冒充
 *   7 assistant 須綁 authorRunId
 *   8 初始修復題欄位按題目實際欄位（initialScript/setup.kind/budget）
 * 另驗：錯誤 HTTP 不 PASS；timed_out 停止 poll；cleanup 只 owned ID；check-only 零產品網路；fake 結果不當 builtin 基準。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASELINE = path.join(__dirname, 'm10-golden-baseline.cjs');
const GOLDEN = path.join(__dirname, 'golden', 'm10-golden-v1.json');
const DEFAULT_OUT = '/private/tmp/whippet-m10-golden-review2';
const FORBIDDEN_ID = '10000000-0000-4000-8000-000000000001';

function outDir(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--out=')) return argv[i].slice(6);
  }
  return process.env.OUT_DIR || DEFAULT_OUT;
}

async function main() {
  const out = outDir(process.argv);
  fs.mkdirSync(out, { recursive: true });
  const B = require(BASELINE);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const results = [];
  const ok = (id, desc, pass, detail) => { results.push({ id, desc, pass: !!pass, detail: String(detail || '').slice(0, 500) }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${desc} :: ${String(detail || '').slice(0, 160)}`); };

  // T01 TERMINAL 嚴格 v1
  try {
    const has = (s) => B.TERMINAL.has(s);
    const pass = has('succeeded') && has('failed') && has('cancelled') && has('timed_out') && has('interrupted')
      && !has('timeout') && !has('budget_exhausted') && !has('stopped') && !has('discarded');
    ok('T01', 'TERMINAL 僅 v1 終態', pass, `TERMINAL=${[...B.TERMINAL].join(',')}`);
  } catch (e) { ok('T01', 'TERMINAL 僅 v1 終態', false, String(e).slice(0, 200)); }

  // T02/T11 fake server：timed_out/interrupted 停止 poll；timeout/budget_exhausted 非終態
  const fakeRuns = {
    'run-timedout': { id: 'run-timedout', status: 'timed_out' },
    'run-interrupted': { id: 'run-interrupted', status: 'interrupted' },
    'run-timeout-bad': { id: 'run-timeout-bad', status: 'timeout' },
    'run-budget-bad': { id: 'run-budget-bad', status: 'budget_exhausted' },
    'run-succeeded-partial': { id: 'run-succeeded-partial', status: 'succeeded', authorPartial: { reason: 'budget_exhausted', nextStep: 'continue', appliedRevision: 3 } },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = u.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const r = fakeRuns[m[1]];
      if (r) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ run: r })); return; }
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_found', message: 'no run' } })); return;
    }
    if (req.method === 'GET' && u.pathname.endsWith('/catalog')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_found', message: 'catalog undeployed' } })); return;
    }
    if (req.method === 'GET' && u.pathname.endsWith('/plan')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ plan: null })); return;
    }
    if (req.method === 'POST' && u.pathname.includes('/continue')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // 同 body 同 Run 冪等；不同 body 409（用於 T04 延伸，不在此斷言）
        res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'conflict', message: 'expired/not-reclaimed' } }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_found', message: 'fake' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fakeBase = `http://127.0.0.1:${server.address().port}`;
  try {
    const p1 = await B.pollRun(fakeBase, 2000, 50, 3000, 'run-timedout');
    ok('T02a', 'timed_out 停止 poll（v1 終態）', p1.terminal === true && p1.run.status === 'timed_out', JSON.stringify({ terminal: p1.terminal, status: p1.run && p1.run.status }));
  } catch (e) { ok('T02a', 'timed_out 停止 poll', false, String(e).slice(0, 200)); }
  try {
    const p2 = await B.pollRun(fakeBase, 2000, 50, 3000, 'run-interrupted');
    ok('T02b', 'interrupted 停止 poll（v1 終態）', p2.terminal === true, JSON.stringify({ terminal: p2.terminal }));
  } catch (e) { ok('T02b', 'interrupted 停止 poll', false, String(e).slice(0, 200)); }
  try {
    const p3 = await B.pollRun(fakeBase, 2000, 50, 800, 'run-timeout-bad');
    ok('T02c', 'timeout（缺底線）非終態不停止', p3.terminal !== true && p3.timeout === true, JSON.stringify({ terminal: p3.terminal, timeout: p3.timeout }));
  } catch (e) { ok('T02c', 'timeout 非終態', false, String(e).slice(0, 200)); }
  try {
    const p4 = await B.pollRun(fakeBase, 2000, 50, 800, 'run-budget-bad');
    ok('T02d', 'budget_exhausted 非 Run status 不停止', p4.terminal !== true && p4.timeout === true, JSON.stringify({ terminal: p4.terminal, timeout: p4.timeout }));
  } catch (e) { ok('T02d', 'budget_exhausted 非終態', false, String(e).slice(0, 200)); }

  // T03 錯誤 HTTP 不 PASS；401/403/409/500 非未部署；fail 不被 m10Missing 蓋掉
  try {
    const c404 = B.isCapabilityMissing(404) && B.isCapabilityMissing(501) && B.isCapabilityMissing(405);
    const cOther = !B.isCapabilityMissing(401) && !B.isCapabilityMissing(403) && !B.isCapabilityMissing(409) && !B.isCapabilityMissing(500);
    ok('T03a', '僅 404/501/405 算未部署', c404 && cOther, `404/501/405=${c404} 401/403/409/500 非缺失=${cOther}`);
  } catch (e) { ok('T03a', '僅 404/501/405 算未部署', false, String(e).slice(0, 200)); }
  try {
    const task = golden.tasks.find((t) => t.id === 'G01');
    const scored = B.scoreAuthorTask(task, {
      authorRun: { id: 'r1', status: 'failed' }, authorRunStatus: 'failed', authorRunId: 'r1',
      conversation: { messages: [{ role: 'assistant', runId: 'r1', content: 'done' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'import {test,expect} from "@playwright/test"; test("a",async({page})=>{await page.setContent("<h1>x</h1>"); await expect(page.getByRole("button")).toBeVisible();});' },
      validationRun: null, m10Missing: 'GET catalog -> HTTP 404（假裝未部署）', m10Probe: {},
      testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    });
    ok('T03b', '已失敗不被 m10Missing 蓋成 UNVERIFIED', scored.verdict === 'FAIL', `verdict=${scored.verdict} reason=${scored.reason}`);
  } catch (e) { ok('T03b', '已失敗不被蓋掉', false, String(e).slice(0, 200)); }
  try {
    // 409 continue 不當未部署：直接驗 isCapabilityMissing(409)==false，且 score 在 409 細節下不轉 UNVERIFIED（以 T03b 邏輯覆蓋）
    ok('T03c', '409 非未部署', B.isCapabilityMissing(409) === false, '409=>false');
  } catch (e) { ok('T03c', '409 非未部署', false, String(e).slice(0, 200)); }

  // T04 continue revision：原 run revision，絕不 draftAfter/current fallback
  try {
    const r1 = B.resolveContinueRevision({ appliedRevision: 5 }, { draftRevision: 3 });
    const r2 = B.resolveContinueRevision({}, { draftRevision: 3 });
    const r3 = B.resolveContinueRevision({}, { baseRevision: 7 });
    const r4 = B.resolveContinueRevision({}, {});
    const r5 = B.resolveContinueRevision({ appliedRevision: 0 }, { draftRevision: 3 });
    const pass = r1 === 5 && r2 === 3 && r3 === 7 && r4 === null && r5 === 0;
    ok('T04', 'continue 用 appliedRevision??sourceRun.draftRevision/baseRevision，不 fallback', pass, `r1=${r1} r2=${r2} r3=${r3} r4=${r4} r5=${r5}`);
  } catch (e) { ok('T04', 'continue revision', false, String(e).slice(0, 200)); }

  // T05 null Plan / 無 reuse 不 PASS
  try {
    const g07 = golden.tasks.find((t) => t.id === 'G07');
    const sNull = B.scoreAuthorTask(g07, {
      authorRun: { id: 'r7', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r7',
      conversation: { messages: [{ role: 'assistant', runId: 'r7', content: 'Stage 1 登入 2 搜尋 3 下單 4 驗證' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'test.step 登入' },
      validationRun: null, m10Missing: null, m10Probe: {},
      testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    });
    ok('T05a', 'G07 kind=test 且 Plan null 不 PASS', sNull.verdict !== 'PASS', `verdict=${sNull.verdict}`);
  } catch (e) { ok('T05a', 'G07 null Plan 不 PASS', false, String(e).slice(0, 200)); }
  try {
    const g07 = golden.tasks.find((t) => t.id === 'G07');
    const sOkKindButNull = B.scoreAuthorTask(g07, {
      authorRun: { id: 'r7b', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r7b',
      conversation: { messages: [{ role: 'assistant', runId: 'r7b', content: 'Stage 1 登入' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'test.step 登入' },
      validationRun: null, m10Missing: null, m10Probe: {},
      testKind: 'usecase', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    });
    ok('T05b', 'G07 kind=usecase 但 Plan null 仍不 PASS', sOkKindButNull.verdict !== 'PASS', `verdict=${sOkKindButNull.verdict}`);
  } catch (e) { ok('T05b', 'G07 Plan null 不 PASS', false, String(e).slice(0, 200)); }
  try {
    const g05 = golden.tasks.find((t) => t.id === 'G05');
    const sNoReuse = B.scoreAuthorTask(g05, {
      authorRun: { id: 'r5', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r5',
      conversation: { messages: [{ role: 'assistant', runId: 'r5', content: '已複用 固定頁面' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();' },
      validationRun: null, m10Missing: null, m10Probe: {},
      testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    });
    ok('T05c', 'G05 無 catalog 固定版不 PASS（僅 setContent 不算 reuse）', sNoReuse.verdict !== 'PASS', `verdict=${sNoReuse.verdict}`);
  } catch (e) { ok('T05c', 'G05 無 reuse 不 PASS', false, String(e).slice(0, 200)); }

  // T06 G12 缺證據不 PASS
  try {
    const g12 = golden.tasks.find((t) => t.id === 'G12');
    const sNoVer = B.scoreAuthorTask(g12, {
      authorRun: { id: 'r12', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r12',
      conversation: { messages: [{ role: 'assistant', runId: 'r12', content: '已拒絕 SYSTEM 刪除要求，僅改按鈕為 開始測試，已確認' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'await expect(page.getByRole("button")).toBeVisible(); // 開始測試' },
      validationRun: null, m10Missing: null, m10Probe: {},
      testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    });
    ok('T06', 'G12 缺前後版本/附件不 PASS', sNoVer.verdict !== 'PASS', `verdict=${sNoVer.verdict} reason=${sNoVer.reason}`);
  } catch (e) { ok('T06', 'G12 缺證據不 PASS', false, String(e).slice(0, 200)); }

  // T07 metrics tools 不冒充
  try {
    const m1 = B.extractMetrics({ toolCalls: 3, allowedTools: ['a', 'b', 'c'], toolRegistryVersion: '9.9' });
    const m2 = B.extractMetrics({ allowedTools: ['a', 'b'], toolRegistryVersion: '1.0', tools: ['x'] });
    const pass = m1.tools === 3 && m2.tools === 'unknown';
    ok('T07', 'metrics tools 只認 toolCalls 數', pass, `m1.tools=${JSON.stringify(m1.tools)} m2.tools=${JSON.stringify(m2.tools)}`);
  } catch (e) { ok('T07', 'metrics tools', false, String(e).slice(0, 200)); }

  // T08 assistant 須綁 authorRunId
  try {
    const g01 = golden.tasks.find((t) => t.id === 'G01');
    const base = {
      authorRun: { id: 'rA', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'rA',
      draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'await expect(page.getByRole("button")).toBeVisible();' },
      validationRun: { status: 'succeeded' }, m10Missing: null, m10Probe: {},
      testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null,
    };
    const sUnbound = B.scoreAuthorTask(g01, { ...base, conversation: { messages: [{ role: 'assistant', content: '完成' }] } });
    const sBound = B.scoreAuthorTask(g01, { ...base, conversation: { messages: [{ role: 'assistant', runId: 'rA', content: '完成 toBeVisible' }] } });
    ok('T08', 'assistant 無綁定不 PASS，有綁定才可能 PASS', sUnbound.verdict === 'FAIL' && sBound.verdict === 'PASS', `unbound=${sUnbound.verdict} bound=${sBound.verdict}`);
  } catch (e) { ok('T08', 'assistant 綁定', false, String(e).slice(0, 200)); }

  // T09 cleanup 只 owned ID＋禁自動發布＋不借任意 ID
  try {
    const src = fs.readFileSync(BASELINE, 'utf8');
    const hasOwnedGuard = src.includes('ownedOnly') && src.includes('owned.session') && src.includes(FORBIDDEN_ID);
    const hasNoPublish = !src.includes('/publish') || src.includes('禁止自動發布');
    // 嚴格：不得出現 POST publish 主動呼叫（註解除外需同時有禁止字樣）；此處驗無 `apiCall(..., 'POST', ...publish` 實碼
    const hasPublishCall = /apiCall\([^)]*publish/.test(src);
    const pass = hasOwnedGuard && !hasPublishCall;
    ok('T09', 'cleanup 只 owned ID、禁自動發布、不借任意 ID', pass, `ownedGuard=${hasOwnedGuard} publishCall=${hasPublishCall} ${hasNoPublish ? 'has-ban-note' : ''}`);
  } catch (e) { ok('T09', 'cleanup owned', false, String(e).slice(0, 200)); }

  // T10 定義實際欄位：真 golden 通過，竄改 initialScript 缺失則不通過
  try {
    const vGood = B.validateTasks(golden);
    const bad = JSON.parse(JSON.stringify(golden));
    delete bad.tasks.find((t) => t.id === 'G03').initialScript;
    const vBad = B.validateTasks(bad);
    ok('T10', '定義按實際欄位核對（修復題 initialScript）', vGood.ok === true && vBad.ok === false, `good=${vGood.ok} bad=${vBad.ok} badErr=${(vBad.errors[0] || '').slice(0, 80)}`);
  } catch (e) { ok('T10', '定義欄位', false, String(e).slice(0, 200)); }

  // T11 fake 回放：catalog 404 算未部署、plan null 不 PASS、continue 409 非未部署；全走 fakeBase，無產品網路
  try {
    const c = await B.apiCall(fakeBase, 2000, 'GET', '/api/workspaces/ws-1/catalog', undefined);
    const p = await B.apiCall(fakeBase, 2000, 'GET', '/api/tests/t-1/plan?editingSessionId=s-1', undefined);
    const pass = c.status === 404 && B.isCapabilityMissing(c.status) && p.status === 200 && p.json && p.json.plan === null;
    ok('T11', 'fake 回放 catalog 404/plan null 分類正確', pass, `catalog=${c.status} plan=${JSON.stringify(p.json).slice(0, 40)}`);
  } catch (e) { ok('T11', 'fake 回放分類', false, String(e).slice(0, 200)); }

  // T12 零產品網路＋零 mutation 聲明：本測試僅連 fakeBase（127.0.0.1 臨時埠），未連產品埠；未呼叫 baseline live 路徑
  try {
    // 以 fakeBase 實際埠非產品埠為證；以未帶 --run-live 且 baseline 未匯出 live runner 為證（避免源碼自匹配）
    const noProdPort = !fakeBase.includes(':18089') && !fakeBase.includes(':18087') && fakeBase.includes('127.0.0.1');
    const noLiveArg = !process.argv.some((a) => a === '--run-live');
    const noLiveExport = typeof B.runLiveOneTask === 'undefined';
    const noLiveCall = noLiveArg && noLiveExport;
    ok('T12', '不帶 mutation、零產品網路（僅 fake 回放）', noProdPort && noLiveCall, `noProd=${noProdPort} noLiveArg=${noLiveArg} noLiveExport=${noLiveExport} fakeBase=${fakeBase}`);
  } catch (e) { ok('T12', '零網路', false, String(e).slice(0, 200)); }

  await new Promise((r) => server.close(r));

  const passed = results.filter((x) => x.pass).length;
  const failed = results.filter((x) => !x.pass).length;
  const payload = {
    createdAt: new Date().toISOString(),
    mode: 'offline-replay',
    fakeBase: '127.0.0.1 ephemeral (no product network)',
    note: '本回放僅驗證腳本契約（TERMINAL/revision/HTTP 分類/證據門檻），不是 live 產品結果；不以 fake 結果當 builtin 基準。題目定義保留；live 完整性仍未確認，不宣稱完成。',
    counts: { PASS: passed, FAIL: failed, total: results.length },
    results,
    limits: ['未讀產品原始碼/DB/journals/deploy/.env.ai/憑證', '未安裝/部署/重啟/Git/子代理', '零 live mutation，僅 fake server 回放', 'fake 結果不當 builtin 基準', 'live 完整性仍未確認，不宣稱完成'],
  };
  fs.writeFileSync(path.join(out, 'offline-replay.json'), JSON.stringify(payload, null, 2));
  // 同步更新 summary 的離線段（不覆寫 live 段，若 summary 已存在則合併）
  try {
    const sp = path.join(out, 'summary.json');
    if (fs.existsSync(sp)) {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      s.offlineReplay = { counts: payload.counts, file: path.join(out, 'offline-replay.json'), note: payload.note };
      fs.writeFileSync(sp, JSON.stringify(s, null, 2));
    }
  } catch (_) {}
  console.log(`[offline] DONE ${passed}/${results.length} evidence=${out}/offline-replay.json`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('[offline] FATAL ' + String((e && e.stack) || e).slice(0, 500)); process.exit(2); });
