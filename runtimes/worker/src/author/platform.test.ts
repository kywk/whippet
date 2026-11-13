import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSkillsPath, type SkillManifest } from './manifest.js';
import { loadToolRegistry, sha256 } from './registry.js';
import { validateAuthorInput, serializeAuthorArtifact, type AuthorInput } from './types.js';
import { runAuthor } from './loop.js';
import { readAIConfig } from '../ai/config.js';
import { type AgentEngine } from './engine.js';
import { explorationBrowser, type ExplorationBrowser } from './tools.js';
import { KnownSecrets } from '../login/client.js';
import { PassThrough } from 'node:stream';
import { attemptIO, MAX_TOOL_FRAME, MAX_MODULE_TOOL_FRAME } from '../attempt-io.js';
const id='11111111-1111-1111-1111-111111111111';
const metadata={slug:'search',moduleKind:'step' as const,exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:'',harness:"import {test,expect} from '@playwright/test'; import {search} from '@lib/search'; test('harness',async()=>{expect(search()).toBe(1)});"};
function input(skill:'module-authoring'|'usecase-planner'):AuthorInput{
 const dir=join(defaultSkillsPath,skill),main=readFileSync(join(dir,'SKILL.md')),raw=readFileSync(join(dir,'manifest.json')),m=JSON.parse(raw.toString()) as SkillManifest,r=loadToolRegistry();
 return {kind:'author',runId:id,attemptId:id,script:'export function search(){return 1}',timeoutMs:10000,author:{conversationId:id,baseRevision:1,messages:[{role:'user',content:'Build'}],skillId:skill,skillVersion:'1',editingSessionId:id,contextRevision:1,sourceVersion:null,conversationSummary:null,allowedTools:skill==='module-authoring'?['update_module_candidate','request_module_validation']:['propose_plan'],platform:{planId:null,stageId:null,module:skill==='module-authoring'?metadata:null},skills:[{id:skill,version:'1',sha256:sha256(main),manifestSha256:sha256(raw),referenceHashes:Object.fromEntries(m.references.map(r=>[r.id,r.sha256]))}],budget:m.budget,model:m.model,toolRegistryVersion:r.version,toolRegistrySha256:r.sha256}};
}
const config=readAIConfig({WHIPPET_AI_ENABLED:'true',WHIPPET_AI_BASE_URL:'https://synthetic.invalid',OPENCODE_API_KEY:'synthetic-key'});
const finalText=JSON.stringify({message:'完成'});
const call=(name:string,args:unknown,n:number)=>({name,arguments:JSON.stringify(args),call_id:`opaque-${n}`});
test('platform accepts nested only and rejects missing, top-level, duplicate and invalid null pairs',()=>{
 const v=input('module-authoring');validateAuthorInput(v);
 for(const mutate of [(x:any)=>delete x.author.platform,(x:any)=>{x.platform=x.author.platform;delete x.author.platform},(x:any)=>{x.platform=x.author.platform},(x:any)=>{x.author.platform.stageId='s'},(x:any)=>{x.author.platform.module=null},(x:any)=>{x.author.skillId='test-author';x.author.skills[0].id='test-author'}]){const bad=structuredClone(v);mutate(bad);assert.throws(()=>validateAuthorInput(bad));}
 const p=input('usecase-planner');validateAuthorInput(p);p.author.platform!.module=metadata;assert.throws(()=>validateAuthorInput(p));
});
test('Module final is rebuilt from last passing body+harness and rejects forged final or partial',async()=>{
 const v=input('module-authoring');let verified=0;
 const browser={verifyDraft:async(h:string,o:any)=>{verified++;assert.equal(h,metadata.harness);assert.equal(o.moduleFile.slug,'search');return {passed:o.moduleFile.content===v.script,summary:'checked'};}} as ExplorationBrowser;
 const engine:AgentEngine={async run(r){assert.deepEqual(await r.execute(call('update_module_candidate',{script:v.script,module:metadata},1),1),{candidate:true,selfTestPassed:true});await r.execute(call('update_module_candidate',{script:'broken',module:metadata},2),2);await r.execute(call('request_module_validation',{},3),3);return {finalText};}};
 const out=await runAuthor(v,config,browser,{engine});assert.equal(out.script,v.script);assert.equal(out.requestValidation,true);assert.equal(verified,2);assert.deepEqual((out as any).module,metadata);
 await assert.rejects(runAuthor(v,config,browser,{engine:{async run(){return {finalText:JSON.stringify({message:'fake',module:metadata})}}}}));
 await assert.rejects(runAuthor(v,config,browser,{engine:{async run(){return {finalText:'',partial:{reason:'model_budget',nextStep:'continue'}}}}}));
});
test('planner final takes last successful canonical candidateRef, never model injection',async()=>{
 const v=input('usecase-planner'),stages=[{id:'one',title:'搜尋',action:'reuse',moduleVersionId:id,args:{}}];let calls=0;
 const engine:AgentEngine={async run(r){await r.execute(call('propose_plan',{stages},1),1);await r.execute(call('propose_plan',{stages},2),2);return {finalText};}};
 const out=await runAuthor(v,config,undefined,{engine,harness:{async call(){if(++calls===2)throw Error('safe');return {candidate:true,candidateRef:id,stages}}}});
 assert.deepEqual((out as any).planCandidate,{candidateRef:id});assert.equal(out.requestValidation,undefined);assert.equal(out.script,undefined);
 await assert.rejects(runAuthor(v,config,undefined,{engine:{async run(){return {finalText:JSON.stringify({message:'fake',planCandidate:{candidateRef:id}})}}}}));
});
test('only authoritative Module primary gets 25MiB final and pending IDs select 26MiB frames',()=>{
 const value={message:'x'.repeat(14*1024*1024)};assert.throws(()=>serializeAuthorArtifact(value));assert.doesNotThrow(()=>serializeAuthorArtifact(value,'module-authoring'));
 for(const name of ['read_plan','catalog_get']){
 const read=new PassThrough(),write=new PassThrough(),io=attemptIO({read,write});let received=0,failed=0;
 io.subscribe('tool_response',()=>{received++},()=>{failed++});io.expectTool(id,name);
 read.write(JSON.stringify({kind:'tool_response',requestId:'unknown',result:'x'})+'\n');assert.equal(received,0);
 read.write(JSON.stringify({kind:'tool_response',requestId:id,result:'x'.repeat(MAX_TOOL_FRAME)})+'\n');assert.equal(received,name==='catalog_get'?1:0);assert.equal(failed,name==='catalog_get'?0:1);
 read.destroy();write.destroy();
 }
 assert.equal(MAX_MODULE_TOOL_FRAME,26*1024*1024);
});

