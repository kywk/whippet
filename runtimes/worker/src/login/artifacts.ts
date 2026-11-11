import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {KnownSecrets} from './client.js';

// Reuse the pinned Playwright distribution's bundled ZIP codec, no new package.
const {yauzl,yazl}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const LIMIT=64*1024*1024;
const embedded=/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

export async function redactReportBytes(data:Buffer,secrets:KnownSecrets,renamePaths:Map<string,string>=new Map(),depth=0):Promise<Buffer>{
  if(data.length>LIMIT||depth>2)throw new Error('credential_evidence_limit');
  const text=(value:string)=>{for(const [old,next]of renamePaths)value=value.split(old).join(next);return secrets.redact(value);};
  function strings(value:any):any{if(typeof value==='string')return text(value);if(Array.isArray(value))return value.filter((v)=>!(v&&typeof v==='object'&&typeof v.path==='string'&&[...renamePaths].some(([old,next])=>next===''&&v.path.endsWith(old)))).map(strings);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,strings(v)]));return value;}
  if(data.subarray(0,4).equals(Buffer.from([80,75,3,4]))||data.subarray(0,4).equals(Buffer.from([80,75,5,6]))){
    const entries=await new Promise<{name:string;body:Buffer}[]>((resolve,reject)=>yauzl.fromBuffer(data,{lazyEntries:true},(error:Error,zip:any)=>{
      if(error)return reject(new Error('credential_evidence_zip'));
      const out:{name:string;body:Buffer}[]=[];let total=0;
      zip.on('error',()=>reject(new Error('credential_evidence_zip')));zip.on('end',()=>resolve(out));
      zip.on('entry',(entry:any)=>{
        total+=entry.uncompressedSize;if(out.length>=4096||entry.uncompressedSize>LIMIT||total>128*1024*1024){zip.close();reject(new Error('credential_evidence_limit'));return;}
        zip.openReadStream(entry,(err:Error,stream:any)=>{if(err){reject(new Error('credential_evidence_zip'));return;}const chunks:Buffer[]=[];let size=0;
          stream.on('error',()=>reject(new Error('credential_evidence_zip')));stream.on('data',(b:Buffer)=>{size+=b.length;if(size>LIMIT){stream.destroy();reject(new Error('credential_evidence_limit'));}else chunks.push(b);});
          stream.on('end',()=>{out.push({name:entry.fileName,body:Buffer.concat(chunks)});zip.readEntry();});
        });
      });zip.readEntry();
    }));
    const output=new yazl.ZipFile();const result=new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];let size=0;output.outputStream.on('error',()=>reject(new Error('credential_evidence_zip')));output.outputStream.on('data',(b:Buffer)=>{size+=b.length;if(size>LIMIT){output.outputStream.destroy();reject(new Error('credential_evidence_limit'));}else chunks.push(b);});output.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));});
    for(const entry of entries){if(entry.name.endsWith('/'))continue;const body=/\.(png|jpe?g)$/i.test(entry.name)?entry.body:await redactReportBytes(entry.body,secrets,renamePaths,depth+1);output.addBuffer(body,entry.name);}
    output.end();return result;
  }
  let source=data.toString('utf8');const matches=[...source.matchAll(embedded)];
  if(matches.length){for(const match of matches){const body=await redactReportBytes(Buffer.from(match[1]!,'base64'),secrets,renamePaths,depth+1);source=source.replace(match[0],`data:application/zip;base64,${body.toString('base64')}`);}return Buffer.from(source);}
  try{return Buffer.from(JSON.stringify(strings(JSON.parse(source))));}catch{/* Markdown/source or NDJSON. */}
  const lines=source.split('\n');
  if(lines.length>1&&lines.every((line)=>!line.trim()||(()=>{try{JSON.parse(line);return true;}catch{return false;}})()))return Buffer.from(lines.map((line)=>line.trim()?JSON.stringify(strings(JSON.parse(line))):line).join('\n'));
  return Buffer.from(text(source));
}

export async function sanitizeLoginOutputs(dir:string,secrets:KnownSecrets,warn:(message:string)=>void=()=>undefined):Promise<void>{
  if(secrets.list().length===0)return;
  const renames=new Map<string,string>();let files:string[]=[];
  try{files=await readdir(join(dir,'data'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of files){
    if(!/^[0-9a-f]{40}\.(zip|md)$/.test(name))continue;
    const path=join(dir,'data',name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>LIMIT)throw new Error('credential_evidence_file');
    try{
      const body=await redactReportBytes(await readFile(path),secrets),next=createHash('sha1').update(body).digest('hex')+extname(name);
      if(next!==name){await writeFile(join(dir,'data',next),body,{mode:0o600});await rm(path);renames.set(name,next);}
    }catch{await rm(path);renames.set(name,'');warn('Credential evidence omitted: unsafe optional attachment');}
  }
  for(const name of ['report.html','results.json','author.json','result.json']){
    const path=join(dir,name);let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.size>LIMIT)throw new Error('credential_evidence_file');
    const body=await redactReportBytes(await readFile(path),secrets,renames);const temp=join(dir,`.${name}.privacy`);await writeFile(temp,body,{mode:0o600});await rename(temp,path);
  }
  await rm(join(dir,'html'),{recursive:true,force:true});await rm(join(dir,'test-results'),{recursive:true,force:true});
}
