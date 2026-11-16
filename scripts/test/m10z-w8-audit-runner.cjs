// Runs inside a keyless, network-disabled disposable Worker container.
const fs=require('node:fs'),cp=require('node:child_process');
const input=JSON.parse(fs.readFileSync(0,'utf8')),dir='/tmp/m10audit';fs.mkdirSync(dir);fs.symlinkSync('/opt/whippet/worker/node_modules',dir+'/node_modules');
fs.writeFileSync(dir+'/case.spec.ts',input.script,{mode:0o600});
fs.writeFileSync(dir+'/playwright.config.cjs',`module.exports={testDir:${JSON.stringify(dir)},testMatch:'case.spec.ts',workers:1,timeout:30000,retries:0,reporter:'json',outputDir:${JSON.stringify(dir+'/results')},use:{headless:true,launchOptions:{args:['--no-sandbox']}}};`);
fs.writeFileSync(dir+'/preload.cjs',String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const append=fs.appendFileSync.bind(fs);const mark=(name)=>append('/tmp/m10audit/events',name+'\n');
for(const name of ['readFileSync','readFile','openSync','open']){const old=fs[name];fs[name]=function(path,...args){if(typeof path==='string'&&(/(^|\/)\.env($|\.)|vault-key|manager-token|\/private\/|\/Users\//.test(path)))mark('privateFileAttempt');return old.call(this,path,...args);};}
for(const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync']){const old=cp[name];cp[name]=function(command,...args){if(!/chrome|chromium|headless_shell|\/node$/.test(String(command)))mark('unexpectedProcess');return old.call(this,command,...args);};}
for(const library of ['node:http','node:https'])for(const name of ['request','get']){const target=require(library),old=target[name];target[name]=function(...args){mark('nodeNetworkAttempt');return old.apply(this,args);};}
const oldFetch=global.fetch;global.fetch=function(...args){mark('nodeNetworkAttempt');return oldFetch.apply(this,args);};
const pw=require('/opt/whippet/worker/node_modules/playwright');
for(const type of [pw.chromium,pw.firefox,pw.webkit]){const old=type.launch.bind(type);type.launch=async function(...args){const browser=await old(...args),create=browser.newContext.bind(browser);browser.newContext=async function(...args){const context=await create(...args);await context.route('**/*',route=>{mark('browserNetworkAttempt');return route.abort();});return context;};return browser;};}
`);
const run=cp.spawnSync(process.execPath,['/opt/whippet/worker/node_modules/@playwright/test/cli.js','test','--config',dir+'/playwright.config.cjs'],{env:{...process.env,NODE_OPTIONS:'--require='+dir+'/preload.cjs'},encoding:'utf8',timeout:45000,maxBuffer:16*1024*1024});
let stats={};try{stats=JSON.parse(run.stdout).stats??{};}catch{}
const events=fs.existsSync(dir+'/events')?fs.readFileSync(dir+'/events','utf8').trim().split('\n').filter(Boolean):[];
const counts=Object.fromEntries(['privateFileAttempt','unexpectedProcess','nodeNetworkAttempt','browserNetworkAttempt'].map(name=>[name,events.filter(x=>x===name).length]));
const result={exitCode:run.status,expected:stats.expected??0,unexpected:stats.unexpected??0,flaky:stats.flaky??0,skipped:stats.skipped??0,counts,networkDisabled:true,keyless:true};result.pass=run.status===0&&result.expected>0&&result.unexpected===0&&Object.values(counts).every(n=>n===0);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.pass?0:1;
