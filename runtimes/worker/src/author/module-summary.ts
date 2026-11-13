import { AuthorError, type AuthorInput } from './types.js';
import { exactObject, sha256 } from './registry.js';
import { validateModule, type ModuleMetadata } from './platform.js';
import { validBatchEvidence } from './batch.js';
export interface ModuleSummary {schemaVersion:1;module:ModuleMetadata;bundleHash:string;bodyHash:string;harnessHash:string}
export function validateModuleSummary(input:AuthorInput):void {
 const a=input.author,s=a.moduleSummary;if(s===undefined)return;
 if(a.skillId!=='acceptance-summary'||a.batch!==undefined||a.platform!==undefined||!exactObject(s,['schemaVersion','module','bundleHash','bodyHash','harnessHash'])||s.schemaVersion!==1||!(['bundleHash','bodyHash','harnessHash'] as const).every(k=>typeof s[k]==='string'&&/^[a-f0-9]{64}$/.test(s[k]))||Buffer.byteLength(JSON.stringify(s))>13*1024*1024||a.allowedTools?.length!==0||a.budget?.maxToolCalls!==0||!validBatchEvidence(a.validationEvidence,a.baseRevision))throw new AuthorError('invalid_input');
 validateModule(input.script,s.module);
 if(s.bodyHash!==sha256(input.script)||s.harnessHash!==sha256(s.module.harness)||a.validationEvidence!.scriptHash!==s.harnessHash)throw new AuthorError('invalid_input');
}
