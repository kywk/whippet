import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runAuthor} from './loop.js';
import {defaultSkillsPath,type SkillManifest} from './manifest.js';
import {loadToolRegistry,sha256} from './registry.js';
import {readAIConfig} from '../ai/config.js';
import {AuthorError,type AuthorInput,type AuthorOutput} from './types.js';
import type {ExplorationBrowser} from './tools.js';

const id='11111111-1111-4111-8111-111111111111';
const config=readAIConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-wave2'});
const metadata={slug:'search',moduleKind:'step' as const,exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:''};
const script='export function search(){return 1}';
const harness="import {test,expect} from '@playwright/test';import {search} from '@lib/search';test('intent',()=>{expect(search()).toBe(1)});";
const final={message:'已完成候選'};

function task(skill:'module-authoring'|'test-author'):AuthorInput{
 const dir=join(defaultSkillsPath,skill),raw=readFileSync(join(dir,'manifest.json'));
 const manifest=JSON.parse(raw.toString()) as SkillManifest,registry=loadToolRegistry();
 const module=skill==='module-authoring';
 return {kind:'author',runId:id,attemptId:id,script:module?script:'old draft',timeoutMs:180000,author:{
  conversationId:id,baseRevision:1,messages:[{role:'user',content:module?'建立 search Module':'繼續完成固定目標：驗證搜尋結果標題；保留既有業務斷言。'}],
  skillId:skill,skillVersion:'1',editingSessionId:id,contextRevision:1,sourceVersion:null,conversationSummary:null,
  allowedTools:module?['stage_module_candidate_part','commit_module_candidate','request_module_validation','browser_snapshot']:['browser_snapshot','update_draft','request_validation'],
  ...(module?{platform:{planId:null,stageId:null,module:{...metadata,harness}}}:{}),
  skills:[{id:skill,version:'1',sha256:sha256(readFileSync(join(dir,'SKILL.md'))),manifestSha256:sha256(raw),referenceHashes:Object.fromEntries(manifest.references.map(ref=>[ref.id,ref.sha256]))}],
  budget:manifest.budget,model:manifest.model,toolRegistryVersion:registry.version,toolRegistrySha256:registry.sha256,
 }};
}
function browser(verifyDraft:NonNullable<ExplorationBrowser['verifyDraft']>,onSnapshot=()=>{}):ExplorationBrowser{
 return {navigate:async()=>({}),snapshot:async()=>{onSnapshot();return {};},click:async()=>({}),fill:async()=>({}),close:async()=>{},verifyDraft};
}

test('M10Z module guard PASS survives exploratory budget and requests separate validation',async()=>{
 const sequence:[string,object][]=[
  ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:0}],
  ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
  ['commit_module_candidate',{stagingRevision:2,metadata}],
  ...Array.from({length:5},()=>['browser_snapshot',{}] as [string,object]),
 ];
 let requests=0,selfTests=0,snapshots=0;
 let output:AuthorOutput|undefined,error:unknown;
 try{output=await runAuthor(task('module-authoring'),config,browser(async()=>{selfTests++;return {passed:true,summary:'synthetic PASS'};},()=>{snapshots++;}),{
  fetcher:async()=>{const [name,args]=sequence[requests++]!;return Response.json({status:'completed',output:[{type:'function_call',call_id:String(requests),name,arguments:JSON.stringify(args)}]});},
 }) as AuthorOutput;}catch(caught){error=caught;}
 assert.equal(error,undefined,JSON.stringify({requests,selfTests,snapshots,errorCode:(error as {code?:string}|undefined)?.code}));
 assert.equal(requests,3);
 assert.equal(selfTests,1);
 assert.equal(snapshots,0);
 assert.equal(output?.script,script);
 assert.deepEqual(output?.module,{...metadata,harness});
 assert.equal(output?.requestValidation,true);
});

test('M10Z continue synthetic repeated exploration has no verified candidate',async()=>{
 let requests=0,selfTests=0;
 const output=await runAuthor(task('test-author'),config,browser(async()=>{selfTests++;return {passed:true,summary:'synthetic PASS'};}),{
  fetcher:async()=>Response.json({status:'completed',output:[{type:'function_call',call_id:String(++requests),name:'browser_snapshot',arguments:'{}'}]}),
 }) as AuthorOutput;
 assert.equal(requests,8);
 assert.equal(selfTests,0);
 assert.equal(output.partial?.reason,'budget_exhausted');
 assert.equal(output.partial?.checkpoint,undefined);
 assert.equal(output.script,undefined);
 assert.equal(output.requestValidation,false);
 assert.match(output.partial!.nextStep,/update_draft/);
 assert.doesNotMatch(output.partial!.nextStep,/最後通過自我試跑的候選稿/);
});

