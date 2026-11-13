import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {builtinEngine,type EngineRun} from './engine.js';
import {capabilitySnapshot,loadSkillBundle,type CapabilitySnapshot,type SkillManifest} from './manifest.js';
import {loadToolRegistry,sha256} from './registry.js';
import {runAuthor} from './loop.js';
import {AuthorError,type AuthorInput} from './types.js';
import {readAIConfig} from '../ai/config.js';

function fixture(id='module-authoring') {
 const root=mkdtempSync(join(tmpdir(),'whippet-output-budget-')),registry=loadToolRegistry(),content='# Synthetic skill',reference='Synthetic reference';
 const dir=join(root,id);mkdirSync(join(dir,'references'),{recursive:true});writeFileSync(join(dir,'SKILL.md'),content);writeFileSync(join(dir,'references/ref.md'),reference);
 const manifest:SkillManifest={id,version:'1',defaultTools:['read_skill_reference'],budget:{maxModelRequests:8,maxToolCalls:12,maxDurationMs:180000},model:{provider:'opencode',model:'muse-spark-1.3-contributor',reasoningEffort:'xhigh'},references:[{id:'ref',path:'references/ref.md',sha256:sha256(reference)}]};
 const snapshot:CapabilitySnapshot={skills:[{id,version:'1',sha256:sha256(content),manifestSha256:'',referenceHashes:{ref:sha256(reference)}}],budget:{...manifest.budget},model:{...manifest.model},toolRegistryVersion:registry.version,toolRegistrySha256:registry.sha256};
 const save=()=>{const raw=JSON.stringify(manifest);writeFileSync(join(dir,'manifest.json'),raw);snapshot.skills[0]!.manifestSha256=sha256(raw);};save();
 return {root,manifest,snapshot,registry,save,close:()=>rmSync(root,{recursive:true,force:true})};
}
function setBudget(budget:object,value:unknown){Object.assign(budget,{maxOutputTokens:value});}
function engine(budget:EngineRun['budget'],bodies:number[]):EngineRun {
 return {instructions:'synthetic',context:[],tools:[],budget,model:{reasoningEffort:'low'},signal:new AbortController().signal,beforeRequest:x=>x,request:async b=>{bodies.push(b.max_output_tokens as number);return {status:'completed',output:[],output_text:'done'};},execute:async()=>({}),checkpoint:()=>undefined};
}
test('output budget engine defaults and explicit values reach request; invalid values never request',async()=>{
 for(const value of [undefined,1,8192,16384]){
  const budget={modelRequests:8,toolExecutions:12};if(value!==undefined)setBudget(budget,value);
  const bodies:number[]=[];await builtinEngine.run(engine(budget,bodies));assert.deepEqual(bodies,[value??8192]);
 }
 for(const value of [null,true,'16384',0,-1,1.5,16385,Number.NaN,Infinity]){
  const budget={modelRequests:8,toolExecutions:12};setBudget(budget,value);const bodies:number[]=[];
  await assert.rejects(builtinEngine.run(engine(budget,bodies)),e=>e instanceof AuthorError&&e.code==='invalid_input');assert.equal(bodies.length,0);
 }
});
test('output budget snapshot and manifest validate both effective bounds and immutable pins',()=>{
 const f=fixture();try{
  loadSkillBundle(f.snapshot,f.registry,f.root);
  setBudget(f.manifest.budget,16384);f.save();setBudget(f.snapshot.budget,16384);loadSkillBundle(f.snapshot,f.registry,f.root);
  delete (f.snapshot.budget as any).maxOutputTokens;loadSkillBundle(f.snapshot,f.registry,f.root); // absent remains 8192
  setBudget(f.manifest.budget,4096);f.save();assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);
  setBudget(f.snapshot.budget,4096);loadSkillBundle(f.snapshot,f.registry,f.root);
  delete (f.manifest.budget as any).maxOutputTokens;f.save();setBudget(f.snapshot.budget,16384);assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);
  setBudget(f.snapshot.budget,8192);loadSkillBundle(f.snapshot,f.registry,f.root);
  const pin=f.snapshot.skills[0]!.manifestSha256;setBudget(f.manifest.budget,16384);f.save();f.snapshot.skills[0]!.manifestSha256=pin;assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);
 }finally{f.close();}
});
test('output budget strict malformed fields and non-module elevation fail closed',()=>{
 for(const id of ['module-authoring','test-author']){
  const f=fixture(id);try{
   for(const value of [null,true,'16384',0,-1,1.5,16385]){
    setBudget(f.snapshot.budget,value);assert.throws(()=>capabilitySnapshot(f.snapshot),AuthorError);
    delete (f.snapshot.budget as any).maxOutputTokens;setBudget(f.manifest.budget,value);f.save();assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);
   }
   delete (f.manifest.budget as any).maxOutputTokens;f.save();Object.assign(f.snapshot.budget,{unknown:8192});assert.throws(()=>capabilitySnapshot(f.snapshot),AuthorError);delete (f.snapshot.budget as any).unknown;
   Object.assign(f.manifest.budget,{unknown:8192});f.save();assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);delete (f.manifest.budget as any).unknown;
   if(id!=='module-authoring'){
    setBudget(f.snapshot.budget,16384);assert.throws(()=>capabilitySnapshot(f.snapshot),AuthorError);delete (f.snapshot.budget as any).maxOutputTokens;
    setBudget(f.manifest.budget,16384);f.save();assert.throws(()=>loadSkillBundle(f.snapshot,f.registry,f.root),AuthorError);
   }
  }finally{f.close();}
 }
});
test('output budget auxiliary module cannot elevate primary snapshot',()=>{
 const f=fixture('test-author'),aux=fixture();try{
  // Snapshot primary identity alone must prevent an auxiliary opt-in from elevating it.
  setBudget(aux.manifest.budget,16384);aux.save();f.snapshot.skills.push(aux.snapshot.skills[0]!);setBudget(f.snapshot.budget,16384);
  assert.throws(()=>capabilitySnapshot(f.snapshot),AuthorError);
 }finally{f.close();aux.close();}
});
test('output budget true author fetch pins module and legacy defaults across requests',async()=>{
 const original=process.env.WHIPPET_SKILLS_PATH;
 try{for(const [id,manifestValue,snapshotValue,expected] of [['module-authoring',16384,16384,16384],['module-authoring',16384,undefined,8192],['test-author',undefined,undefined,8192]] as const){
  const f=fixture(id);try{
   if(manifestValue!==undefined)setBudget(f.manifest.budget,manifestValue);f.save();if(snapshotValue!==undefined)setBudget(f.snapshot.budget,snapshotValue);
   process.env.WHIPPET_SKILLS_PATH=f.root;
   const uuid='11111111-1111-4111-8111-111111111111',input:AuthorInput={kind:'author',runId:uuid,attemptId:uuid,script:'export function synthetic(){return 1}',timeoutMs:10000,author:{...f.snapshot,conversationId:uuid,baseRevision:1,messages:[{role:'user',content:'synthetic'}],skillId:id,skillVersion:'1',editingSessionId:uuid,contextRevision:1,sourceVersion:null,conversationSummary:null,allowedTools:['read_skill_reference'],...(id==='module-authoring'?{platform:{planId:null,stageId:null,module:{slug:'synthetic',moduleKind:'step',exportName:'synthetic',signature:'',inputs:'',returns:'',preconditions:'',postconditions:'',harness:"import {test} from '@playwright/test';test('synthetic',()=>{});"}}}:{})}};
   const cfg=readAIConfig({WHIPPET_AI_ENABLED:'true',WHIPPET_AI_BASE_URL:'https://synthetic.invalid',OPENCODE_API_KEY:'synthetic-only'}),seen:number[]=[];
   await assert.rejects(runAuthor(input,cfg,undefined,{fetcher:async(_url,init)=>{
    const body=JSON.parse(init!.body as string);seen.push(body.max_output_tokens);
    if(seen.length===1)return Response.json({status:'completed',output:[{type:'function_call',call_id:'synthetic',name:'read_skill_reference',arguments:JSON.stringify({skillId:id,referenceId:'ref'})}]});
    return Response.json({status:'incomplete',output:[]});
   }}),e=>e instanceof AuthorError&&e.code==='invalid_response');
   assert.deepEqual(seen,[expected,expected]);assert.deepEqual([f.snapshot.budget.maxModelRequests,f.snapshot.budget.maxToolCalls,f.snapshot.budget.maxDurationMs],[8,12,180000]);
  }finally{f.close();}
 }}finally{if(original===undefined)delete process.env.WHIPPET_SKILLS_PATH;else process.env.WHIPPET_SKILLS_PATH=original;}
});

