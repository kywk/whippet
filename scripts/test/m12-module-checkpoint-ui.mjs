// Candidate Server + actual ConversationPanel/client; caller owns a disposable
// test schema. Uses the repo-pinned Node Playwright, no paid model or Manager.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir,writeFile,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../runtimes/worker/node_modules/playwright/index.mjs';

const fixture=JSON.parse(readFileSync(0,'utf8'));
const repo=fileURLToPath(new URL('../../',import.meta.url));
const binary=resolve(process.argv[2]),out=resolve(process.argv[3]);
assert.ok(process.env.TEST_DATABASE_URL?.startsWith('postgres://postgres:postgres@127.0.0.1:'));
await mkdir(out,{recursive:true});
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
const apiURL=`http://127.0.0.1:${await port()}`,webURL=`http://127.0.0.1:${await port()}`;
const admin=randomUUID()+randomUUID(),name=`m12-wave11-${randomUUID()}`;
const html=resolve(repo,`apps/web/dist/${name}.html`),jsx=resolve(repo,`apps/web/dist/${name}.jsx`),processes=[];
let browser,stage='start';const responses=[];
async function ready(url,child){const end=Date.now()+15000;while(Date.now()<end&&child.exitCode===null){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('candidate_not_ready');}
async function request(path){const r=await fetch(apiURL+'/api'+path,{headers:{'X-Whippet-Admin-Token':admin}});assert.ok(r.ok,`fixture_http_${r.status}`);return r.json();}
try{
  const server=spawn(binary,[],{cwd:repo,stdio:'ignore',env:{PATH:process.env.PATH,PORT:new URL(apiURL).port,WHIPPET_BIND_HOST:'127.0.0.1',DATABASE_URL:process.env.TEST_DATABASE_URL,MANAGER_TOKEN:randomUUID()+randomUUID(),WHIPPET_ADMIN_TOKEN:admin,WHIPPET_PUBLIC_ORIGIN:webURL,ARTIFACT_DIR:fixture.artifactDir,WHIPPET_SKILLS_PATH:resolve(repo,'runtimes/worker/skills'),WHIPPET_TOOL_REGISTRY_PATH:resolve(repo,'contracts/tools/registry.json')}});
  processes.push(server);await ready(apiURL+'/readyz',server);
  await writeFile(html,`<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/dist/${name}.jsx"></script></html>`,{flag:'wx'});
  await writeFile(jsx,`import React,{useState,useEffect,useCallback} from 'react';import {createRoot} from 'react-dom/client';import {ConversationPanel} from '../src/ConversationPanel';import {createHttpApi} from '../src/api';import '../src/styles.css';
const f=window.checkpointFixture,api=createHttpApi('/api');api.setAdminToken(f.admin);const noop=()=>{};
function App(){const [session,setSession]=useState(),[runs,setRuns]=useState([]);const refresh=useCallback(()=>{void api.listRuns(f.testId).then(setRuns)},[]);const sync=useCallback(d=>setSession(s=>({...s,draft:d})),[]);const reload=useCallback(async()=>{const s=await api.getEditingSession(f.testId,f.sessionId);setSession(s);return s},[]);const onRun=useCallback(r=>{window.continuedRunId=r.id;setRuns(p=>[r,...p.filter(x=>x.id!==r.id)])},[]);useEffect(()=>{void reload();refresh()},[]);return session?<main style={{height:'95vh',width:'100%',maxWidth:1120,margin:'auto'}}><ConversationPanel api={api} apiBase="/api" testId={f.testId} testKind="module" editingSessionId={f.sessionId} draft={session.draft} draftDirty={false} draftBusy={false} runs={runs} onRun={onRun} onRefreshRuns={refresh} onSynchronized={sync} onUseCandidate={()=>false} onOpenManual={noop} onGuardChange={noop} onConversationChanged={noop} onRefreshSession={reload} onShowTab={noop} aiExploration={{available:true}} authorEngine="builtin" publishReady={false}/></main>:<p>載入中</p>};createRoot(document.getElementById('root')).render(<App/>);`,{flag:'wx'});
  const web=spawn('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',new URL(webURL).port],{cwd:resolve(repo,'apps/web'),stdio:'ignore',env:{PATH:process.env.PATH,HOME:process.env.HOME,WHIPPET_API_PROXY_TARGET:apiURL}});
  processes.push(web);await ready(webURL,web);
  await writeFile(resolve(out,'lifecycle.json'),JSON.stringify({serverPid:server.pid,webPid:web.pid,apiURL,webURL,html,jsx},null,2)+'\n');
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(5000);await page.addInitScript(f=>{window.checkpointFixture=f},{...fixture,admin});
  let posts=0;const pageErrors=[],httpErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.name));page.on('response',r=>{if(r.status()>=400)httpErrors.push(r.status())});
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(`/runs/${fixture.sourceRunId}/continue`)){posts++;assert.deepEqual(r.postDataJSON(),{editingSessionId:fixture.sessionId,revision:fixture.revision});}});
  page.on('response',r=>{if(r.url().endsWith(`/runs/${fixture.sourceRunId}/continue`))void r.json().then(body=>responses.push({status:r.status(),code:body?.error?.code})).catch(()=>responses.push({status:r.status()}))});
  stage='load';
  await page.goto(webURL+`/dist/${name}.html`);await page.waitForLoadState('networkidle');
  const card=page.getByRole('region',{name:'部分完成與繼續'});await card.waitFor();
  assert.match(await card.innerText(),/已保存候選/);assert.match(await card.innerText(),/完整 Module 本體、metadata 與 harness/);assert.match(await card.innerText(),/補齊第二個付款斷言/);
  const button=card.getByRole('button',{name:'繼續',exact:true});await button.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='繼續'&&!b.disabled));
  await page.screenshot({path:resolve(out,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
  await page.screenshot({path:resolve(out,'narrow.png'),fullPage:true});
  const layout=await page.evaluate(()=>({viewport:window.innerWidth,width:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,20)}));
  await writeFile(resolve(out,'layout.json'),JSON.stringify(layout,null,2)+'\n');assert.equal(layout.width<=layout.viewport,true);
  stage='click';await button.click();stage='wait-for-child';await page.waitForFunction(()=>typeof window.continuedRunId==='string',null,{timeout:5000});
  stage='wait-for-progress';await page.getByRole('status').filter({hasText:'AI 正在處理這一輪。'}).waitFor();
  assert.equal(await card.count(),0);assert.ok(responses.some(r=>r.status===202));
  assert.equal(posts,1);assert.deepEqual(pageErrors,[]);assert.deepEqual(httpErrors,[]);
  const current=await request(`/tests/${fixture.testId}/draft?editingSessionId=${fixture.sessionId}`);
  assert.equal(current.revision,fixture.revision);assert.equal(current.script,fixture.script);assert.deepEqual(current.module,fixture.module);
  const result={status:'PASS',realAPI:true,realConversationPanel:true,sourceRunId:fixture.sourceRunId,continuedRunId:await page.evaluate(()=>window.continuedRunId),checkpointReasonDisplayed:true,fullCandidatePreserved:true,posts,pageErrors:pageErrors.length,httpErrors:httpErrors.length,smallViewportFits:true,paidModelRequests:0};
  await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
  const pages=browser?.contexts().flatMap(c=>c.pages())??[];
  const alerts=pages.length?await pages[0].getByRole('alert').allTextContents().catch(()=>[]):[];
  await writeFile(resolve(out,'failure.json'),JSON.stringify({stage,error:error.name,responses,alerts},null,2)+'\n');
  throw error;
}finally{
  await browser?.close();
  for(const p of processes.reverse()){if(p.exitCode!==null)continue;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,1500))]);if(p.exitCode===null)p.kill('SIGKILL');}
  await rm(html,{force:true});await rm(jsx,{force:true});
  await writeFile(resolve(out,'cleanup.json'),JSON.stringify({browserClosed:true,processes:processes.map(p=>({pid:p.pid,exitCode:p.exitCode,signalCode:p.signalCode})),fixtureRemoved:true},null,2)+'\n');
}
