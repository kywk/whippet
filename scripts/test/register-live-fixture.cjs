// Prepare a live-view fixture; validation is started by the UI.
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.WHIPPET_API_URL || 'http://127.0.0.1:18081';
async function api(method, route, body) {
  const response = await fetch(base + route, { method, headers: {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status}`);
  return response.json();
}
(async () => {
  const workspace = (await api('GET', '/api/workspaces')).items[0];
  const name = process.env.WHIPPET_FIXTURE_NAME || 'M4 驗收｜即時監看';
  const items = (await api('GET', `/api/workspaces/${workspace.id}/tests`)).items;
  const test = items.find(item => item.name === name) || await api('POST', `/api/workspaces/${workspace.id}/tests`, { name, description: process.env.WHIPPET_FIXTURE_DESCRIPTION || '45 秒合成動態頁面，驗證 WebRTC、JPEG 備援與停止監看；不呼叫 AI。' });
  const script = await fs.readFile(process.env.WHIPPET_FIXTURE_SCRIPT || path.join(__dirname, 'fixtures/m4-live.spec.ts'), 'utf8');
  let draft = await api('GET', `/api/tests/${test.id}/draft`);
  if (draft.script !== script) draft = await api('PUT', `/api/tests/${test.id}/draft`, { revision: draft.revision, script });
  const result = { testId: test.id, name, revision: draft.revision };
  await fs.writeFile('/private/tmp/whippet-m4-fixture.json', JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
