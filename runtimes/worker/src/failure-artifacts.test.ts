import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportFailureArtifacts, FAILURE_LIMITS } from "./failure-artifacts.js";

// Basic transport fixtures, not real traces or Playwright success evidence.
const zip = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
const md = Buffer.from("# Synthetic assertion context\n");
const name = (body: Buffer, ext: string) => `${createHash("sha1").update(body).digest("hex")}.${ext}`;

test("M6 native evidence deduplicates fallback; missing HTML exports only existing current-task evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "whippet-evidence-"));
  try {
    const html = join(root,"html"), results = join(root,"test-results"), out = join(root,"out");
    await mkdir(join(html,"data"),{recursive:true});await mkdir(join(results,"test"),{recursive:true});await mkdir(out);
    await writeFile(join(html,"data",name(zip,"zip")),zip);await writeFile(join(html,"data",name(md,"md")),md);
    await writeFile(join(results,"test","trace.zip"),zip);await writeFile(join(results,"test","error-context.md"),md);
    const other = join(root,"other-task");await mkdir(other);await writeFile(join(other,"trace.zip"),Buffer.concat([zip,Buffer.from("other task")]));
    const warnings: string[]=[];
    await exportFailureArtifacts(html,results,out,(v)=>warnings.push(v));
    assert.deepEqual((await readdir(join(out,"data"))).sort(),[name(zip,"zip"),name(md,"md")].sort());
    assert.equal(warnings.length,0);
    await rm(html,{recursive:true});await rm(join(out,"data"),{recursive:true});
    await exportFailureArtifacts(html,results,out,(v)=>warnings.push(v));
    assert.deepEqual(await readFile(join(out,"data",name(zip,"zip"))),zip);
    assert.deepEqual(await readFile(join(out,"data",name(md,"md"))),md);
    assert.equal((await readdir(join(out,"data"))).length,2);
    await assert.rejects(readFile(join(out,"report.html")),{code:"ENOENT"});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("M6 invalid signature/UTF-8/hash/symlink and oversized optional evidence are skipped", async () => {
  const root = await mkdtemp(join(tmpdir(),"whippet-evidence-invalid-"));
  try {
    const html=join(root,"html"),out=join(root,"out"),data=join(html,"data");await mkdir(data,{recursive:true});await mkdir(out);
    const invalidZIP=Buffer.from([0x50,0x4b,7,8,1]),invalidMD=Buffer.from([0xff]);
    await writeFile(join(data,name(invalidZIP,"zip")),invalidZIP);await writeFile(join(data,name(invalidMD,"md")),invalidMD);
    await writeFile(join(data,"0".repeat(40)+".zip"),zip);
    await writeFile(join(root,"outside.zip"),zip);await symlink(join(root,"outside.zip"),join(data,name(zip,"zip")));
    const huge=await open(join(data,"1".repeat(40)+".md"),"w");await huge.truncate(FAILURE_LIMITS.mdBytes+1);await huge.close();
    await writeFile(join(data,name(md,"md")),md);
    const warnings:string[]=[];await exportFailureArtifacts(html,join(root,"missing"),out,(v)=>warnings.push(v));
    assert.deepEqual(await readdir(join(out,"data")),[name(md,"md")]);
    assert.ok(warnings.includes("invalid_content"));assert.ok(warnings.includes("invalid_file"));assert.ok(warnings.includes("hash_mismatch"));
    assert.equal(warnings.some((v)=>v.includes("outside")),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("M6 optional count quota stops at 32 independently of other report data", async () => {
  const root=await mkdtemp(join(tmpdir(),"whippet-evidence-count-"));
  try {
    const html=join(root,"html"),out=join(root,"out");await mkdir(join(html,"data"),{recursive:true});await mkdir(out);
    for(let i=0;i<33;i++){const body=Buffer.from(`# context ${i}`);await writeFile(join(html,"data",name(body,"md")),body);}
    const warnings:string[]=[];await exportFailureArtifacts(html,join(root,"missing"),out,(v)=>warnings.push(v));
    assert.equal((await readdir(join(out,"data"))).length,32);assert.ok(warnings.includes("quota"));
  } finally {await rm(root,{recursive:true,force:true});}
});
