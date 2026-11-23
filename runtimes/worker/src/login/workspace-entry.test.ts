import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { AIOriginGate, installAIOriginGate } from '../author/scope.js';
import { loginAs } from './helper.js';
import { maskKnownInputs } from './privacy.js';
import type { WorkspaceConfig } from '../workspace-context.js';

const roleId = '3e1f5abd-0f26-4cc5-b757-e471d5293cf3';

test('workspace-entry uses a leased role, exact IdP form and page-bound redirects', async t => {
  async function site(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const addr = server.address();
    assert(addr && typeof addr === 'object');
    return 'http://127.0.0.1:' + addr.port;
  }

  const browser = await chromium.launch();
  t.after(() => browser.close());
  let authenticated = false, legacy = false, posts = 0, credentialRequests = 0;
  let formOpened!: () => void, releaseForm!: () => void;
  const opened = new Promise<void>(resolve => { formOpened = resolve; });
  const held = new Promise<void>(resolve => { releaseForm = resolve; });
  const idp = await site(async (req,res) => {
    if (req.method === 'POST') {
      posts++;
      if (legacy) res.end('Signed in');
      else res.writeHead(303,{Location:sp+'/acs'}).end();
    } else {
      formOpened();
      await held;
      res.writeHead(200,{'Content-Type':'text/html'}).end('<form method="post"><input id="user" name="user"><input id="pass" name="pass" type="password"><button>Submit</button></form>');
    }
  });
  const sp = await site((req,res) => {
    if (req.url === '/acs') authenticated = true;
    res.writeHead(302,{Location:authenticated ? ap+'/entry' : idp+'/form'}).end();
  });
  const ap = await site((_req,res) => {
    if (authenticated) res.end('Returned to application');
    else res.writeHead(302,{Location:sp+'/start'}).end();
  });
  const dir = await mkdtemp(join(tmpdir(),'whippet-workspace-entry-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const socketPath = join(dir,'role.sock');
  const socket = createSocket(peer => peer.on('data',data => {
    const msg = JSON.parse(data.toString());
    if (msg.roleId === roleId) {
      credentialRequests++;
      peer.end(JSON.stringify({credentials:{loginOrigin:idp,roleId,username:'fixture',password:'fixture'}})+'\n');
    } else peer.end('{}\n');
  }));
  await new Promise<void>(resolve => socket.listen(socketPath,resolve));
  const old = process.env.WHIPPET_LOGIN_SOCKET;
  process.env.WHIPPET_LOGIN_SOCKET = socketPath;
  t.after(() => { socket.close(); if (old) process.env.WHIPPET_LOGIN_SOCKET=old; else delete process.env.WHIPPET_LOGIN_SOCKET; });

  const config: WorkspaceConfig = {name:'QA',purpose:'test',backgroundSummary:'',
    targets:[{name:'AP',purpose:'test',origin:ap}], dependencies:[idp,sp].map(origin=>({name:origin,purpose:'login',origin})),
    excludedOrigins:[],exclusions:'',loginRoles:[{roleId,name:'manager',loginMethod:'form',loginOrigin:idp}],
    defaultTestUrl:ap+'/entry',timeoutMs:10000};
  const context = await browser.newContext();
  const noScope = await context.newPage();
  const login = (page: typeof noScope) => loginAs(page,roleId,'#user','#pass','button','workspace-entry');
  await assert.rejects(login(noScope),/credential_operation_failed/);
  assert.equal(credentialRequests,0);
  const gate = new AIOriginGate(config);
  const control = await installAIOriginGate(context,gate);
  const page = await context.newPage(), other = await context.newPage();
  await Promise.all([control.ready(page),control.ready(other)]);
  const active = login(page);
  try {
    await Promise.race([opened,active.then(()=>{throw Error('unexpected early completion');})]);
    assert.equal(gate.check(sp,'navigation',other)?.error,'dependency_usage_not_allowed');
    assert.equal(gate.check('https://unknown.invalid','navigation',page)?.error,'scope_confirmation_required');
  } finally { releaseForm(); }
  assert.deepEqual(await active,{submitted:true});
  assert.equal(page.url(),config.defaultTestUrl);
  assert.equal(posts,1);
  // The AP never receives raw IdP secrets via a renderer global or hook.
  assert.equal(await page.evaluate(() => '__whippetPrivacy' in window),false);
  await maskKnownInputs(page,['synthetic-redaction-sentinel']);
  await page.evaluate(() => {
    const p=document.createElement('p');
    p.textContent='visible synthetic-redaction-sentinel';
    document.body.appendChild(p);
  });
  await page.waitForSelector('p[data-whippet-private]', {timeout:3000});
  assert.deepEqual(await page.evaluate(() => Object.keys(window).filter(k => /whippet/i.test(k))),[]);

  assert.equal(gate.check(sp,'navigation',page)?.error,'dependency_usage_not_allowed');
  await assert.rejects(gate.duringWorkspaceLogin(page,'wrong-role',idp,async()=>{}));
  await assert.rejects(gate.duringWorkspaceLogin(page,roleId,idp,async()=>{throw Error('cancelled');}),/cancelled/);
  assert.equal(gate.check(idp,'navigation',page)?.error,'dependency_usage_not_allowed');
  legacy = true;
  await noScope.goto(ap+'/entry');
  // Five argument form keeps the existing single-origin login contract.
  assert.deepEqual(await loginAs(noScope,roleId,'#user','#pass','button'),{submitted:true});
  assert.equal(posts,2);
  assert.equal(new URL(noScope.url()).origin,idp);
  const excluded = new AIOriginGate({...config,dependencies:config.dependencies.filter(d=>d.origin!==sp),excludedOrigins:[sp]});
  assert.equal(excluded.check(sp,'navigation',page)?.error,'origin_excluded');
});
