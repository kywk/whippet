// Optional in-memory evidence only. No payload, ID, hash or free-form error input.
export const moduleTerminalClasses = ['LIMIT','INVALID_RESPONSE','FINAL_JSON_PARSE','FINAL_SHAPE','CHECKPOINT_MISSING','CHECKPOINT_REJECTED','PROVIDER_FAILED','TIMEOUT','CANCELLED','ARTIFACT_SERIALIZE_LIMIT','ARTIFACT_WRITE_FAILED','COMPLETED','UNKNOWN'] as const;
export type ModuleTerminalClass = typeof moduleTerminalClasses[number];
export const selfTestFailureClasses = ['INVALID_SPEC','GUARD','TIMEOUT','CANCELLED','TEST_FAILED','UNKNOWN'] as const;
export type SelfTestFailureClass = typeof selfTestFailureClasses[number];
export class ModuleDiagnostics {
 private lastSelfTestFailureClass:SelfTestFailureClass='UNKNOWN';
 selfTestFailure(value:unknown){this.lastSelfTestFailureClass=selfTestFailureClasses.includes(value as SelfTestFailureClass)?value as SelfTestFailureClass:'UNKNOWN';}
 private passed=0;private failed=0;private created=false;private present=false;private retained=false;
 private terminal?:ModuleTerminalClass;private emitted=false;
 selfTest(passed:boolean){if(passed){this.passed=Math.min(12,this.passed+1);this.created=true;}else this.failed=Math.min(12,this.failed+1);}
 checkpoint(present:boolean,retained=false){this.present=present;this.retained=retained;}
 failure(value:ModuleTerminalClass){if((!this.terminal||this.terminal==='UNKNOWN')&&value!=='COMPLETED'&&moduleTerminalClasses.includes(value))this.terminal=value;}
 finish(fallback:ModuleTerminalClass,emit:(value:object)=>void){
  if(this.emitted)return;this.emitted=true;
  const terminalClass=fallback==='ARTIFACT_WRITE_FAILED'?fallback:this.terminal??(moduleTerminalClasses.includes(fallback)?fallback:'UNKNOWN');
  try{emit({schemaVersion:2,lastSelfTestFailureClass:this.lastSelfTestFailureClass,selfTestPassedCount:this.passed,selfTestFailedCount:this.failed,checkpointCreated:this.created,checkpointPresentAtFinalize:this.present,checkpointRetainedAfterSecretGuard:this.retained,terminalClass});}catch{/* Evidence failure never changes task semantics. */}
 }
}
