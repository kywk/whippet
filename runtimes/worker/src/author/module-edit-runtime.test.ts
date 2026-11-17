import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runAuthor} from './loop.js';
import {loadToolRegistry,sha256} from './registry.js';
import {readAuthorConfig,runtimeDigest,type AuthorRuntime} from './runtime.js';
import type {AuthorInput,AuthorOutput} from './types.js';
import {envelope,call} from './spike/fixture.js';
import {estimateInputTokens} from './engines/context.js';

const id='11111111-1111-4111-8111-111111111111';
const metadata={slug:'payment',moduleKind:'step' as const,exportName:'run',signature:'run({page,args})',inputs:'none',returns:'number',preconditions:'不得刪除原斷言',postconditions:'保留付款限制與證據run/fixed'};
const body='export function run(){return 1}';
const spec="import {test,expect} from '@playwright/test';import {run} from '@lib/payment';test('payment',async({page})=>{expect(await run({page,args:{}})).toBe(1)});";
function task(engine:'builtin'|'vercel',large=false):AuthorInput{
 const root=new URL('../../skills/module-authoring/',import.meta.url),raw=readFileSync(new URL('manifest.json',root)),manifest=JSON.parse(raw.toString()),registry=loadToolRegistry();
 const runtime:AuthorRuntime=JSON.parse(readFileSync(new URL('../../../../contracts/testdata/agent-runtime.json',import.meta.url),'utf8'));
 runtime.engine=engine;runtime.contextInputTokens=32000;runtime.sha256=runtimeDigest(runtime);
 return {kind:'author',runId:id,attemptId:id,workspaceId:id,testId:id,timeoutMs:180000,script:body+(large?'\n// '+'繁體限制 '.repeat(1800):''),
 workspaceContext:{schemaVersion:'1',workspaceId:id,settingsRevision:1,roleRefs:[],config:{name:'payment',purpose:'test',backgroundSummary:'synthetic',targets:[{name:'target',purpose:'test',origin:'https://example.test'}],dependencies:[],excludedOrigins:[],exclusions:'',loginRoles:[],defaultTestUrl:'',timeoutMs:60000}},author:{
 conversationId:id,editingSessionId:id,baseRevision:7,contextRevision:3,sourceVersion:null,conversationSummary:null,messages:[{role:'user',content:'只修正付款回傳與對應斷言，保留其他限制與run/fixed證據，不發佈。'}],skillId:'module-authoring',skillVersion:'1',
 allowedTools:['read_author_snapshot','read_module_candidate_part','edit_module_candidate','commit_module_candidate','request_module_validation'],platform:{planId:null,stageId:null,module:{...metadata,harness:spec+(large?'\n// '+'保留其他斷言 '.repeat(1500):'')}},
 skills:[{id:'module-authoring',version:'1',sha256:sha256(readFileSync(new URL('SKILL.md',root))),manifestSha256:sha256(raw),referenceHashes:Object.fromEntries(manifest.references.map((r:{id:string;sha256:string})=>[r.id,r.sha256]))}],budget:manifest.budget,model:manifest.model,toolRegistryVersion:registry.version,toolRegistrySha256:registry.sha256,runtime}};
}
function edit(v:AuthorInput,ref:{stagingRevision:number;scriptSha256:string;harnessSha256:string}){
 const scriptOffset=Buffer.byteLength(v.script.slice(0,v.script.indexOf('return 1')))+7;
 const harness=v.author.platform!.module!.harness,assertOffset=Buffer.byteLength(harness.slice(0,harness.indexOf('toBe(1)')))+5;
 return {stagingRevision:ref.stagingRevision,scriptSha256:ref.scriptSha256,harnessSha256:ref.harnessSha256,edits:[{part:'script',offsetBytes:scriptOffset,deleteBytes:1,insert:'2'},{part:'harness',offsetBytes:assertOffset,deleteBytes:1,insert:'2'}],metadata};
}
const snapshot=(body:any)=>{const item=body.input.find((i:any)=>i.role==='user'&&JSON.stringify(i.content).includes('Saved draft snapshot'));
 const text=typeof item.content==='string'?item.content:item.content[0].text;return JSON.parse(text.slice(text.indexOf('{')));};
const config=(v:AuthorInput)=>readAuthorConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-module-edit-key'},v.author.runtime);

