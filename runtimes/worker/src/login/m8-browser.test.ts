import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {chromium} from '@playwright/test';
import {mediaEnvironment} from '../live/files.js';
import {AIOriginGate,installAIOriginGate} from '../author/scope.js';
import type {WorkspaceConfig} from '../workspace-context.js';

const id='11111111-1111-4111-8111-111111111111';
const username='synthetic-login-user',password='synthetic-password-sentinel',token='synthetic-cookie-token-sentinel';

async function zipText(data:Buffer):Promise<string>{
 const {yauzl}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
 return new Promise((resolve,reject)=>yauzl.fromBuffer(data,{lazyEntries:true},(error:Error,zip:any)=>{
  if(error)return reject(error);const content:string[]=[];let total=0;
  zip.on('error',reject);zip.on('end',()=>resolve(content.join('\n')));zip.on('entry',(entry:any)=>{
   total+=entry.uncompressedSize;if(total>128*1024*1024){zip.close();reject(new Error('evidence_limit'));return;}
   zip.openReadStream(entry,(err:Error,stream:any)=>{if(err)return reject(err);const chunks:Buffer[]=[];stream.on('data',(b:Buffer)=>chunks.push(b));stream.on('end',()=>{if(!/\.(png|jpe?g)$/i.test(entry.fileName))content.push(Buffer.concat(chunks).toString());zip.readEntry();});});
  });zip.readEntry();
 }));
}

