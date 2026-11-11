import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readAIConfig} from "../ai/config.js";
import {runAuthor} from "./loop.js";
import {authorNeedsBrowser,AuthorError,parseWorkspaceAuthorOutput,validateAuthorInput,type AuthorInput} from "./types.js";
import {validateWorkspaceConfig,type WorkspaceConfig} from "../workspace-context.js";

const id="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
const cfg=readAIConfig({WHIPPET_AI_ENABLED:"true",OPENCODE_API_KEY:"synthetic-m8-only",WHIPPET_AI_REASONING_EFFORT:"high"});
function config():WorkspaceConfig{return {name:" 合成工作區 ",purpose:"驗收登入",backgroundSummary:"保留既有背景",targets:[{name:"網站",purpose:"主要驗測",origin:"https://example.test"}],dependencies:[{name:"登入",purpose:"login",origin:"https://login.example.test"}],excludedOrigins:[],exclusions:"不測付款",loginRoles:[{roleId:null,name:"測試角色",loginMethod:"form",loginOrigin:"https://login.example.test"}],defaultTestUrl:"https://example.test/tasks",timeoutMs:60000};}
function input(configured=false):AuthorInput{return {kind:"author",runId:id,attemptId:id,workspaceId:id,testId:null,script:"",timeoutMs:180000,
  workspaceContext:{schemaVersion:"1",workspaceId:id,settingsRevision:1,config:configured?config():null,roleRefs:configured?[{roleId:id,secretRef:other,secretVersion:1,configured:true}]:[]},
  author:{conversationId:id,baseRevision:1,skillId:"workspace-author",skillVersion:"1",editingSessionId:null,sourceVersion:null,contextRevision:0,conversationSummary:null,allowedTools:[],messages:[{role:"user",content:"修改原有背景，先提供設定候選"}]}};}
function final(value:unknown){return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(value)}]}]});}