test('output budget no-capability author remains 8192 and invalid capability fails before fetch',async()=>{
 const uuid='11111111-1111-4111-8111-111111111111';
 const input:AuthorInput={kind:'author',runId:uuid,attemptId:uuid,script:'',timeoutMs:10000,author:{conversationId:uuid,baseRevision:1,messages:[{role:'user',content:'synthetic'}]}};
 const cfg=readAIConfig({WHIPPET_AI_ENABLED:'true',WHIPPET_AI_BASE_URL:'https://synthetic.invalid',OPENCODE_API_KEY:'synthetic-only'}),seen:number[]=[];
 await assert.rejects(runAuthor(input,cfg,undefined,{fetcher:async(_url,init)=>{seen.push(JSON.parse(init!.body as string).max_output_tokens);return Response.json({status:'incomplete',output:[]});}}),e=>e instanceof AuthorError&&e.code==='invalid_response');
 assert.deepEqual(seen,[8192]);
 const f=fixture();try{
  Object.assign(input.author,f.snapshot,{skillId:'module-authoring',skillVersion:'1'});setBudget(input.author.budget!,null);
  await assert.rejects(runAuthor(input,cfg,undefined,{fetcher:async()=>{assert.fail('invalid input fetched');}}),e=>e instanceof AuthorError&&e.code==='invalid_input');
 }finally{f.close();}
});
