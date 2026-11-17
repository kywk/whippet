import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleCandidateStore } from './module-candidate.js';
import { AuthorError } from './types.js';
import { KnownSecrets } from '../login/client.js';
import { fitContext, ContextCapacityError } from './engines/context.js';

const change=(part:string,offsetBytes:number,deleteBytes:number,insert:string)=>({part,offsetBytes,deleteBytes,insert});
function args(s:ModuleCandidateStore,edits:object[]){const r=s.reference();return {stagingRevision:r.stagingRevision,scriptSha256:r.scriptSha256,harnessSha256:r.harnessSha256,edits};}

test('exact UTF-8 edits preserve every untouched byte and immutable versions remain readable',()=>{
  const script='// 繁體中文限制。\nexport function run(){return 1}'+ 'x'.repeat(20000),harness='原有斷言。'+ 'y'.repeat(21000);
  const s=new ModuleCandidateStore(script,harness,()=>{}),before=s.reference(),offset=Buffer.byteLength(script.slice(0,script.indexOf('return 1')));
  const next=s.edit(args(s,[change('script',offset,8,'return 2')]),()=>{});
  assert.equal(next.script,script.replace('return 1','return 2'));assert.equal(next.harness,harness);assert.equal(s.reference().stagingRevision,1);
  assert.equal(s.read({part:'script',stagingRevision:0,offsetBytes:0}).sha256,before.scriptSha256);
  assert.equal(s.read({part:'script',stagingRevision:null,offsetBytes:0}).stagingRevision,1);
  assert.throws(()=>s.read({part:'harness',stagingRevision:0,offsetBytes:null}),AuthorError);
  let offsetBytes:number|null=0,text='';while(offsetBytes!==null){const p=s.read({part:'harness',stagingRevision:0,offsetBytes});text+=p.content;offsetBytes=p.nextOffsetBytes;}assert.equal(text,harness);
  assert.equal(s.read({part:'harness',stagingRevision:0,offsetBytes:0}).validationEvidence,false);
});

test('stale hashes/CAS, overlapping edits, UTF-8 cuts, oversize and rejected metadata are atomic',()=>{
  const s=new ModuleCandidateStore('界abc','harness',()=>{}),before=s.reference();
  for(const bad of [
    {...args(s,[]),stagingRevision:1},{...args(s,[]),scriptSha256:'0'.repeat(64)},
    args(s,[change('script',1,0,'x')]),args(s,[change('script',0,1,'x')]),
    args(s,[change('script',3,2,'x'),change('script',4,1,'z')]),args(s,[change('script',3,0,'x'),change('script',3,0,'z')]),
    args(s,[change('harness',0,0,'x'.repeat(8193))]),args(s,[change('script',0,0,'\ud800')]),
    args(s,[change('script',99,0,'x')]),args(s,[change('script',0,0,'')]),
  ]){assert.throws(()=>s.edit(bad,()=>{}),AuthorError);assert.deepEqual(s.reference(),before);}
  assert.throws(()=>s.edit(args(s,[change('script',3,1,'z')]),()=>{throw new AuthorError('tool_failed')}),AuthorError);assert.deepEqual(s.reference(),before);
  const large=new ModuleCandidateStore('x'.repeat(2*1024*1024),'h',()=>{});assert.throws(()=>large.edit(args(large,[change('script',0,0,'x')]),()=>{}),AuthorError);assert.equal(large.reference().stagingRevision,0);
  assert.throws(()=>s.complete(0),AuthorError); // Frozen base alone is not legacy staging.
});

test('immutable candidate pages compact with exact revision read-back and the original tool reservation',()=>{
  const s=new ModuleCandidateStore('a'.repeat(7000),'h',()=>{}),readArgs={part:'script',stagingRevision:null,offsetBytes:0},page=s.read(readArgs);
  s.edit(args(s,[change('script',0,1,'b')]),()=>{});
  const body={input:[{type:'function_call',name:'read_module_candidate_part',call_id:'old',arguments:JSON.stringify(readArgs)},{type:'function_call_output',call_id:'old',output:JSON.stringify(page)},{type:'function_call_output',call_id:'latest',output:'{}'}],tools:[{name:'read_module_candidate_part'}],instructions:'protected scope/Stage/evidence'};
  const capacity={contextWindowTokens:32768,maxInputTokens:5000,safetyTokens:1024};
  const fit=fitContext(body,capacity,8192,{toolCalls:1,moduleCandidates:s});assert.equal(fit.compacted,1);
  const compact=JSON.parse((fit.body.input as any[])[1].output);assert.equal(compact.retrieve.arguments.stagingRevision,0);assert.deepEqual(s.read(compact.retrieve.arguments),page);assert.equal(compact.validationEvidence,false);
  assert.throws(()=>fitContext(body,capacity,8192,{toolCalls:0,moduleCandidates:s}),ContextCapacityError);
  assert.equal(JSON.parse(body.input[1]!.output!).content,'a'.repeat(7000));
});

test('newly classified secrets revoke source references/pages rather than returning misleading hashes',()=>{
  const secrets=new KnownSecrets(),s=new ModuleCandidateStore('secret-placeholder','h',v=>{if(JSON.stringify(secrets.clean(v))!==JSON.stringify(v))throw new AuthorError('sensitive_output')});
  s.reference();secrets.add('secret-placeholder');assert.throws(()=>s.reference(),AuthorError);assert.throws(()=>s.read({part:'script',stagingRevision:0,offsetBytes:0}),AuthorError);
});
