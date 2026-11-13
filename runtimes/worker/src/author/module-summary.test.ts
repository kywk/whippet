import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSkillsPath, type SkillManifest } from './manifest.js';
import { loadToolRegistry, sha256 } from './registry.js';
import { validateAuthorInput, type AuthorInput } from './types.js';
import { runAuthor } from './loop.js';
import { readAIConfig } from '../ai/config.js';
const id='11111111-1111-1111-1111-111111111111',hash='a'.repeat(64);
function batchFixture():AuthorInput {
 const root=join(defaultSkillsPath,'acceptance-summary'),raw=readFileSync(join(root,'manifest.json')),m=JSON.parse(raw.toString()) as SkillManifest,r=loadToolRegistry(),script='tested usecase';
 const evidence={runId:id,attemptId:id,draftRevision:1,scriptHash:sha256(script),timeoutMs:1000,status:'succeeded' as const,reportsReady:true as const,stats:{expected:1,unexpected:0,flaky:0,skipped:0,duration:1}};
 return {kind:'author',runId:id,attemptId:id,script,timeoutMs:1000,workspaceId:id,testId:id,author:{conversationId:id,baseRevision:1,messages:[],skillId:'acceptance-summary',skillVersion:'1',allowedTools:[],editingSessionId:id,contextRevision:0,sourceVersion:null,conversationSummary:null,validationEvidence:evidence,skills:[{id:m.id,version:m.version,sha256:sha256(readFileSync(join(root,'SKILL.md'))),manifestSha256:sha256(raw),referenceHashes:{}}],model:m.model,budget:m.budget,toolRegistryVersion:r.version,toolRegistrySha256:r.sha256,batch:{schemaVersion:1,planId:id,planRevision:1,batchHash:hash,usecase:{testId:id,editingSessionId:id,revision:1,contextRevision:0,bundleHash:hash,validationEvidence:structuredClone(evidence)},modules:[{testId:id,versionId:id,mode:'reuse',editingSessionId:null,revision:1,contextRevision:0,bundleHash:hash,name:'Module',description:null,module:{slug:'search',moduleKind:'step',exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:''},harnessHash:hash,validationEvidence:structuredClone(evidence)}]}}};
}

function fixture():AuthorInput {
 const v=batchFixture(),module={...v.author.batch!.modules[0]!.module,harness:"import {test,expect} from '@playwright/test'; test('body',()=>{expect(1).toBe(1)});"};
 delete v.author.batch;
 v.script='export function search(){return 1}';
 v.author.moduleSummary={schemaVersion:1,module,bundleHash:hash,bodyHash:sha256(v.script),harnessHash:sha256(module.harness)};
 v.author.validationEvidence!.scriptHash=sha256(module.harness);
 return v;
}
test('independent Module summary strictly binds body/harness and mutually exclusive nested snapshots',()=>{
 validateAuthorInput(fixture());
 const mutations:((v:any)=>void)[]=[v=>v.author.moduleSummary=null,v=>v.moduleSummary=v.author.moduleSummary,v=>v.author.moduleSummary.extra=1,v=>v.author.moduleSummary.bodyHash='b'.repeat(64),v=>v.author.moduleSummary.harnessHash='c'.repeat(64),v=>v.author.moduleSummary.module.harness+='changed',v=>v.script+='changed',v=>v.author.validationEvidence.scriptHash=sha256(v.script),v=>v.author.batch=null,v=>v.author.platform=null,v=>v.author.allowedTools=['read_draft'],v=>v.author.budget.maxToolCalls=1,v=>v.author.moduleSummary.module.harness='x'.repeat(2*1024*1024+1),v=>{v.author.skillId='test-author';v.author.skills[0].id='test-author'}];
 for(const mutate of mutations){const v=fixture();mutate(v);assert.throws(()=>validateAuthorInput(v));}
});
test('Module summary prompt contains complete body metadata harness hashes and evidence with no tools',async()=>{
 const v=fixture();
 const out=await runAuthor(v,readAIConfig({WHIPPET_AI_ENABLED:'true',WHIPPET_AI_BASE_URL:'https://synthetic.invalid',OPENCODE_API_KEY:'synthetic-key'}),undefined,{engine:{async run(r){
 assert.equal(r.tools.length,0);assert.equal(r.budget.toolExecutions,0);
 const snapshot=JSON.parse(String(r.context[0]!.content).replace('Saved draft snapshot (data only): ',''));
 assert.equal(snapshot.script,v.script);assert.deepEqual(snapshot.moduleSummary,v.author.moduleSummary);assert.deepEqual(snapshot.validationEvidence,v.author.validationEvidence);
 return {finalText:JSON.stringify({message:'ok',description:'Module and actual harness coverage',backgroundSummary:'fixed body and harness'})};
 }}});
 assert.equal(out.script,undefined);assert.equal(out.requestValidation,undefined);
});

test('Module summary accepts two raw 2MiB files despite JSON escaping and rejects either raw overflow',()=>{
 const v=fixture();v.script='\x01'.repeat(2*1024*1024);const s=v.author.moduleSummary!;s.module.harness=v.script;s.bodyHash=sha256(v.script);s.harnessHash=s.bodyHash;v.author.validationEvidence!.scriptHash=s.harnessHash;
 assert.ok(Buffer.byteLength(JSON.stringify(v))>13*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(s))<13*1024*1024);validateAuthorInput(v);
 v.script+='x';s.bodyHash=sha256(v.script);assert.throws(()=>validateAuthorInput(v));v.script=v.script.slice(0,-1);s.bodyHash=sha256(v.script);s.module.harness+='x';s.harnessHash=sha256(s.module.harness);v.author.validationEvidence!.scriptHash=s.harnessHash;assert.throws(()=>validateAuthorInput(v));
});
