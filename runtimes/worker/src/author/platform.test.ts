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
