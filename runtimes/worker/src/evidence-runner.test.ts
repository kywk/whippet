import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mediaEnvironment } from "./live/files.js";

test("M6 true failed assertion exports ZIP/MD/PNG and passing run retains no trace", {
  skip:process.env.WHIPPET_EVIDENCE_BROWSER_TEST!=="1",timeout:45000,
}, async () => {
  const fixtures=process.env.WHIPPET_EVIDENCE_FIXTURES??fileURLToPath(new URL("../examples/",import.meta.url));
  const evidence=process.env.WHIPPET_EVIDENCE_DIR??tmpdir();await mkdir(evidence,{recursive:true});
  for(const fixture of ["fail","pass"]){
    const work=await mkdtemp(join(evidence,`m6-${fixture}-`));
    const script=await readFile(join(fixtures,`${fixture}.spec.ts`),"utf8");
    await writeFile(join(work,"input.json"),JSON.stringify({runId:"11111111-1111-4111-8111-111111111111",attemptId:"22222222-2222-4222-8222-222222222222",script,timeoutMs:20000}));
    let exitCode=0;
    try {await promisify(execFile)(process.execPath,[fileURLToPath(new URL("./runner.js",import.meta.url))],{env:{...mediaEnvironment(process.env),WHIPPET_WORK_DIR:work},timeout:25000,maxBuffer:512*1024});}
    catch(error){assert.ok(error&&typeof error==="object"&&"code"in error&&typeof error.code==="number");exitCode=error.code;}
    const result=JSON.parse(await readFile(join(work,"output/result.json"),"utf8"));
    assert.equal(result.status,fixture==="fail"?"failed":"succeeded");assert.equal(exitCode,fixture==="fail"?1:0);
    assert.ok((await readFile(join(work,"output/report.html"))).length>0);
    let files:string[]=[];try{files=await readdir(join(work,"output/data"));}catch(error){assert.ok(error&&typeof error==="object"&&"code"in error&&error.code==="ENOENT");}
    if(fixture==="fail"){
      for(const ext of ["zip","md","png"]){assert.ok(files.some((v)=>v.endsWith(`.${ext}`)),`Missing real failure ${ext}`);}
      for(const file of files.filter((v)=>/\.(zip|md)$/.test(v))){
        const body=await readFile(join(work,"output/data",file));assert.equal(file,`${createHash("sha1").update(body).digest("hex")}.${file.split(".").pop()}`);
        if(file.endsWith(".zip"))assert.deepEqual(body.subarray(0,4),Buffer.from([0x50,0x4b,3,4]));
        else assert.ok(new TextDecoder("utf-8",{fatal:true}).decode(body).length>0);
      }
    }else{assert.equal(files.some((v)=>/\.(zip|md)$/.test(v)),false,"Passing run must not retain trace or error context");}
    console.log(JSON.stringify({fixture,status:result.status,files,work}));
  }
});