test('M8 synthetic origin/redirect/popup guard and full login spec keep real reports and redact ZIP content',{
 skip:process.env.WHIPPET_M8_BROWSER_TEST!=='1',timeout:180000,
},async()=>{
 let foreignHits=0;
 const foreign=createServer((_req,res)=>{foreignHits++;res.end('outside confirmed scope');});
 await new Promise<void>((resolve)=>foreign.listen(0,'127.0.0.1',resolve));
 const foreignURL=`http://127.0.0.1:${(foreign.address() as import('node:net').AddressInfo).port}`;
 const site=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/redirect'){res.writeHead(302,{Location:foreignURL+'/blocked?token=never-return'});res.end();return;}
  if(req.url==='/popup'){res.end(`<button onclick="window.open('${foreignURL}/popup')">Popup</button>`);return;}
  if(req.url==='/session'){
   let body='';req.on('data',(b)=>body+=b);req.on('end',()=>{
    const params=new URLSearchParams(body);if(params.get('username')!==username||params.get('password')!==password){res.writeHead(401);res.end('<h1>Login rejected</h1>');return;}
    res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Lax`);
    res.end(`<h1>Authenticated</h1><ul><li>alpha</li></ul><span id="sensitive">${username} ${password} ${token}</span>`);
   });return;
  }
  res.end('<form method="post" action="/session"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button type="submit">Login</button></form>');
 });
 await new Promise<void>((resolve)=>site.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(site.address() as import('node:net').AddressInfo).port}`;
 const config:WorkspaceConfig={name:'合成登入',purpose:'M8真實驗證',backgroundSummary:'不使用模型或真帳密',targets:[{name:'site',purpose:'驗測',origin:base}],dependencies:[],excludedOrigins:[],exclusions:'',loginRoles:[{roleId:id,name:'測試者',loginMethod:'form',loginOrigin:base}],defaultTestUrl:base,timeoutMs:30000};
 const evidence=process.env.WHIPPET_M8_EVIDENCE_DIR??await mkdtemp(join(tmpdir(),'whippet-m8-browser-'));await mkdir(evidence,{recursive:true});
 try{
  const browser=await chromium.launch({headless:true,env:mediaEnvironment(process.env)});
  try{
   const context=await browser.newContext({serviceWorkers:'block'}),gate=new AIOriginGate(config),control=await installAIOriginGate(context,gate),page=await context.newPage();await control.ready(page);
   await assert.rejects(page.goto(base+'/redirect'));assert.equal(foreignHits,0,'redirect reached unconfirmed origin');
   await page.close();
   const popupPage=await context.newPage();await control.ready(popupPage);
   await popupPage.goto(base+'/popup');const requestFailed=context.waitForEvent('requestfailed',{predicate:(r)=>r.url().startsWith(foreignURL)});await popupPage.getByRole('button',{name:'Popup'}).click();await requestFailed;
   assert.equal(foreignHits,0,'popup reached unconfirmed origin');await context.close();
  }finally{await browser.close();}
  const outcomes=[];
  for(const fail of [false,true]){
   const work=await mkdtemp(join(evidence,fail?'fail-':'pass-'));
   const script=`import {test,expect} from '@playwright/test';import {loginAs} from 'whippet/login';
test('real role login',async({page},testInfo)=>{await page.goto('/login');
const submitted=await loginAs(page,${JSON.stringify(id)},'#username','#password','button[type=submit]');expect(submitted).toEqual({submitted:true});
await expect(page.getByRole('heading')).toHaveText('Authenticated');await expect(page.getByRole('listitem')).toHaveText(['alpha']);
await expect(page.locator('#sensitive')).toHaveCSS('-webkit-text-fill-color','rgba(0, 0, 0, 0)');
await testInfo.attach('authenticated-safe',{body:await page.screenshot(),contentType:'image/png'});
${fail?"await expect(page.getByRole('heading')).toHaveText('Intentional failure; preserve Failed 1');":''}});`;
   await writeFile(join(work,'input.json'),JSON.stringify({kind:'run',workspaceId:id,testId:id,runId:id,attemptId:id,scriptOrigin:'ai',script,timeoutMs:30000,workspaceSettings:{revision:1,sites:[],defaultTestUrl:base,timeoutMs:30000},workspaceContext:{schemaVersion:'1',workspaceId:id,settingsRevision:1,config,roleRefs:[{roleId:id,secretRef:id,secretVersion:1,configured:true}]}}));
   const child=spawn(process.execPath,[fileURLToPath(new URL('../runner.js',import.meta.url))],{env:{...mediaEnvironment(process.env),WHIPPET_WORK_DIR:work},stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='',pending='';let requests=0;
   child.stdout.on('data',(b)=>{const text=b.toString();stdout+=text;pending+=text;for(;;){const n=pending.indexOf('\n');if(n<0)break;const line=pending.slice(0,n);pending=pending.slice(n+1);try{const frame=JSON.parse(line);if(frame.kind==='credential_request'){requests++;child.stdin.write(JSON.stringify({kind:'credential_response',requestId:frame.requestId,attemptId:id,credentials:{workspaceId:id,runId:id,attemptId:id,roleId:id,secretRef:id,secretVersion:1,loginOrigin:base,username,password}})+'\n');}}catch{}}});
   child.stderr.on('data',(b)=>stderr+=b.toString());
   const timer=setTimeout(()=>child.kill('SIGKILL'),60000);const exit=await new Promise<number|null>((resolve)=>child.on('close',resolve));clearTimeout(timer);
   const result=JSON.parse(await readFile(join(work,'output/result.json'),'utf8'));assert.equal(result.status,fail?'failed':'succeeded',`runner status mismatch; details withheld (exit ${exit})`);assert.equal(requests,1);
   const results=JSON.parse(await readFile(join(work,'output/results.json'),'utf8'));assert.equal(results.stats.unexpected,fail?1:0);assert.equal(results.stats.expected,fail?0:1);
   const html=await readFile(join(work,'output/report.html'),'utf8');const encoded=html.match(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/)![1]!;const decoded=await zipText(Buffer.from(encoded,'base64'));
   for(const value of [username,password,token]){assert.equal((stdout+stderr+JSON.stringify(results)+decoded).includes(value),false,'known credential remained in output/report');}
   for(const name of await readdir(join(work,'output/data'))){if(name.endsWith('.zip')){const text=await zipText(await readFile(join(work,'output/data',name)));for(const value of [username,password,token])assert.equal(text.includes(value),false,'trace ZIP contents retained known credential');}}
   outcomes.push({status:result.status,stats:results.stats,work});
  }
  await writeFile(join(evidence,'summary.json'),JSON.stringify({foreignHits,outcomes,network:'synthetic_loopback_only',model:'not_used',pngVisualCheck:'pending_PM',liveVisualCheck:'pending_PM'},null,2));
  process.stdout.write(JSON.stringify({evidence,foreignHits,outcomes:outcomes.map((v)=>({status:v.status,stats:v.stats}))})+'\n');
 }finally{site.closeAllConnections();foreign.closeAllConnections();await Promise.all([new Promise<void>((resolve)=>site.close(()=>resolve())),new Promise<void>((resolve)=>foreign.close(()=>resolve()))]);}
});
