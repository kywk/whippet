// Optional in-memory evidence only. No payload, ID, hash or free-form error input.
export const moduleTerminalClasses = ['LIMIT','INVALID_RESPONSE','FINAL_JSON_PARSE','FINAL_SHAPE','CHECKPOINT_MISSING','CHECKPOINT_REJECTED','PROVIDER_FAILED','TIMEOUT','CANCELLED','ARTIFACT_SERIALIZE_LIMIT','ARTIFACT_WRITE_FAILED','COMPLETED','UNKNOWN'] as const;
export type ModuleTerminalClass = typeof moduleTerminalClasses[number];
export const selfTestFailureClasses = ['INVALID_SPEC','GUARD','TIMEOUT','CANCELLED','TEST_FAILED','UNKNOWN'] as const;
export type SelfTestFailureClass = typeof selfTestFailureClasses[number];
export const modelRequestFailureStages = ['UNKNOWN','FETCH_REJECTED','HTTP_NON_OK','BODY_JSON_REJECTED','RESPONSE_GUARD_REJECTED','INCOMPLETE_MAX_OUTPUT_TOKENS','INCOMPLETE_CONTENT_FILTER','INCOMPLETE_UNKNOWN','ENVELOPE_INVALID'] as const;
export type ModelRequestFailureStage = typeof modelRequestFailureStages[number];
export const failedStepCategories = ['EXPECT','PW_API','TEST_STEP','OTHER','UNOBSERVED'] as const;
export type FailedStepCategory = typeof failedStepCategories[number];
export const mainFrameNavigationStates = ['OBSERVED','NOT_OBSERVED','UNOBSERVED'] as const;
export type MainFrameNavigation = typeof mainFrameNavigationStates[number];
export interface SelfTestObservation { failedStepCategory: FailedStepCategory; mainFrameNavigation: MainFrameNavigation }
export class ModuleDiagnostics {
 private modelRequestFailureStage:ModelRequestFailureStage='UNKNOWN';
 modelRequestFailure(value:unknown){if(this.modelRequestFailureStage==='UNKNOWN'&&modelRequestFailureStages.includes(value as ModelRequestFailureStage))this.modelRequestFailureStage=value as ModelRequestFailureStage;}
 private lastSelfTestFailureClass:SelfTestFailureClass='UNKNOWN';
 selfTestFailure(value:unknown){
  this.lastSelfTestFailureClass=selfTestFailureClasses.includes(value as SelfTestFailureClass)?value as SelfTestFailureClass:'UNKNOWN';
  this.lastSelfTestFailedStepCategory='UNOBSERVED';
  this.lastSelfTestMainFrameNavigation='UNOBSERVED';
 }
 private lastSelfTestFailedStepCategory:FailedStepCategory='UNOBSERVED';
 private lastSelfTestMainFrameNavigation:MainFrameNavigation='UNOBSERVED';
 selfTestObservation(value:unknown){
  const candidate=value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
  if(candidate && Object.keys(candidate).length===2 && Object.hasOwn(candidate,'failedStepCategory') && Object.hasOwn(candidate,'mainFrameNavigation') && failedStepCategories.includes(candidate.failedStepCategory as FailedStepCategory) && mainFrameNavigationStates.includes(candidate.mainFrameNavigation as MainFrameNavigation)){
   this.lastSelfTestFailedStepCategory=candidate.failedStepCategory as FailedStepCategory;
   this.lastSelfTestMainFrameNavigation=candidate.mainFrameNavigation as MainFrameNavigation;
  }else{this.lastSelfTestFailedStepCategory='UNOBSERVED';this.lastSelfTestMainFrameNavigation='UNOBSERVED';}
 }
 private passed=0;private failed=0;private created=false;private present=false;private retained=false;
 private terminal?:ModuleTerminalClass;private emitted=false;
 selfTest(passed:boolean){if(passed){this.passed=Math.min(12,this.passed+1);this.created=true;}else this.failed=Math.min(12,this.failed+1);}
 checkpoint(present:boolean,retained=false){this.present=present;this.retained=retained;}
 failure(value:ModuleTerminalClass){if((!this.terminal||this.terminal==='UNKNOWN')&&value!=='COMPLETED'&&moduleTerminalClasses.includes(value))this.terminal=value;}
 finish(fallback:ModuleTerminalClass,emit:(value:object)=>void){
  if(this.emitted)return;this.emitted=true;
  const terminalClass=fallback==='ARTIFACT_WRITE_FAILED'?fallback:this.terminal??(moduleTerminalClasses.includes(fallback)?fallback:'UNKNOWN');
  try{emit({schemaVersion:4,modelRequestFailureStage:this.modelRequestFailureStage,lastSelfTestFailureClass:this.lastSelfTestFailureClass,lastSelfTestFailedStepCategory:this.lastSelfTestFailedStepCategory,lastSelfTestMainFrameNavigation:this.lastSelfTestMainFrameNavigation,selfTestPassedCount:this.passed,selfTestFailedCount:this.failed,checkpointCreated:this.created,checkpointPresentAtFinalize:this.present,checkpointRetainedAfterSecretGuard:this.retained,terminalClass});}catch{/* Evidence failure never changes task semantics. */}
 }
}
