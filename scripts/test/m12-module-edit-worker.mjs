// Actual Worker/editor with synthetic transport; optional real self-test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runAuthor} from '../../runtimes/worker/dist/author/loop.js';
import {readAuthorConfig} from '../../runtimes/worker/dist/author/runtime.js';
import {serializeAuthorArtifact} from '../../runtimes/worker/dist/author/types.js';
import {explorationBrowser} from '../../runtimes/worker/dist/author/tools.js';
import {envelope,call,text} from '../../runtimes/worker/dist/author/spike/fixture.js';
const {input,pause,mode='synthetic',readsBefore=0}=JSON.parse(readFileSync(0,'utf8'));
const config=readAuthorConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-editor-bridge-key'},input.author.runtime);
const original=input.author.platform.module,next=pause?2:3;
const script=`export function run(){return ${next}}`,harness=`import {test,expect} from '@playwright/test';import {run} from '@lib/${original.slug}';test('intent',async({page})=>{expect(await run({page,args:{}})).toBe(${mode==='fail'?99:next})});`;
const {harness:_old,...metadata}=original;metadata.returns=String(next);
const real=mode==='synthetic'?undefined:explorationBrowser({PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},{scope:input.workspaceContext.config,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let requests=0,selfTests=0;const observed=[];
try {
 const out=await runAuthor(input,config,{verifyDraft:async(...args)=>{selfTests++;const r=real?await real.verifyDraft(...args):{passed:true,summary:'synthetic'};observed.push(r.passed);return r;}},{fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init.body));assert.equal(body.max_output_tokens,16384);assert.equal(body.reasoning.effort,'xhigh');requests++;
  const source=body.input.find(i=>i.role==='user'&&JSON.stringify(i.content).includes('Saved draft snapshot'));
  const raw=typeof source.content==='string'?source.content:source.content[0].text,ref=JSON.parse(raw.slice(raw.indexOf('{'))).moduleCandidateRef;
  if(requests<=readsBefore)return Response.json(envelope([call('read_module_candidate_part',`read-${requests}`,{part:'script',stagingRevision:0,offsetBytes:0})]));
  if(requests===readsBefore+1)return Response.json(envelope([call('edit_module_candidate','edit',{stagingRevision:0,scriptSha256:ref.scriptSha256,harnessSha256:ref.harnessSha256,edits:[{part:'script',offsetBytes:0,deleteBytes:Buffer.byteLength(input.script),insert:script},{part:'harness',offsetBytes:0,deleteBytes:Buffer.byteLength(original.harness),insert:harness}],metadata,...(pause?{nextStep:'仍須完成最後付款斷言，保留原目標、限制及run/fixed。'}:{})})]));
  assert.equal(mode,'fail');assert.equal(requests,readsBefore+2);return Response.json(envelope([text('{"message":"自試失敗，未保存"}')]));
 }});
 assert.equal(requests,readsBefore+1);assert.equal(selfTests,1);assert.equal(out.script,script);assert.equal(out.module.harness,harness);assert.equal(out.requestValidation,!pause);
 if(pause){assert.equal(out.partial.reason,'checkpoint_saved');assert.equal(out.partial.usage.modelRequests,requests);assert.equal(out.partial.usage.toolCalls,requests);}
 process.stdout.write(serializeAuthorArtifact(out,'module-authoring'));
}catch(error){
 if(mode!=='fail')throw error;
 assert.equal(error.code,'invalid_response');assert.deepEqual(observed,[false]);assert.equal(selfTests,1);
 process.stdout.write(JSON.stringify({expectedFailure:true,checkpointCreated:false,requests,selfTests})+'\n');
}finally{await real?.close();}
