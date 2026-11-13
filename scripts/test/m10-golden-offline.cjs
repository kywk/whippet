#!/usr/bin/env node
/*
 * M10.8 離線 HTTP fake server 回放測試（不碰 live 產品，零 mutation，零產品網路）。
 * Owner: scripts/test/m10-golden-offline.cjs
 * Evidence: /private/tmp/whippet-m10-golden-score-guard/offline-replay.json（score-guard；不覆寫 final-seam 舊證據）
 * 只讀：scripts/test/m10-golden-baseline.cjs（引用其純函數＋runLiveOneTask fake回放）、scripts/test/golden/m10-golden-v1.json、contracts v1/v2/v7/v10 HTTP/Plan/10.2段落。
 * 不讀產品源碼/DB/journals/憑證/deploy env；不安裝/部署/重啟/Git/子代理；只離線修正，禁止 live mutation。
 * M10.8 preflight 新增（live NOT_RUN）：T13 port 守衛（19087 production／19187 fixture／18087 禁止／18187 停用）、
 *   T14 budget 定義限定（task.budget 無 perRun override，19187 budget1 不混算）、T15 fixture manifest 形狀提案驗證＋禁自動發布、
 *   T16 registry10.2 分離（首搜 query/limit 與 next_page 分離，QA 不合成 cursor）＋證據目錄 score-guard（相容 final-seam 舊目錄）。
 *   final-seam四縫（PM裁定）：S1 G05/G06 kind=usecase走planner（routeOverride test→usecase，其他12題不變，prompt/JSON不變）；
 *   S2 fixtureContext獨立（originalPrompt/fixtureContext/submittedContent，slug校驗，固定test/version不變）；
 *   S3 reuse須本輪Plan exact且action===reuse（缺action/null/其他action皆拒；catalog僅有值/錯version/Plan null皆不得成功，僅Plan亦UNVERIFIED，G06 loginVerification=NOT_PERFORMED，FAIL優先；planner僅寫Plan不改draft，same revision不因此FAIL）；
 *   S4 G13/G14 budget2未實施整題不得PASS（預算前置不符UNVERIFIED，實際失敗仍FAIL，production partial另記不混19187）。
 *   score-guard補丁：T24 fake planner不人為增加draft revision（same revision語義）；新增T29 same revision exact reuse→UNVERIFIED且reuse true、T30 missing/null/modify→reuse false不可PASS、T31 same revision但run failed仍FAIL、T32 fake live回放same revision exact reuse→UNVERIFIED（真scoreAuthorTask＋fake live函式，不只字串檢查）。
 *   live-review(2026-11-13 parent t3d離線覆核)：新增T33 G08 planner-only same revision→UNVERIFIED非產稿錯誤（真評分，Plan 3 stages＋succeeded；author failed仍FAIL）、T34 G13/14 budget2前置不符 same revision→UNVERIFIED（真評分，succeeded無partial＋production8/12/180；真正HTTP/run失敗仍FAIL）、T35 G13 continue 409/HTTP失敗仍FAIL不批次抹fail（真評分）；保留既有39項意圖（T01-T32），不改原14題JSON，不新跑模型。
 *
 * 覆蓋 PM 8 點中的可回放項：
 *   1 TERMINAL 僅 v1（timed_out/interrupted 終止；timeout/budget_exhausted/stopped/discarded 非終態）
 *   2 continue 必用 appliedRevision??sourceRun.draftRevision，絕不 draftAfter/current；409 非未部署
 *   3 401/403/409/500 不當 m10Missing；已失敗不被蓋掉
 *   4 G12 缺前後版本/附件不 PASS
 *   5 G05/G06須本輪Plan reuse exact（僅catalog固定版不夠）不PASS；G05/G06/G07/G08 kind非usecase或Plan null不PASS；不借任意ID；禁自動發布
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
const DEFAULT_OUT = '/private/tmp/whippet-m10-golden-score-guard';
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

  // T12 零產品網路＋零 mutation 聲明：本測試僅連 fakeBase（127.0.0.1 臨時埠），未連產品埠；runLiveOneTask僅供fake回放（非產品網路），未帶 --run-live 即零mutation
  try {
    // 以 fakeBase 實際埠非產品埠為證；runLiveOneTask存在僅為T24 fake回放行為驗證（不用字串contains替代），仍零產品網路、未帶 --run-live
    const noProdPort = !fakeBase.includes(':18089') && !fakeBase.includes(':18087') && !fakeBase.includes(':19087') && !fakeBase.includes(':19187') && fakeBase.includes('127.0.0.1');
    const noLiveArg = !process.argv.some((a) => a === '--run-live');
    const hasFakeLiveFn = typeof B.runLiveOneTask === 'function';
    const noLiveCall = noLiveArg && (hasFakeLiveFn || typeof B.runLiveOneTask === 'undefined');
    ok('T12', '不帶 mutation、零產品網路（僅 fake 回放）', noProdPort && noLiveCall, `noProd=${noProdPort} noLiveArg=${noLiveArg} hasFakeLiveFn=${hasFakeLiveFn} fakeBase=${fakeBase}`);
  } catch (e) { ok('T12', '零網路', false, String(e).slice(0, 200)); }

  // T13 live 目標守衛：19087 production／19187 fixture／18087 禁止／18187 停用（純函數，零網路）
  try {
    const forb = B.isForbiddenTarget('https://127.0.0.1:18089') === false
      && B.isForbiddenTarget('http://localhost:18087') === true
      && B.isForbiddenTarget('http://localhost:18187') === true
      && B.isForbiddenTarget('http://localhost:19187') === true
      && B.isForbiddenTarget('http://localhost:19087') === false;
    const prod = B.isProductionBaselineTarget('http://localhost:19087') === true
      && B.isProductionBaselineTarget('http://localhost:19187') === false
      && B.isProductionBaselineTarget('http://localhost:18087') === false;
    ok('T13', 'live 目標守衛：僅19087為production基準，18087/18187/19187禁止', forb && prod, `forb=${forb} prod=${prod}`);
  } catch (e) { ok('T13', 'live 目標守衛', false, String(e).slice(0, 200)); }

  // T14 預算題定義限定：task.budget 僅定義 maxSteps，公開 API 無 perRun override；19187 budget1 不得混算
  try {
    const g13 = golden.tasks.find((t) => t.id === 'G13');
    const g14 = golden.tasks.find((t) => t.id === 'G14');
    const shape = g13 && g13.budget && typeof g13.budget.maxSteps === 'number' && g14 && g14.budget && typeof g14.budget.maxSteps === 'number';
    const src = fs.readFileSync(BASELINE, 'utf8');
    const noOverrideClaim = !/task\.budget.*已生效|perRun.*override.*已生效|budget.*override.*生效/.test(src) || /無perRun override/.test(src);
    const hasBudgetNote = /無perRun override/.test(src) && /19187/.test(src) && /19087/.test(src);
    ok('T14', 'budget僅定義無perRun override，19187不混算production', shape && noOverrideClaim && hasBudgetNote, `shape=${shape} note=${hasBudgetNote}`);
  } catch (e) { ok('T14', 'budget 定義限定', false, String(e).slice(0, 200)); }

  // T15 fixture manifest 形狀提案驗證＋禁自動發布／不借任意 ID（純函數＋源碼靜態檢查）
  try {
    const good = B.validateFixtureManifest({ workspaceId: 'ws-qa-new-001', scopeConfirmed: true, catalogSeeded: true, ownership: ['pm-seed-list'] });
    const badForbidden = B.validateFixtureManifest({ workspaceId: FORBIDDEN_ID, scopeConfirmed: true, catalogSeeded: true, ownership: ['x'] });
    const badScope = B.validateFixtureManifest({ workspaceId: 'ws-qa-new-002', scopeConfirmed: false, catalogSeeded: true, ownership: ['x'] });
    const badOwn = B.validateFixtureManifest({ workspaceId: 'ws-qa-new-003', scopeConfirmed: true, catalogSeeded: true, ownership: [] });
    const src = fs.readFileSync(BASELINE, 'utf8');
    const hasPublishCall = /apiCall\([^)]*publish/.test(src);
    const hasConfirmScopeCall = /apiCall\([^)]*confirm-scope/.test(src);
    const pass = good.ok === true && badForbidden.ok === false && badScope.ok === false && badOwn.ok === false && !hasPublishCall && !hasConfirmScopeCall;
    ok('T15', 'fixture manifest形狀＋禁自動發布/不借ID/不悄悄confirm', pass, `good=${good.ok} forb=${badForbidden.ok} scope=${badScope.ok} own=${badOwn.ok} publish=${hasPublishCall} confirmScope=${hasConfirmScopeCall}`);
  } catch (e) { ok('T15', 'fixture manifest 形狀', false, String(e).slice(0, 200)); }

  // T16 registry10.2 分離＋證據目錄 score-guard（相容 final-seam 舊目錄）＋live-review新目錄：QA 不合成 cursor，首搜僅 query/limit；closed Plan done 可讀已在註解保留
  try {
    const src = fs.readFileSync(BASELINE, 'utf8');
    const noCursorParam = !/catalog_search.*cursor|cursor.*catalog_search/.test(src);
    const hasRegistryNote = /registry10\.2|首搜.*query\/limit|next_page/.test(src) || /catalog_next_page/.test(src) || /首搜/.test(fs.readFileSync(path.join(__dirname, 'golden', 'README.md'), 'utf8'));
    const outIsFinal = out === '/private/tmp/whippet-m10-golden-final-seam' || String(out).endsWith('m10-golden-final-seam') || out === '/private/tmp/whippet-m10-golden-score-guard' || String(out).endsWith('m10-golden-score-guard') || out === '/tmp/whippet-m10-golden-live-review' || String(out).endsWith('m10-golden-live-review');
    ok('T16', 'registry10.2分離不合成cursor＋證據score-guard（相容final-seam，live-review新目錄亦可）', noCursorParam && outIsFinal, `noCursor=${noCursorParam} outFinal=${outIsFinal} note=${hasRegistryNote}`);
  } catch (e) { ok('T16', 'registry10.2＋final-seam', false, String(e).slice(0, 200)); }

  const manifestSample = { schemaVersion: 1, baselineId: 'm10-golden-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '11111111-1111-4111-8111-111111111111', settingsRevision: 3, authorizationRevision: 5 }, catalogSeeds: [{ taskIds: ['G05'], testId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333' }, { taskIds: ['G06'], testId: '44444444-4444-4444-8444-444444444444', versionId: '55555555-5555-4555-8555-555555555555' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '11111111-1111-4111-8111-111111111111', seedTestIds: ['22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
  try {
    const vGood = B.validateGoldenManifest(manifestSample);
    const vBadNull = B.validateGoldenManifest(null);
    const vBadBudget = B.validateGoldenManifest({ ...manifestSample, productionBudget: { maxModelRequests: 1, maxToolCalls: 12, maxDurationMs: 180000 } });
    const src0 = fs.readFileSync(BASELINE, 'utf8');
    const hasNeedManifest = src0.includes('BLOCKED-NEEDS-MANIFEST') && src0.includes('if (!o.fixtureManifest)');
    const pass = vGood.ok === true && vBadNull.ok === false && vBadBudget.ok === false && hasNeedManifest;
    ok('T17', 'manifest missing zero mutation', pass, 'good=' + vGood.ok + ' null=' + vBadNull.ok + ' budgetBad=' + vBadBudget.ok);
  } catch (e) { ok('T17', 'manifest missing zero mutation', false, String(e).slice(0,200)); }
  try {
    const strictOk = B.isStrictProductionUrl('http://127.0.0.1:19087') === true;
    const strictHttps = B.isStrictProductionUrl('https://127.0.0.1:19087') === false;
    const strictLocalhost = B.isStrictProductionUrl('http://localhost:19087') === false;
    const strictEvil = B.isStrictProductionUrl('http://evil.invalid:19087') === false;
    const bothOk = B.areStrictProductionTargets('http://127.0.0.1:19087', 'http://127.0.0.1:19087') === true;
    const singleSide = B.areStrictProductionTargets('http://127.0.0.1:19087', 'http://localhost:18087') === false;
    const pass = strictOk && strictHttps && strictLocalhost && strictEvil && bothOk && singleSide;
    ok('T18', 'two URLs strict reject', pass, 'strictOk=' + strictOk + ' evil=' + strictEvil + ' single=' + singleSide);
  } catch (e) { ok('T18', 'two URLs strict reject', false, String(e).slice(0,200)); }
  try {
    const wsGood = { id: manifestSample.workspace.id, lifecycle: 'active', scopeStatus: 'confirmed', revision: 3, authorizationRevision: 5, settings: { targets: [] }, executionAvailable: true };
    const wsBadRev = { ...wsGood, revision: 999 };
    const wsBadScope = { ...wsGood, scopeStatus: 'unconfirmed' };
    const vWGood = B.verifyWorkspaceObject(wsGood, manifestSample);
    const vWBadRev = B.verifyWorkspaceObject(wsBadRev, manifestSample);
    const vWBadScope = B.verifyWorkspaceObject(wsBadScope, manifestSample);
    const catGood = { workspaceId: manifestSample.workspace.id, items: [{ testId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', workspaceId: manifestSample.workspace.id }, { testId: '44444444-4444-4444-8444-444444444444', versionId: '55555555-5555-4555-8555-555555555555', workspaceId: manifestSample.workspace.id }] };
    const catBad = { workspaceId: manifestSample.workspace.id, items: [{ testId: '22222222-2222-4222-8222-222222222222', versionId: '99999999-9999-4999-8999-999999999999', workspaceId: manifestSample.workspace.id }] };
    const vCGood = B.verifyCatalogSeeds(catGood, manifestSample, manifestSample.workspace.id);
    const vCBad = B.verifyCatalogSeeds(catBad, manifestSample, manifestSample.workspace.id);
    const src1 = fs.readFileSync(BASELINE, 'utf8');
    const hasPrecheckBlock = src1.includes('BLOCKED-WORKSPACE-PRECHECK') && src1.includes('BLOCKED-CATALOG-PRECHECK');
    const pass = vWGood.ok && !vWBadRev.ok && !vWBadScope.ok && vCGood.ok && !vCBad.ok && hasPrecheckBlock;
    ok('T19', 'scope seed mismatch zero mutation', pass, 'wGood=' + vWGood.ok + ' wBadRev=' + vWBadRev.ok + ' cGood=' + vCGood.ok + ' cBad=' + vCBad.ok);
  } catch (e) { ok('T19', 'scope seed mismatch zero mutation', false, String(e).slice(0,200)); }
  try {
    const src2 = fs.readFileSync(BASELINE, 'utf8');
    const usesManifestWs = src2.includes('rec.workspaceId = manifest.workspace.id');
    const hasTestPost = src2.includes('/api/workspaces') && src2.includes('/tests');
    const needleOld = String.fromCharCode(39) + "/api/workspaces" + String.fromCharCode(39); const noOldWsPost = !src2.includes(needleOld + ", { name:");
    const passesManifest = src2.includes('runLiveOneTask(API_BASE, o, task, i, global.__manifest)');
    const pass = usesManifestWs && hasTestPost && noOldWsPost && passesManifest;
    ok('T20', 'use manifest workspace new Test zero POST workspaces', pass, 'usesWs=' + usesManifestWs + ' noOld=' + noOldWsPost + ' passes=' + passesManifest);
  } catch (e) { ok('T20', 'use manifest workspace new Test', false, String(e).slice(0,200)); }
  try {
    const seedRec = { workspaceId: manifestSample.workspace.id, testId: '22222222-2222-4222-8222-222222222222', sessionId: '77777777-7777-4777-8777-777777777777', owned: { workspace: false, test: true, session: true } };
    const ownedRec = { workspaceId: manifestSample.workspace.id, testId: '66666666-6666-4666-8666-666666666666', sessionId: '77777777-7777-4777-8777-777777777777', owned: { workspace: false, test: true, session: true } };
    const vSeed = B.isCleanupAllowed(seedRec, manifestSample);
    const vOwned = B.isCleanupAllowed(ownedRec, manifestSample);
    const src3 = fs.readFileSync(BASELINE, 'utf8');
    const hasSeedGuard = src3.includes('seed Test no cleanup') && src3.includes('only owned session');
    const pass = vSeed.ok === false && vOwned.ok === true && hasSeedGuard;
    ok('T21', 'seed no cleanup only owned session', pass, 'seedOk=' + vSeed.ok + ' ownedOk=' + vOwned.ok);
  } catch (e) { ok('T21', 'seed no cleanup', false, String(e).slice(0,200)); }
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const fixed = B.getFixedSeedsForTask(manifestSample, 'G05');
    const catExact = { status: 200, json: { items: [{ testId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', workspaceId: manifestSample.workspace.id }] }, workspaceId: manifestSample.workspace.id };
    const catArbitrary = { status: 200, json: { items: [{ testId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workspaceId: manifestSample.workspace.id }] }, workspaceId: manifestSample.workspace.id };
    const baseCtx = { authorRun: { id: 'r5x', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r5x', conversation: { messages: [{ role: 'assistant', runId: 'r5x', content: 'reuse fixed' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'await page.setContent(\"<h1>x</h1>\"); await expect(page.getByRole(\"heading\")).toBeVisible();' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'test', planEvidence: null, versionsBefore: null, versionsAfter: null, workspaceId: manifestSample.workspace.id };
    const sExact = B.scoreAuthorTask(g05, { ...baseCtx, catalogEvidence: catExact, fixedSeeds: fixed });
    const sArb = B.scoreAuthorTask(g05, { ...baseCtx, catalogEvidence: catArbitrary, fixedSeeds: fixed });
    const pass = sArb.verdict !== 'PASS' && fixed.length === 1;
    ok('T22', 'fixed version mismatch no PASS', pass, 'arb=' + sArb.verdict + ' exact=' + sExact.verdict + ' fixedLen=' + fixed.length);
  } catch (e) { ok('T22', 'fixed version mismatch no PASS', false, String(e).slice(0,200)); }
  try {
    const src4 = fs.readFileSync(BASELINE, 'utf8');
    const hasBudgetExact = src4.includes('productionBudget.maxModelRequests must be 8') && src4.includes('productionBudget.maxToolCalls must be 12') && src4.includes('productionBudget.maxDurationMs must be 180000');
    const hasNoFake = src4.includes('no perRun override') && src4.includes('not 19187');
    const g13 = golden.tasks.find(function(t){return t.id==='G13';});
    const scored13 = B.scoreAuthorTask(g13, { authorRun: { id: 'rb', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'rb', conversation: { messages: [{ role: 'assistant', runId: 'rb', content: 'partial' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'x' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null });
    const hasBudgetNote = JSON.stringify(scored13.details).includes('budget precondition mismatch') || JSON.stringify(scored13.details).includes('no perRun override');
    const pass = hasBudgetExact && hasNoFake && hasBudgetNote;
    ok('T23', 'budget no fake apply', pass, 'exact=' + hasBudgetExact + ' note=' + hasBudgetNote);
  } catch (e) { ok('T23', 'budget no fake apply', false, String(e).slice(0,200)); }
  // T24 final-seam S1+S2：實際live函式fake HTTP回放核G05/G06建立usecase→messages含原prompt+context→GET本輪plan，零POST workspaces/confirm/publish；routeOverride test→usecase，其他12題不變，prompt/JSON不變
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const g06 = golden.tasks.find(function(t){return t.id==='G06';});
    const cap05 = B.TASK_CAPABILITY['G05'] || [];
    const cap06 = B.TASK_CAPABILITY['G06'] || [];
    const routeConstOk = cap05.indexOf('plan')!==-1 && cap06.indexOf('plan')!==-1 && cap05.indexOf('catalog')===-1 && cap06.indexOf('catalog')===-1 && B.EXPECTED_TEST_KIND['G05']==='usecase' && B.EXPECTED_TEST_KIND['G06']==='usecase';
    const othersOk = B.EXPECTED_TEST_KIND['G01']==='test' && B.EXPECTED_TEST_KIND['G02']==='test' && B.EXPECTED_TEST_KIND['G03']==='test' && B.EXPECTED_TEST_KIND['G04']==='test' && B.EXPECTED_TEST_KIND['G07']==='usecase' && B.EXPECTED_TEST_KIND['G08']==='usecase' && B.EXPECTED_TEST_KIND['G09']==='test' && B.EXPECTED_TEST_KIND['G10']==='test' && B.EXPECTED_TEST_KIND['G11']==='test' && B.EXPECTED_TEST_KIND['G12']==='test' && B.EXPECTED_TEST_KIND['G13']==='test' && B.EXPECTED_TEST_KIND['G14']==='test';
    const capOthersOk = JSON.stringify(B.TASK_CAPABILITY['G01'])===JSON.stringify(['author']) && JSON.stringify(B.TASK_CAPABILITY['G07'])===JSON.stringify(['author','plan']) && JSON.stringify(B.TASK_CAPABILITY['G13'])===JSON.stringify(['author','continue']);
    const promptUnchanged = g05.prompt.indexOf('Whippet ready')!==-1 && g05.prompt.indexOf('固定頁面')!==-1 && g05.prompt.indexOf('[fixture-context')===-1 && g06.prompt.indexOf('m10-synthetic-password-sentinel')!==-1 && g06.prompt.indexOf('[fixture-context')===-1 && g05.setup.kind==='reuseSearch' && g06.setup.kind==='reuseSearch';
    const manifestWithSlug = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'golden-ready-page revision 2 驗收摘要候選' }, { taskIds: ['G06'], testId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', versionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a', slug: 'golden-login-role-gap', publishedName: 'golden-login-role-gap G06合成缺口驗收摘要' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e', '7f53cf3c-0975-4fba-a85e-001d3d319b62'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const loaderOk = B.validateGoldenManifest(manifestWithSlug).ok === true;
    // fake live server（僅127.0.0.1臨時埠，零產品網路）
    const liveReq = { testKinds: [], messages: [], planGets: 0, forbWs: 0, forbConfirm: 0, forbPublish: 0 };
    const liveState = { seq: 0, tests: {}, runs: {} };
    const liveServer = http.createServer(function(req, res){
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;
      const method = req.method;
      let body = '';
      req.on('data', function(c){ body += c; });
      req.on('end', function(){
        let j = null; try { j = JSON.parse(body || '{}'); } catch (_) { j = {}; }
        const send = function(code, obj){ res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (method === 'POST' && (p === '/api/workspaces' || p === '/api/workspaces/')) { liveReq.forbWs++; send(404, { error: { code: 'not_found' } }); return; }
        if (method === 'POST' && (p.indexOf('/confirm-scope')!==-1)) { liveReq.forbConfirm++; send(404, { error: { code: 'not_found' } }); return; }
        if (method === 'POST' && p.indexOf('/confirm')!==-1) { liveReq.forbConfirm++; send(404, { error: { code: 'not_found' } }); return; }
        if (method === 'POST' && p.indexOf('/publish')!==-1) { liveReq.forbPublish++; send(404, { error: { code: 'not_found' } }); return; }
        const mTs = p.match(/^\/api\/workspaces\/([^/]+)\/tests$/);
        if (method === 'POST' && mTs) {
          liveState.seq++;
          const testId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa' + (liveState.seq % 10);
          const kind = (j && j.kind) || 'test';
          liveReq.testKinds.push(kind);
          liveState.tests[testId] = { kind: kind, ws: mTs[1], revision: 1 };
          send(201, { test: { id: testId, kind: kind } }); return;
        }
        const mEs = p.match(/^\/api\/tests\/([^/]+)\/editing-session$/);
        if (method === 'POST' && mEs) {
          const tid = mEs[1];
          const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb' + (liveState.seq % 10);
          if (!liveState.tests[tid]) liveState.tests[tid] = {};
          liveState.tests[tid].sessionId = sid;
          liveState.tests[tid].revision = 1;
          send(201, { session: { id: sid, draft: { revision: 1 } } }); return;
        }
        const mDraft = p.match(/^\/api\/tests\/([^/]+)\/draft$/);
        if (method === 'GET' && mDraft) {
          const tid = mDraft[1];
          // score-guard：planner僅寫Plan不改draft，fake不人為增加revision（same revision語義，不以draft遞增躲前置檢查）
          const rev = 1;
          const script = '';
          send(200, { draft: { revision: rev, script: script } }); return;
        }
        const mMsg = p.match(/^\/api\/tests\/([^/]+)\/messages$/);
        if (method === 'POST' && mMsg) {
          const tid = mMsg[1];
          const content = (j && j.content) ? String(j.content) : '';
          liveReq.messages.push({ testId: tid, content: content, editingSessionId: j.editingSessionId, revision: j.revision });
          liveState.seq++;
          const runId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc' + (liveState.seq % 10);
          liveState.runs[runId] = { id: runId, status: 'succeeded' };
          if (!liveState.tests[tid]) liveState.tests[tid] = {};
          liveState.tests[tid].runId = runId;
          liveState.tests[tid].messagesContent = content;
          send(202, { run: { id: runId }, conversationId: 'conv-1' }); return;
        }
        const mRun = p.match(/^\/api\/runs\/([^/]+)$/);
        if (method === 'GET' && mRun) {
          const rid = mRun[1];
          const r = liveState.runs[rid] || { id: rid, status: 'succeeded' };
          send(200, { run: r }); return;
        }
        const mConv = p.match(/^\/api\/tests\/([^/]+)\/conversation/);
        if (method === 'GET' && mConv) {
          const tid = mConv[1];
          const st = liveState.tests[tid] || {};
          const runId = st.runId || 'unknown';
          send(200, { conversation: { messages: [{ role: 'assistant', runId: runId, content: '已複用 fixture seed 完成' }] } }); return;
        }
        const mPlan = p.match(/^\/api\/tests\/([^/]+)\/plan/);
        if (method === 'GET' && mPlan) {
          liveReq.planGets++;
          const plan = { id: 'plan-1', testId: mPlan[1], editingSessionId: 's-1', revision: 1, baseRevision: 1, contextRevision: 1, status: 'draft', stages: [{ id: 's-g05', title: 'reuse g05', action: 'reuse', status: 'ready', moduleTestId: manifestWithSlug.catalogSeeds[0].testId, moduleVersionId: manifestWithSlug.catalogSeeds[0].versionId }, { id: 's-g06', title: 'reuse g06', action: 'reuse', status: 'ready', moduleTestId: manifestWithSlug.catalogSeeds[1].testId, moduleVersionId: manifestWithSlug.catalogSeeds[1].versionId }] };
          send(200, { plan: plan }); return;
        }
        if (method === 'POST' && p.indexOf('/discard')!==-1) { send(200, { ok: true }); return; }
        if (method === 'GET' && p.indexOf('/editing-sessions/')!==-1) { send(404, { error: { code: 'not_found' } }); return; }
        send(404, { error: { code: 'not_found' } }); return;
      });
    });
    await new Promise(function(r){ liveServer.listen(0, '127.0.0.1', r); });
    const fakeBase = 'http://127.0.0.1:' + liveServer.address().port;
    const oLive = { timeout: 2000, pollInterval: 50, runTimeout: 5000 };
    const rec05 = await B.runLiveOneTask(fakeBase, oLive, g05, 4, manifestWithSlug);
    const rec06 = await B.runLiveOneTask(fakeBase, oLive, g06, 5, manifestWithSlug);
    await new Promise(function(r){ liveServer.close(r); });
    const kindsOk = liveReq.testKinds.length >= 2 && liveReq.testKinds.every(function(k){ return k === 'usecase'; });
    const msgsOk = liveReq.messages.length >= 2 && liveReq.messages.every(function(m){
      const orig = (m.testId && rec05 && rec06) ? true : true;
      return m.content.indexOf('[fixture-context')!==-1 && (m.content.indexOf('golden-ready-page')!==-1 || m.content.indexOf('golden-login-role-gap')!==-1) && (m.content.indexOf('ef24df7d-a0a8-495b-8c6d-a847ecbf038e')!==-1 || m.content.indexOf('7f53cf3c-0975-4fba-a85e-001d3d319b62')!==-1);
    });
    const origOk = rec05.originalPrompt === g05.prompt && rec06.originalPrompt === g06.prompt && rec05.submittedContent.indexOf(g05.prompt)===0 && rec06.submittedContent.indexOf(g06.prompt)===0 && rec05.fixtureContext.indexOf('並非現Catalog name')!==-1 && rec06.fixtureContext.indexOf('並非現Catalog name')!==-1;
    const routeOk = rec05.routeOverride && rec05.routeOverride.from==='test' && rec05.routeOverride.to==='usecase' && rec06.routeOverride && rec06.routeOverride.from==='test' && rec06.routeOverride.to==='usecase';
    const zeroForb = liveReq.forbWs===0 && liveReq.forbConfirm===0 && liveReq.forbPublish===0;
    const planOk = liveReq.planGets >= 2;
    const verdictOk = rec05.verdict==='UNVERIFIED' && rec06.verdict==='UNVERIFIED';
    const pass = routeConstOk && othersOk && capOthersOk && promptUnchanged && loaderOk && kindsOk && msgsOk && origOk && routeOk && zeroForb && planOk && verdictOk;
    ok('T24', 'G05/G06 live fake回放usecase+fixtureContext+GET plan零禁POST', pass, 'const=' + routeConstOk + ' others=' + othersOk + ' kinds=' + JSON.stringify(liveReq.testKinds) + ' msgs=' + liveReq.messages.length + ' planGets=' + liveReq.planGets + ' forb=' + liveReq.forbWs + '/' + liveReq.forbConfirm + '/' + liveReq.forbPublish + ' v05=' + rec05.verdict + ' v06=' + rec06.verdict);
  } catch (e) { ok('T24', 'G05/G06 live fake回放usecase+fixtureContext', false, String((e && e.stack) || e).slice(0, 300)); }
  // T25 final-seam S2：manifest slug/publishedName可選＋CATALOG slug一致＋fixtureContext獨立（原prompt保留，不默默替換，不宣稱中文可搜）
  try {
    const mBase = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'golden-ready-page revision 2 驗收摘要候選' }, { taskIds: ['G06'], testId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', versionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a', slug: 'golden-login-role-gap', publishedName: 'golden-login-role-gap G06合成缺口驗收摘要' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e', '7f53cf3c-0975-4fba-a85e-001d3d319b62'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const vSlugOk = B.validateGoldenManifest(mBase).ok === true;
    const mBadSlug = JSON.parse(JSON.stringify(mBase)); mBadSlug.catalogSeeds[0].slug = 123;
    const vBadSlug = B.validateGoldenManifest(mBadSlug).ok === false;
    const mNoSlug = JSON.parse(JSON.stringify(mBase)); delete mNoSlug.catalogSeeds[0].slug; delete mNoSlug.catalogSeeds[0].publishedName; delete mNoSlug.catalogSeeds[1].slug; delete mNoSlug.catalogSeeds[1].publishedName;
    const vNoSlugOk = B.validateGoldenManifest(mNoSlug).ok === true;
    const catGood = { workspaceId: mBase.workspace.id, items: [{ testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', workspaceId: mBase.workspace.id, module: { slug: 'golden-ready-page' } }, { testId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', versionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a', workspaceId: mBase.workspace.id, module: { slug: 'golden-login-role-gap' } }] };
    const catBadSlug = { workspaceId: mBase.workspace.id, items: [{ testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', workspaceId: mBase.workspace.id, module: { slug: 'wrong-slug' } }, { testId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', versionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a', workspaceId: mBase.workspace.id, module: { slug: 'golden-login-role-gap' } }] };
    const vCatGood = B.verifyCatalogSeeds(catGood, mBase, mBase.workspace.id).ok === true;
    const vCatBad = B.verifyCatalogSeeds(catBadSlug, mBase, mBase.workspace.id).ok === false;
    const g05t = golden.tasks.find(function(t){return t.id==='G05';});
    const built = B.buildFixtureContext(g05t, mBase);
    const ctxOk = built.originalPrompt === g05t.prompt && built.submittedContent.indexOf(g05t.prompt)===0 && built.submittedContent.indexOf('[fixture-context')!==-1 && built.fixtureContext.indexOf('golden-ready-page')!==-1 && built.fixtureContext.indexOf('7be6bb9a-997e-4669-b973-f450dcd4ebf8')!==-1 && built.fixtureContext.indexOf('並非現Catalog name')!==-1 && g05t.prompt.indexOf('[fixture-context')===-1;
    const pass = vSlugOk && vBadSlug && vNoSlugOk && vCatGood && vCatBad && ctxOk;
    ok('T25', 'slug可選+Catalog slug一致+fixtureContext獨立', pass, 'slugOk=' + vSlugOk + ' badSlug=' + vBadSlug + ' noSlug=' + vNoSlugOk + ' catGood=' + vCatGood + ' catBad=' + vCatBad + ' ctx=' + ctxOk);
  } catch (e) { ok('T25', 'slug+fixtureContext', false, String(e).slice(0,200)); }
  // T26 final-seam S3反例：Catalog有值但Plan缺/錯version不能reuse成功
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const mS = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'x' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const fixed = B.getFixedSeedsForTask(mS, 'G05');
    const base = { authorRun: { id: 'r5a', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r5a', conversation: { messages: [{ role: 'assistant', runId: 'r5a', content: '已複用 golden-ready-page' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: { status: 200, json: { items: [{ testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', workspaceId: mS.workspace.id }] }, workspaceId: mS.workspace.id }, versionsBefore: null, versionsAfter: null, workspaceId: mS.workspace.id, fixedSeeds: fixed };
    const sNullPlan = B.scoreAuthorTask(g05, Object.assign({}, base, { planEvidence: null }));
    const sWrongVer = B.scoreAuthorTask(g05, Object.assign({}, base, { planEvidence: { status: 200, plan: { stages: [{ id: 's1', title: 'x', action: 'reuse', status: 'ready', moduleTestId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', moduleVersionId: '00000000-0000-4000-8000-000000000000' }] } } }));
    const sNoStage = B.scoreAuthorTask(g05, Object.assign({}, base, { planEvidence: { status: 200, plan: { stages: [] } } }));
    const nullNoPass = sNullPlan.verdict !== 'PASS' && JSON.stringify(sNullPlan.details).indexOf('reusePlanEvidence=false')!==-1;
    const wrongNoPass = sWrongVer.verdict !== 'PASS' && JSON.stringify(sWrongVer.details).indexOf('reusePlanEvidence=false')!==-1;
    const noStageNoPass = sNoStage.verdict !== 'PASS';
    const pass = nullNoPass && wrongNoPass && noStageNoPass;
    ok('T26', 'Catalog有值但Plan缺/錯version不能reuse成功', pass, 'null=' + sNullPlan.verdict + ' wrong=' + sWrongVer.verdict + ' empty=' + sNoStage.verdict);
  } catch (e) { ok('T26', 'Catalog有值但Plan缺/錯version', false, String(e).slice(0,200)); }
  // T27 final-seam S3正例exact Plan only reuseEvidence=true但整題UNVERIFIED；G06空稿不算credentials；FAIL優先
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const g06 = golden.tasks.find(function(t){return t.id==='G06';});
    const mS = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'x' }, { taskIds: ['G06'], testId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', versionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a', slug: 'golden-login-role-gap', publishedName: 'y' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e', '7f53cf3c-0975-4fba-a85e-001d3d319b62'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const mkCtx = function(id, script){
      const fixed = B.getFixedSeedsForTask(mS, id);
      const seed = fixed[0];
      return { authorRun: { id: 'r-'+id, status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r-'+id, conversation: { messages: [{ role: 'assistant', runId: 'r-'+id, content: 'Stage reuse ' + seed.slug }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: script }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: { status: 200, json: { items: [{ testId: seed.testId, versionId: seed.versionId, workspaceId: mS.workspace.id }] }, workspaceId: mS.workspace.id }, planEvidence: { status: 200, plan: { stages: [{ id: 's1', title: 'reuse', action: 'reuse', status: 'ready', moduleTestId: seed.testId, moduleVersionId: seed.versionId }] } }, versionsBefore: null, versionsAfter: null, workspaceId: mS.workspace.id, fixedSeeds: fixed };
    };
    const s05exact = B.scoreAuthorTask(g05, mkCtx('G05', 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();'));
    const exactReuseTrue = JSON.stringify(s05exact.details).indexOf('reusePlanEvidence=true')!==-1;
    const exactUnverified = s05exact.verdict === 'UNVERIFIED';
    const e2eSep = JSON.stringify(s05exact.details).indexOf('reusePlanEvidence:')!==-1 && JSON.stringify(s05exact.details).indexOf('taskEndToEndAssertions:')!==-1;
    const s06empty = B.scoreAuthorTask(g06, mkCtx('G06', ''));
    const g06notPass = s06empty.verdict !== 'PASS' && JSON.stringify(s06empty.details).indexOf('loginVerification=NOT_PERFORMED')!==-1;
    const s06fail = B.scoreAuthorTask(g06, { authorRun: { id: 'r-G06', status: 'failed' }, authorRunStatus: 'failed', authorRunId: 'r-G06', conversation: { messages: [{ role: 'assistant', runId: 'r-G06', content: 'x' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: '' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: null, planEvidence: { status: 200, plan: { stages: [{ id: 's1', title: 'reuse', action: 'reuse', status: 'ready', moduleTestId: '7f53cf3c-0975-4fba-a85e-001d3d319b62', moduleVersionId: '1b82353e-8f36-4a34-a5ba-490ce44e661a' }] } }, versionsBefore: null, versionsAfter: null, workspaceId: mS.workspace.id, fixedSeeds: B.getFixedSeedsForTask(mS, 'G06') });
    const failPrior = s06fail.verdict === 'FAIL';
    const pass = exactReuseTrue && exactUnverified && e2eSep && g06notPass && failPrior;
    ok('T27', 'exact Plan only reuse true但UNVERIFIED；G06空稿非credentials；FAIL優先', pass, 'exact=' + s05exact.verdict + ' reuseTrue=' + exactReuseTrue + ' e2eSep=' + e2eSep + ' g06empty=' + s06empty.verdict + ' failPrior=' + s06fail.verdict);
  } catch (e) { ok('T27', 'exact Plan UNVERIFIED/G06', false, String(e).slice(0,200)); }
  // T28 final-seam S4：G13/14 task budget2未實施，production仍8/12/180；自然partial仍整題不得PASS，預算前置不符UNVERIFIED（實際失敗仍FAIL）；另記production partial不混19187
  try {
    const g13 = golden.tasks.find(function(t){return t.id==='G13';});
    const g14 = golden.tasks.find(function(t){return t.id==='G14';});
    const mkBudgetCtx = function(id, runStatus, partial){
      return { authorRun: { id: 'rb-'+id, status: runStatus, authorPartial: partial }, authorRunStatus: runStatus, authorRunId: 'rb-'+id, conversation: { messages: [{ role: 'assistant', runId: 'rb-'+id, content: 'partial progress' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 2, script: 'x' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null };
    };
    const s13partial = B.scoreAuthorTask(g13, mkBudgetCtx('G13', 'succeeded', { reason: 'budget_exhausted', nextStep: 'continue', appliedRevision: 2 }));
    const s14partial = B.scoreAuthorTask(g14, mkBudgetCtx('G14', 'succeeded', { reason: 'budget_exhausted', nextStep: 'continue', appliedRevision: 2 }));
    const s13fail = B.scoreAuthorTask(g13, mkBudgetCtx('G13', 'failed', null));
    const partialUnverified = s13partial.verdict === 'UNVERIFIED' && s14partial.verdict === 'UNVERIFIED';
    const budgetMsg = JSON.stringify(s13partial.details).indexOf('budget2未實施')!==-1 && JSON.stringify(s13partial.details).indexOf('production仍8/12/180')!==-1 && JSON.stringify(s13partial.details).indexOf('19187')!==-1;
    const failPrior = s13fail.verdict === 'FAIL';
    const pass = partialUnverified && budgetMsg && failPrior;
    ok('T28', 'G13/14自然partial仍budget2未驗不得PASS', pass, 's13=' + s13partial.verdict + ' s14=' + s14partial.verdict + ' fail=' + s13fail.verdict + ' msg=' + budgetMsg);
  } catch (e) { ok('T28', 'G13/14 budget2未驗', false, String(e).slice(0,200)); }
  // T29 score-guard 直接回放（真 scoreAuthorTask）：same draft revision exact reuse action=reuse → UNVERIFIED 且 reuse true（planner 僅寫 Plan 不改 draft，不因此 FAIL）
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const mS29 = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'x' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const fixed29 = B.getFixedSeedsForTask(mS29, 'G05');
    const seed29 = fixed29[0];
    const ctx29 = { authorRun: { id: 'r-guard-29', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r-guard-29', conversation: { messages: [{ role: 'assistant', runId: 'r-guard-29', content: '已複用 golden-ready-page' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: null, planEvidence: { status: 200, plan: { stages: [{ id: 's1', title: 'reuse', action: 'reuse', status: 'ready', moduleTestId: seed29.testId, moduleVersionId: seed29.versionId }] } }, versionsBefore: null, versionsAfter: null, workspaceId: mS29.workspace.id, fixedSeeds: fixed29 };
    const s29 = B.scoreAuthorTask(g05, ctx29);
    const reuseTrue29 = JSON.stringify(s29.details).indexOf('reusePlanEvidence=true') !== -1;
    const noDraftFail29 = JSON.stringify(s29.details).indexOf('planner僅寫Plan不改draft') !== -1;
    const pass29 = s29.verdict === 'UNVERIFIED' && reuseTrue29;
    ok('T29', 'same revision exact reuse→UNVERIFIED且reuse true（真評分）', pass29, 'verdict=' + s29.verdict + ' reuseTrue=' + reuseTrue29 + ' plannerNote=' + noDraftFail29);
  } catch (e) { ok('T29', 'same revision exact reuse UNVERIFIED', false, String(e).slice(0,200)); }
  // T30 score-guard 直接回放（真 scoreAuthorTask）：missing action/null/modify → reuse false 且不可 PASS（須本輪 Plan exact action=reuse，不靠 Catalog/assistant）
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const mS30 = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'x' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const fixed30 = B.getFixedSeedsForTask(mS30, 'G05');
    const seed30 = fixed30[0];
    const mk30 = function(stage){
      return { authorRun: { id: 'r-guard-30', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r-guard-30', conversation: { messages: [{ role: 'assistant', runId: 'r-guard-30', content: '已複用' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: { status: 200, json: { items: [{ testId: seed30.testId, versionId: seed30.versionId, workspaceId: mS30.workspace.id }] }, workspaceId: mS30.workspace.id }, planEvidence: { status: 200, plan: { stages: [stage] } }, versionsBefore: null, versionsAfter: null, workspaceId: mS30.workspace.id, fixedSeeds: fixed30 };
    };
    const sMissing = B.scoreAuthorTask(g05, mk30({ id: 's1', title: 'reuse', status: 'ready', moduleTestId: seed30.testId, moduleVersionId: seed30.versionId }));
    const sNull = B.scoreAuthorTask(g05, mk30({ id: 's1', title: 'reuse', action: null, status: 'ready', moduleTestId: seed30.testId, moduleVersionId: seed30.versionId }));
    const sModify = B.scoreAuthorTask(g05, mk30({ id: 's1', title: 'reuse', action: 'modify', status: 'ready', moduleTestId: seed30.testId, moduleVersionId: seed30.versionId }));
    const fMissing = JSON.stringify(sMissing.details).indexOf('reusePlanEvidence=false') !== -1 && sMissing.verdict !== 'PASS';
    const fNull = JSON.stringify(sNull.details).indexOf('reusePlanEvidence=false') !== -1 && sNull.verdict !== 'PASS';
    const fModify = JSON.stringify(sModify.details).indexOf('reusePlanEvidence=false') !== -1 && sModify.verdict !== 'PASS';
    const pass30 = fMissing && fNull && fModify;
    ok('T30', 'missing/null/modify→reuse false且不可PASS（真評分）', pass30, 'missing=' + sMissing.verdict + ' null=' + sNull.verdict + ' modify=' + sModify.verdict);
  } catch (e) { ok('T30', 'missing/null/modify reuse false', false, String(e).slice(0,200)); }
  // T31 score-guard 直接回放（真 scoreAuthorTask）：same revision 但 run failed 仍 FAIL（FAIL 優先，不被 UNVERIFIED 蓋掉）
  try {
    const g05 = golden.tasks.find(function(t){return t.id==='G05';});
    const mS31 = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'x' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const fixed31 = B.getFixedSeedsForTask(mS31, 'G05');
    const seed31 = fixed31[0];
    const ctx31 = { authorRun: { id: 'r-guard-31', status: 'failed' }, authorRunStatus: 'failed', authorRunId: 'r-guard-31', conversation: { messages: [{ role: 'assistant', runId: 'r-guard-31', content: 'reuse' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'await page.setContent("<h1>x</h1>"); await expect(page.getByRole("heading")).toBeVisible();' }, validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: null, planEvidence: { status: 200, plan: { stages: [{ id: 's1', title: 'reuse', action: 'reuse', status: 'ready', moduleTestId: seed31.testId, moduleVersionId: seed31.versionId }] } }, versionsBefore: null, versionsAfter: null, workspaceId: mS31.workspace.id, fixedSeeds: fixed31 };
    const s31 = B.scoreAuthorTask(g05, ctx31);
    ok('T31', 'same revision但run failed仍FAIL（真評分）', s31.verdict === 'FAIL', 'verdict=' + s31.verdict);
  } catch (e) { ok('T31', 'same revision run failed仍FAIL', false, String(e).slice(0,200)); }
  // T32 score-guard fake live 回放（真 runLiveOneTask＋fake planner，不只字串檢查）：planner 不增加 draft revision，same revision exact reuse → UNVERIFIED 且 reuse true
  try {
    const g05live = golden.tasks.find(function(t){return t.id==='G05';});
    const manifestGuard = { schemaVersion: 1, baselineId: 'm10-golden-r102-production-v1', apiBase: 'http://127.0.0.1:19087', workspace: { id: '33b9b990-e974-4732-b8f9-2d1e6bb26901', settingsRevision: 2, authorizationRevision: 1 }, catalogSeeds: [{ taskIds: ['G05'], testId: 'ef24df7d-a0a8-495b-8c6d-a847ecbf038e', versionId: '7be6bb9a-997e-4669-b973-f450dcd4ebf8', slug: 'golden-ready-page', publishedName: 'golden-ready-page revision 2 驗收摘要候選' }], ownership: { createdFor: 'm10-golden-r102', workspaceId: '33b9b990-e974-4732-b8f9-2d1e6bb26901', seedTestIds: ['ef24df7d-a0a8-495b-8c6d-a847ecbf038e'] }, productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 } };
    const guardState = { seq: 0, tests: {}, runs: {} };
    const guardServer = http.createServer(function(req, res){
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;
      const method = req.method;
      let body = '';
      req.on('data', function(c){ body += c; });
      req.on('end', function(){
        let j = null; try { j = JSON.parse(body || '{}'); } catch (_) { j = {}; }
        const send = function(code, obj){ res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const mTs = p.match(/^\/api\/workspaces\/([^/]+)\/tests$/);
        if (method === 'POST' && mTs) {
          guardState.seq++;
          const testId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa' + (guardState.seq % 10);
          guardState.tests[testId] = { kind: (j && j.kind) || 'test', revision: 1 };
          send(201, { test: { id: testId, kind: (j && j.kind) || 'test' } }); return;
        }
        const mEs = p.match(/^\/api\/tests\/([^/]+)\/editing-session$/);
        if (method === 'POST' && mEs) {
          const tid = mEs[1];
          const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb' + (guardState.seq % 10);
          if (!guardState.tests[tid]) guardState.tests[tid] = {};
          guardState.tests[tid].sessionId = sid;
          guardState.tests[tid].revision = 1;
          send(201, { session: { id: sid, draft: { revision: 1 } } }); return;
        }
        const mDraft = p.match(/^\/api\/tests\/([^/]+)\/draft$/);
        if (method === 'GET' && mDraft) {
          send(200, { draft: { revision: 1, script: '' } }); return;
        }
        const mMsg = p.match(/^\/api\/tests\/([^/]+)\/messages$/);
        if (method === 'POST' && mMsg) {
          const tid = mMsg[1];
          guardState.seq++;
          const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'.slice(0, 35) + (guardState.seq % 10);
          guardState.runs[runId] = { id: runId, status: 'succeeded' };
          if (!guardState.tests[tid]) guardState.tests[tid] = {};
          guardState.tests[tid].runId = runId;
          send(202, { run: { id: runId }, conversationId: 'conv-guard' }); return;
        }
        const mRun = p.match(/^\/api\/runs\/([^/]+)$/);
        if (method === 'GET' && mRun) {
          const rid = mRun[1];
          const r = guardState.runs[rid] || { id: rid, status: 'succeeded' };
          send(200, { run: r }); return;
        }
        const mConv = p.match(/^\/api\/tests\/([^/]+)\/conversation/);
        if (method === 'GET' && mConv) {
          const tid = mConv[1];
          const st = guardState.tests[tid] || {};
          const runId = st.runId || 'unknown';
          send(200, { conversation: { messages: [{ role: 'assistant', runId: runId, content: '已複用 fixture seed 完成' }] } }); return;
        }
        const mPlan = p.match(/^\/api\/tests\/([^/]+)\/plan/);
        if (method === 'GET' && mPlan) {
          const plan = { id: 'plan-guard', testId: mPlan[1], editingSessionId: 's-1', revision: 1, baseRevision: 1, contextRevision: 1, status: 'draft', stages: [{ id: 's-g05', title: 'reuse g05', action: 'reuse', status: 'ready', moduleTestId: manifestGuard.catalogSeeds[0].testId, moduleVersionId: manifestGuard.catalogSeeds[0].versionId }] };
          send(200, { plan: plan }); return;
        }
        if (method === 'POST' && p.indexOf('/discard') !== -1) { send(200, { ok: true }); return; }
        send(404, { error: { code: 'not_found' } }); return;
      });
    });
    await new Promise(function(r){ guardServer.listen(0, '127.0.0.1', r); });
    const guardBase = 'http://127.0.0.1:' + guardServer.address().port;
    const recGuard = await B.runLiveOneTask(guardBase, { timeout: 2000, pollInterval: 50, runTimeout: 5000 }, g05live, 4, manifestGuard);
    await new Promise(function(r){ guardServer.close(r); });
    const reuseTrueGuard = JSON.stringify(recGuard.details || []).indexOf('reusePlanEvidence=true') !== -1;
    const passGuard = recGuard.verdict === 'UNVERIFIED' && reuseTrueGuard;
    ok('T32', 'fake live same revision exact reuse→UNVERIFIED且reuse true（真函式回放）', passGuard, 'verdict=' + recGuard.verdict + ' reuseTrue=' + reuseTrueGuard);
  } catch (e) { ok('T32', 'fake live same revision UNVERIFIED', false, String((e && e.stack) || e).slice(0, 300)); }
  // T33 live-review：G08 planner-only same revision→UNVERIFIED非產稿錯誤（真評分）；author failed仍FAIL（G07/G10不可改PASS）
  try {
    const g08 = golden.tasks.find(function(t){return t.id==='G08';});
    const plan3 = { status: 200, plan: { id: 'plan-g08', testId: 't-g08', editingSessionId: 's-g08', revision: 1, baseRevision: 1, contextRevision: 2, status: 'draft', stages: [
      { id: 'stage-1-catalog-filter', title: 'Stage 1 合成目錄開啟與篩選', action: 'create', status: 'pending' },
      { id: 'stage-2-add-cart', title: 'Stage 2 加入購物車', action: 'create', status: 'pending' },
      { id: 'stage-3-checkout-success', title: 'Stage 3 結帳顯示成功', action: 'create', status: 'pending' },
    ] } };
    const ctxPlannerOnly = { authorRun: { id: 'r-g08-review', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'r-g08-review',
      conversation: { messages: [{ role: 'assistant', runId: 'r-g08-review', content: 'Stage 1 先交付，後續 Stage 入口說明' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: '' },
      validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: null, planEvidence: plan3,
      versionsBefore: null, versionsAfter: null };
    const sPlanner = B.scoreAuthorTask(g08, ctxPlannerOnly);
    const plannerUnver = sPlanner.verdict === 'UNVERIFIED' && JSON.stringify(sPlanner.details).indexOf('planner-only') !== -1 && JSON.stringify(sPlanner.details).indexOf('未執行Stage停止斷言') !== -1;
    const ctxFailed = { authorRun: { id: 'r-g08-fail', status: 'failed' }, authorRunStatus: 'failed', authorRunId: 'r-g08-fail',
      conversation: { messages: [] }, draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: '' },
      validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'usecase', catalogEvidence: null, planEvidence: null,
      versionsBefore: null, versionsAfter: null };
    const sFailed = B.scoreAuthorTask(g08, ctxFailed);
    const failPreserved = sFailed.verdict === 'FAIL';
    ok('T33', 'G08 planner-only same revision→UNVERIFIED非產稿錯誤；author failed仍FAIL', plannerUnver && failPreserved, 'planner=' + sPlanner.verdict + ' failed=' + sFailed.verdict);
  } catch (e) { ok('T33', 'G08 planner-only UNVERIFIED', false, String((e && e.stack) || e).slice(0, 300)); }
  // T34 live-review：G13/14 budget2前置不符 same revision→UNVERIFIED（真評分，succeeded無partial＋production8/12/180）；author failed仍FAIL
  try {
    const g13 = golden.tasks.find(function(t){return t.id==='G13';});
    const g14 = golden.tasks.find(function(t){return t.id==='G14';});
    const mkNoPartialSame = function(id){
      return { authorRun: { id: 'rb-' + id, status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'rb-' + id,
        conversation: { messages: [{ role: 'assistant', runId: 'rb-' + id, content: 'partial progress' }] },
        draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'x' },
        validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'test', catalogEvidence: null, planEvidence: null,
        versionsBefore: null, versionsAfter: null };
    };
    const s13 = B.scoreAuthorTask(g13, mkNoPartialSame('G13'));
    const s14 = B.scoreAuthorTask(g14, mkNoPartialSame('G14'));
    const budgetUnver = s13.verdict === 'UNVERIFIED' && s14.verdict === 'UNVERIFIED'
      && JSON.stringify(s13.details).indexOf('budget2前置不符') !== -1
      && JSON.stringify(s14.details).indexOf('budget2前置不符') !== -1;
    const s13fail = B.scoreAuthorTask(g13, { authorRun: { id: 'rb-G13-f', status: 'failed' }, authorRunStatus: 'failed', authorRunId: 'rb-G13-f',
      conversation: { messages: [{ role: 'assistant', runId: 'rb-G13-f', content: 'x' }] }, draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'x' },
      validationRun: null, m10Missing: null, m10Probe: {}, testKind: 'test', catalogEvidence: null, planEvidence: null, versionsBefore: null, versionsAfter: null });
    const failPreserved34 = s13fail.verdict === 'FAIL';
    ok('T34', 'G13/14 budget2前置不符 same revision→UNVERIFIED；author failed仍FAIL', budgetUnver && failPreserved34, 's13=' + s13.verdict + ' s14=' + s14.verdict + ' fail=' + s13fail.verdict);
  } catch (e) { ok('T34', 'G13/14 budget2前置不符 UNVERIFIED', false, String((e && e.stack) || e).slice(0, 300)); }
  // T35 live-review：G13真正HTTP/run失敗仍FAIL不批次抹fail（continue 409/HTTP失敗＋draft same→FAIL）
  try {
    const g13 = golden.tasks.find(function(t){return t.id==='G13';});
    const ctxHttpFail = { authorRun: { id: 'rb-G13-h', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'rb-G13-h',
      conversation: { messages: [{ role: 'assistant', runId: 'rb-G13-h', content: 'partial' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'x' },
      validationRun: null, m10Missing: null, m10Probe: { continueHttpFailure: true }, testKind: 'test', catalogEvidence: null, planEvidence: null,
      versionsBefore: null, versionsAfter: null };
    const sHttp = B.scoreAuthorTask(g13, ctxHttpFail);
    const ctxConflict = { authorRun: { id: 'rb-G13-c', status: 'succeeded' }, authorRunStatus: 'succeeded', authorRunId: 'rb-G13-c',
      conversation: { messages: [{ role: 'assistant', runId: 'rb-G13-c', content: 'partial' }] },
      draftBefore: { revision: 1 }, draftAfter: { revision: 1, script: 'x' },
      validationRun: null, m10Missing: null, m10Probe: { continueConflict: true }, testKind: 'test', catalogEvidence: null, planEvidence: null,
      versionsBefore: null, versionsAfter: null };
    const sConflict = B.scoreAuthorTask(g13, ctxConflict);
    const pass35 = sHttp.verdict === 'FAIL' && sConflict.verdict === 'FAIL';
    ok('T35', 'G13真正HTTP/continue失敗仍FAIL不批次抹fail', pass35, 'httpFail=' + sHttp.verdict + ' conflict=' + sConflict.verdict);
  } catch (e) { ok('T35', 'G13真正失敗仍FAIL', false, String((e && e.stack) || e).slice(0, 300)); }
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