test('real Module self-test executes both files through @lib and rejects a failing harness',async()=>{
 const browser=explorationBrowser({PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR});
 try {
  const passed=await browser.verifyDraft!(metadata.harness,{moduleFile:{slug:'search',content:'export function search(){return 1}'}});
  assert.equal(passed.passed,true,passed.error);
  const failed=await browser.verifyDraft!(metadata.harness,{moduleFile:{slug:'search',content:'export function search(){return 2}'}});
  assert.equal(failed.passed,false);
 }finally{await browser.close();}
});

test('Module candidate is discarded if later secret discovery changes body or harness bytes',async()=>{
 for(const field of ['script','harness']){
  const v=input('module-authoring'),secrets=new KnownSecrets(),m=structuredClone(metadata);
  if(field==='script')v.script+=' // synthetic-password';else m.harness+=' // synthetic-password';
  const engine:AgentEngine={async run(r){await r.execute(call('update_module_candidate',{script:v.script,module:m},1),1);secrets.add('synthetic-password');return {finalText};}};
  await assert.rejects(runAuthor(v,config,{verifyDraft:async()=>({passed:true,summary:'ok'}),navigate:async()=>({}),snapshot:async()=>({}),click:async()=>({}),fill:async()=>({}),close:async()=>{}},{engine,secrets}));
 }
});

