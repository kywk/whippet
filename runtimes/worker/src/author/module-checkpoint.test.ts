import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuthor } from './loop.js';
import { loadToolRegistry, sha256 } from './registry.js';
import { readAuthorConfig, runtimeDigest, type AuthorRuntime } from './runtime.js';
import { AuthorError, type AuthorInput, type AuthorOutput } from './types.js';
import { envelope, call } from './spike/fixture.js';
import { KnownSecrets } from '../login/client.js';

const id = '11111111-1111-4111-8111-111111111111';
const script = 'export function run(){return 1}';
const harness = "import {test,expect} from '@playwright/test';import {run} from '@lib/checkpoint';test('intent',()=>{expect(run()).toBe(1)});";
const metadata = { slug: 'checkpoint', moduleKind: 'step' as const, exportName: 'run', signature: 'run()', inputs: 'none', returns: 'one', preconditions: '限制：<>&\u2028不得刪除斷言', postconditions: '保留原斷言' };
function input(engine: 'builtin' | 'vercel'): AuthorInput {
  const registry = loadToolRegistry(), root = new URL('../../skills/module-authoring/', import.meta.url);
  const raw = readFileSync(new URL('manifest.json', root)), manifest = JSON.parse(raw.toString());
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL('../../../../contracts/testdata/agent-runtime.json', import.meta.url), 'utf8'));
  runtime.engine = engine; runtime.sha256 = runtimeDigest(runtime);
  return { kind: 'author', runId: id, attemptId: id, workspaceId: id, testId: id, script, timeoutMs: 180000,
    workspaceContext: { schemaVersion:'1', workspaceId:id, settingsRevision:1, roleRefs:[], config: { name:'checkpoint',purpose:'test',backgroundSummary:'synthetic',targets:[{name:'target',purpose:'test',origin:'https://example.test'}],dependencies:[],excludedOrigins:[],exclusions:'',loginRoles:[],defaultTestUrl:'',timeoutMs:60000 } }, author: {
    conversationId: id, baseRevision: 1, contextRevision: 1, editingSessionId: id, sourceVersion: null, conversationSummary: null,
    messages: [{ role: 'user', content: '先保存已通過的付款 Module，仍須補另一個斷言；不自動發佈。' }],
    skillId: 'module-authoring', skillVersion: '1', allowedTools: ['stage_module_candidate_part', 'commit_module_candidate', 'request_module_validation'],
    platform: { planId: null, stageId: null, module: { ...metadata, harness } },
    skills: [{ id: 'module-authoring', version: '1', sha256: sha256(readFileSync(new URL('SKILL.md', root))), manifestSha256: sha256(raw), referenceHashes: Object.fromEntries(manifest.references.map((r: {id:string;sha256:string}) => [r.id, r.sha256])) }],
    toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, budget: manifest.budget, model: manifest.model, runtime,
  } };
}
const sequence = (pause: boolean) => [
  ['stage_module_candidate_part', { part: 'script', content: script, stagingRevision: 0 }],
  ['stage_module_candidate_part', { part: 'harness', content: harness, stagingRevision: 1 }],
  ['commit_module_candidate', { stagingRevision: 2, metadata, ...(pause ? { nextStep: '補齊另一個付款斷言；原限制與證據不能省略。' } : {}) }],
] as const;
const config = (v: AuthorInput) => readAuthorConfig({ WHIPPET_AI_ENABLED: 'true', OPENCODE_API_KEY: 'synthetic-module-checkpoint-key' }, v.author.runtime);

