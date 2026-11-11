import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import {AIOriginGate,unconfirmedBrowserScope} from './scope.js';
import {CredentialClient,CredentialError,KnownSecrets} from '../login/client.js';
import {redactReportBytes} from '../login/artifacts.js';
import {runAuthor} from './loop.js';
import {readAIConfig} from '../ai/config.js';
import type {AuthorInput} from './types.js';
import type {WorkspaceConfig} from '../workspace-context.js';

const id='11111111-1111-4111-8111-111111111111';
export function scopeConfig():WorkspaceConfig{return {name:'合成站',purpose:'驗收',backgroundSummary:'背景',targets:[{name:'target',purpose:'test',origin:'https://target.test'}],dependencies:[{name:'api',purpose:'api',origin:'https://api.test'},{name:'cdn',purpose:'cdn',origin:'https://cdn.test'},{name:'login',purpose:'login',origin:'https://login.test'}],excludedOrigins:['https://excluded.test'],exclusions:'',loginRoles:[{roleId:id,name:'測試者',loginMethod:'form',loginOrigin:'https://login.test'}],defaultTestUrl:'https://target.test',timeoutMs:60000};}

test('B AI origin gate distinguishes targets, dependency purpose, login and safe denial details',async()=>{
 const gate=new AIOriginGate(scopeConfig());
 assert.equal(new AIOriginGate(unconfirmedBrowserScope()).check('https://target.test','navigation')?.error,'scope_confirmation_required');
 assert.equal(gate.check('https://target.test:443/path?token=not_returned','navigation'),undefined);
 assert.equal(gate.check('https://api.test/data','fetch'),undefined);assert.equal(gate.check('wss://api.test/ws','websocket'),undefined);
 assert.equal(gate.check('https://cdn.test/app.js','script'),undefined);
 assert.equal(gate.check('https://api.test','navigation')?.error,'dependency_usage_not_allowed');
 assert.equal(gate.check('https://cdn.test/data','fetch')?.error,'dependency_usage_not_allowed');
 assert.equal(gate.check('https://login.test','navigation')?.error,'dependency_usage_not_allowed');
 await gate.duringLogin('https://login.test',async()=>assert.equal(gate.check('https://login.test/form','navigation'),undefined));
 assert.equal(gate.check('https://login.test/form','navigation')?.error,'dependency_usage_not_allowed');
 const issue=gate.check('https://target.test.evil.invalid/x?password=not_returned','navigation')!;
 assert.equal(issue.error,'scope_confirmation_required');assert.equal(issue.origin,'https://target.test.evil.invalid');assert.doesNotMatch(JSON.stringify(issue),/password|not_returned/);
 assert.equal(gate.check('https://excluded.test','fetch')?.error,'origin_excluded');
 assert.equal(gate.check('file:///private/key','navigation')?.error,'invalid_browser_url');
});

test('B credential stdin correlates one request, rejects late/wrong-attempt replies and bounds bytes',async()=>{
 const read=new PassThrough(),write=new PassThrough();const frames:any[]=[];write.on('data',(data)=>frames.push(JSON.parse(data.toString())));
 const input={workspaceId:id,runId:id,attemptId:id,workspaceContext:{schemaVersion:'1' as const,workspaceId:id,settingsRevision:1,config:scopeConfig(),roleRefs:[{roleId:id,secretRef:id,secretVersion:1,configured:true}]}};
 const client=new CredentialClient(input,{read,write});const pending=client.resolve(id);
 assert.equal(frames.length,1);assert.equal(frames[0].kind,'credential_request');assert.equal('password'in frames[0],false);
 await assert.rejects(client.resolve(id),CredentialError);
 read.write(JSON.stringify({kind:'credential_response',requestId:frames[0].requestId,attemptId:'wrong',credentials:{}})+'\n');
 const credentials={workspaceId:id,runId:id,attemptId:id,roleId:id,secretRef:id,secretVersion:1,loginOrigin:'https://login.test',username:'synthetic-user',password:'synthetic-🔒-password'};
 read.write(JSON.stringify({kind:'credential_response',requestId:frames[0].requestId,attemptId:id,credentials})+'\n');
 assert.deepEqual(await pending,credentials);assert.equal(client.secrets.clean({text:credentials.password,count:1}).text,'[redacted]');
 const late=client.resolve(id);client.close();await assert.rejects(late,CredentialError);read.write(JSON.stringify({kind:'credential_response',requestId:frames[1].requestId,attemptId:id,credentials})+'\n');
 assert.equal(frames.length,2);read.destroy();write.destroy();
 const oversizedRead=new PassThrough(),oversizedWrite=new PassThrough(),oversizedClient=new CredentialClient(input,{read:oversizedRead,write:oversizedWrite});const oversized=oversizedClient.resolve(id);oversizedRead.write(Buffer.alloc(64*1024+1,97));await assert.rejects(oversized,CredentialError);oversizedWrite.destroy();oversizedRead.destroy();
});

