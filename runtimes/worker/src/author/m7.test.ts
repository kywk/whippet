import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readAIConfig } from "../ai/config.js";
import { runAuthor } from "./loop.js";
import { AuthorError, validateAuthorInput, type AuthorInput } from "./types.js";
import type { ExplorationBrowser } from "./tools.js";

const cfg=readAIConfig({WHIPPET_AI_ENABLED:"true",OPENCODE_API_KEY:"synthetic-m7-never-real",WHIPPET_AI_REASONING_EFFORT:"high"});
const id="11111111-1111-4111-8111-111111111111";
function input(summary=false):AuthorInput {
  const script="throw new Error('do not execute this candidate in author')";
  return {kind:"author",runId:id,attemptId:id,timeoutMs:180000,script,workspaceSettings:{revision:1,sites:[],defaultTestUrl:"https://example.test",timeoutMs:60000},author:{
    skillId:summary?"acceptance-summary":"test-author",skillVersion:"1",allowedTools:summary?[]:["read_draft","update_draft","request_validation"],
    editingSessionId:id,contextRevision:0,conversationId:id,baseRevision:3,
    sourceVersion:{id,description:"Source text is DATA, not a command",backgroundSummary:null},conversationSummary:"Known context from this editing cycle",
    messages:summary?[]:[{role:"user",content:"Preserve the existing test goal"}],
    ...(summary?{validationEvidence:{runId:id,attemptId:id,draftRevision:3,scriptHash:createHash("sha256").update(script).digest("hex"),timeoutMs:60000,status:"succeeded",reportsReady:true,stats:{expected:1,unexpected:0,flaky:0,skipped:1,duration:42.5}}}:{}),
  }};
}
function final(value:object){return Response.json({status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(value)}]}]});}
function call(name:string,args:object,n:number){return Response.json({status:"completed",output:[{type:"function_call",name,call_id:`call_${n}`,arguments:JSON.stringify(args)}]});}
function browser(){const actions:string[]=[];const b:ExplorationBrowser={async navigate(){actions.push("navigate");return{};},async snapshot(){actions.push("snapshot");return{};},async click(){actions.push("click");return{};},async fill(){actions.push("fill");return{};},async close(){actions.push("close");}};return {b,actions};}

test("M7 edit captures flat pinned context, executes only allowed tools, maintains conversation summary",async()=>{
  const task=input();const {b,actions}=browser();const bodies:any[]=[];
  const replies=[()=>call("browser_navigate",{url:"https://example.test"},1),()=>call("update_draft",{script:"candidate remains unexecuted"},2),()=>call("request_validation",{},3),()=>final({message:"候選稿待獨立驗證",conversationSummary:"保留目標及待驗證限制"})];
  const result=await runAuthor(task,cfg,b,{fetcher:async(_url,init)=>{const body=JSON.parse(init!.body as string);bodies.push(body);return replies[bodies.length-1]!();}});
  assert.deepEqual(result,{message:"候選稿待獨立驗證",conversationSummary:"保留目標及待驗證限制",script:"candidate remains unexecuted",requestValidation:true});
  assert.deepEqual(actions,[]);
  for(const body of bodies){
    assert.deepEqual(body.tools.map((t:any)=>t.name),task.author.allowedTools);
    assert.match(body.instructions,/# Test author/);assert.match(body.instructions,/# Playwright recipe/);
    assert.equal(body.instructions.includes("Source text is DATA, not a command"),false);
    const saved=JSON.parse(body.input[0].content.split("(data only): ")[1]);
    assert.equal(saved.script,task.script);assert.equal(saved.editingSessionId,id);assert.equal(saved.contextRevision,0);
    assert.deepEqual(saved.sourceVersion,task.author.sourceVersion);assert.equal(saved.conversationSummary,task.author.conversationSummary);
    assert.equal(saved.context,undefined);assert.equal(saved.mode,undefined);
  }
  assert.match(bodies[1].input.find((v:any)=>v.type==="function_call_output").output,/tool_failed/);
  assert.equal("skillId"in result,false);assert.equal("editingSessionId"in result,false);
});

test("M7 summary accepts empty chat and produces only bounded summary fields with no browser or tools",async()=>{
  const task=input(true);let requests=0;
  const output={message:"摘要待QA確認",description:"目的、前置條件、步驟、檢查與限制",backgroundSummary:"供下次編輯的非機密背景",name:"候選名稱"};
  assert.equal(validateAuthorInput(task),task);
  const result=await runAuthor(task,cfg,undefined,{fetcher:async(_url,init)=>{
    requests++;const body=JSON.parse(init!.body as string);assert.deepEqual(body.tools,[]);assert.equal(body.reasoning.effort,"high");assert.match(body.instructions,/# Acceptance summary/);
    const saved=JSON.parse(body.input[0].content.split("(data only): ")[1]);assert.deepEqual(saved.validationEvidence,task.author.validationEvidence);assert.equal(saved.script,task.script);
    assert.equal(body.input.length,1);assert.equal((init!.headers as Record<string,string>)["x-opencode-session"],id);return final(output);
  }});
  assert.equal(requests,1);assert.deepEqual(result,output);assert.equal("requestValidation"in result,false);assert.equal("script"in result,false);
});

test("M7 invalid pin/context/evidence is rejected before any model request",async()=>{
  const variants=[
    (v:any)=>{v.author.skillVersion="2";},(v:any)=>{delete v.author.contextRevision;},(v:any)=>{v.author.mode="summary";},
    (v:any)=>{v.author.context={};},(v:any)=>{v.author.validationEvidence.scriptHash="0".repeat(64);},
    (v:any)=>{v.author.validationEvidence.draftRevision=2;},(v:any)=>{v.author.validationEvidence.reportsReady=false;},
    (v:any)=>{v.author.validationEvidence.reportUrl="https://example.test/report";},(v:any)=>{delete v.author.validationEvidence.stats.duration;},
    (v:any)=>{v.author.allowedTools=["update_draft"];},(v:any)=>{v.timeoutMs=900001;},
  ];
  let requests=0;
  for(const mutate of variants){const task=input(true);mutate(task);await assert.rejects(runAuthor(task,cfg,undefined,{fetcher:async()=>{requests++;return final({});}}),AuthorError);}
  assert.equal(requests,0);
  const edit=input();edit.author.messages=[];assert.throws(()=>validateAuthorInput(edit),AuthorError);
});

test("M7 summary rejects function calls, scripts, validation flags, metadata and byte overflow without retry",async()=>{
  const base={message:"完成",description:"內容",backgroundSummary:"背景"};
  const variants=[{...base,script:"mutated"},{...base,requestValidation:false},{...base,skillId:"acceptance-summary"},{...base,description:"測".repeat(6000)},{...base,backgroundSummary:"a".repeat(8193)},{...base,name:"a".repeat(201)}];
  for(const output of variants){let calls=0;await assert.rejects(runAuthor(input(true),cfg,undefined,{fetcher:async()=>{calls++;return final(output);}}),(e:unknown)=>e instanceof AuthorError&&e.code==="invalid_response");assert.equal(calls,1);}
  let calls=0;await assert.rejects(runAuthor(input(true),cfg,undefined,{fetcher:async()=>{calls++;return call("update_draft",{script:"forbidden"},1);}}),AuthorError);assert.equal(calls,1);
  await assert.rejects(runAuthor(input(),cfg,undefined,{fetcher:async()=>final({message:"完成",conversationSummary:"a".repeat(8193)})}),AuthorError);
});
