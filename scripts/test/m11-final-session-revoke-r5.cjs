#!/usr/bin/env node
'use strict';
// r5 only: revoke the named QA token through UI and test the next broker RPC.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('../../runtimes/worker/node_modules/playwright');
let stage = 'INPUT';
const check = x => { if (!x) throw Error('check'); };
function brokerStatus(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setTimeout(15000);
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1048576) { socket.destroy(); reject(Error('frame')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      try { const r = JSON.parse(buffer.slice(0, end)); resolve(r.httpStatus === 401 && r.privacyViolation === false); }
      catch { reject(Error('frame')); }
    });
    socket.on('timeout', () => { socket.destroy(); reject(Error('timeout')); });
    socket.on('error', () => reject(Error('socket')));
    socket.on('end', () => reject(Error('closed')));
  });
}
async function main() {
  check(process.argv.length === 4 && path.isAbsolute(process.argv[2]) && path.isAbsolute(process.argv[3]));
  const root = process.argv[2], intentDir = process.argv[3], dir = fs.lstatSync(intentDir);
  check(dir.isDirectory() && dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700 && fs.readdirSync(intentDir).length === 0);
  const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
  check(ready.ready === true && ready.webURL === 'http://127.0.0.1:19787' && ready.cdpURL === 'http://127.0.0.1:19790');
  const browser = await chromium.connectOverCDP(ready.cdpURL);
  try {
    const matches = [];
    for (const p of browser.contexts().flatMap(c => c.pages())) {
      try { if (new URL(p.url()).origin === ready.webURL && await p.evaluate(() => window.name === 'm11-session-qa-t67')) matches.push(p); } catch {}
    }
    check(matches.length === 1);
    const page = matches[0];
    stage = 'UI_SETTINGS';
    await page.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: ready.workspaceName });
    await page.getByRole('button', { name: 'Workspace 設定' }).click();
    await page.getByRole('tab', { name: '正式設定與能力' }).click();
    const access = page.locator('.workspace-agent-access');
    const row = access.locator('.agent-token-list li').filter({ has: page.getByText('Isolated session QA', { exact: true }) });
    await row.waitFor({ timeout: 15000 });
    check(await row.count() === 1);
    const button = row.getByRole('button', { name: '撤銷', exact: true });
    check(await button.count() === 1 && await button.isEnabled());
    stage = 'UI_REVOKE';
    const fd = fs.openSync(path.join(intentDir, 'revoke-token.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, '{"tokenName":"Isolated session QA"}\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let handled;
    page.once('dialog', dialog => {
      const valid = dialog.type() === 'confirm' && dialog.message() === '撤銷後這個 Agent Token 會立即失效。確定撤銷？';
      handled = (valid ? dialog.accept() : dialog.dismiss()).then(() => valid, () => false);
    });
    await button.click();
    check(handled && await handled);
    await row.getByText('已撤銷：', { exact: false }).waitFor({ timeout: 15000 });
    check(await row.getByRole('button', { name: '撤銷', exact: true }).count() === 0);
    console.log('QA_TOKEN_UI_REVOKED=true');
    stage = 'REVOKED_RPC';
    check(await brokerStatus(path.join(root, 'session-rpc.sock')));
    console.log('QA_BROKER_NEXT_RPC_401=true');
    console.log('RESULT=PASS');
  } finally { await browser.close().catch(() => {}); }
}
main().catch(() => { console.log(`RESULT=FAIL\nSTAGE=${stage}`); process.exitCode = 1; });
