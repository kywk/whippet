import { AuthorError, boundedText, type AuthorInput, type ValidationEvidence } from './types.js';
import { exactObject } from './registry.js';
import { validateModule, type ModuleMetadata } from './platform.js';
export interface BatchSummary {
 schemaVersion:1; planId:string; planRevision:number; batchHash:string;
 usecase:{testId:string;editingSessionId:string;revision:number;contextRevision:number;bundleHash:string;validationEvidence:ValidationEvidence};
 modules:{testId:string;versionId:string;mode:'reuse'|'candidate';editingSessionId:string|null;revision:number;contextRevision:number;bundleHash:string;name:string;description:string|null;module:Omit<ModuleMetadata,'harness'>;harnessHash:string;validationEvidence:ValidationEvidence}[];
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min:number)=>Number.isSafeInteger(v)&&(v as number)>=min;
export function validBatchEvidence(v:unknown,revision:number):v is ValidationEvidence {
 if(!exactObject(v,['runId','attemptId','draftRevision','scriptHash','timeoutMs','status','reportsReady','stats'])||!uuid(v.runId)||!uuid(v.attemptId)||v.draftRevision!==revision||!hash(v.scriptHash)||!integer(v.timeoutMs,1)||v.timeoutMs>3600000||v.status!=='succeeded'||v.reportsReady!==true||!exactObject(v.stats,['expected','unexpected','flaky','skipped','duration']))return false;
 return integer(v.stats.expected,1)&&v.stats.unexpected===0&&integer(v.stats.flaky,0)&&integer(v.stats.skipped,0)&&typeof v.stats.duration==='number'&&Number.isFinite(v.stats.duration)&&v.stats.duration>=0;
}
export function validateBatch(input:AuthorInput):void {
 const a=input.author,b=a.batch;if(b===undefined)return;
 const fail=()=>{throw new AuthorError('invalid_input');};
 if(a.skillId!=='acceptance-summary'||!exactObject(b,['schemaVersion','planId','planRevision','batchHash','usecase','modules'])||b.schemaVersion!==1||!uuid(b.planId)||!integer(b.planRevision,1)||!hash(b.batchHash)||Buffer.byteLength(JSON.stringify(b))>4*1024*1024||!Array.isArray(b.modules)||b.modules.length>32||a.allowedTools?.length!==0||a.budget?.maxToolCalls!==0)return fail();
 const u=b.usecase;
 if(!exactObject(u,['testId','editingSessionId','revision','contextRevision','bundleHash','validationEvidence'])||!uuid(u.testId)||!uuid(u.editingSessionId)||!integer(u.revision,1)||!integer(u.contextRevision,0)||!hash(u.bundleHash)||!validBatchEvidence(u.validationEvidence,u.revision)||u.testId!==input.testId||u.editingSessionId!==a.editingSessionId||u.revision!==a.baseRevision||u.contextRevision!==a.contextRevision||(!a.validationEvidence||Object.keys(u.validationEvidence).some(k=>k==='stats'?Object.keys(u.validationEvidence.stats).some(key=>u.validationEvidence.stats[key as keyof ValidationEvidence["stats"]]!==a.validationEvidence!.stats[key as keyof ValidationEvidence["stats"]]):u.validationEvidence[k as keyof ValidationEvidence]!==a.validationEvidence![k as keyof ValidationEvidence])))return fail();
 let previous='';const tests=new Set<string>();
 for(const m of b.modules){
  if(!exactObject(m,['testId','versionId','mode','editingSessionId','revision','contextRevision','bundleHash','name','description','module','harnessHash','validationEvidence'])||!uuid(m.testId)||tests.has(m.testId)||!uuid(m.versionId)||m.versionId<=previous||!['reuse','candidate'].includes(m.mode)|| (m.mode==='reuse'?m.editingSessionId!==null:!uuid(m.editingSessionId))||!integer(m.revision,1)||!integer(m.contextRevision,0)||!hash(m.bundleHash)||!hash(m.harnessHash)||!boundedText(m.name,200)||m.description!==null&&!boundedText(m.description,16384)||!validBatchEvidence(m.validationEvidence,m.revision)||!exactObject(m.module,['slug','moduleKind','exportName','signature','inputs','returns','preconditions','postconditions']))return fail();
  validateModule('',{...m.module,harness:''});tests.add(m.testId);previous=m.versionId;
 }
}
