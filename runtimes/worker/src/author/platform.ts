import { AuthorError, boundedText, type AuthorInput } from './types.js';
import { exactObject, loadToolRegistry, validateToolArguments } from './registry.js';
export const PLATFORM_SERVER_TOOLS = ['catalog_search','catalog_get','read_module_draft','read_usecase_draft','read_plan','propose_plan'] as const;
export const PLATFORM_TOOLS = [...PLATFORM_SERVER_TOOLS,'update_module_candidate','request_module_validation'] as const;
export interface ModuleMetadata { slug:string; moduleKind:'setup'|'step'|'page'; exportName:string; signature:string; inputs:string; returns:string; preconditions:string; postconditions:string; harness:string }
export interface PlatformInput { planId:string|null; stageId:string|null; module:ModuleMetadata|null }
export interface PlannerOutput { script?:never; requestValidation?:never; message:string; planCandidate:{candidateRef:string}; conversationSummary?:string }
export const moduleAuthor = (input:AuthorInput) => input.author.skillId === 'module-authoring';
export const plannerAuthor = (input:AuthorInput) => input.author.skillId === 'usecase-planner';
const reserved = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(' '));
export function validateModule(script:unknown,module:unknown): asserts module is ModuleMetadata {
  validateToolArguments(loadToolRegistry().tools.find(t=>t.name==='update_module_candidate')!,{script,module});
  const m=module as ModuleMetadata;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.exportName)||reserved.has(m.exportName)) throw new AuthorError('invalid_input');
}
export function validatePlatform(input:AuthorInput, capable:boolean):void {
  const module=moduleAuthor(input), planner=plannerAuthor(input), p=input.author.platform;
  if(!module&&!planner){if(p!==undefined||input.author.allowedTools?.some(t=>(PLATFORM_TOOLS as readonly string[]).includes(t)))throw new AuthorError('invalid_input');return;}
  if(!capable||!exactObject(p,['planId','stageId','module']))throw new AuthorError('invalid_input');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(p.planId!==null&&(typeof p.planId!=='string'||!uuid.test(p.planId)))throw new AuthorError('invalid_input');
  if(module){validateModule(input.script,p.module);if((p.planId===null)!==(p.stageId===null)||p.stageId!==null&&!boundedText(p.stageId,64,true))throw new AuthorError('invalid_input');}
  else if(p.module!==null||p.stageId!==null)throw new AuthorError('invalid_input');
  const allowed=module ? new Set(['read_module_draft','update_module_candidate','request_module_validation','read_validation_report','read_skill_reference','read_conversation_history', 'browser_navigate','browser_snapshot','browser_click','browser_fill','browser_login']) : new Set(['catalog_search','catalog_get','read_usecase_draft','read_plan','propose_plan','read_skill_reference','read_conversation_history']);
  if(input.author.allowedTools?.some(t=>!allowed.has(t)))throw new AuthorError('invalid_input');
}
export function plannerCandidate(value:unknown):string {
  if(!exactObject(value,['candidate','candidateRef','stages'])||value.candidate!==true||(typeof value.candidateRef!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.candidateRef)))throw new AuthorError('tool_failed');
  validateToolArguments(loadToolRegistry().tools.find(t=>t.name==='propose_plan')!,{stages:value.stages});
  return value.candidateRef;
}
