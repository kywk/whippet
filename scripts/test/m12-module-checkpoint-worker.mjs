// Server assignment -> actual guarded Worker -> synthetic model/self-test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuthor } from '../../runtimes/worker/dist/author/loop.js';
import { readAuthorConfig } from '../../runtimes/worker/dist/author/runtime.js';
import { serializeAuthorArtifact } from '../../runtimes/worker/dist/author/types.js';
import { envelope, call } from '../../runtimes/worker/dist/author/spike/fixture.js';
import { explorationBrowser } from '../../runtimes/worker/dist/author/tools.js';

const { input, pause, selfTest = 'synthetic' } = JSON.parse(readFileSync(0, 'utf8'));
const config = readAuthorConfig({ WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-module-checkpoint-bridge-key' },input.author.runtime);
const metadata = { slug:input.author.platform.module.slug,moduleKind:'step',exportName:'run',signature:'run({page,args})',inputs:'none',returns:pause?'one':'two',preconditions:'限制：<>&\u2028不得刪除斷言',postconditions:'保留原斷言' };
const script = `export function run(){return ${pause?1:2}}`;
const harness = `import {test,expect} from '@playwright/test';import {run} from '@lib/${metadata.slug}';test('intent',async({page})=>{expect(await run({page,args:{}})).toBe(${selfTest==='fail'?99:pause?1:2})});`;
const sequence = [
  ['stage_module_candidate_part',{part:'script',content:script,stagingRevision:0}],
  ['stage_module_candidate_part',{part:'harness',content:harness,stagingRevision:1}],
  ['commit_module_candidate',{stagingRevision:2,metadata,...(pause?{nextStep:'補齊第二個付款斷言；保留原限制及證據。'}:{})}],
];
let requests=0,selfTests=0;const observed=[];
const real=selfTest==='synthetic'?undefined:explorationBrowser({PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},{scope:input.workspaceContext.config,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
const out=await runAuthor(input,config,{verifyDraft:async(...args)=>{selfTests++;const result=real?await real.verifyDraft(...args):{passed:true,summary:'synthetic self-test'};observed.push(result.passed);return result;}},{fetcher:async(_url,init)=>{
  const body=JSON.parse(String(init.body));assert.equal(body.max_output_tokens,16384);assert.equal(body.model,input.author.runtime.model);assert.equal(body.reasoning.effort,input.author.runtime.reasoningEffort);
  const item=sequence[requests++];
  if(!item){assert.equal(selfTest,'fail');assert.equal(requests,4);return Response.json(envelope([{type:'message',role:'assistant',content:[{type:'output_text',text:'{"message":"斷言失敗，未保存候選"}'}]}]));}
  return Response.json(envelope([call(item[0],`checkpoint-${requests}`,item[1])]));
}});
assert.equal(requests,3);assert.equal(selfTests,1);assert.equal(out.script,script);assert.deepEqual(out.module,{...metadata,harness});
assert.equal(out.requestValidation,!pause);assert.equal(out.partial?.reason,pause?'checkpoint_saved':undefined);
if(pause){assert.equal(out.partial.usage.modelRequests,3);assert.equal(out.partial.usage.toolCalls,3);}
process.stdout.write(serializeAuthorArtifact(out,'module-authoring'));
} catch(error) {
  if(selfTest!=='fail')throw error;
  assert.equal(error.code,'invalid_response');assert.equal(selfTests,1);assert.deepEqual(observed,[false]);assert.equal(requests,4);
  process.stdout.write(JSON.stringify({expectedFailure:true,error:error.code,selfTests,requests,checkpointCreated:false})+'\n');
} finally {await real?.close();}
