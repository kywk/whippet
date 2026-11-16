'use strict';
// Read-only resolution of a possibly completed UI revoke. No retry.
const net = require('node:net');
const { chromium } = require('../../runtimes/worker/node_modules/playwright');
const socketPath = '/private/tmp/whippet-m11-final-t52-r4/session-rpc.sock';
function brokerStatus() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setTimeout(15000);
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1048576) { socket.destroy(); reject(Error()); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      try { const reply = JSON.parse(buffer.slice(0, end)); resolve({ revoked: reply.httpStatus === 401, active: reply.httpStatus === 200, private: reply.privacyViolation === false }); }
      catch { reject(Error()); }
    });
    socket.on('error', () => reject(Error()));
    socket.on('timeout', () => { socket.destroy(); reject(Error()); });
    socket.on('end', () => reject(Error()));
  });
}
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19790');
  try {
    const matches = [];
    for (const p of browser.contexts().flatMap(c => c.pages())) {
      try { if (new URL(p.url()).origin === 'http://127.0.0.1:19787' && await p.evaluate(() => window.name === 'm11-session-qa-t67')) matches.push(p); } catch {}
    }
    if (matches.length !== 1) throw Error();
    const page = matches[0];
    const row = page.locator('.workspace-agent-access .agent-token-list li').filter({ has: page.getByText('Isolated session QA', { exact: true }) });
    if (await row.count() !== 1) throw Error();
    console.log(`QA_TOKEN_UI_REVOKED=${await row.getByText('已撤銷：', { exact: false }).count() === 1}`);
    console.log(`QA_TOKEN_UI_ACTIVE=${await row.getByRole('button', { name: '撤銷', exact: true }).count() === 1}`);
    const status = await brokerStatus();
    console.log(`QA_BROKER_NEXT_RPC_401=${status.revoked}`);
    console.log(`QA_BROKER_NEXT_RPC_200=${status.active}`);
    console.log(`QA_BROKER_PRIVATE=${status.private}`);
  } finally { await browser.close().catch(() => {}); }
}
main().catch(() => { console.log('READ_ONLY_CHECK=FAIL'); process.exitCode = 1; });
