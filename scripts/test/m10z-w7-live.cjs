#!/usr/bin/env node
// Synthetic live acceptance. Persist counts/times only, never pixels or signaling.
const fs=require('node:fs');
const {chromium}=require('../../runtimes/worker/node_modules/@playwright/test');
const OUT=process.argv[2];if(!OUT)throw Error('output_path_required');if(fs.existsSync(OUT))throw Error('output_exists');
const WEB='http://127.0.0.1:19987';const workspace='8f702ea5-d8d1-47cd-a5ab-922897f28279';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const b=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const c=await b.newContext({baseURL:WEB});const p=await c.newPage();p.setDefaultTimeout(10000);
 const result={verdict:'FAIL',phase:'setup',windowFrames:[],windowTimes:[],socketClosedAt:null,noMediaSaved:true};
 const api=async(method,url,data)=>{const r=await c.request.fetch(url,{method,data,headers:{Origin:WEB}});if(!r.ok())throw Error('api_'+r.status());return r.json()};
 try{
  await api('POST','/api/dev-login',{});
  const name='M10Z W7 sustained live '+Date.now();
  const test=await api('POST',`/api/workspaces/${workspace}/tests`,{name,description:'Synthetic moving content, no credentials or model'});result.testId=test.id;
  const {session}=await api('POST',`/api/tests/${test.id}/editing-session`,{});
  result.phase='save';const script="import {test,expect} from '@playwright/test';test('sustained live',async({page})=>{await page.setContent('<h1>W7 live</h1><p id=counter>0</p>');await page.evaluate(()=>{let n=0;setInterval(()=>{document.querySelector('#counter')!.textContent=String(++n)},100)});await expect(page.locator('h1')).toHaveText('W7 live');await page.waitForTimeout(45000);await expect(page.locator('#counter')).not.toHaveText('0');});";
  const d=await api('PUT',`/api/tests/${test.id}/draft`,{editingSessionId:session.id,revision:session.draft.revision,script});
  result.phase='workspace_ui';await p.goto(WEB);await p.getByRole('button',{name:'以開發管理員登入',exact:true}).click();await p.getByRole('combobox',{name:'Workspace'}).first().selectOption(workspace);
  result.phase='test_ui';await p.locator('.test-item').filter({hasText:name}).click();result.phase='edit_tab';await p.getByRole('tab',{name:'對話編輯',exact:true}).click();result.phase='runs_tab';await p.getByRole('tab',{name:'紀錄與畫面',exact:true}).click();
  const run=await api('POST',`/api/tests/${test.id}/draft/validate`,{editingSessionId:session.id,revision:d.revision});result.runId=run.id;
  result.phase='wait_running';let status;
  for(let i=0;i<80;i++){status=await api('GET',`/api/runs/${run.id}`);if(status.status==='running')break;if(['failed','succeeded'].includes(status.status))throw Error('ended_before_viewer');await sleep(250)}
  p.on('websocket',s=>{if(s.url().endsWith(`/api/runs/${run.id}/live`))s.on('close',()=>{result.socketClosedAt=Date.now()})});
  result.phase='history_row';const row=p.locator(`tr[data-run-id="${run.id}"]`);for(let i=0;i<15&&!(await row.count());i++){const refresh=p.getByRole('button',{name:'重新整理紀錄',exact:true});for(const button of await refresh.all()){if(await button.isEnabled())await button.click();}await sleep(400)}
  result.phase='watch_click';await row.getByRole('button',{name:`開始監看 Run ${run.id}`,exact:true}).click();result.viewerOpenedAt=Date.now();
  result.phase='decode';await p.waitForFunction(()=>{const v=document.querySelector('[data-testid=live-video]');return v&&v.videoWidth>0},{},{timeout:15000});
  for(let i=0;i<4;i++){
   const sample=await p.evaluate(async()=>{const v=document.querySelector('[data-testid=live-video]');let n=0,active=true;const start=Date.now();function frame(){if(!active)return;if(v.videoWidth>0&&!v.hidden)n++;v.requestVideoFrameCallback(frame)}v.requestVideoFrameCallback(frame);await new Promise(r=>setTimeout(r,3000));active=false;return {n,start,end:Date.now()}});
   result.windowFrames.push(sample.n);result.windowTimes.push([sample.start,sample.end]);
  }
  if(result.windowFrames.some(n=>n<3))throw Error('sustained_frames_missing');
  result.beforeClose=(await api('GET',`/api/runs/${run.id}`)).status;result.closeStartedAt=Date.now();
  await p.getByRole('button',{name:'關閉監看面板',exact:true}).click();result.closeFinishedAt=Date.now();await sleep(500);
  result.afterClose=(await api('GET',`/api/runs/${run.id}`)).status;
  if(result.beforeClose!=='running'||result.afterClose!=='running')throw Error('close_timing_not_proven');
  result.phase='terminal';
  for(let i=0;i<65;i++){const r=await api('GET',`/api/runs/${run.id}`);if(['failed','succeeded','timed_out','cancelled'].includes(r.status)){result.terminal=r.status;result.terminalObservedAt=Date.now();break}await sleep(1000)}
  if(result.terminal!=='succeeded')throw Error('run_not_succeeded');
  result.verdict='PASS';
 }catch(e){result.timeout=e.name==='TimeoutError';result.errorCode=/^[a-z_]+(?:\d+)?$/.test(e.message)?e.message:'browser_step_failed'}
 finally{fs.writeFileSync(OUT,JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});await b.close();console.log(JSON.stringify(result));if(result.verdict!=='PASS')process.exitCode=1}
})();
