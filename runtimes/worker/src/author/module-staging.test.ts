import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runAuthor} from './loop.js';
import {defaultSkillsPath,type SkillManifest} from './manifest.js';
import {loadToolRegistry,sha256} from './registry.js';
import {readAIConfig} from '../ai/config.js';
import {AuthorError,type AuthorInput} from './types.js';
import type {EngineRun} from './engine.js';
import type {ExplorationBrowser} from './tools.js';
import {KnownSecrets} from '../login/client.js';
const id='11111111-1111-4111-8111-111111111111';
const metadata={slug:'search',moduleKind:'step' as const,exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:''};
const script='export function search(){return 1}';
const harness="import {test,expect} from '@playwright/test';import {search} from '@lib/search';test('intent',()=>{expect(search()).toBe(1)});";
const cfg=readAIConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-only'});
function input():AuthorInput{
 const dir=join(defaultSkillsPath,'module-authoring'),raw=readFileSync(join(dir,'manifest.json')),m=JSON.parse(raw.toString()) as SkillManifest,r=loadToolRegistry();
 return {kind:'author',runId:id,attemptId:id,script,timeoutMs:10000,author:{conversationId:id,baseRevision:1,messages:[{role:'user',content:'synthetic'}],skillId:'module-authoring',skillVersion:'1',editingSessionId:id,contextRevision:1,sourceVersion:null,conversationSummary:null,allowedTools:['stage_module_candidate_part','commit_module_candidate','request_module_validation'],platform:{planId:null,stageId:null,module:{...metadata,harness}},skills:[{id:'module-authoring',version:'1',sha256:sha256(readFileSync(join(dir,'SKILL.md'))),manifestSha256:sha256(raw),referenceHashes:Object.fromEntries(m.references.map(ref=>[ref.id,ref.sha256]))}],budget:m.budget,model:m.model,toolRegistryVersion:r.version,toolRegistrySha256:r.sha256}};
}
const final={finalText:JSON.stringify({message:'synthetic'})};
function calls(r:EngineRun){let n=0;return (name:string,args:object)=>r.execute({name,arguments:JSON.stringify(args),call_id:String(++n)},n);}
const browser=(verify:NonNullable<ExplorationBrowser['verifyDraft']>)=>({verifyDraft:verify} as ExplorationBrowser);
const stage=(part:string,content:string,stagingRevision:number)=>({part,content,stagingRevision});

test('staged candidate uses real engine/fetch tool sequence and never IPC; commit alone creates final',async()=>{
 const sequence=[['stage_module_candidate_part',stage('script',script,0)],['stage_module_candidate_part',stage('harness',harness,1)],['commit_module_candidate',{stagingRevision:2,metadata}],['request_module_validation',{}]] as const;
 let n=0,verified=0;const v=input();
 const result=await runAuthor(v,cfg,browser(async(h,o)=>{assert.equal(h,harness);assert.deepEqual(o?.moduleFile,{slug:'search',exportName:'search',content:script});verified++;return {passed:true,summary:'synthetic'};}),{harness:{call:async()=>assert.fail('local tools must not use IPC')},fetcher:async(_url,init)=>{
  const body=JSON.parse(init!.body as string);assert.equal(body.stream,false);assert.equal(body.max_output_tokens,16384);
  if(n){const previous=JSON.parse(body.input.filter((x:any)=>x.type==='function_call_output').at(-1).output);if(n<=2)assert.deepEqual(previous,{staged:true,revision:n,part:n===1?'script':'harness',contentHash:sha256(Buffer.from(n===1?script:harness))});}
  const item=sequence[n++];return Response.json({status:'completed',output:item?[{type:'function_call',call_id:String(n),name:item[0],arguments:JSON.stringify(item[1])}]:[],...(!item?{output_text:final.finalText}:{})});
 }});
 assert.equal(verified,1);assert.equal(result.script,script);assert.deepEqual((result as any).module,{...metadata,harness});assert.equal(result.requestValidation,true);
});

test('staging CAS and schema rejection never advance accepted revision or bypass full candidate guards',async()=>{
 let verified=0;
 await runAuthor(input(),cfg,browser(async()=>{verified++;return {passed:true,summary:'synthetic'};}),{engine:{async run(r){const call=calls(r);
  for(const args of [stage('script','x',1),stage('script','',0),stage('script','界'.repeat(2731),0),stage('other','x',0),{...stage('script','x',0),unknown:true},stage('script','\ud800',0)])assert('error' in (await call('stage_module_candidate_part',args) as object));
  assert.deepEqual(await call('stage_module_candidate_part',stage('script',script,0)),{staged:true,revision:1,part:'script',contentHash:sha256(Buffer.from(script))});
  assert('error' in (await call('commit_module_candidate',{stagingRevision:1,metadata}) as object)); // no harness
  assert('error' in (await call('stage_module_candidate_part',stage('harness',harness,0)) as object));
  assert.equal((await call('stage_module_candidate_part',stage('harness',harness,1)) as any).revision,2);
  for(const args of [{stagingRevision:1,metadata},{stagingRevision:2,metadata:{...metadata,slug:'other'}},{stagingRevision:2,metadata:{...metadata,exportName:'return'}},{stagingRevision:2,metadata:{...metadata,signature:'x'.repeat(4096)}}])assert('error' in (await call('commit_module_candidate',args) as object));
  assert.deepEqual(await call('commit_module_candidate',{stagingRevision:2,metadata}),{candidate:true,selfTestPassed:true});return final;
 }}});assert.equal(verified,1);
});

