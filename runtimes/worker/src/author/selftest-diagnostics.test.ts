import test from 'node:test';
import assert from 'node:assert/strict';
import {explorationBrowser} from './tools.js';
import {unconfirmedBrowserScope} from './scope.js';
import {ModuleDiagnostics} from './module-diagnostics.js';

const prefix="import {test,expect} from '@playwright/test';";
test('M109 v2 actual self-test branches, off equivalence, safe fixed evidence',async()=>{
 for(const [name,script,expected] of [
  ['invalid','SECRET_SENTINEL','INVALID_SPEC'],
  ['guard',prefix+"test('synthetic',()=>{});",'GUARD'],
  ['failed',prefix+"test('synthetic',()=>expect(1,'SECRET_SENTINEL').toBe(2));",'TEST_FAILED'],
  ['parse',prefix+"test('synthetic',()=>{ syntax ??? });",'UNKNOWN'],
  ['timeout',prefix+"test('synthetic',async()=>{await new Promise(()=>{});});",'TIMEOUT'],
  ['cancel',prefix+"test('synthetic',()=>{});",'CANCELLED'],
 ] as const){
  const results:unknown[]=[];
  for(const enabled of [false,true]){
   const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},{timeoutMs:5000,...(name==='guard'?{scope:unconfirmedBrowserScope()}:{})});
   const d=new ModuleDiagnostics(); const seen:string[]=[];
   const controller=new AbortController();if(name==='cancel')controller.abort();
   try{
    const result=await browser.verifyDraft!(script,{signal:controller.signal,...(enabled?{onSelfTestFailure:(value)=>{seen.push(value);d.selfTestFailure(value);}}:{})});
    results.push({passed:result.passed,category:result.category});
    d.selfTest(result.passed);
   }catch(e:any){results.push({error:e.code});}finally{await browser.close();}
   assert.deepEqual(seen,enabled?[expected]:[]);
   if(enabled){
    let count=0;d.failure('LIMIT');d.finish('UNKNOWN',value=>{count++;const v=value as any;assert.equal(v.schemaVersion,3);assert.equal(v.lastSelfTestFailureClass,expected);assert.equal(v.terminalClass,'LIMIT');assert(!JSON.stringify(value).includes('SECRET_SENTINEL'));});
    d.finish('UNKNOWN',()=>count++);assert.equal(count,1);
   }
  }
  assert.deepEqual(results[0],results[1],name);
 }
});
test('M109 v2 malicious failure classes cannot enter summary; success retains last failure',()=>{
 for(const value of ['PARSE','TIMEOUT SECRET_SENTINEL',null,{},['GUARD']]){
  const d=new ModuleDiagnostics();d.selfTestFailure(value);d.finish('COMPLETED',v=>assert.equal((v as any).lastSelfTestFailureClass,'UNKNOWN'));
 }
 const d=new ModuleDiagnostics();d.selfTestFailure('TEST_FAILED');d.selfTest(false);d.selfTest(true);
 d.finish('COMPLETED',v=>{assert.equal((v as any).lastSelfTestFailureClass,'TEST_FAILED');assert.equal((v as any).terminalClass,'COMPLETED');});
});
test('M109 v2 observer failure cannot change real invalid-spec result',async()=>{
 const b=explorationBrowser({});
 const result=await b.verifyDraft!('invalid',{onSelfTestFailure:()=>{throw Error('SECRET_SENTINEL');}});
 assert.equal(result.passed,false);await b.close();
});
test('M109 v2 actual in-flight self-test cancellation is observed without changing cancellation',async()=>{
 const b=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
 const controller=new AbortController(),seen:string[]=[];
 const timer=setTimeout(()=>controller.abort(),500);
 try{await assert.rejects(b.verifyDraft!(prefix+"test('synthetic',async()=>{await new Promise(()=>{});});",{signal:controller.signal,onSelfTestFailure:value=>seen.push(value)}),{code:'cancelled'});assert.deepEqual(seen,['CANCELLED']);}
 finally{clearTimeout(timer);await b.close();}
});
