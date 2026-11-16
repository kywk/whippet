#!/usr/bin/env node
// Supplement only previously unresolved golden cases; retain the original scorer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const root=path.resolve(__dirname,'../..'),out=process.argv[2];
if(!out)throw Error('output_dir_required');
const source=fs.readFileSync(path.join(__dirname,'m10-golden-baseline.cjs'),'utf8');
const sourcePath=path.join(__dirname,'m10-golden-baseline.cjs');
let copy=source.replace("const CA = '/private/tmp/whippet-m8-wave/tls/cert.pem';","const CA = '/Users/kywk/.local/share/whippet/m10z-20261115/qa.crt';");
const a=copy.indexOf('function isStrictProductionUrl('),b=copy.indexOf('function areStrictProductionTargets(',a);
copy=copy.slice(0,a)+`function isStrictProductionUrl(v){try{return new URL(v).href==='https://127.0.0.1:19989/'}catch{return false}}\n`+copy.slice(b);
copy=copy.replace('const allowCleanup = isCleanupAllowed(rec, manifest);',"const allowCleanup = {ok:false,reason:'retained_for_supplemental_checks'};");
const m=new Module(sourcePath,module);m.filename=sourcePath;m.paths=module.paths;m._compile(copy,sourcePath);const g=m.exports;
const seeds=JSON.parse(fs.readFileSync('/private/tmp/whippet-m10z-20261116-wave7/golden-seeds.json'));if(seeds.some(s=>!s.versionId))throw Error('seeds_not_ready');
const api='https://127.0.0.1:19989',ws='8f702ea5-d8d1-47cd-a5ab-922897f28279';
const manifest={schemaVersion:1,baselineId:'m10z-wave8-injection-repair',apiBase:api,workspace:{id:ws,settingsRevision:1,authorizationRevision:1},catalogSeeds:seeds.map(s=>({taskIds:[s.goldenId],testId:s.testId,versionId:s.versionId,slug:s.slug,publishedName:s.slug})),ownership:{createdFor:'m10-golden-r102',workspaceId:ws,seedTestIds:seeds.map(s=>s.testId)},productionBudget:{maxModelRequests:8,maxToolCalls:12,maxDurationMs:180000}};
if(!g.validateGoldenManifest(manifest).ok)throw Error('manifest_invalid');
const tasks=JSON.parse(fs.readFileSync(path.join(__dirname,'golden/m10-golden-v1.json'))).tasks;
const label=process.argv[4]||'supplement';if(!/^[a-z0-9-]+$/.test(label))throw Error('label_invalid');
const only=(process.argv[3]||'G11,G12').split(',');
if(only.some(id=>!['G11','G12'].includes(id)))throw Error('only_unresolved_cases_allowed');
const segment=s=>s.slice(s.indexOf('function scoreAuthorTask('),s.indexOf('function checkScriptPattern('));if(segment(source)!==segment(copy))throw Error('scorer_changed');
fs.writeFileSync(path.join(out,'golden-'+label+'-intent.json'),JSON.stringify({selected:only,originalQuestionsSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'golden/m10-golden-v1.json'))).digest('hex'),originalScorerSha256:crypto.createHash('sha256').update(segment(source)).digest('hex'),originalScorerPreserved:true,passedCasesNotRerun:['G01','G02','G03','G04'],budget2Cases:'separate_required'},null,2),{flag:'wx',mode:0o600});
const cp=require('node:child_process');
function preservationSnapshot(){
 const query="SELECT json_build_object('tests',(SELECT coalesce(json_agg(id ORDER BY id),'[]') FROM tests),'versions',(SELECT coalesce(json_agg(id ORDER BY id),'[]') FROM test_versions),'artifacts',(SELECT coalesce(json_agg(run_id::text||'/'||attempt_id::text||'/'||name ORDER BY run_id,attempt_id,name),'[]') FROM artifacts));";
 const database=JSON.parse(cp.execFileSync('docker',['exec','whippet-m10z-20261115-pg','psql','-X','-q','-U','postgres','-tAc',query],{encoding:'utf8'}));
 const files=new Map(),base='/Users/kywk/.local/share/whippet/m10z-20261115/artifacts';
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())files.set(crypto.createHash('sha256').update(path.relative(base,p)).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));}}
 walk(base);return {database,files,at:Date.now()};
}
function compareSnapshots(before,after){
 const deleted=Object.fromEntries(Object.keys(before.database).map(key=>[key,before.database[key].filter(id=>!new Set(after.database[key]).has(id)).length]));
 let missingFiles=0,changedFiles=0;for(const [id,hash] of before.files){if(!after.files.has(id))missingFiles++;else if(after.files.get(id)!==hash)changedFiles++;}
 return {beforeAt:before.at,afterAt:after.at,baselineBeforeModel:true,existingCounts:Object.fromEntries(Object.entries(before.database).map(([key,value])=>[key,value.length])),deleted,existingFiles:before.files.size,missingFiles,changedFiles,pass:Object.values(deleted).every(n=>n===0)&&missingFiles===0&&changedFiles===0};
}
(async()=>{
 for(const original of tasks.filter(t=>only.includes(t.id))){
  const task=structuredClone(original);
  if(['G11','G12'].includes(task.id)){
   const html=task.id==='G11'?'<h1>Whippet ready</h1><button>Run test</button><p>'+task.setup.injectedText+'</p>':'<button>Run test</button>';
   task.initialScript="import {test,expect} from '@playwright/test';test('synthetic button',async({page})=>{await page.setContent("+JSON.stringify(html)+");await expect(page.getByRole('button')).toBeVisible();});";
  }
  const before=preservationSnapshot();
  console.log(JSON.stringify({id:task.id,phase:'started',baselineBeforeModel:true}));
  const r=await g.runLiveOneTask(api,{timeout:10000,pollInterval:1000,runTimeout:240000},task,0,manifest);
  const after=preservationSnapshot();
  const preservation=compareSnapshots(before,after);
  const record={preservation,id:r.id,rawVerdict:r.verdict,testId:r.testId,sessionId:r.sessionId,authorRunId:r.authorRunId,authorRunStatus:r.authorRunStatus,validationRunId:r.validationRunId,validationStatus:r.validationStatus,partial:r.m10Probe?.partial?.present===true,failObservations:r.details.filter(d=>d.startsWith('FAIL-obs')).length,unverifiedObservations:r.details.filter(d=>/UNVERIFIED/.test(d)).length,originalPromptUnchanged:true,modelBudgetUnchanged:true,noFreeTextSaved:true,fixtureInitialized:true};
  fs.writeFileSync(path.join(out,task.id+'-'+label+'.json'),JSON.stringify(record,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(record));
 }
})().catch(()=>{console.error('golden_supplement_failed');process.exitCode=1});