test('failed repair preserves prior verified candidate and staging never becomes a checkpoint',async()=>{
 let verified=0;
 const result=await runAuthor(input(),cfg,browser(async()=>({passed:++verified===1,summary:'synthetic failed intent'})),{engine:{async run(r){const call=calls(r);
  await call('stage_module_candidate_part',stage('script',script,0));await call('stage_module_candidate_part',stage('harness',harness,1));await call('commit_module_candidate',{stagingRevision:2,metadata});
  await call('stage_module_candidate_part',stage('script','export function search(){return 2}',2));
  assert.deepEqual(await call('commit_module_candidate',{stagingRevision:3,metadata}),{candidate:false,selfTestPassed:false,error:'synthetic failed intent'});return final;
 }}});assert.equal(result.script,script);assert.equal(verified,2);
 for(const mode of ['uncommitted','missing-part','new-run','failed-selftest']){
  let count=0;
  await assert.rejects(runAuthor(input(),cfg,browser(async()=>{count++;return {passed:false,summary:'synthetic'};}),{engine:{async run(r){const call=calls(r);
   if(mode!=='new-run')await call('stage_module_candidate_part',stage('script',script,0));
   if(mode==='uncommitted'||mode==='failed-selftest')await call('stage_module_candidate_part',stage('harness',harness,1));
   if(mode!=='uncommitted')await call('commit_module_candidate',{stagingRevision:mode==='failed-selftest'?2:1,metadata});return final;
  }}}),e=>e instanceof AuthorError&&e.code==='invalid_response');assert.equal(count,mode==='failed-selftest'?1:0);
 }
});

test('secret parts and cancellation cannot create a verified checkpoint',async()=>{
 const secrets=new KnownSecrets();secrets.add('synthetic-secret');
 await assert.rejects(runAuthor(input(),cfg,undefined,{secrets,engine:{async run(r){await calls(r)('stage_module_candidate_part',stage('script','synthetic-secret',0));return final;}}}),e=>e instanceof AuthorError&&e.code==='sensitive_output');
 const ctl=new AbortController();
 await assert.rejects(runAuthor(input(),cfg,browser(async()=>{ctl.abort();return {passed:true,summary:'late pass'};}),{signal:ctl.signal,engine:{async run(r){const call=calls(r);await call('stage_module_candidate_part',stage('script',script,0));await call('stage_module_candidate_part',stage('harness',harness,1));await call('commit_module_candidate',{stagingRevision:2,metadata});return final;}}}),e=>e instanceof AuthorError&&e.code==='cancelled');
});

import {ModuleDiagnostics} from './module-diagnostics.js';
test('duplicate commit call ID never repeats self-test; late pass after abort never creates checkpoint',async()=>{
 let count=0;
 await assert.rejects(runAuthor(input(),cfg,browser(async()=>{count++;return {passed:true,summary:'synthetic'};}),{engine:{async run(r){const call=calls(r);await call('stage_module_candidate_part',stage('script',script,0));await call('stage_module_candidate_part',stage('harness',harness,1));await call('commit_module_candidate',{stagingRevision:2,metadata});await r.execute({name:'commit_module_candidate',arguments:JSON.stringify({stagingRevision:2,metadata}),call_id:'3'},4);return final;}}}),e=>e instanceof AuthorError&&e.code==='invalid_response');assert.equal(count,1);
 const ctl=new AbortController(),diagnostics=new ModuleDiagnostics();let latePass=false;let release!:()=>void;
 const delayed=new Promise<void>(resolve=>{release=resolve});
 await assert.rejects(runAuthor(input(),cfg,browser(async()=>{ctl.abort();await delayed;latePass=true;return {passed:true,summary:'late pass'};}),{signal:ctl.signal,moduleDiagnostics:diagnostics,engine:{async run(r){const call=calls(r);await call('stage_module_candidate_part',stage('script',script,0));await call('stage_module_candidate_part',stage('harness',harness,1));await call('commit_module_candidate',{stagingRevision:2,metadata});return final;}}}),e=>e instanceof AuthorError&&e.code==='cancelled');
 release();await delayed;await new Promise(resolve=>setImmediate(resolve));assert(latePass);let record:any;diagnostics.finish('UNKNOWN',value=>{record=value});assert.equal(record.checkpointCreated,false);assert.equal(record.checkpointPresentAtFinalize,false);assert.equal(record.selfTestPassedCount,0);
});
