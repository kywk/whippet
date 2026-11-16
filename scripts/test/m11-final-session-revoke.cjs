#!/usr/bin/env node
'use strict';
// The exact closed lease and QA token only; fixed safe outputs, no raw frames.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('../../runtimes/worker/node_modules/playwright');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let stage = 'INPUT';
function check(value) { if (!value) throw Error('check'); }
function persist(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
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
      try { const reply = JSON.parse(buffer.slice(0, end)); resolve(reply.httpStatus === 401 && reply.privacyViolation === false); }
      catch { reject(Error('frame')); }
    });
    socket.on('timeout', () => { socket.destroy(); reject(Error('timeout')); });
    socket.on('error', () => reject(Error('socket')));
    socket.on('end', () => reject(Error('closed')));
  });
}
async function main() {
  check(process.argv.length === 4 && path.isAbsolute(process.argv[2]) && path.isAbsolute(process.argv[3]));
  const root = process.argv[2], intentDir = process.argv[3];
  const dir = fs.lstatSync(intentDir);
  check(dir.isDirectory() && dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700);
  const lease = JSON.parse(fs.readFileSync(path.join(intentDir, 'lease-1.json'), 'utf8'));
  check(UUID.test(lease.sessionId) && UUID.test(lease.leaseId));
  check(fs.existsSync(path.join(intentDir, 'close-1.json')) && !fs.existsSync(path.join(intentDir, 'revoke-token.json')));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19790');
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    const matches = [];
    for (const candidate of pages) {
      try {
        if (new URL(candidate.url()).origin === 'http://127.0.0.1:19787' && await candidate.evaluate(() => window.name === 'm11-session-qa-t67')) matches.push(candidate);
      } catch { /* Ignore unrelated closed pages. */ }
    }
    check(matches.length === 1);
    const page = matches[0];
    stage = 'CLOSED_VIEWER_ATTACH';
    const rejected = await page.evaluate(({ sessionId, leaseId }) => new Promise(resolve => {
      const url = new URL(`/api/browser-sessions/${sessionId}/leases/${leaseId}/live`, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url.href);
      let opened = false, settled = false;
      const timer = setTimeout(() => finish(false), 10000);
      function finish(value) { if (settled) return; settled = true; clearTimeout(timer); socket.close(); resolve(value); }
      socket.onopen = () => { opened = true; };
      socket.onmessage = event => {
        if (typeof event.data !== 'string') { finish(false); return; }
        try { const message = JSON.parse(event.data); finish(opened && message.type === 'error' && message.code === 'not_found'); }
        catch { finish(false); }
      };
      socket.onerror = () => finish(false);
      socket.onclose = () => finish(false);
    }), lease);
    check(rejected === true);
    console.log('CLOSED_VIEWER_FIXED_NOT_FOUND=true');

    stage = 'UI_REVOKE';
    const access = page.locator('.workspace-agent-access');
    const row = access.locator('.agent-token-list li').filter({ has: page.getByText('Isolated session QA', { exact: true }) });
    check(await row.count() === 1);
    const button = row.getByRole('button', { name: '撤銷', exact: true });
    check(await button.count() === 1 && await button.isEnabled());
    persist(path.join(intentDir, 'revoke-token.json'), { tokenName: 'Isolated session QA' });
    page.once('dialog', dialog => {
      if (dialog.type() === 'confirm' && dialog.message() === '撤銷後這個 Agent Token 會立即失效。確定撤銷？') void dialog.accept();
      else void dialog.dismiss();
    });
    await button.click();
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
