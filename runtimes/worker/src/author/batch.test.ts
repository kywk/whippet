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
function fixture():AuthorInput {
 const root=join(defaultSkillsPath,'acceptance-summary'),raw=readFileSync(join(root,'manifest.json')),m=JSON.parse(raw.toString()) as SkillManifest,r=loadToolRegistry(),script='tested usecase';
 const evidence={runId:id,attemptId:id,draftRevision:1,scriptHash:sha256(script),timeoutMs:1000,status:'succeeded' as const,reportsReady:true as const,stats:{expected:1,unexpected:0,flaky:0,skipped:0,duration:1}};
 return {kind:'author',runId:id,attemptId:id,script,timeoutMs:1000,workspaceId:id,testId:id,author:{conversationId:id,baseRevision:1,messages:[],skillId:'acceptance-summary',skillVersion:'1',allowedTools:[],editingSessionId:id,contextRevision:0,sourceVersion:null,conversationSummary:null,validationEvidence:evidence,skills:[{id:m.id,version:m.version,sha256:sha256(readFileSync(join(root,'SKILL.md'))),manifestSha256:sha256(raw),referenceHashes:{}}],model:m.model,budget:m.budget,toolRegistryVersion:r.version,toolRegistrySha256:r.sha256,batch:{schemaVersion:1,planId:id,planRevision:1,batchHash:hash,usecase:{testId:id,editingSessionId:id,revision:1,contextRevision:0,bundleHash:hash,validationEvidence:structuredClone(evidence)},modules:[{testId:id,versionId:id,mode:'reuse',editingSessionId:null,revision:1,contextRevision:0,bundleHash:hash,name:'Module',description:null,module:{slug:'search',moduleKind:'step',exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:''},harnessHash:hash,validationEvidence:structuredClone(evidence)}]}}};
}
test('batch requires summary-only nested snapshot, bounded metadata, unique pinned modules and matching evidence',()=>{
 validateAuthorInput(fixture());
 const mutations:((v:any)=>void)[]=[v=>v.author.batch=null,v=>{v.batch=v.author.batch;delete v.author.batch},v=>v.author.batch.extra=1,v=>v.author.batch.modules.push(v.author.batch.modules[0]),v=>v.author.batch.modules[0].module.harness='hidden body',v=>v.author.batch.modules[0].mode='candidate',v=>v.author.batch.modules[0].harnessHash='A'.repeat(64),v=>v.author.batch.usecase.validationEvidence.stats.expected=2,v=>v.author.batch.modules[0].name='x'.repeat(201),v=>v.author.batch.modules[0].module.inputs='x'.repeat(4*1024*1024),v=>{v.author.skillId='test-author';v.author.skills[0].id='test-author'},v=>v.author.budget.maxToolCalls=1];
 for(const mutate of mutations){const v=fixture();mutate(v);assert.throws(()=>validateAuthorInput(v));}
});
test('summary engine sees full batch and hash with zero tools and unchanged final parser',async()=>{
 const v=fixture();let seen=false;
 const out=await runAuthor(v,readAIConfig({WHIPPET_AI_ENABLED:'true',WHIPPET_AI_BASE_URL:'https://synthetic.invalid',OPENCODE_API_KEY:'synthetic-key'}),undefined,{engine:{async run(r){assert.equal(r.tools.length,0);assert.equal(r.budget.toolExecutions,0);assert.ok(JSON.stringify(r.context).includes(hash));assert.ok(JSON.stringify(r.context).includes('harnessHash'));assert.ok(r.instructions.includes('author.batch'));seen=true;return {finalText:JSON.stringify({message:'ok',description:'whole batch',backgroundSummary:'validated scope'})};}}});
 assert.equal(seen,true);assert.deepEqual(out,{message:'ok',description:'whole batch',backgroundSummary:'validated scope'});
});
