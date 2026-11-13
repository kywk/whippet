// Browser regression: synthetic API only, never contact a real Whippet backend.
// Uses existing worker Playwright; serve the built apps/web/dist on isolated 5187.
import { chromium } from '../../../runtimes/worker/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
const out=process.env.REVIEW_OUT ?? '/private/tmp/whippet-m10-web-review/stage-retry/latest';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE ?? '/Users/kywk/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const results=[];const now='2026-11-13T00:00:00Z',tid='synthetic-usecase',sid='synthetic-session',wid='synthetic-workspace',pid='synthetic-plan';
const workspace={id:wid,name:'合成 API：Stage 重試測試',revision:1,authorizationRevision:1,lifecycle:'active',scopeStatus:'confirmed',settings:null,conversationId:'workspace-chat',activeRunId:null,currentProposal:null,sites:[],defaultTestUrl:'',timeoutMs:60000,roles:[],secretsAvailable:false,executionAvailable:true,unavailableReason:null,capabilities:Object.fromEntries(['aiExploration','aiExecution','manualExecution','credentialLogin'].map(k=>[k,{available:true,reason:null}]))};
const draft={testId:tid,editingSessionId:sid,revision:2,script:'// 合成：未執行測試',updatedAt:now,scriptOrigin:'manual',validationRunId:'validation',validationStatus:'succeeded',reportUrl:'/synthetic-report'};
const run={id:'validation',workspaceId:wid,testId:tid,editingSessionId:sid,kind:'validation',status:'succeeded',draftRevision:2,createdAt:now,finishedAt:now,reportUrl:'/synthetic-report'};
const version={id:'published-usecase',testId:tid,editingSessionId:sid,revision:2,script:draft.script,createdAt:now,validationRunId:run.id,summaryRunId:'summary',description:'合成已發佈版本',backgroundSummary:'僅回歸測試，沒有真後端寫入。',scriptOrigin:'manual'};
const candidate={testId:'candidate-module',versionId:'candidate-version',name:'合成候選',slug:'synthetic-candidate',moduleKind:'step',revision:2,bundleHash:'c'.repeat(64)};
try{for(const [size,width]of [['desktop',1440],['narrow',390]])for(const status of (process.env.RETRY_CASES?.split(',').map(v=>/^\d+$/.test(v)?Number(v):v) ?? [200,409,503,'gates'])){
 const context=await browser.newContext({viewport:{width,height:width===390?844:1000},reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(10000);const calls=[],errors=[];let published=false,publishAt,retryCount=0,gate='ready',contextRevision=3;
 const test=()=>({id:tid,workspaceId:wid,kind:'usecase',name:'合成 Stage 人工修復',description:'合成 fixture',publishedVersionId:published?version.id:null,activeEditingSession:published?null:{id:sid,status:'active',draftRevision:2,updatedAt:now}});
 const session=()=>({id:sid,testId:tid,workspaceId:wid,status:published?'published':'active',sourceVersionId:null,sourceVersion:null,conversationId:'chat',conversationSummary:null,contextRevision:1,draft:published?null:draft,summary:null,pendingRunIds:[],reclaimPending:false,publishedVersionId:published?version.id:null,createdAt:now,closedAt:published?now:null});
 const plan=()=>({id:pid,testId:tid,editingSessionId:sid,revision:3,baseRevision:2,contextRevision:1,status:'stopped',validationRunId:run.id,stages:[{id:'candidate',title:'合成新建',action:'create',status:'failed',error:'合成 author 失敗',authorRunId:'failed-author',module:{slug:candidate.slug,moduleKind:'step',description:'合成'},moduleTestId:candidate.testId,candidateVersionId:candidate.versionId,draftRevision:2,args:{}}]});
 const retry=()=>({eligible:gate==='ready',reason:gate==='ready'?null:gate==='missing'?'source_unavailable':gate==='unknown'?'future_reason':'reclaim_pending',planRevision:3,source:gate==='missing'?null:{moduleTestId:'candidate-module',editingSessionId:'module-session',moduleRevision:2,moduleContextRevision:contextRevision,authorRunId:'failed-author',authorStatus:'failed',validationRunId:null,validationStatus:null,reclaimed:gate==='ready'}});
 const summary=()=>({runId:'summary',planId:pid,planRevision:3,batchHash:'b'.repeat(64),status:'succeeded',stale:false,publishReady:!published,message:'合成摘要',name:'合成批次',description:'合成完整摘要，無真實驗證。',backgroundSummary:'合成背景。',candidates:[candidate]});
 await page.addInitScript(()=>addEventListener('DOMContentLoaded',()=>{const b=document.createElement('div');b.textContent='合成 API 回歸測試 · 非真後端驗收';b.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff0b5;color:#432b00;text-align:center;padding:5px;pointer-events:none';document.body.append(b);}));
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname.replace('/api',''),method=req.method();calls.push({method,path,at:Date.now(),body:req.postDataJSON()});let data,code=200;
 if(path==='/dev-login')data={user:{id:'admin',role:'superadmin'}};
 else if(path==='/workspaces')data={items:[workspace]};
 else if(path===`/workspaces/${wid}`||path===`/workspaces/${wid}/settings`)data=workspace;
 else if(path===`/workspaces/${wid}/tests`)data={items:[test()]};
 else if(path===`/tests/${tid}`)data=test();
 else if(path===`/tests/${tid}/versions`)data={items:published?[version]:[]};
 else if(path===`/tests/${tid}/draft`)data=draft;
 else if(path===`/tests/${tid}/editing-sessions/${sid}`)data={session:session()};
 else if(path===`/tests/${tid}/editing-sessions`)data={items:[session()]};
 else if(path.endsWith('/conversation'))data={id:'chat',testId:tid,editingSessionId:sid,messages:[]};
 else if(path===`/tests/${tid}/runs`)data={items:[run]};
 else if(path===`/runs/${run.id}`)data=run;
 else if(path.endsWith('/artifacts'))data={items:[]};
 else if(path===`/tests/${tid}/plan`)data={plan:plan()};
 else if(path===`/plans/${pid}/summary`&&method==='GET')data={summary:null};
 else if(path===`/plans/${pid}/stages/candidate/retry`){if(method==='GET')data={retry:retry()};else{retryCount++;if(status==='network'){await route.abort('failed');return;}code=status;data=status===200?{plan:{...plan(),status:'running',revision:4}}:{error:{code:'CONFLICT',message:'合成失敗'}};}}
 else if(path===`/plans/${pid}/publish`&&method==='POST'){publishAt=Date.now();code=status;if(status===200){published=true;data={usecaseVersion:version,moduleVersions:[{...version,id:candidate.versionId,testId:candidate.testId}]};}else data={error:{code:status===409?'CONFLICT':'UNAVAILABLE',message:`合成${status}：不可假稱發佈成功`}};}
 else {code=404;data={error:{code:'UNHANDLED',message:path}};errors.push(`unhandled ${method} ${path}`);}
 if(path.endsWith('/retry') || path===`/tests/${tid}/plan`)calls[calls.length-1].syntheticResponse={status:code,body:data};
 await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(data)});
 });
 const label=`${size}-${status}`;const result={label};
 try{
 await page.goto('http://127.0.0.1:5187/');await page.getByRole('button',{name:'以開發管理員登入'}).click();await page.locator('#side-tab-script').waitFor({state:'attached'});if(width<=1220)await page.getByRole('button',{name:'展開右側欄',exact:true}).click();await page.getByRole('tab',{name:'驗證與發佈',exact:true}).click();const panel=page.locator('.plan-panel');await panel.getByRole('button',{name:'修復並重試',exact:true}).click();const form=page.getByRole('region',{name:'失敗 Stage 人工修復',exact:true});const text=form.getByRole('textbox',{name:'人工修復指示'}),check=form.getByRole('checkbox'),submit=form.getByRole('button',{name:'確認修復並重試',exact:true});
 await text.fill('  合成人工修復 🐕  ');await check.check();await text.fill('  合成人工修復 🐕 再核對  ');assert.equal(await check.isChecked(),false);await check.check();
 if(status==='gates'||status==='unknown'){
 if(status==='unknown'){gate='unknown';await page.waitForTimeout(3300);assert.ok(await submit.isDisabled());assert.ok(await check.isDisabled());await form.getByRole('alert').waitFor();}else{
 contextRevision=4;await page.waitForTimeout(3300);assert.equal(await check.isChecked(),false,'snapshot changed clears confirmation');
 gate='reclaim';await page.waitForTimeout(3300);assert.ok(await submit.isDisabled());assert.ok(await check.isDisabled());
 gate='missing';await page.waitForTimeout(3300);assert.ok(await submit.isDisabled());await form.getByText('尚無完整來源與回收證據，不可重試。').waitFor();}
 }else{
 await form.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${label}-before.png`,fullPage:true});await submit.click();await page.waitForTimeout(3500);assert.equal(retryCount,1);const sent=calls.find(c=>c.method==='POST'&&c.path.endsWith('/retry'));assert.deepEqual(sent.body,{planRevision:3,moduleRevision:2,moduleContextRevision:3,confirmed:true,content:'  合成人工修復 🐕 再核對  '});assert.ok(await submit.isDisabled());if(status===200){assert.ok((await panel.innerText()).includes('已停止 · Plan r3'),'GET current stopped wins over historical running receipt');assert.ok(calls.some(c=>c.path===`/tests/${tid}/plan`&&c.at>=sent.at));}else{await page.waitForTimeout(3200);assert.equal(retryCount,1);assert.ok(await submit.isDisabled());}
 }
 await form.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${label}.png`,fullPage:true});await writeFile(`${out}/${label}.txt`,await page.locator('body').innerText());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth)<=width);assert.deepEqual(errors,[]);assert.ok(calls.every(c=>c.method==='GET'||c.path==='/dev-login'||c.path.endsWith('/retry')));result.verdict='PASS';result.retryPosts=retryCount;
 }catch(e){result.verdict='FAIL';result.error=e.stack;process.exitCode=1;await page.screenshot({path:`${out}/${label}-failure.png`,fullPage:true});}
 result.errors=errors;results.push(result);await writeFile(`${out}/${label}-requests.json`,JSON.stringify(calls,null,2));await context.close();
 }}finally{await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));await browser.close();console.log(JSON.stringify({out,results},null,2));}