test('M10Z failed Module self-test remains repairable before guard completion',async()=>{
 const bad='export function search(){return 0}';
 const sequence:[string,object][]=[
  ['stage_module_candidate_part',{part:'script',content:bad,stagingRevision:0}],
  ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
  ['commit_module_candidate',{stagingRevision:2,metadata}],
  ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:2}],
  ['commit_module_candidate',{stagingRevision:3,metadata}],
 ];
 let requests=0,selfTests=0;
 const output=await runAuthor(task('module-authoring'),config,browser(async(_h,options)=>{
  selfTests++;return {passed:options?.moduleFile?.content===script,summary:'synthetic check'};
 }),{fetcher:async()=>{
  const [name,args]=sequence[requests++]!;
  return Response.json({status:'completed',output:[{type:'function_call',call_id:String(requests),name,arguments:JSON.stringify(args)}]});
 }}) as AuthorOutput;
 assert.equal(requests,5);
 assert.equal(selfTests,2);
 assert.equal(output.script,script);
 assert.equal(output.requestValidation,true);
});

test('M10Z Module guard completion does not grant unavailable validation tool',async()=>{
 const input=task('module-authoring');
 input.author.allowedTools=['stage_module_candidate_part','commit_module_candidate'];
 const sequence:[string,object][]=[
  ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:0}],
  ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
  ['commit_module_candidate',{stagingRevision:2,metadata}],
 ];
 let requests=0;
 const output=await runAuthor(input,config,browser(async()=>({passed:true,summary:'synthetic PASS'})),{fetcher:async()=>{
  const [name,args]=sequence[requests++]!;
  return Response.json({status:'completed',output:[{type:'function_call',call_id:String(requests),name,arguments:JSON.stringify(args)}]});
 }}) as AuthorOutput;
 assert.equal(requests,3);
 assert.equal(output.script,script);
 assert.equal(output.requestValidation,false);
});

test('M10Z Module partial remains LIMIT for legacy engine and forged checkpoints',async()=>{
 const input=task('module-authoring');
 await assert.rejects(runAuthor(input,config,browser(async()=>({passed:true,summary:'synthetic PASS'})),{engine:{run:async run=>{
  const calls:[string,object][]=[
   ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:0}],
   ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
   ['commit_module_candidate',{stagingRevision:2,metadata}],
  ];
  for(let i=0;i<calls.length;i++)await run.execute({name:calls[i]![0],arguments:JSON.stringify(calls[i]![1]),call_id:String(i+1)},i+1);
  return {finalText:'',partial:{reason:'model_budget',nextStep:'synthetic',checkpoint:{script:'forged'}}};
 }}}),error=>error instanceof AuthorError&&error.code==='limit');
 await assert.rejects(runAuthor(input,config,browser(async()=>({passed:true,summary:'unused'})),{engine:{run:async()=>({finalText:'',partial:{reason:'model_budget',nextStep:'synthetic',checkpoint:{script:'forged'}}})}}),
  error=>error instanceof AuthorError&&error.code==='limit');
});

test('M10Z Module commit on final model request completes without extra request',async()=>{
 const sequence:[string,object][]=[
  ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:0}],
  ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
  ...Array.from({length:5},()=>['browser_snapshot',{}] as [string,object]),
  ['commit_module_candidate',{stagingRevision:2,metadata}],
 ];
 let requests=0;
 const output=await runAuthor(task('module-authoring'),config,browser(async()=>({passed:true,summary:'synthetic PASS'})),{fetcher:async()=>{
  const [name,args]=sequence[requests++]!;
  return Response.json({status:'completed',output:[{type:'function_call',call_id:String(requests),name,arguments:JSON.stringify(args)}]});
 }}) as AuthorOutput;
 assert.equal(requests,8);
 assert.equal(output.script,script);
 assert.equal(output.requestValidation,true);
});

 test('M10Z verified Test candidate completes without spending remaining model budget',async()=>{
 let requests=0,selfTests=0;
 const candidate="import {test,expect} from '@playwright/test';test('goal',()=>expect(1).toBe(1));";
 const output=await runAuthor(task('test-author'),config,browser(async()=>{selfTests++;return {passed:true,summary:'synthetic PASS'};}),{
  fetcher:async()=>Response.json({status:'completed',output:[{type:'function_call',call_id:String(++requests),name:'update_draft',arguments:JSON.stringify({script:candidate})}]}),
 }) as AuthorOutput;
 assert.equal(requests,1);
 assert.equal(selfTests,1);
 assert.equal(output.script,candidate);
 assert.equal(output.requestValidation,true);
 assert.equal(output.partial,undefined);
});
