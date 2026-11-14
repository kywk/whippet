import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {FullResult, TestCase, TestResult, TestStep} from '@playwright/test/reporter';
import NDJSONReporter from '../reporter.js';
import {explorationBrowser} from './tools.js';
import {ModuleDiagnostics, type SelfTestObservation} from './module-diagnostics.js';

test('M10.Z Wave3 red: actual no-browser verifyDraft expect failure needs a step category', async () => {
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  const failure:string[]=[];
  const seen:SelfTestObservation[]=[];
  try {
    const result=await browser.verifyDraft!("import {test,expect} from '@playwright/test'; test('synthetic',()=>expect(1).toBe(2));",{onSelfTestFailure:value=>failure.push(value),onSelfTestObservation:value=>seen.push(value)});
    assert.equal(result.passed,false);
    assert.deepEqual(failure,['TEST_FAILED']);
    assert.equal(seen.at(-1)?.failedStepCategory,'EXPECT');
    const diagnostic=new ModuleDiagnostics();
    diagnostic.selfTestFailure(failure[0]);
    diagnostic.selfTestObservation(seen[0]);
    diagnostic.selfTest(false);
    let emitted:Record<string,unknown>|undefined;
    diagnostic.finish('LIMIT',value=>{emitted=value as Record<string,unknown>});
    assert.equal(emitted?.lastSelfTestFailedStepCategory,'EXPECT','MISSING_OBSERVATION: TEST_FAILED collapsed the Reporter expect step');
    assert.equal(emitted?.lastSelfTestMainFrameNavigation,'UNOBSERVED');
  } finally {await browser.close();}
});

test('M10.Z Wave3 red: actual no-browser verifyDraft request API failure needs a distinct step category', async () => {
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  const failure:string[]=[];
  const seen:SelfTestObservation[]=[];
  try {
    const result=await browser.verifyDraft!("import {test} from '@playwright/test'; test('synthetic',async({request})=>{await request.get('not-a-url')});",{onSelfTestFailure:value=>failure.push(value),onSelfTestObservation:value=>seen.push(value)});
    assert.equal(result.passed,false);
    assert.deepEqual(failure,['TEST_FAILED']);
    assert.equal(seen.at(-1)?.failedStepCategory,'PW_API');
    const diagnostic=new ModuleDiagnostics();
    diagnostic.selfTestFailure(failure[0]);
    diagnostic.selfTestObservation(seen[0]);
    diagnostic.selfTest(false);
    let emitted:Record<string,unknown>|undefined;
    diagnostic.finish('LIMIT',value=>{emitted=value as Record<string,unknown>});
    assert.equal(emitted?.lastSelfTestFailedStepCategory,'PW_API','MISSING_OBSERVATION: TEST_FAILED collapsed the Playwright request API step');
  } finally {await browser.close();}
});

