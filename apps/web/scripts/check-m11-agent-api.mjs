// Isolated M11 API contract checks. All values are synthetic; never print credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const typeUrl = moduleUrl(compile(await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')));
const planUrl = moduleUrl(compile(await readFile(new URL('../src/plan.ts', import.meta.url), 'utf8')));
const code = compile(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')).replace(/from ['"]\.\/types['"]/g, `from '${typeUrl}'`).replace(/from ['"]\.\/plan['"]/g, `from '${planUrl}'`);
const { createHttpApi } = await import(moduleUrl(code));

globalThis.window = { location: { href: 'http://localhost:5173/' } };
const api = createHttpApi('/api');
const admin = 'synthetic-admin-value';
const agent = 'synthetic-agent-value';
const token = { id: 'token-1', workspaceId: 'ws-1', name: 'Synthetic', createdAt: '2026-11-14T00:00:00Z', revokedAt: null, lastUsedAt: null };
let status = 200;
let body = {};
let lastRequest;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  lastRequest = { url, options };
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

try {
  api.setAdminToken(admin);
  body = { user: { id: 'superadmin', role: 'superadmin' } };
  await api.login();
  assert.ok(lastRequest.options.headers['X-Whippet-Admin-Token'] === admin);
  assert.ok(lastRequest.options.cache === 'no-store' && lastRequest.options.redirect === 'error');
  assert.ok(!lastRequest.url.includes(admin));

  api.setAdminToken('');
  body = { items: [token] };
  const listed = await api.listAgentTokens('ws-1');
  assert.ok(!Object.hasOwn(lastRequest.options.headers, 'X-Whippet-Admin-Token'));
  assert.ok(listed.length === 1 && !Object.hasOwn(listed[0], 'token'));

  status = 201; body = { token: agent, agentToken: token };
  const created = await api.createAgentToken('ws-1', 'Synthetic');
  assert.ok(created.token === agent && !Object.hasOwn(created.agentToken, 'token'));
  assert.ok(!lastRequest.url.includes(agent));

  status = 200; body = { items: [{ ...token, token: agent }] };
  await assert.rejects(api.listAgentTokens('ws-1'), (error) => error.code === 'INVALID_RESPONSE');
  body = { items: [{ ...token, workspaceId: 'other' }] };
  await assert.rejects(api.listAgentTokens('ws-1'), (error) => error.code === 'WORKSPACE_CONFLICT');

  body = { items: [{ id: 'audit-1', tokenId: token.id, workspaceId: 'ws-1', toolName: 'catalog_search', decision: 'allowed', occurredAt: token.createdAt }], nextCursor: null };
  const audit = await api.listAgentToolAudit('ws-1');
  assert.ok(audit.items.length === 1 && audit.nextCursor === null);
  assert.ok(lastRequest.url.includes('limit=20'));

  status = 204;
  await api.revokeAgentToken('ws-1', token.id);
  assert.ok(lastRequest.options.method === 'DELETE');
  await api.logout();
  assert.ok(lastRequest.url === '/api/dev-logout' && lastRequest.options.credentials === 'include');
  console.log('M11 Agent API checks passed');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
}
