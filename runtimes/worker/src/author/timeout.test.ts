import test from 'node:test';
import assert from 'node:assert/strict';
import {runAuthor} from './loop.js';
import {readAIConfig} from '../ai/config.js';
import type {AuthorInput} from './types.js';

const id='11111111-1111-4111-8111-111111111111';
const config=readAIConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-only'});
test('non-OK response cleanup obeys total deadline and cancellation without changing provider failure',async()=>{
 for(const mode of ['resolved','rejected','timeout','cancel'] as const){
  const input:AuthorInput={kind:'author',runId:id,attemptId:id,script:'',timeoutMs:60,author:{conversationId:id,baseRevision:1,messages:[{role:'user',content:'synthetic'}]}};
  const controller=new AbortController();let cancels=0;let requestSignal:AbortSignal|null|undefined;
  const timer=mode==='cancel'?setTimeout(()=>controller.abort(),15):undefined;
  let watchdog:ReturnType<typeof setTimeout>|undefined;
  try{
   const outcome=await Promise.race([
    runAuthor(input,config,undefined,{signal:controller.signal,fetcher:async(_url,init)=>{
     requestSignal=init?.signal;
     return {ok:false,body:{cancel:()=>{cancels++;return mode==='resolved'?Promise.resolve():mode==='rejected'?Promise.reject(new Error('synthetic')):new Promise(()=>{});}}} as unknown as Response;
    }}).then(()=> 'unexpected-success',(error:unknown)=>(error as {code?:string}).code),
    new Promise<string>(resolve=>{watchdog=setTimeout(()=>resolve('cleanup-hung'),500);}),
   ]);
   assert.equal(outcome,mode==='timeout'?'timed_out':mode==='cancel'?'cancelled':'provider_failed',mode);
   assert.equal(cancels,1);
   assert.equal(requestSignal?.aborted,mode==='timeout'||mode==='cancel');
  }finally{clearTimeout(timer);clearTimeout(watchdog);}
 }
});

import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('real main entry emits fixed observations only for explicit M109 or legacy M106 opt-in',async()=>{
 const root=await mkdtemp(join(tmpdir(),'whippet-observer-gate-'));
 try{
  const preload=join(root,'fetch.mjs');
  // No network or inherited process environment: the real entry runs against a synthetic rejection.
  await writeFile(preload,"globalThis.fetch=async()=>{throw new Error('synthetic-fetch-rejection');};\n");
  for(const [m109,m106,enabled] of [['','',false],['0','0',false],['true','true',false],['1','',true],['','1',true],['1','1',true]] as const){
   const work=await mkdtemp(join(root,'attempt-'));
   await writeFile(join(work,'input.json'),JSON.stringify({kind:'author',runId:id,attemptId:id,script:'',timeoutMs:1000,author:{conversationId:id,baseRevision:1,skillId:'test-author',skillVersion:'1',editingSessionId:id,contextRevision:1,sourceVersion:null,conversationSummary:null,allowedTools:[],messages:[{role:'user',content:'synthetic'}]}}));
   const child=spawnSync(process.execPath,['--import',preload,fileURLToPath(new URL('./main.js',import.meta.url))],{encoding:'utf8',timeout:5000,env:{WHIPPET_WORK_DIR:work,WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-only',WHIPPET_M109_DIAGNOSTICS:m109,WHIPPET_M106_OBSERVE:m106}});
   assert.equal(child.status,1);assert.equal(child.error,undefined);
   assert(!child.stdout.includes('synthetic-fetch-rejection'));assert(!child.stderr.includes('synthetic-fetch-rejection'));
   const messages=child.stdout.trim().split('\n').map(line=>JSON.parse(line).message as string);
   const observations=messages.filter(message=>message.startsWith('author:observe:'));
   assert.deepEqual(observations,enabled?['author:observe:1:started','author:observe:1:fetchInvoked','author:observe:1:failed']:[]);
   assert.equal(messages.some(message=>message.startsWith('m109_diagnostic:')),m109==='1');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