test('M10.Z Wave3 red: actual main-frame navigation is a page event', async () => {
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>fixture</title>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  const seen:SelfTestObservation[]=[];
  try {
    const script=`import {test,expect} from '@playwright/test'; test('synthetic',async({page})=>{await page.goto('http://127.0.0.1:${port}/'); expect(1).toBe(2)});`;
    const result=await browser.verifyDraft!(script,{onSelfTestObservation:value=>seen.push(value)});
    assert.equal(result.passed,false);
    assert.equal(seen.at(-1)?.mainFrameNavigation,'OBSERVED','MISSING_OBSERVATION: true main-frame event was discarded');
  } finally {
    await browser.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

for(const category of ['expect','pw:api'] as const){
  test(`M10.Z Wave3 red: Reporter ${category} error-bearing step needs its own category`, async () => {
    const dir=await mkdtemp(join(tmpdir(),'whippet-w3-reporter-'));
    try {
      const reporter=new NDJSONReporter({summaryPath:join(dir,'summary.json'),diagnostics:true});
      reporter.onStepEnd({} as TestCase,{} as TestResult,{category,error:{message:'synthetic'}} as TestStep);
      reporter.onTestEnd({titlePath:()=>['synthetic'],expectedStatus:'passed'} as TestCase,{status:'failed',duration:1,errors:[{message:'SECRET_SENTINEL'}]} as TestResult);
      await reporter.onEnd({status:'failed'} as FullResult);
      const summary=JSON.parse(await readFile(join(dir,'summary.json'),'utf8')) as Record<string,unknown>;
      assert.equal(summary.failedStepCategory,category==='expect'?'EXPECT':'PW_API','MISSING_OBSERVATION: Reporter discarded a structured failed step');
      assert.deepEqual(summary.errors,['SECRET_SENTINEL'],'existing Reporter errors must remain available to the original self-test result');
    } finally {await rm(dir,{recursive:true,force:true});}
  });
}

test('M10.Z Wave3 red: absent browser fixture is UNOBSERVED', async () => {
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  const seen:SelfTestObservation[]=[];
  try {
    const result=await browser.verifyDraft!("import {test,expect} from '@playwright/test'; test('synthetic',()=>expect(1).toBe(2));",{onSelfTestObservation:value=>seen.push(value)});
    assert.equal(result.passed,false);
    assert.equal(seen.at(-1)?.mainFrameNavigation,'UNOBSERVED','MISSING_OBSERVATION: absent page event cannot mean navigation did not occur');
  } finally {await browser.close();}
});

test('M10.Z Wave3 red: page fixture without a navigation event is NOT_OBSERVED', async () => {
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  const seen:SelfTestObservation[]=[];
  try {
    const result=await browser.verifyDraft!("import {test,expect} from '@playwright/test'; test('synthetic',async({page})=>{await page.waitForTimeout(10);expect(1).toBe(2)});",{onSelfTestObservation:value=>seen.push(value)});
    assert.equal(result.passed,false);
    assert.equal(seen.at(-1)?.mainFrameNavigation,'NOT_OBSERVED','MISSING_OBSERVATION: completed page event lifecycle has no main-frame event');
  } finally {await browser.close();}
});

test('M10.Z Wave3: last failed observation survives a later pass and excludes raw Reporter evidence', () => {
  const diagnostic=new ModuleDiagnostics();
  diagnostic.selfTestFailure('TEST_FAILED');
  diagnostic.selfTestObservation({failedStepCategory:'EXPECT',mainFrameNavigation:'OBSERVED'});
  diagnostic.selfTest(false);
  diagnostic.selfTest(true);
  let emitted:Record<string,unknown>|undefined;
  diagnostic.finish('COMPLETED',value=>{emitted=value as Record<string,unknown>});
  assert.equal(emitted?.schemaVersion,4);
  assert.equal(emitted?.lastSelfTestFailedStepCategory,'EXPECT');
  assert.equal(emitted?.lastSelfTestMainFrameNavigation,'OBSERVED');
  assert.equal(emitted?.selfTestPassedCount,1);
  assert.equal(emitted?.selfTestFailedCount,1);
  assert.equal(JSON.stringify(emitted).includes('SECRET_SENTINEL'),false);
  const malformed=new ModuleDiagnostics();
  malformed.selfTestObservation({failedStepCategory:'EXPECT',mainFrameNavigation:'OBSERVED',raw:'SECRET_SENTINEL'});
  let rejected:Record<string,unknown>|undefined;
  malformed.finish('UNKNOWN',value=>{rejected=value as Record<string,unknown>});
  assert.equal(rejected?.lastSelfTestFailedStepCategory,'UNOBSERVED');
  assert.equal(rejected?.lastSelfTestMainFrameNavigation,'UNOBSERVED');
  const inherited=Object.assign(Object.create({failedStepCategory:'EXPECT',mainFrameNavigation:'OBSERVED'}),{foo:1,bar:2});
  const forged=new ModuleDiagnostics();
  forged.selfTestObservation(inherited);
  let forgedPayload:Record<string,unknown>|undefined;
  forged.finish('UNKNOWN',value=>{forgedPayload=value as Record<string,unknown>});
  assert.equal(forgedPayload?.lastSelfTestFailedStepCategory,'UNOBSERVED');
  assert.equal(forgedPayload?.lastSelfTestMainFrameNavigation,'UNOBSERVED');
  const laterFailure=new ModuleDiagnostics();
  laterFailure.selfTestFailure('TEST_FAILED');
  laterFailure.selfTestObservation({failedStepCategory:'EXPECT',mainFrameNavigation:'OBSERVED'});
  laterFailure.selfTest(false);
  laterFailure.selfTestFailure('CANCELLED');
  let latest:Record<string,unknown>|undefined;
  laterFailure.finish('CANCELLED',value=>{latest=value as Record<string,unknown>});
  assert.equal(latest?.lastSelfTestFailureClass,'CANCELLED');
  assert.equal(latest?.lastSelfTestFailedStepCategory,'UNOBSERVED');
  assert.equal(latest?.lastSelfTestMainFrameNavigation,'UNOBSERVED');
});

test('M10.Z Wave3: observation callback failure cannot change failed self-test result', async () => {
  const browser=explorationBrowser({PATH:process.env.PATH,TMPDIR:process.env.TMPDIR});
  try {
    const result=await browser.verifyDraft!("import {test,expect} from '@playwright/test'; test('synthetic',()=>expect(1).toBe(2));",{onSelfTestObservation:()=>{throw new Error('SECRET_SENTINEL')}});
    assert.equal(result.passed,false);
    assert.equal(result.category,'script_or_assertion');
    assert.equal(typeof result.error,'string');
  } finally {await browser.close();}
});
