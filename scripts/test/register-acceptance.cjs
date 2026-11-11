// Register actual Whippet UI specs, validate them in platform Workers, then publish.
// Local API only. No model requests, credentials, or nested Worker executions.
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WHIPPET_API_URL || 'http://127.0.0.1:18081';
const cases = [
 ['01-login.spec.ts','Whippet 驗收 01｜登入與搜尋','登入預設 Workspace、搜尋固定測試並查看詳情，最後返回登入。不修改測試資料。'],
 ['02-report.spec.ts','Whippet 驗收 02｜歷史執行報告','從既有成功測試的歷史紀錄開啟真正 Playwright 報告，確認 Passed 1／Failed 0。不啟動巢狀執行。'],
 ['03-draft.spec.ts','Whippet 驗收 03｜新增與暫存草稿','透過網頁建立草稿、儲存並重新登入確認內容；驗證尚未通過時不可發佈。每次執行會新增一份「驗收產物・草稿」未發佈測試。'],
 ['04-unsaved.spec.ts','Whippet 驗收 04｜未儲存編輯防護','未儲存腳本時阻止 AI 訊息、驗證與發佈；還原後恢復操作，重新登入確認原稿未變。不送出 AI 請求。'],
];
async function api(method, route, body) {
 const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const j=await r.json();if(!r.ok)throw Error(`${method} ${route}: ${r.status} ${j.error?.message||''}`);return j;
}
async function waitRun(id) {
 const end=Date.now()+100000;let previous;
 while(Date.now()<end){const r=await api('GET','/api/runs/'+id);if(r.status!==previous){console.log(`run ${id} ${r.status}`);previous=r.status;}
 if(['succeeded','failed','cancelled','timed_out','interrupted'].includes(r.status))return r;
 await new Promise(resolve=>setTimeout(resolve,1000));}
 throw Error('Run deadline exceeded: '+id);
}
(async()=>{
 const ws=(await api('GET','/api/workspaces')).items[0];
 const existing=(await api('GET',`/api/workspaces/${ws.id}/tests`)).items;
 const results=[];
 for(const [file,name,description] of cases){
  const script=await fs.readFile(path.join(__dirname,'acceptance',file),'utf8');
  const t=existing.find(t=>t.name===name)||await api('POST',`/api/workspaces/${ws.id}/tests`,{name,description});
  let d=await api('GET',`/api/tests/${t.id}/draft`);
  const changed=d.script!==script;
  if(changed)d=await api('PUT',`/api/tests/${t.id}/draft`,{revision:d.revision,script});
  // Resume the saved revision's validation after interruption; do not queue duplicates.
  const v=d.validationRunId ? await api('GET','/api/runs/'+d.validationRunId)
    : await api('POST',`/api/tests/${t.id}/draft/validate`,{revision:d.revision});
  const run=await waitRun(v.id);
  const row={file,name,testId:t.id,revision:d.revision,runId:run.id,status:run.status,reportUrl:run.reportUrl,error:run.error};
  results.push(row);
  await fs.writeFile('/private/tmp/whippet-acceptance-results.json',JSON.stringify(results,null,2)+'\n');
  if(run.status!=='succeeded')throw Error(`${name} failed: ${run.error||run.status}`);
  const versions=(await api('GET',`/api/tests/${t.id}/versions`)).items;
  const published=versions.find(v=>v.id===t.publishedVersionId);
  if (!published || published.revision!==d.revision) {
   const version=await api('POST',`/api/tests/${t.id}/publish`,{revision:d.revision,confirmed:true});row.versionId=version.id;
  } else row.versionId=t.publishedVersionId;
  await fs.writeFile('/private/tmp/whippet-acceptance-results.json',JSON.stringify(results,null,2)+'\n');
  console.log(`PUBLISHED ${name} test=${t.id} report=${base+run.reportUrl}`);
 }
 console.log('DONE: four acceptance cases validated and published');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