test('both engines edit >8KiB original parts through frozen references and preserve all untouched bytes inside capacity',async t=>{
 for(const engine of ['builtin','vercel'] as const){
  const v=task(engine,true),before=JSON.stringify(v),bodies:any[]=[];let verified=0;
  const out=await runAuthor(v,config(v),{verifyDraft:async(h:string,o:any)=>{verified++;assert.equal(h,v.author.platform!.module!.harness.replace('toBe(1)','toBe(2)'));assert.equal(o.moduleFile.content,v.script.replace('return 1','return 2'));return {passed:true,summary:'synthetic'};}} as any,{fetcher:async(_url,init)=>{
   const b=JSON.parse(String(init!.body));bodies.push(b);assert.ok(estimateInputTokens(b)<=32000);assert.equal(b.max_output_tokens,16384);assert.equal(b.reasoning.effort,'xhigh');
   const saved=snapshot(b),ref=saved.moduleCandidateRef;assert.equal(ref.stagingRevision,0);assert.equal(saved.script.dataOnly,true);assert.equal(saved.platform.module.harness.dataOnly,true);
   if(bodies.length===1)return Response.json(envelope([call('read_module_candidate_part','script',{part:'script',stagingRevision:0,offsetBytes:0})]));
   if(bodies.length===2)return Response.json(envelope([call('read_module_candidate_part','harness',{part:'harness',stagingRevision:0,offsetBytes:0})]));
   assert.equal(bodies.length,3);const args=edit(v,ref);assert.ok(Buffer.byteLength(JSON.stringify(args))<8192);return Response.json(envelope([call('edit_module_candidate','edit',args)]));
  }}) as AuthorOutput;
  assert.equal(verified,1);assert.equal(bodies.length,3);assert.equal(out.script,v.script.replace('return 1','return 2'));assert.equal(out.requestValidation,true);assert.equal(out.partial,undefined);assert.equal(JSON.stringify(v),before);
  t.diagnostic(JSON.stringify({engine,requests:bodies.length,selfTests:verified,sourceBytes:Buffer.byteLength(v.script)+Buffer.byteLength(v.author.platform!.module!.harness),peakEstimate:Math.max(...bodies.map(estimateInputTokens)),limit:32000}));
 }
});

test('a complete candidate can finish in the final single model/tool slot with no extra request or staging',async()=>{
 for(const engine of ['builtin','vercel'] as const){
  const v=task(engine);v.author.budget!.maxModelRequests=1;v.author.budget!.maxToolCalls=1;let requests=0,tests=0;
  const out=await runAuthor(v,config(v),{verifyDraft:async()=>{tests++;return {passed:true,summary:'synthetic'};}} as any,{fetcher:async(_url,init)=>{
   assert.equal(++requests,1);const b=JSON.parse(String(init!.body));return Response.json(envelope([call('edit_module_candidate','edit',edit(v,snapshot(b).moduleCandidateRef))]));
  }}) as AuthorOutput;
  assert.equal(requests,1);assert.equal(tests,1);assert.equal(out.script,v.script.replace('return 1','return 2'));assert.equal(out.partial,undefined);
 }
});

test('failed local edits expose a new unverified revision for repair while the verified guard stays authoritative',async()=>{
 const v=task('builtin');let requests=0,tests=0;
 const out=await runAuthor(v,config(v),{verifyDraft:async()=>({passed:++tests===2,summary:'synthetic intent'})} as any,{fetcher:async(_url,init)=>{
  const b=JSON.parse(String(init!.body));
  if(++requests===1){const args=edit(v,snapshot(b).moduleCandidateRef);args.edits=args.edits.slice(0,1);return Response.json(envelope([call('edit_module_candidate','first',args)]));}
  assert.equal(requests,2);const prior=JSON.parse(b.input.find((i:any)=>i.type==='function_call_output'&&i.call_id==='first').output);assert.equal(prior.candidate,false);assert.equal(prior.candidateRef.validationEvidence,false);
  const args=edit(v,prior.candidateRef);args.edits=args.edits.slice(1);return Response.json(envelope([call('edit_module_candidate','repair',args)]));
 }}) as AuthorOutput;
 assert.equal(requests,2);assert.equal(tests,2);assert.equal(out.script,v.script.replace('return 1','return 2'));assert.equal(out.partial,undefined);
});
