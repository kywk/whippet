import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page} from '@playwright/test';
import {LiveObserver} from './observer.js';
import {replaceFile,type LiveControl,UUID} from './files.js';

const viewer='11111111-1111-4111-8111-111111111111',nextViewer='22222222-2222-4222-8222-222222222222';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>((done)=>resolve=done);return {promise,resolve};}
async function setup(mode:'jpeg'|'webrtc'='jpeg'){
 const dir=await mkdtemp(join(tmpdir(),'whippet-sensitive-'));await mkdir(join(dir,'live'));
 const control:LiveControl={viewerId:viewer,mode,expiresAt:Date.now()+30000,iceServers:[]};
 await replaceFile(join(dir,'live/control.json'),JSON.stringify(control));
 return {dir,control,async set(value:LiveControl){await replaceFile(join(dir,'live/control.json'),JSON.stringify(value));},async state(){return JSON.parse(await readFile(join(dir,'live/state.json'),'utf8'));},async cleanup(){await rm(dir,{recursive:true,force:true});}};
}
function page(startBarrier?:Promise<void>){
 const callbacks:((v:{data:Buffer})=>void)[]=[];
 const fake={isClosed:()=>false,screencast:{async start(options:{onFrame:(v:{data:Buffer})=>void}){callbacks.push(options.onFrame);if(startBarrier)await startBarrier;},async stop(){}}};
 return {page:fake as unknown as Page,callbacks};
}
function tick(observer:LiveObserver):Promise<void>{return (observer as unknown as {tick():Promise<void>}).tick();}
const frame=Buffer.from([255,216,1,2,255,217]);

test('sensitive pause invalidates a running start callback and drains atomic frame writes before completion',async()=>{
 const s=await setup(),start=deferred(),write=deferred(),written=deferred();let writes=0;
 const p=page(start.promise);
 const observer=new LiveObserver(s.dir,{autoTick:false,async writeFrame(path,data){writes++;written.resolve();await write.promise;await replaceFile(path,data);}});observer.observePage(p.page);
 try{
  const running=tick(observer);
  while(p.callbacks.length===0)await new Promise<void>((resolve)=>setImmediate(resolve));
  p.callbacks[0]!({data:frame});await written.promise;
  const paused=observer.pauseSensitive();let completed=false;void paused.then(()=>completed=true);
  p.callbacks[0]!({data:frame});start.resolve();await running;await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(completed,false,'pause completed before its older file write');
  write.resolve();await paused;assert.equal(writes,1);
  p.callbacks[0]!({data:frame});await tick(observer);assert.equal(writes,1);
  await assert.rejects(stat(join(s.dir,'live',viewer+'.jpg')),{code:'ENOENT'});
  assert.equal((await s.state()).reason,'sensitive_input');
 }finally{start.resolve();write.resolve();await observer.close();await s.cleanup();}
});

test('viewer joining mid-pause gets its own pause state; persistent complete precedes resumed JPEG',async()=>{
 const s=await setup(),p=page();const writes:{reason:string;viewerId:string}[]=[];
 const observer=new LiveObserver(s.dir,{autoTick:false,async writeFrame(path,data){const state=await s.state();writes.push({reason:state.reason,viewerId:state.viewerId});await replaceFile(path,data);}});observer.observePage(p.page);
 try{
  await observer.pauseSensitive();await s.set({...s.control,viewerId:nextViewer});await tick(observer);
  assert.equal(p.callbacks.length,0);assert.deepEqual([ (await s.state()).viewerId,(await s.state()).reason],[nextViewer,'sensitive_input']);
  await observer.resumeSensitive();await tick(observer);
  assert.equal((await s.state()).reason,'sensitive_input_complete');
  p.callbacks.at(-1)!({data:frame});await tick(observer);
  // Drain this test's real fs write without creating a second capture.
  await (observer as unknown as {frameWrite?:Promise<void>}).frameWrite;
  assert.deepEqual(writes,[{reason:'sensitive_input_complete',viewerId:nextViewer}]);
  await tick(observer);assert.equal((await s.state()).reason,'sensitive_input_complete','resume was only a polling pulse');
 }finally{await observer.close();await s.cleanup();}
});

test('WebRTC resume issues a new UUID and ignores old or untagged answers; complete precedes offer',async()=>{
 const s=await setup('webrtc'),p=page();const helpers:{answers:string[];draws:number}[]=[];
 const observer=new LiveObserver(s.dir,{autoTick:false,helperFactory(){const h={answers:[] as string[],draws:0};helpers.push(h);return {async start(){return `offer-${helpers.length}`;},async answer(value){h.answers.push(value);},async draw(){h.draws++;},async close(){}};}});observer.observePage(p.page);
 try{
  await tick(observer);const first=await s.state();assert.match(first.offerId,UUID);
  await s.set({...s.control,answer:'old-answer',answerOfferId:first.offerId});await tick(observer);assert.deepEqual(helpers[0]!.answers,['old-answer']);
  await observer.pauseSensitive();await observer.resumeSensitive();assert.equal((await s.state()).reason,'sensitive_input_complete');
  await tick(observer);const fresh=await s.state();assert.match(fresh.offerId,UUID);assert.notEqual(fresh.offerId,first.offerId);assert.equal(fresh.reason,'sensitive_input_complete');
  assert.deepEqual(helpers[1]!.answers,[],'stale answer consumed during new helper startup');
  await s.set({...s.control,answer:'untagged'});await tick(observer);assert.deepEqual(helpers[1]!.answers,[]);
  await s.set({...s.control,answer:'fresh-answer',answerOfferId:fresh.offerId});await tick(observer);assert.deepEqual(helpers[1]!.answers,['fresh-answer']);
  await s.set({...s.control,mode:'jpeg'});await tick(observer);
  await s.set({...s.control,answer:'late-after-mode',answerOfferId:fresh.offerId});await tick(observer);
  assert.notEqual((await s.state()).offerId,fresh.offerId);assert.deepEqual(helpers[2]!.answers,[]);
 }finally{await observer.close();await s.cleanup();}
});