import { HarnessClient } from './harness.js';
test('catalog parameter rejection reaches real loop and model corrects query before guarded Plan success',async()=>{
 const v=input('usecase-planner');v.author.allowedTools=['catalog_search','catalog_get','propose_plan'];
 const read=new PassThrough(),write=new PassThrough(),client=new HarnessClient(v,{read,write});
 let frames=0,requests=0;const cursors:unknown[]=[];
 write.on('data',(raw)=>{const f=JSON.parse(raw.toString());frames++;
  let result:unknown={};
  if(f.name==='catalog_search'){cursors.push(f.arguments.query);if(cursors.length===1){read.write(JSON.stringify({kind:'tool_response',requestId:f.requestId,attemptId:v.attemptId,error:'catalog_search_invalid_request'})+'\n');return;}result={items:[{versionId:id}],nextCursor:null};}
  if(f.name==='catalog_get')result={versionId:id};
  if(f.name==='propose_plan')result={candidate:true,candidateRef:id,stages:[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}]};
  read.write(JSON.stringify({kind:'tool_response',requestId:f.requestId,attemptId:v.attemptId,result})+'\n');
 });
 const stages=[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}];
 const operations=[['catalog_search',{query:'first',limit:10}],['catalog_search',{query:'synthetic',limit:10}],['catalog_get',{moduleVersionId:id}],['propose_plan',{stages}]] as const;
 try{
 const observed:string[]=[];
 const out=await runAuthor(v,config,undefined,{observer:e=>observed.push(e),harness:client,fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(requests===1){const serialized=JSON.stringify(body);assert(serialized.includes('catalog_search_invalid_request'));assert(serialized.includes('Check query and limit'));assert(!serialized.includes('Inspect the page state'));}
  const n=requests++;const op=operations[n];
  return new Response(JSON.stringify({status:'completed',output:op?[{type:'function_call',call_id:`opaque-${n}`,name:op[0],arguments:JSON.stringify(op[1])}]:[{type:'message',content:[{type:'output_text',text:finalText}]}]}),{status:200,headers:{'content-type':'application/json'}});
 }});
 for(const event of ['feedbackFrameAccepted','feedbackQueued','feedbackIncludedAtFetch','toolsIncludedAtFetch','functionCallObserved'])assert(observed.some(e=>e.endsWith(':'+event)));
 assert.deepEqual(cursors,['first','synthetic']);assert.equal(frames,4);assert.equal(requests,5);assert.equal((out as any).planCandidate.candidateRef,id);assert.equal(v.author.budget!.maxModelRequests,8);
 }finally{client.close();read.destroy();write.destroy();}
});
test('catalog feedback IPC remains scoped to pending tool and exact error frame',async()=>{
 for(const mode of ['wrong-tool','next-page','unknown','extra','late']){
  const v=input('usecase-planner');v.author.allowedTools=['catalog_search','catalog_next_page','catalog_get'];
  const read=new PassThrough(),write=new PassThrough(),client=new HarnessClient(v,{read,write});let frame:any;
  write.on('data',raw=>{frame=JSON.parse(raw.toString());});
  const name=mode==='wrong-tool'?'catalog_get':mode==='next-page'?'catalog_next_page':'catalog_search';
  const pending=client.call(name,name==='catalog_get'?{moduleVersionId:id}:name==='catalog_next_page'?{cursor:'issued',limit:10}:{query:'synthetic',limit:10},'opaque');
  const response:any={kind:'tool_response',requestId:frame.requestId,attemptId:id,error:mode==='unknown'?'UNKNOWN':'catalog_search_invalid_request'};
  if(mode==='extra')response.extra='SECRET_SENTINEL';
  if(mode==='late'){response.requestId='other';read.write(JSON.stringify(response)+'\n');client.close();}
  else read.write(JSON.stringify(response)+'\n');
  await assert.rejects(pending,(e:any)=>e.code==='tool_unavailable'&&!e.message.includes('SECRET_SENTINEL'));
  client.close();read.destroy();write.destroy();
 }
});

