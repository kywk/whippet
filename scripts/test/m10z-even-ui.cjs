#!/usr/bin/env node
// M10.Z #2 第一段：真 UI 登入、兩 Workspace 切換與持久化外框；不建立 Run、不讀對話正文。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const ROOT = '/private/tmp/whippet-m10z-20261114';
const OUT = path.join(ROOT, 'even');
const API = 'https://127.0.0.1:19889';
const WEB = 'http://127.0.0.1:19887';
const STATE = path.join(OUT, 'case2-workspaces.json');
const RESULT = path.join(OUT, 'case2-ui-read.json');
const JOURNEY_RESULT = path.join(OUT, 'case2-ui-journey.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > 128 * 1024) throw Error('input_invalid'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function save(file, value) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function guard() {
  const a = safeJson(path.join(ROOT, 'admission.json'));
  if (a.schemaVersion !== 1 || a.leader !== 't6g' || a.isolatedApi !== API) throw Error('leader_admission_required');
}
function api(method, route, body, cert) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(API + route, { method, ca: cert, timeout: 15000, headers: {
      Accept: 'application/json', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
    } }, res => {
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size <= 128 * 1024) chunks.push(b); else req.destroy(Error('response_limit')); });
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(Error('timeout'))); req.on('error', reject);
    if (bytes) req.write(bytes); req.end();
  });
}
async function createSecond() {
  guard();
  if (fs.existsSync(STATE)) throw Error('second_workspace_already_recorded');
  const fixture = safeJson(path.join(ROOT, 'business-fixture.json'));
  const cert = fs.readFileSync(path.join(ROOT, 'qa.crt'));
  const a = await api('GET', '/api/workspaces/' + fixture.workspaceId, undefined, cert);
  if (a.status !== 200 || !UUID.test(a.json?.id) || a.json.scopeStatus !== 'confirmed') throw Error('workspace_A_not_ready');
  const name = 'm10z-even-second-' + crypto.randomUUID().slice(0, 8);
  save(STATE, { status: 'INTENT', workspaceA: a.json.id, workspaceAConversationId: a.json.conversationId, workspaceBName: name, noRunScheduled: true });
  const b = await api('POST', '/api/workspaces', { name }, cert);
  if (b.status !== 201 || !UUID.test(b.json?.id) || b.json.id === a.json.id || b.json.conversationId === a.json.conversationId) throw Error('workspace_B_create_failed');
  save(STATE, { status: 'SECOND_CREATED', workspaceA: a.json.id, workspaceAConversationId: a.json.conversationId, workspaceB: b.json.id, workspaceBName: name, workspaceBConversationId: b.json.conversationId, noRunScheduled: true });
  process.stdout.write('SECOND_CREATED case2-workspaces.json\n');
}
async function uiRead() {
  guard();
  const s = safeJson(STATE);
  if (s.status !== 'SECOND_CREATED' || !UUID.test(s.workspaceA) || !UUID.test(s.workspaceB)) throw Error('two_workspace_setup_required');
  const { chromium } = require(path.join(__dirname, '../../runtimes/worker/node_modules/@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const result = { status: 'NOT_RUN', web: WEB, workspaceA: s.workspaceA, workspaceB: s.workspaceB, checks: {}, noConversationBodyRead: true, noRunScheduled: true };
  let step = 'open';
  try {
    const page = await browser.newPage();
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const login = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await login.count() === 1) await login.click();
    const combo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await combo.waitFor({ state: 'visible', timeout: 30000 });
    result.checks.login = true;
    async function switchTo(id, name) {
      result.uiSubstep = 'select';
      if ((await combo.evaluate(el => el.tagName)) === 'SELECT') await combo.selectOption(id);
      else { await combo.click(); const option = page.getByRole('option', { name, exact: true }); await option.waitFor({ state: 'visible', timeout: 10000 }); await option.click(); }
      result.uiSubstep = 'gear';
      await page.getByRole('button', { name: 'Workspace 設定', exact: true }).first().click();
      result.uiSubstep = 'heading';
      await page.getByRole('heading', { name: `Workspace：${name}`, exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      result.uiSubstep = 'log';
      await page.getByRole('log', { name: 'Workspace 設定對話' }).waitFor({ state: 'visible', timeout: 30000 });
      result.uiSubstep = 'done';
    }
    const cert = fs.readFileSync(path.join(ROOT, 'qa.crt'));
    const a = await api('GET', '/api/workspaces/' + s.workspaceA, undefined, cert);
    const b = await api('GET', '/api/workspaces/' + s.workspaceB, undefined, cert);
    if (a.status !== 200 || b.status !== 200 || a.json.conversationId !== s.workspaceAConversationId || b.json.conversationId !== s.workspaceBConversationId) throw Error('workspace_metadata_changed');
    step = 'workspace_A'; await switchTo(s.workspaceA, a.json.name); result.checks.workspaceAVisible = true;
    step = 'workspace_B'; await switchTo(s.workspaceB, b.json.name); result.checks.workspaceBVisible = true;
    step = 'reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    const relogin = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await relogin.count() === 1) await relogin.click();
    await combo.waitFor({ state: 'visible', timeout: 30000 });
    await switchTo(s.workspaceB, b.json.name);
    result.checks.workspaceBPersistedAfterReload = true;
    step = 'scoped_lists';
    const ta = await api('GET', `/api/workspaces/${s.workspaceA}/tests`, undefined, cert);
    const tb = await api('GET', `/api/workspaces/${s.workspaceB}/tests`, undefined, cert);
    if (ta.status !== 200 || tb.status !== 200 || !Array.isArray(ta.json?.items) || !Array.isArray(tb.json?.items)) throw Error('test_list_unavailable');
    const ownA = ta.json.items.some(x => x.id === safeJson(path.join(OUT, 'case4-plan-setup.json')).testId);
    const leaked = tb.json.items.some(x => x.id === safeJson(path.join(OUT, 'case4-plan-setup.json')).testId);
    result.checks.workspaceScopedTestList = ownA && !leaked;
    result.checks.distinctConversationIds = a.json.conversationId !== b.json.conversationId;
    result.status = Object.values(result.checks).every(Boolean) ? 'PASS_PARTIAL_UI_READ' : 'FAIL';
  } catch (_) { result.status = 'FAIL'; result.failedStep = step; }
  finally { await browser.close(); save(RESULT, result); }
  process.stdout.write(result.status + ' case2-ui-read.json\n');
  if (result.status !== 'PASS_PARTIAL_UI_READ') process.exitCode = 1;
}
async function journeyRead() {
  guard();
  const s = safeJson(path.join(OUT, 'case2-login-state.json'));
  if (s.phase !== 'REOPEN_SAVED' || !UUID.test(s.A?.testId) || !UUID.test(s.B?.testId) || !s.A?.reopenedPersisted) throw Error('journey_not_ready');
  const { chromium } = require(path.join(__dirname, '../../runtimes/worker/node_modules/@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const result = { status: 'NOT_RUN', checks: {}, noConversationBodyRead: true, noCredentialValueRead: true, noRunScheduled: true };
  let step = 'open';
  try {
    const page = await browser.newPage();
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 30000 });
    async function login() {
      const button = page.getByRole('button', { name: '以開發管理員登入', exact: true });
      if (await button.count() === 1) await button.click();
      await page.getByRole('combobox', { name: 'Workspace' }).first().waitFor({ state: 'visible', timeout: 30000 });
    }
    async function workspace(id) {
      const combo = page.getByRole('combobox', { name: 'Workspace' }).first();
      await combo.selectOption(id);
      await page.getByRole('button', { name: '重新載入測試列表' }).waitFor({ state: 'visible', timeout: 30000 });
    }
    async function test(name) {
      const row = page.locator('.test-item').filter({ hasText: name });
      await row.waitFor({ state: 'visible', timeout: 30000 });
      await row.click();
      await page.getByRole('heading', { name, exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    }
    await login(); result.checks.login = true;
    step = 'A_overview'; await workspace(s.A.workspaceId); await test(s.A.testIntentName);
    result.checks.AFormalEnabled = await page.getByRole('button', { name: '執行正式版本' }).isEnabled();
    result.checks.AVersionVisible = await page.getByText(s.A.versionId, { exact: true }).count() > 0;
    step = 'B_isolation'; await workspace(s.B.workspaceId);
    await page.locator('.test-item').filter({ hasText: s.B.testIntentName }).waitFor({ state: 'visible', timeout: 30000 });
    result.checks.ANotInBList = await page.locator('.test-item').filter({ hasText: s.A.testIntentName }).count() === 0;
    await test(s.B.testIntentName);
    result.checks.BUnpublished = await page.getByRole('button', { name: '執行正式版本' }).isDisabled();
    step = 'reload_A'; await page.reload({ waitUntil: 'domcontentloaded' }); await login(); await workspace(s.A.workspaceId); await test(s.A.testIntentName);
    await page.getByRole('tab', { name: /對話編輯/ }).click();
    await page.getByRole('tabpanel', { name: '測試編輯模式' }).waitFor({ state: 'visible', timeout: 30000 });
    const scriptView = page.getByLabel('目前草稿腳本');
    await scriptView.waitFor({ state: 'visible', timeout: 30000 });
    const scriptText = await scriptView.textContent();
    result.checks.reopenedDraftVisible = !!scriptText && scriptText.includes(s.A.roleId) && scriptText.includes('Authenticated A');
    result.checks.AFormalStillEnabled = await page.getByRole('button', { name: '執行正式版本' }).isEnabled();
    result.status = Object.values(result.checks).every(Boolean) ? 'PASS_UI_JOURNEY' : 'FAIL';
  } catch (_) { result.status = 'FAIL'; result.failedStep = step; }
  finally { await browser.close(); save(JOURNEY_RESULT, result); }
  process.stdout.write(result.status + ' case2-ui-journey.json\n');
  if (result.status !== 'PASS_UI_JOURNEY') process.exitCode = 1;
}
async function fullJourney(fixed = false) {
  guard();
  const stateFile = path.join(OUT, 'case2-login-state.json');
  const s = safeJson(stateFile);
  if (s.phase !== 'VALIDATE_B_DONE' || !UUID.test(s.A?.formalRunId) || !UUID.test(s.B?.validationRunId)) throw Error('journey_not_ready');
  if (fixed) { const old=safeJson(JOURNEY_RESULT); if(old.failedStep!=='A_overview'||Object.keys(old.uiMutationResponseIds||{}).length!==0)throw Error('prior_ui_mutation_unknown'); }
  const cert=fs.readFileSync(path.join(ROOT,'qa.crt'));
  const testA=await api('GET',`/api/tests/${s.A.testId}`,undefined,cert);
  const testB=await api('GET',`/api/tests/${s.B.testId}`,undefined,cert);
  if(testA.status!==200||testB.status!==200||testA.json?.workspaceId!==s.A.workspaceId||testB.json?.workspaceId!==s.B.workspaceId)throw Error('ui_test_metadata_changed');
  const nameA=testA.json.name, nameB=testB.json.name;
  const intentFile = path.join(OUT, fixed?'case2-ui-fixed-intent.json':'case2-ui-intent.json');
  fs.writeFileSync(intentFile, JSON.stringify({ status: 'STARTED', aTestId: s.A.testId, bTestId: s.B.testId, noAdditionalRun: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { chromium } = require(path.join(__dirname, '../../runtimes/worker/node_modules/@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const result = { status: 'NOT_RUN', checks: {}, uiMutationResponseIds: {}, noConversationBodyRead: true, noCredentialValueRead: true, noAdditionalRun: true };
  let step = 'open';
  try {
    const page = await browser.newPage();
    page.on('dialog', dialog => { void dialog.accept(); });
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 30000 });
    async function login() {
      const b = page.getByRole('button', { name: '以開發管理員登入', exact: true });
      if (await b.count() === 1) await b.click();
      await page.getByRole('combobox', { name: 'Workspace' }).first().waitFor({ state: 'visible', timeout: 30000 });
    }
    async function chooseWorkspace(id) { await page.getByRole('combobox', { name: 'Workspace' }).first().selectOption(id); await page.getByRole('button', { name: '重新載入測試列表' }).waitFor({ state: 'visible', timeout: 30000 }); }
    async function chooseTest(name) { const row=page.locator('.test-item').filter({hasText:name});await row.waitFor({state:'visible',timeout:30000});await row.click();await page.getByRole('heading',{name,exact:true}).waitFor({state:'visible',timeout:30000}); }
    await login(); result.checks.adminLogin = true;
    step='A_overview'; await chooseWorkspace(s.A.workspaceId); await chooseTest(nameA);
    result.checks.AFormalEnabled = await page.getByRole('button',{name:'執行正式版本'}).isEnabled();
    result.checks.AVersionVisible = await page.getByText(s.A.versionId,{exact:true}).count()>0;
    result.checks.AFormalHistoryVisible = await page.getByText(s.A.formalRunId,{exact:true}).count()>0;
    step='B_isolation'; await chooseWorkspace(s.B.workspaceId);
    await page.locator('.test-item').filter({hasText:nameB}).waitFor({state:'visible',timeout:30000});
    result.checks.AAbsentFromBList = await page.locator('.test-item').filter({hasText:nameA}).count()===0;
    await chooseTest(nameB);
    result.checks.BUnpublished = await page.getByRole('button',{name:'執行正式版本'}).isDisabled();
    step='A_reopen'; await chooseWorkspace(s.A.workspaceId); await chooseTest(nameA);
    const reopenResponse=page.waitForResponse(r=>r.request().method()==='POST'&&/\/api\/tests\/[^/]+\/editing-session$/.test(new URL(r.url()).pathname),{timeout:30000});
    await page.getByRole('tab',{name:/對話編輯/}).click();
    const rr=await reopenResponse; const opened=await rr.json();
    if(![200,201].includes(rr.status())||!UUID.test(opened?.session?.id))throw Error('ui_reopen_response_invalid');
    result.uiMutationResponseIds.reopenSessionId=opened.session.id;
    await page.getByRole('tabpanel',{name:'測試編輯模式'}).waitFor({state:'visible',timeout:30000});
    const panel=page.getByRole('tabpanel',{name:'測試編輯模式'});
    result.checks.AConversationPanel = await panel.getByLabel('對話編輯工作區').count()>0;
    result.checks.AScriptAndPublishPanel = await panel.getByLabel('腳本、驗證與發佈').count()>0;
    step='A_resume_edit'; await page.getByText('工程師手動修改（進階）').click();
    const input=page.locator('#draft-script'); await input.waitFor({state:'visible',timeout:30000});
    const current=await input.inputValue();
    if(!current.includes(s.A.roleId))throw Error('reopened_script_mismatch');
    const marker='// m10z even UI resume proof';
    await input.fill(current.trimEnd()+'\n'+marker+'\n');
    const saveResponse=page.waitForResponse(r=>r.request().method()==='PUT'&&/\/api\/tests\/[^/]+\/draft$/.test(new URL(r.url()).pathname),{timeout:30000});
    await page.getByRole('button',{name:'儲存草稿',exact:true}).click();
    const sr=await saveResponse; const saved=await sr.json();
    if(sr.status()!==200||!Number.isInteger(saved?.revision))throw Error('ui_save_response_invalid');
    result.uiMutationResponseIds.savedRevision=saved.revision;
    result.checks.reopenedSaved = (saved.script||'').includes(marker);
    step='reload_persistence'; await chooseWorkspace(s.B.workspaceId);await page.reload({waitUntil:'domcontentloaded'});await login();await chooseWorkspace(s.A.workspaceId);await chooseTest(nameA);
    await page.getByRole('tab',{name:/對話編輯/}).click();
    const code=page.getByLabel('目前草稿腳本');await code.waitFor({state:'visible',timeout:30000});
    result.checks.reopenedPersistedAfterSwitchReload = (await code.textContent()||'').includes(marker);
    step='ui_discard'; await page.getByRole('tab',{name:'概覽'}).click();
    await page.getByRole('button',{name:'刪除草稿'}).click();
    await page.getByRole('heading',{name:'確認放棄本次修改？'}).waitFor({state:'visible',timeout:30000});
    const discardResponse=page.waitForResponse(r=>r.request().method()==='POST'&&/\/api\/tests\/[^/]+\/editing-sessions\/[^/]+\/discard$/.test(new URL(r.url()).pathname),{timeout:30000});
    await page.getByRole('button',{name:'確認放棄草稿'}).click();
    const dr=await discardResponse; const discarded=await dr.json();
    if(![200,202].includes(dr.status())||discarded?.session?.id!==opened.session.id)throw Error('ui_discard_response_invalid');
    result.uiMutationResponseIds.discardSessionId=discarded.session.id;
    for(let i=0;i<45;i++){const v=await api('GET',`/api/tests/${s.A.testId}/editing-sessions/${opened.session.id}`,undefined,cert);if(v.status===200&&v.json?.session?.status==='discarded'){result.checks.uiDiscardCompleted=true;break;}await new Promise(r=>setTimeout(r,2000));}
    const a=await api('GET',`/api/tests/${s.A.testId}`,undefined,cert);
    result.checks.publishedVersionSurvives = a.status===200&&a.json?.publishedVersionId===s.A.versionId;
    result.status=Object.values(result.checks).every(Boolean)?'PASS_UI_JOURNEY':'FAIL';
  } catch (_) { result.status='FAIL'; result.failedStep=step; }
  finally { await browser.close(); fs.writeFileSync(fixed?path.join(OUT,'case2-ui-journey-fixed.json'):JOURNEY_RESULT,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600}); }
  process.stdout.write(result.status+' '+(fixed?'case2-ui-journey-fixed.json':'case2-ui-journey.json')+'\n');
  if(result.status!=='PASS_UI_JOURNEY')process.exitCode=1;
}
async function postReview() {
  guard(); const s=safeJson(path.join(OUT,'case2-login-state.json')); const prior=safeJson(path.join(OUT,'case2-ui-journey-fixed.json'));
  if(prior.uiMutationResponseIds?.reopenSessionId!==prior.uiMutationResponseIds?.discardSessionId||prior.checks?.uiDiscardCompleted!==true)throw Error('ui_mutation_not_verified');
  const cert=fs.readFileSync(path.join(ROOT,'qa.crt'));
  const a=await api('GET',`/api/tests/${s.A.testId}`,undefined,cert),b=await api('GET',`/api/tests/${s.B.testId}`,undefined,cert);
  if(a.status!==200||b.status!==200)throw Error('test_unavailable');
  const {chromium}=require(path.join(__dirname,'../../runtimes/worker/node_modules/@playwright/test'));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const result={status:'NOT_RUN',checks:{},noRunScheduled:true,noConversationBodyRead:true};let step='open';
  try{const page=await browser.newPage();await page.goto(WEB,{waitUntil:'domcontentloaded'});const login=page.getByRole('button',{name:'以開發管理員登入',exact:true});if(await login.count())await login.click();const combo=page.getByRole('combobox',{name:'Workspace'}).first();await combo.waitFor({state:'visible'});
    step='A_overview';await combo.selectOption(s.A.workspaceId);const ar=page.locator('.test-item').filter({hasText:a.json.name});await ar.waitFor({state:'visible'});await ar.click();await page.getByRole('heading',{name:a.json.name,exact:true}).waitFor();
    result.checks.ASummaryDescription=await page.locator('.version-description-content').evaluate(el=>!!el.textContent&&el.textContent.length>20&&!el.textContent.includes('尚無正式版本說明'));
    result.checks.AVersionReportLink=await page.getByRole('link',{name:'查看版本驗證報告'}).count()>0;
    result.checks.AFormalHistory=await page.getByText(s.A.formalRunId,{exact:true}).count()>0;
    result.checks.APublishedVersion=await page.getByText(s.A.versionId,{exact:true}).count()>0;
    step='B_editor';await combo.selectOption(s.B.workspaceId);const br=page.locator('.test-item').filter({hasText:b.json.name});await br.waitFor({state:'visible'});await br.click();await page.getByRole('tab',{name:/對話編輯/}).click();await page.getByRole('tabpanel',{name:'測試編輯模式'}).waitFor({state:'visible'});
    result.checks.BScriptPublishPanel=await page.locator('aside.studio-side[aria-label="腳本、驗證與發佈"]').count()>0;
    result.checks.BConversationPanel=await page.locator('section.studio-chat[aria-label="對話編輯工作區"]').count()>0;
    result.status=Object.values(result.checks).every(Boolean)?'PASS_UI_POST_REVIEW':'FAIL';
  }catch(_){result.status='FAIL';result.failedStep=step;}finally{await browser.close();fs.writeFileSync(path.join(OUT,'case2-ui-post-review.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});}
  process.stdout.write(result.status+' case2-ui-post-review.json\n');if(result.status!=='PASS_UI_POST_REVIEW')process.exitCode=1;
}
async function main() { const mode = process.argv[2] || '--prepare'; if (mode === '--prepare') return process.stdout.write('PREPARED no Run\n'); if (mode === '--create-second') return createSecond(); if (mode === '--ui-read') return uiRead(); if (mode === '--journey-read') return journeyRead(); if (mode === '--full-journey') return fullJourney(); if (mode === '--full-journey-fixed') return fullJourney(true); if (mode === '--post-review') return postReview(); throw Error('usage: --prepare | --create-second | --ui-read | --journey-read | --full-journey | --full-journey-fixed | --post-review'); }
main().catch(e => { process.stderr.write('BLOCKED ' + (e.message === 'second_workspace_already_recorded' ? e.message : 'precondition_or_api_failure') + '\n'); process.exitCode = 2; });
