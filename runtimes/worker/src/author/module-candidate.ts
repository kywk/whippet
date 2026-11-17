import { AuthorError } from './types.js';
import { sha256 } from './registry.js';

type Part = 'script' | 'harness';
interface Parts { script: string; harness: string }
interface Version { parts: Parts; staged: Set<Part> }
const parts: Part[] = ['script', 'harness'];
const maxPart = 2 * 1024 * 1024;
const fail = (): never => { throw new AuthorError('tool_failed'); };
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max && Buffer.from(value).toString('utf8') === value;
}
function exact(v: unknown, keys: string[]): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
}
const boundary = (bytes: Buffer, offset: number) => Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length && (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80);

// Attempt-local immutable versions. Source bytes come only from the frozen Run
// or accepted edits; this object never reads files, Server state or another Run.
export class ModuleCandidateStore {
  private revision = 0;
  private readonly versions = new Map<number, Version>();
  constructor(script: string, harness: string, private readonly guard: (value: unknown) => void) {
    if (!text(script,maxPart) || !text(harness,maxPart)) throw new AuthorError('invalid_input');
    this.versions.set(0,{parts:Object.freeze({script,harness}),staged:new Set()});
  }
  reference() {
    const p=this.versions.get(this.revision)!.parts;
    this.guard(p);
    return { stagingRevision:this.revision,scriptSha256:sha256(p.script),harnessSha256:sha256(p.harness),
      scriptBytes:Buffer.byteLength(p.script),harnessBytes:Buffer.byteLength(p.harness),dataOnly:true,validationEvidence:false };
  }
  private current(expected: unknown): Version {
    if (expected !== this.revision) return fail();
    return this.versions.get(this.revision)!;
  }
  private install(next: Parts, staged: Set<Part>): void {
    if (this.revision >= 12) fail();
    this.versions.set(++this.revision,{parts:Object.freeze({...next}),staged:new Set(staged)});
  }
  stage(value: unknown): object {
    if (!exact(value,['part','content','stagingRevision']) || !parts.includes(value.part) || !text(value.content,8192) || !value.content.trim()) return fail();
    const prior=this.current(value.stagingRevision);
    this.guard(value.content);
    const next={...prior.parts,[value.part]:value.content},staged=new Set(prior.staged);staged.add(value.part);
    this.install(next,staged);
    return {staged:true,revision:this.revision,part:value.part,contentHash:sha256(value.content)};
  }
  complete(expected: unknown): Parts {
    const state=this.current(expected);
    if (state.staged.size !== 2) return fail();
    this.guard(state.parts);return {...state.parts};
  }
  edit(value: unknown, accept: (next: Parts) => void): Parts {
    if (!exact(value,['stagingRevision','scriptSha256','harnessSha256','edits']) || !Array.isArray(value.edits) || value.edits.length > 16) return fail();
    const state=this.current(value.stagingRevision), ref=this.reference();
    if (value.scriptSha256 !== ref.scriptSha256 || value.harnessSha256 !== ref.harnessSha256) return fail();
    const groups=new Map<Part,{offsetBytes:number;deleteBytes:number;insert:string}[]>();let inserted=0;
    for (const edit of value.edits) {
      if (!exact(edit,['part','offsetBytes','deleteBytes','insert']) || !parts.includes(edit.part) || !Number.isSafeInteger(edit.deleteBytes) || edit.deleteBytes<0 || !text(edit.insert,8192)) return fail();
      const bytes=Buffer.from(state.parts[edit.part as Part]);
      if (!boundary(bytes,edit.offsetBytes) || !boundary(bytes,edit.offsetBytes+edit.deleteBytes) || edit.deleteBytes===0 && edit.insert==='') return fail();
      inserted+=Buffer.byteLength(edit.insert);if(inserted>8192)return fail();
      const list=groups.get(edit.part)??[];list.push({offsetBytes:edit.offsetBytes,deleteBytes:edit.deleteBytes,insert:edit.insert});groups.set(edit.part,list);
    }
    const next={...state.parts};
    for (const [part,edits] of groups) {
      edits.sort((a,b)=>a.offsetBytes-b.offsetBytes);
      for(let i=1;i<edits.length;i++)if(edits[i]!.offsetBytes<=edits[i-1]!.offsetBytes || edits[i]!.offsetBytes<edits[i-1]!.offsetBytes+edits[i-1]!.deleteBytes)return fail();
      let bytes=Buffer.from(next[part]);
      for(const edit of [...edits].reverse())bytes=Buffer.concat([bytes.subarray(0,edit.offsetBytes),Buffer.from(edit.insert),bytes.subarray(edit.offsetBytes+edit.deleteBytes)]);
      next[part]=bytes.toString('utf8');if(!text(next[part],maxPart))return fail();
    }
    this.guard(next);accept(Object.freeze({...next})); // Rejecting metadata never advances CAS.
    this.install(next,new Set(parts));return {...next};
  }
  read(value: unknown) {
    if (!exact(value,['part','stagingRevision','offsetBytes']) || !parts.includes(value.part)) return fail();
    const revision=value.stagingRevision===null?this.revision:value.stagingRevision;
    const state=this.versions.get(revision);if(!state)return fail();
    const bytes=Buffer.from(state.parts[value.part as Part]),offset=value.offsetBytes===null?0:value.offsetBytes;
    if (!boundary(bytes,offset) || value.offsetBytes===null && bytes.length>8192) return fail();
    let end=Math.min(offset+8192,bytes.length);while(end<bytes.length&&!boundary(bytes,end))end--;
    const page={part:value.part as Part,stagingRevision:revision as number,sha256:sha256(bytes),totalBytes:bytes.length,offsetBytes:offset as number,
      content:bytes.subarray(offset,end).toString('utf8'),nextOffsetBytes:end<bytes.length?end:null,dataOnly:true,validationEvidence:false};
    this.guard(page);return page;
  }
}