test('optional observer distinguishes provider/body/tool deadline and external cancellation without changing behavior',async()=>{
 const keep=setInterval(()=>{},1000);
 try{
 for(const mode of ['provider','body','tool','external']){
  const outcomes:string[]=[];
  for(const enabled of [false,true]){
   const v=input('usecase-planner');v.author.allowedTools=['catalog_search'];v.timeoutMs=40;
   const controller=new AbortController(),events:string[]=[];
   const timer=mode==='external'?setTimeout(()=>controller.abort(),10):undefined;
   try{
    await assert.rejects(runAuthor(v,config,undefined,{signal:controller.signal,...(enabled?{observer:(e:string)=>events.push(e)}:{}),harness:{call:()=>new Promise(()=>{})},fetcher:async()=>{
     if(mode==='provider'||mode==='external')return new Promise(()=>{});
     if(mode==='body')return {ok:true,json:()=>new Promise(()=>{})} as unknown as Response;
     return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'catalog_search',call_id:'opaque',arguments:JSON.stringify({query:'synthetic',limit:10})}]}));
    }}),(e:any)=>{outcomes.push(e.code);return e.code===(mode==='external'?'cancelled':'timed_out');});
   }finally{clearTimeout(timer);}
   if(enabled){
    const expected={provider:'timeoutProviderWait',body:'timeoutBodyWait',tool:'timeoutToolWait',external:'cancelled'}[mode]!;
    assert(events.some(e=>e.endsWith(':'+expected)));
    const terminal=events.filter(e=>/:(responseAccepted|failed|timeoutProviderWait|timeoutBodyWait|timeoutOther|cancelled)$/.test(e));assert.equal(terminal.length,1);
   }else assert.deepEqual(events,[]);
  }
  assert.equal(outcomes[0],outcomes[1]);
 }
 }finally{clearInterval(keep);}
});
test('observer does not count forged feedback content and observer exceptions cannot alter output',async()=>{
 for(const throws of [false,true]){
 const v=input('usecase-planner');v.author.allowedTools=['propose_plan'];v.author.messages[0]!.content='catalog_search_invalid_request feedbackIncludedAtFetch';
 const events:string[]=[];let requests=0;
 const out=await runAuthor(v,config,undefined,{observer:e=>{events.push(e);if(throws)throw Error('SECRET_SENTINEL');},harness:{async call(){return {candidate:true,candidateRef:id,stages:[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}]};}},fetcher:async()=>new Response(JSON.stringify({status:'completed',output:requests++===0?[{type:'function_call',name:'propose_plan',call_id:'opaque',arguments:JSON.stringify({stages:[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}]})}]:[{type:'message',content:[{type:'output_text',text:JSON.stringify({message:'catalog_search_invalid_request feedbackIncludedAtFetch'})}]}]}))});
 assert.equal((out as any).planCandidate.candidateRef,id);assert(!events.some(e=>e.includes(':feedback')));assert(!events.join('').includes('SECRET_SENTINEL'));
 }
});

