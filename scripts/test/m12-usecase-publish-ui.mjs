// Candidate Server + actual batch publication UI/client; caller owns a disposable
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
const admin=randomUUID()+randomUUID(),name=`m12-wave14-${randomUUID()}`;
const html=resolve(repo,`apps/web/dist/${name}.html`),jsx=resolve(repo,`apps/web/dist/${name}.jsx`),processes=[];
let browser,stage='start';const responses=[];
async function ready(url,child){const end=Date.now()+15000;while(Date.now()<end&&child.exitCode===null){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('candidate_not_ready');}
async function request(path){const r=await fetch(apiURL+'/api'+path,{headers:{'X-Whippet-Admin-Token':admin}});assert.ok(r.ok,`fixture_http_${r.status}`);return r.json();}
try{
  const server=spawn(binary,[],{cwd:repo,stdio:'ignore',env:{PATH:process.env.PATH,PORT:new URL(apiURL).port,WHIPPET_BIND_HOST:'127.0.0.1',DATABASE_URL:process.env.TEST_DATABASE_URL,MANAGER_TOKEN:randomUUID()+randomUUID(),WHIPPET_ADMIN_TOKEN:admin,WHIPPET_PUBLIC_ORIGIN:webURL,ARTIFACT_DIR:fixture.artifactDir,WHIPPET_SKILLS_PATH:resolve(repo,'runtimes/worker/skills'),WHIPPET_TOOL_REGISTRY_PATH:resolve(repo,'contracts/tools/registry.json')}});
  processes.push(server);await ready(apiURL+'/readyz',server);
  await writeFile(html,`<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/dist/${name}.jsx"></script></html>`,{flag:'wx'});
  await writeFile(jsx,`import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {PlanPanel} from '../src/PlanPanel';import {createHttpApi} from '../src/api';import '../src/styles.css';
const f=window.checkpointFixture,api=createHttpApi('/api');api.setAdminToken(f.admin);const noop=()=>{};
function App(){const [session,setSession]=useState();useEffect(()=>{void api.getEditingSession(f.testId,f.sessionId).then(setSession)},[]);return session?<main style={{width:'100%',maxWidth:1120,margin:'auto'}}><PlanPanel api={api} testId={f.testId} session={session} draft={session.draft} runs={[]} authorEngine="builtin" blocked={false} onGuardChange={noop} onRun={noop} onPublished={v=>{window.publishedVersionId=v.id}} onRefresh={noop}/></main>:<p>載入中</p>};createRoot(document.getElementById('root')).render(<App/>);`,{flag:'wx'});
  const web=spawn('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',new URL(webURL).port],{cwd:resolve(repo,'apps/web'),stdio:'ignore',env:{PATH:process.env.PATH,HOME:process.env.HOME,WHIPPET_API_PROXY_TARGET:apiURL}});
  processes.push(web);await ready(webURL,web);
  await writeFile(resolve(out,'lifecycle.json'),JSON.stringify({serverPid:server.pid,webPid:web.pid,apiURL,webURL,html,jsx},null,2)+'\n');
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(5000);await page.addInitScript(f=>{window.checkpointFixture=f},{...fixture,admin});
  let posts=0;const pageErrors=[],httpErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.name));page.on('response',r=>{if(r.status()>=400)httpErrors.push(r.status())});
  const endpoint=`/plans/${fixture.planId}/publish`;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(endpoint)){posts++;assert.deepEqual(r.postDataJSON(),{planRevision:fixture.planRevision,confirmed:true,summaryRunId:fixture.summaryRunId});}});
  stage='load';await page.goto(webURL+`/dist/${name}.html`);await page.waitForLoadState('networkidle');
  const checkbox=page.getByRole('checkbox',{name:/我已檢視全部候選清單與整批摘要/});await checkbox.waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('input[type=checkbox]')].some(x=>!x.disabled));
  assert.match(await page.getByRole('region',{name:'Use Case Plan 與整批發佈'}).innerText(),/m12-verify/);
  await page.screenshot({path:resolve(out,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(out,'narrow.png'),fullPage:true});
  const layout=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));await writeFile(resolve(out,'layout.json'),JSON.stringify(layout,null,2)+'\n');assert.ok(layout.width<=layout.viewport);
  stage='confirm';await checkbox.check();const button=page.getByRole('button',{name:'確認整批發佈',exact:true});
  const response=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='POST');await button.click();const receipt=await response;assert.equal(receipt.status(),200);
  const publication=await receipt.json();await page.waitForFunction(()=>typeof window.publishedVersionId==='string');
  assert.equal(publication.moduleVersions.length,1);assert.equal(posts,1);assert.deepEqual(pageErrors,[]);assert.deepEqual(httpErrors,[]);
  const plan=(await request(`/tests/${fixture.testId}/plan?editingSessionId=${fixture.sessionId}`)).plan;assert.equal(plan.status,'done');
  const result={status:'PASS',realAPI:true,realPlanPanel:true,scriptedUserConfirmation:true,publishedVersionId:publication.usecaseVersion.id,publishedModuleCount:publication.moduleVersions.length,posts,pageErrors:pageErrors.length,httpErrors:httpErrors.length,smallViewportFits:true,paidModelRequests:0};
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