test("M8 workspace interview captures packaged skill and flat nullable context without browser/tools",async()=>{
  for(const configured of [false,true]){
    const task=input(configured);const output={message:"請檢視候選，尚未造訪或測試網站",proposal:config(),conversationSummary:"待明確確認設定"};
    let requests=0,actions=0;
    const browser={async navigate(){actions++;return{};},async snapshot(){actions++;return{};},async click(){actions++;return{};},async fill(){actions++;return{};},async close(){actions++;}};
    assert.equal(authorNeedsBrowser(task),false);
    const result=await runAuthor(task,cfg,browser,{fetcher:async(_url,init)=>{
      requests++;const body=JSON.parse(init!.body as string);assert.deepEqual(body.tools,[]);assert.equal(body.reasoning.effort,"high");
      assert.match(body.instructions,/# Workspace author/);assert.doesNotMatch(body.instructions,/# Playwright recipe/);assert.match(body.instructions,/never grants network/);
      const saved=JSON.parse(body.input[0].content.split("(data only): ")[1]);
      assert.deepEqual(saved.workspaceContext,task.workspaceContext);assert.equal(saved.workspaceId,id);assert.equal(saved.testId,null);assert.equal(saved.editingSessionId,null);assert.equal(saved.sourceVersion,null);
      for(const key of ["context","owner","workspaceSessionId","requiredPolicyVersion"])assert.equal(saved[key],undefined);
      assert.equal((init!.headers as Record<string,string>)["x-opencode-session"],id);assert.equal(body.store,false);return final(output);
    }});
    assert.deepEqual(result,output);assert.equal(requests,1);assert.equal(actions,0);
  }
  const task=input();assert.deepEqual(await runAuthor(task,cfg,undefined,{fetcher:async()=>final({message:"用途與目標網站是什麼？"})}),{message:"用途與目標網站是什麼？"});
});

test("M8 refuses alternate owners, authorization fields, secrets and origin conflicts before model",async()=>{
  const mutations:((v:any)=>void)[]=[
    v=>{v.requiredPolicyVersion=1;},v=>{v.owner={};},v=>{v.workspaceSessionId=id;},v=>{v.author.editingSessionId=id;},v=>{delete v.author.editingSessionId;},
    v=>{v.testId=id;},v=>{v.workspaceContext.workspaceId=other;},v=>{v.author.baseRevision=2;},v=>{v.author.allowedTools=["browser_navigate"];},
    v=>{v.workspaceContext.config={...config(),password:"synthetic"};},v=>{v.workspaceContext.roleRefs=[{roleId:id,secretRef:null,secretVersion:null,configured:false,password:"synthetic"}];},
    v=>{v.workspaceContext.config={...config(),excludedOrigins:["https://example.test:443/"]};},
    v=>{v.workspaceContext.config={...config(),excludedOrigins:["https://excluded.test","https://excluded.test:443/"]};},
    v=>{v.workspaceContext.config={...config(),dependencies:[{name:"衝突",purpose:"api",origin:"https://example.test:443/"}]};},
    v=>{v.workspaceContext.config={...config(),targets:[{name:"網站",purpose:"目標",origin:"https://user:pass@example.test"}]};},
  ];
  let requests=0;for(const mutate of mutations){const task=input();mutate(task);await assert.rejects(runAuthor(task,cfg,undefined,{fetcher:async()=>{requests++;return final({});}}),AuthorError);}assert.equal(requests,0);
  const scoped=input();scoped.testId=id;scoped.author.skillId="test-author";scoped.author.editingSessionId=id;scoped.author.allowedTools=["browser_navigate"];
  assert.throws(()=>validateAuthorInput(scoped),(e:unknown)=>e instanceof AuthorError&&e.code==="security_unavailable");
});

test("M8 proposal output rejects permission/secret fields, cross-Workspace role and overflow without retry",async()=>{
  const good={message:"候選待確認",proposal:config()};
  const variants=[{...good,confirmed:true},{...good,script:"forbidden"},{...good,requestValidation:false},{...good,secretRef:id},{...good,conversationSummary:null},
    {...good,proposal:{...config(),secretRef:id}}, {...good,proposal:{...config(),loginRoles:[{...config().loginRoles[0]!,roleId:other}]}},
    {...good,proposal:{...config(),purpose:"a".repeat(8193)}},{...good,proposal:{...config(),targets:Array(21).fill(config().targets[0])}},
    {...good,conversationSummary:"測".repeat(2731)}];
  for(const output of variants){let requests=0;await assert.rejects(runAuthor(input(),cfg,undefined,{fetcher:async()=>{requests++;return final(output);}}),(e:unknown)=>e instanceof AuthorError&&e.code==="invalid_response");assert.equal(requests,1);}
  let requests=0;await assert.rejects(runAuthor(input(true),cfg,undefined,{fetcher:async()=>{requests++;return Response.json({status:"completed",output:[{type:"function_call",name:"browser_navigate",call_id:"x",arguments:'{"url":"https://example.test"}'}]});}}),AuthorError);assert.equal(requests,1);
  const c=config();c.excludedOrigins=Array.from({length:40},(_,n)=>`https://excluded${n}.test`);assert.equal(validateWorkspaceConfig(c),c);c.excludedOrigins.push("https://excess.test");assert.throws(()=>validateWorkspaceConfig(c));
  const incomplete={...config(),purpose:"",backgroundSummary:"",targets:[],dependencies:[],loginRoles:[],defaultTestUrl:""};
  assert.deepEqual(parseWorkspaceAuthorOutput({message:"仍須補齊用途與目標",proposal:incomplete},input().workspaceContext!),{message:"仍須補齊用途與目標",proposal:incomplete});
});

test("M8 typed Workspace context reaches readonly M7 summary as DATA without granting tools",async()=>{
  const task=input(true);task.testId=id;task.script="// fixed complete script, never executed by summary";
  task.author.skillId="acceptance-summary";task.author.editingSessionId=id;task.author.messages=[];
  task.author.validationEvidence={runId:id,attemptId:id,draftRevision:1,scriptHash:createHash("sha256").update(task.script).digest("hex"),timeoutMs:60000,status:"succeeded",reportsReady:true,stats:{expected:1,unexpected:0,flaky:0,skipped:0,duration:1}};
  assert.equal(authorNeedsBrowser(task),false);
  const output={message:"摘要待QA確認",description:"保留完整驗收目的",backgroundSummary:"新的Workspace背景"};
  assert.deepEqual(await runAuthor(task,cfg,undefined,{fetcher:async(_url,init)=>{
    const body=JSON.parse(init!.body as string);assert.deepEqual(body.tools,[]);assert.match(body.instructions,/# Acceptance summary/);
    const saved=JSON.parse(body.input[0].content.split("(data only): ")[1]);assert.deepEqual(saved.workspaceContext,task.workspaceContext);assert.equal(saved.testId,id);return final(output);
  }}),output);
});

test("M8 edit rejects undeclared validation and B accepts Server-granted validation",async()=>{
  const task=input();task.testId=id;task.script="original candidate";task.author.skillId="test-author";task.author.editingSessionId=id;
  task.author.allowedTools=["read_draft","read_validation_report","update_draft"];
  task.author.validation={runId:other,status:"failed",error:"fixed saved assertion summary"};
  assert.equal(authorNeedsBrowser(task),false);
  let requests=0;
  const result=await runAuthor(task,cfg,undefined,{fetcher:async(_url,init)=>{
    const body=JSON.parse(init!.body as string);assert.deepEqual(body.tools.map((t:any)=>t.name),task.author.allowedTools);requests++;
    if(requests===1)return Response.json({status:"completed",output:[{type:"function_call",name:"request_validation",call_id:"blocked",arguments:"{}"}]});
    if(requests===2){assert.match(body.input.find((i:any)=>i.type==="function_call_output").output,/tool_failed/);return Response.json({status:"completed",output:[{type:"function_call",name:"update_draft",call_id:"update",arguments:JSON.stringify({script:"updated candidate; not executed"})}]});}
    return final({message:"候選已更新，受限驗證尚未就緒"});
  }});
  assert.deepEqual(result,{message:"候選已更新，受限驗證尚未就緒",script:"updated candidate; not executed",requestValidation:false});assert.equal(requests,3);
  task.author.allowedTools.push("request_validation");assert.equal(validateAuthorInput(task),task); // B: Server may now grant real validation.
});