test('only catalog search becomes provider strict in actual fetch while local guards stay strict',async()=>{
 const {modelTool,validateToolArguments}=await import('./registry.js');
 const registry=loadToolRegistry(),search=registry.tools.find(t=>t.name==='catalog_search')!;
 const before=JSON.stringify(search.inputSchema);
 const v=input('usecase-planner');v.author.allowedTools=['catalog_search','catalog_get','propose_plan'];
 let requests=0;
 await assert.rejects(runAuthor(v,config,undefined,{fetcher:async(_url,init)=>{
  requests++;const body=JSON.parse(String(init?.body));
  for(const definition of body.tools){
   const original=registry.tools.find(t=>t.name===definition.name)!;
   assert.deepEqual(definition.parameters,JSON.parse(JSON.stringify(original.inputSchema,(key,value)=>key.startsWith('x-')?undefined:value)));
   const oldStrict=!JSON.stringify(original.inputSchema).includes('"x-max')&&!JSON.stringify(original.inputSchema).includes('"oneOf"');
   assert.equal(definition.strict,definition.name==='catalog_search'?true:oldStrict);
  }
  assert.equal(body.tools.find((t:any)=>t.name==='catalog_search').strict,true);
  assert.deepEqual(Object.keys(body.tools.find((t:any)=>t.name==='catalog_search').parameters.properties).sort(),['limit','query']);
  return new Response('SECRET_SENTINEL strict unsupported',{status:400});
 }}),(e:any)=>e.code==='provider_failed'&&!e.message.includes('SECRET_SENTINEL'));
 assert.equal(requests,1,'provider rejection must not fallback or retry');
 for(const tool of registry.tools){const oldStrict=!JSON.stringify(tool.inputSchema).includes('"x-max')&&!JSON.stringify(tool.inputSchema).includes('"oneOf"');assert.equal(modelTool(tool).strict,tool.name==='catalog_search'?true:oldStrict);}
 assert.equal(JSON.stringify(search.inputSchema),before);
 for(const args of [{query:'界'.repeat(400),limit:10},{query:'x',limit:0},{query:'x',limit:21},{query:'x',limit:1.5}])assert.throws(()=>validateToolArguments(search,args));
 assert.throws(()=>modelTool({...search,inputSchema:{...search.inputSchema,required:['query']}}));
 assert.throws(()=>modelTool({...search,inputSchema:{...search.inputSchema,additionalProperties:true as false}}));
});
test('registry 10.2 real loop traverses two pages with unchanged opaque cursor then pins guarded reuse',async()=>{
 const v=input('usecase-planner');v.author.allowedTools=['catalog_search','catalog_next_page','catalog_get','propose_plan'];
 const read=new PassThrough(),write=new PassThrough(),client=new HarnessClient(v,{read,write});
 const token='synthetic-issued-cursor';let requests=0;const names:string[]=[];
 write.on('data',raw=>{const f=JSON.parse(raw.toString());names.push(f.name);let result:unknown;
  if(f.name==='catalog_search'){assert.deepEqual(f.arguments,{query:'synthetic',limit:1});result={items:[],nextCursor:token};}
  else if(f.name==='catalog_next_page'){assert.deepEqual(f.arguments,{cursor:token,limit:1});result={items:[{versionId:id}],nextCursor:null};}
  else if(f.name==='catalog_get')result={versionId:id};
  else result={candidate:true,candidateRef:id,stages:[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}]};
  read.write(JSON.stringify({kind:'tool_response',requestId:f.requestId,attemptId:id,result})+'\n');
 });
 const operations=[['catalog_search',{query:'synthetic',limit:1}],['catalog_next_page',{cursor:token,limit:1}],['catalog_get',{moduleVersionId:id}],['propose_plan',{stages:[{id:'one',title:'reuse',action:'reuse',moduleVersionId:id,args:{}}]}]] as const;
 try{const out=await runAuthor(v,config,undefined,{harness:client,fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const tool=body.tools.find((t:any)=>t.name==='catalog_next_page');assert.equal(tool.strict,false);assert.equal(tool.parameters.properties.cursor.minLength,1);
  const n=requests++,op=operations[n];return Response.json({status:'completed',output:op?[{type:'function_call',call_id:`opaque-${n}`,name:op[0],arguments:JSON.stringify(op[1])}]:[{type:'message',content:[{type:'output_text',text:finalText}]}]});
 }});assert.equal((out as any).planCandidate.candidateRef,id);assert.deepEqual(names,['catalog_search','catalog_next_page','catalog_get','propose_plan']);assert.equal(requests,5);
 }finally{client.close();read.destroy();write.destroy();}
});
test('registry 10.2 search rejects cursor and next-page retains exact schema and Unicode/UTF8 guards',async()=>{
 const {validateToolArguments}=await import('./registry.js');const {matchesSchema}=await import('./schema.js');
 const r=loadToolRegistry(),search=r.tools.find(t=>t.name==='catalog_search')!,next=r.tools.find(t=>t.name==='catalog_next_page')!;
 assert.throws(()=>validateToolArguments(search,{query:'x',limit:1,cursor:null}));
 for(const cursor of [null,'',42,'😀'.repeat(257)])assert.throws(()=>validateToolArguments(next,{cursor,limit:1}));
 assert.doesNotThrow(()=>validateToolArguments(next,{cursor:'😀',limit:1}));
 assert.equal(matchesSchema({type:'string',minLength:2},'😀'),false);
 assert.throws(()=>validateToolArguments(next,{cursor:'issued',limit:1,query:'x'}));
});