test('both engines pause a verified standalone Module and complete a second Run within the original allocation', async t => {
  for (const engine of ['builtin', 'vercel'] as const) {
    let totalRequests = 0, totalTests = 0;
    const first = input(engine), original = JSON.stringify(first);
    let prior: AuthorOutput | undefined;
    for (const pause of [true, false]) {
      const v = structuredClone(first);
      if (!pause) {
        v.author.baseRevision++; v.author.contextRevision = v.author.contextRevision! + 1;
        v.author.budget!.maxModelRequests -= prior!.partial!.usage!.modelRequests;
        v.author.budget!.maxToolCalls -= prior!.partial!.usage!.toolCalls;
        v.author.budget!.maxDurationMs -= prior!.partial!.usage!.durationMs;
        v.timeoutMs = v.author.budget!.maxDurationMs;
      }
      let requests = 0;
      const out = await runAuthor(v, config(v), { verifyDraft: async () => { totalTests++; return { passed: true, summary: 'synthetic' }; } } as any, {
        fetcher: async (_url, init) => {
          const body = JSON.parse(String(init!.body)); assert.equal(body.max_output_tokens, 16384); assert.equal(body.reasoning.effort, 'xhigh');
          const item = sequence(pause)[requests++]; assert.ok(item, 'no hidden finish request'); totalRequests++;
          return Response.json(envelope([call(item[0], `tool-${requests}`, item[1])]));
        },
      }) as AuthorOutput;
      assert.equal(out.script, script); assert.deepEqual(out.module, { ...metadata, harness }); assert.equal(requests, 3);
      if (pause) {
        assert.equal(out.requestValidation, false); assert.equal(out.partial?.reason, 'checkpoint_saved');
        assert.equal(out.partial?.checkpoint?.scriptHash, sha256(script));
        assert.equal((out.partial?.checkpoint as any)?.moduleHash, sha256(Object.values({ ...metadata, harness }).map(s => `${Buffer.byteLength(s)}:${s}`).join('')));
        assert.equal(out.partial?.usage?.modelRequests, 3); assert.equal(out.partial?.usage?.toolCalls, 3); prior = out;
      } else { assert.equal(out.partial, undefined); assert.equal(out.requestValidation, true); }
    }
    assert.equal(totalRequests, 6); assert.equal(totalTests, 2); assert.equal(JSON.stringify(first), original);
    t.diagnostic(JSON.stringify({engine,totalRequests,totalTests,firstUsage:prior!.partial!.usage,maxRequests:8,maxTools:12}));
  }
});

test('Plan stages cannot request a standalone checkpoint and failed self-tests cannot mint one', async () => {
  for (const mode of ['plan', 'failed'] as const) {
    const v = input('builtin'); if (mode === 'plan') { v.author.platform!.planId = id; v.author.platform!.stageId = 'stage'; }
    let requests = 0, tests = 0;
    await assert.rejects(runAuthor(v, config(v), { verifyDraft: async () => { tests++; return { passed: false, summary: 'synthetic failure' }; } } as any, { fetcher: async () => {
      const item = sequence(true)[requests++];
      return Response.json(envelope(item ? [call(item[0], `t-${requests}`, item[1])] : [{type:'message',role:'assistant',content:[{type:'output_text',text:'{"message":"未保存"}'}]}]));
    } }), e => e instanceof AuthorError && e.code === 'invalid_response');
    assert.equal(tests, mode === 'plan' ? 0 : 1);
  }
});

test('cancellation and newly discovered secrets discard a Module checkpoint before artifact output', async () => {
  for (const mode of ['cancel', 'secret'] as const) {
    const v=input('builtin'), stop=new AbortController(), secrets=new KnownSecrets(); let requests=0;
    await assert.rejects(runAuthor(v,config(v),{verifyDraft:async()=>{
      if(mode==='cancel')stop.abort(); else secrets.add('不得刪除斷言');
      return {passed:true,summary:'synthetic'};
    }} as any,{signal:stop.signal,secrets,fetcher:async()=>{
      const item=sequence(true)[requests++]; assert.ok(item);
      return Response.json(envelope([call(item[0],`t-${requests}`,item[1])]));
    }}),e=>e instanceof AuthorError&&e.code===(mode==='cancel'?'cancelled':'sensitive_output'));
    assert.equal(requests,3);
  }
});

test('truncated commit arguments never execute or promote staged parts to a Module checkpoint', async () => {
  for (const engine of ['builtin','vercel'] as const) {
    const v=input(engine);let requests=0,tests=0;
    await assert.rejects(runAuthor(v,config(v),{verifyDraft:async()=>{tests++;return {passed:true,summary:'synthetic'};}} as any,{fetcher:async()=>{
      if(++requests<3){const item=sequence(true)[requests-1]!;return Response.json(envelope([call(item[0],`t-${requests}`,item[1])]));}
      assert.equal(requests,3);
      return Response.json(envelope([{...call('commit_module_candidate','half',{}),arguments:'{"stagingRevision":'}],{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}));
    }}),e=>e instanceof AuthorError&&e.code==='invalid_response');
    assert.equal(tests,0);assert.equal(requests,3);
  }
});