test('B original Playwright embedded ZIP redacts string leaves, preserving real failure counts and code shell',async()=>{
 const {yazl,yauzl}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
 const zip=new yazl.ZipFile();const chunks:Buffer[]=[];const zipped=new Promise<Buffer>((resolve)=>{zip.outputStream.on('data',(b:Buffer)=>chunks.push(b));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));});
 zip.addBuffer(Buffer.from(JSON.stringify({stats:{expected:0,unexpected:1,flaky:0,skipped:0,duration:12},errors:[{message:'secret 1 leaked'}],attachment:{path:'data/old.zip'}})),'report.json');zip.end();
 const source=Buffer.from(`<script>const staticLabel='1';</script><template>data:application/zip;base64,${(await zipped).toString('base64')}</template>`);
 const secrets=new KnownSecrets();secrets.add('1');const cleaned=await redactReportBytes(source,secrets,new Map([['old.zip','new.zip']]));
 assert.match(cleaned.toString(),/staticLabel='1'/);const encoded=cleaned.toString().match(/base64,([A-Za-z0-9+/=]+)/)![1]!;
 const report:any=await new Promise((resolve,reject)=>yauzl.fromBuffer(Buffer.from(encoded,'base64'),{lazyEntries:true},(error:Error,z:any)=>{if(error)return reject(error);z.on('entry',(entry:any)=>z.openReadStream(entry,(_err:Error,stream:any)=>{const data:Buffer[]=[];stream.on('data',(b:Buffer)=>data.push(b));stream.on('end',()=>{resolve(JSON.parse(Buffer.concat(data).toString()));z.close();});}));z.readEntry();}));
 assert.deepEqual(report.stats,{expected:0,unexpected:1,flaky:0,skipped:0,duration:12});assert.match(report.errors[0].message,/\[redacted\]/);assert.equal(report.attachment.path,'data/new.zip');
});

test('B author passes safe scope refusal to the next model request without raw URL or false success',async()=>{
 const task:AuthorInput={kind:'author',runId:id,attemptId:id,workspaceId:id,testId:id,scriptOrigin:'manual',script:'full arbitrary source retained',timeoutMs:180000,
 workspaceContext:{schemaVersion:'1',workspaceId:id,settingsRevision:1,config:scopeConfig(),roleRefs:[]},
 author:{skillId:'test-author',skillVersion:'1',editingSessionId:id,contextRevision:0,sourceVersion:null,conversationSummary:null,conversationId:id,baseRevision:1,messages:[{role:'user',content:'測試已確認網站'}],allowedTools:['browser_navigate']}};
 const gate=new AIOriginGate(scopeConfig());let count=0;
 const result=await runAuthor(task,readAIConfig({WHIPPET_AI_ENABLED:'true',OPENCODE_API_KEY:'synthetic-b'}),{
 async navigate(url){gate.require(url,'navigation');return{};},async snapshot(){return{};},async click(){return{};},async fill(){return{};},async close(){},
 },{fetcher:async(_url,init)=>{count++;const body=JSON.parse(init!.body as string);if(count===1)return Response.json({status:'completed',output:[{type:'function_call',call_id:'c1',name:'browser_navigate',arguments:JSON.stringify({url:'https://unconfirmed.test/path?token=private-value'})}]});
 const refusal=body.input.find((v:any)=>v.type==='function_call_output');assert.match(refusal.output,/scope_confirmation_required/);assert.doesNotMatch(refusal.output,/private-value|path\?/);
 return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"message":"請先確認新增網站範圍；尚未探索成功"}'}]}]});}});
 assert.equal(count,2);assert.equal(result.requestValidation,false);assert.equal(result.script,undefined);
});