import { ModuleDiagnostics } from './module-diagnostics.js';
test('M109 diagnostics discriminate module branches without changing engine outputs',async()=>{
 for(const mode of ['limit','missing','selftest-failed','json','shape','secret','complete']){
  const results:unknown[]=[];
  for(const enabled of [false,true]){
   const v=input('module-authoring'),secrets=new KnownSecrets();let captured:any;const d=enabled?new ModuleDiagnostics():undefined;
   if(mode==='secret')v.script+=' // SECRET_SENTINEL';
   const browser={verifyDraft:async()=>({passed:mode!=='selftest-failed',summary:'synthetic'}),navigate:async()=>({}),snapshot:async()=>({}),click:async()=>({}),fill:async()=>({}),close:async()=>{}};
   let outcome:any;
   try{outcome=await runAuthor(v,config,browser,{...(d?{moduleDiagnostics:d}:{}),secrets,engine:{async run(r){
    if(mode!=='missing')await r.execute(call('update_module_candidate',{script:v.script,module:metadata},1),1);
    if(mode==='secret')secrets.add('SECRET_SENTINEL');
    if(mode==='limit')return {finalText:'',partial:{reason:'model_budget',nextStep:'synthetic'}};
    return {finalText:mode==='json'?'invalid json':mode==='shape'?JSON.stringify({message:'synthetic',script:'forged'}):finalText};
   }}});}catch(e:any){outcome={error:e.code};}
   results.push(outcome);d?.finish('COMPLETED',v=>{captured=v;});d?.finish('UNKNOWN',()=>assert.fail('duplicate terminal'));
   if(enabled){const expected={limit:'LIMIT',missing:'CHECKPOINT_MISSING','selftest-failed':'CHECKPOINT_MISSING',json:'FINAL_JSON_PARSE',shape:'FINAL_SHAPE',secret:'CHECKPOINT_REJECTED',complete:'COMPLETED'}[mode];assert.equal(captured.terminalClass,expected);assert.equal(captured.selfTestFailedCount,mode==='selftest-failed'?1:0);assert.equal(captured.selfTestPassedCount,['missing','selftest-failed'].includes(mode)?0:1);assert(!JSON.stringify(captured).includes('SECRET_SENTINEL'));}
   else assert.equal(captured,undefined);
  }
  assert.deepEqual(results[0],results[1]);
 }
});
test('M109 diagnostic sink errors and persistence terminal never affect task results',()=>{
 const d=new ModuleDiagnostics();d.selfTest(true);d.failure('LIMIT');let count=0;
 assert.doesNotThrow(()=>d.finish('ARTIFACT_WRITE_FAILED',value=>{count++;assert.equal((value as any).terminalClass,'ARTIFACT_WRITE_FAILED');throw Error('SECRET_SENTINEL');}));
 d.finish('COMPLETED',()=>count++);assert.equal(count,1);
});

