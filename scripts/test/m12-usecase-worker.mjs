// One actual production-engine Run. Model settings come only from the controlled
// parent environment; browser/self-test children never inherit provider keys.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {runAuthor} from '../../runtimes/worker/dist/author/loop.js';
import {readAuthorConfig} from '../../runtimes/worker/dist/author/runtime.js';
import {AI_DEFAULTS} from '../../runtimes/worker/dist/ai/config.js';
import {serializeAuthorArtifact} from '../../runtimes/worker/dist/author/types.js';
import {loadToolRegistry,validateToolArguments,validateToolResult,sha256} from '../../runtimes/worker/dist/author/registry.js';
import {envelope,call,text} from '../../runtimes/worker/dist/author/spike/fixture.js';
import {KnownSecrets} from '../../runtimes/worker/dist/login/client.js';

const {input,image,harnessURL,harnessToken,synthetic=false,scriptedCalls=[],wave='14'}=JSON.parse(readFileSync(0,'utf8'));
assert.ok(['14','15'].includes(wave));
const safeEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const metrics={modelRequests:0,toolCalls:0,inputTokens:0,outputTokens:0,tokenUsageObserved:false,selfTests:[]};
const registry=loadToolRegistry(),calls=new Map(),secrets=new KnownSecrets();
const config=readAuthorConfig(synthetic?{WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-usecase-key'}:process.env,input.author.runtime);
assert.equal(config.engine,'vercel');assert.equal(config.model,AI_DEFAULTS.model);assert.equal(config.reasoningEffort,AI_DEFAULTS.reasoningEffort);assert.equal(config.baseURL,AI_DEFAULTS.baseURL);
secrets.add(config.apiKey);
const selfTestCode=`import {explorationBrowser} from './dist/author/tools.js';let s='';for await(const b of process.stdin)s+=b;const p=JSON.parse(s),b=explorationBrowser(process.env,{scope:p.scope});try{const r=await b.verifyDraft(p.script,{moduleFile:p.moduleFile});process.stdout.write(JSON.stringify(r));}finally{await b.close()}`;
async function verifyDraft(script,options={}) {
 const name=`whippet-m12-w${wave}-selftest-`+randomUUID();
 const p=spawn('docker',['run','--rm','-i','--name',name,'--label',`whippet.test=m12-wave${wave}`,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','1g','--cpus','1','--tmpfs','/tmp:rw,size=512m','--entrypoint','node',image,'--input-type=module','-e',selfTestCode],{env:safeEnv,stdio:['pipe','pipe','ignore']});
 let result='',overflow=false;
 p.stdout.on('data',b=>{if(Buffer.byteLength(result)+b.length>512*1024){overflow=true;p.kill('SIGTERM')}else result+=b});
 const stop=()=>p.kill('SIGTERM');options.signal?.addEventListener('abort',stop,{once:true});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify({script,moduleFile:options.moduleFile,scope:input.workspaceContext.config}));
 try {
  const code=await new Promise((resolve,reject)=>{p.on('exit',resolve);p.on('error',reject)});assert.equal(code,0);assert.equal(overflow,false);
  const r=JSON.parse(result);metrics.selfTests.push({passed:r.passed,scriptSha256:sha256(script),...(options.moduleFile?{bodySha256:sha256(options.moduleFile.content)}:{})});return r;
 } finally {options.signal?.removeEventListener('abort',stop);await new Promise(resolve=>{const c=spawn('docker',['rm','-f',name],{env:safeEnv,stdio:'ignore'});c.on('exit',resolve);c.on('error',resolve)})}
}
const started=performance.now();
try {
 let syntheticRequests=0;
 const fetcher=synthetic?async()=>{const item=scriptedCalls[syntheticRequests++];assert.ok(item,'no implicit model retry');return Response.json(envelope([item.name?call(item.name,`synthetic-${syntheticRequests}`,item.arguments):text(JSON.stringify(item.final))]));}:undefined;
 const output=await runAuthor(input,config,{verifyDraft}, {secrets,...(fetcher?{fetcher}:{}),harness:{call:async(name,args,providerCallId,signal)=>{
  const tool=registry.tools.find(t=>t.name===name);assert.equal(tool?.side,'server');validateToolArguments(tool,args);
  let id=calls.get(providerCallId);if(!id){id=randomUUID();calls.set(providerCallId,id)}
  const response=await fetch(harnessURL,{method:'POST',headers:{'Content-Type':'application/json','X-M12-Test-Token':harnessToken},body:JSON.stringify({callId:id,name,arguments:args}),signal});
  if(!response.ok)throw new Error('harness_tool_failed');const value=await response.json();validateToolResult(tool,value);return value;
 }},progress:event=>{
  let match=/^author:model:(\d+):started$/.exec(event);if(match)metrics.modelRequests=Number(match[1]);
  match=/^author:tool:(\d+):[^:]+:started$/.exec(event);if(match)metrics.toolCalls=Number(match[1]);
  match=/^author:usage:(\d+):(\d+)$/.exec(event);if(match){metrics.inputTokens+=Number(match[1]);metrics.outputTokens+=Number(match[2]);metrics.tokenUsageObserved=true}
  if(/^author:(model|tool):\d+:(?:[a-z_]+:)?(?:started|succeeded|failed)$/.test(event))process.stderr.write(JSON.stringify({event})+'\n');
 }});
 const artifact=JSON.parse(serializeAuthorArtifact(output,input.author.skillId));
 const receipt={status:'PASS',synthetic,engine:'vercel',skillId:input.author.skillId,model:config.model,effort:config.reasoningEffort,budget:input.author.budget,metrics,latencyMs:Math.round(performance.now()-started),artifact};
 assert.equal(JSON.stringify(receipt).includes(config.apiKey),false);process.stdout.write(JSON.stringify(receipt));
}catch(error){process.stdout.write(JSON.stringify({status:'FAIL',code:typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'harness_or_worker_failed',metrics,latencyMs:Math.round(performance.now()-started)}));process.exitCode=1}