import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
test('M109 real entry flag is silent when off and persistence failure emits one safe terminal',()=>{
 const runs:any[]=[];
 for(const mode of ['off','on','write-fail']){
  const dir=mkdtempSync(join(tmpdir(),'whippet-m109-synthetic-'));
  try{
   const v=input('module-authoring');v.author.allowedTools=[];
   writeFileSync(join(dir,'input.json'),JSON.stringify(v));
   if(mode==='write-fail')writeFileSync(join(dir,'output'),'synthetic blocker');
   const child=spawnSync(process.execPath,[fileURLToPath(new URL('./main.js',import.meta.url))],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,WHIPPET_WORK_DIR:dir,WHIPPET_AI_ENABLED:'false',WHIPPET_M109_DIAGNOSTICS:mode==='off'?'0':'1'}});
   assert.equal(child.status,1);const messages=child.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>typeof e.message==='string'&&e.message.startsWith('m109_diagnostic:'));
   assert.equal(messages.length,mode==='off'?0:1);
   if(mode==='write-fail'){assert.equal(JSON.parse(messages[0].message.slice('m109_diagnostic:'.length)).terminalClass,'ARTIFACT_WRITE_FAILED');assert.equal(existsSync(join(dir,'output/result.json')),false);}
   else runs.push(readFileSync(join(dir,'output/result.json'),'utf8'));
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
 assert.equal(runs[0],runs[1]);
});
test('M109 real loop timeout cancellation and provider rejection retain fixed terminal classes',async()=>{
 const keep=setInterval(()=>{},1000);
 try{for(const mode of ['timeout','cancel','provider']){
  const v=input('module-authoring');v.author.allowedTools=[];v.timeoutMs=40;
  const controller=new AbortController(),d=new ModuleDiagnostics();let captured:any;
  const timer=mode==='cancel'?setTimeout(()=>controller.abort(),10):undefined;
  try{await assert.rejects(runAuthor(v,config,undefined,{moduleDiagnostics:d,signal:controller.signal,fetcher:async()=>mode==='provider'?new Response('SECRET_SENTINEL',{status:400}):new Promise(()=>{})}));}finally{clearTimeout(timer);}
  d.finish('UNKNOWN',x=>{captured=x;});assert.equal(captured.terminalClass,{timeout:'TIMEOUT',cancel:'CANCELLED',provider:'PROVIDER_FAILED'}[mode]);assert(!JSON.stringify(captured).includes('SECRET_SENTINEL'));
 }}finally{clearInterval(keep);}
});

test('M109 v2 real verifier classification survives loop LIMIT independently',async()=>{
 const {explorationBrowser}=await import('./tools.js');
 const v=input('module-authoring'),d=new ModuleDiagnostics(),browser=explorationBrowser({});
 // Metadata validation permits text; the real verifier rejects its missing test/import.
 const invalid={...metadata,harness:'SECRET_SENTINEL'};
 try{
  await assert.rejects(runAuthor(v,config,browser,{moduleDiagnostics:d,engine:{async run(r){
   await r.execute(call('update_module_candidate',{script:v.script,module:invalid},1),1);
   return {finalText:'',partial:{reason:'model_budget',nextStep:'synthetic'}};
  }}}));
  d.finish('UNKNOWN',value=>{const x=value as any;assert.equal(x.selfTestFailedCount,1);assert.equal(x.selfTestPassedCount,0);assert.equal(x.lastSelfTestFailureClass,'INVALID_SPEC');assert.equal(x.terminalClass,'LIMIT');assert(!JSON.stringify(x).includes('SECRET_SENTINEL'));});
 }finally{await browser.close();}
});
