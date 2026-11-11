#!/usr/bin/env node
// M3 API smoke（純黑箱）：Node 原生 fetch，無認證，不刪資料，寫入 POST 不重試。
// 只送使用者合成需求給模型，不傳專案內容；印最少 id/status/工具摘要，無模型全文。
// BASE 預設 http://127.0.0.1:18081；fixture 僅寫入需求文字，不由本腳本連線。
'use strict';

const BASE = (process.env.WHIPPET_API_URL || 'http://127.0.0.1:18081').replace(/\/$/, '');
const FIXTURE = process.env.WHIPPET_FIXTURE_URL || 'http://host.docker.internal:18082';
const OVERALL_MS = 9 * 60 * 1000;
const AUTHOR_MS = 210 * 1000;
const VALID_MS = 180 * 1000;
const POLL_MS = 3000;
const t0 = Date.now();

function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) {
    console.error(`FAIL overall-timeout step=${step}`);
    process.exit(1);
  }
}

async function api(method, path, body) {
  checkOverall(`${method} ${path}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { http: res.status, json, text: text.slice(0, 500) };
}

function need(cond, msg, evidence) {
  if (!cond) {
    console.error(`FAIL ${msg}${evidence ? ` evidence=${JSON.stringify(evidence).slice(0, 300)}` : ''}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollRun(runId, maxMs, label) {
  const start = Date.now();
  for (;;) {
    checkOverall(`poll-${label} ${runId}`);
    if (Date.now() - start > maxMs) {
      console.error(`FAIL ${label}-timeout id=${runId}`);
      process.exit(1);
    }
    await sleep(POLL_MS);
    const r = await api('GET', `/api/runs/${runId}`);
    need(r.http === 200, `${label}-get-run`, { id: runId, http: r.http, body: r.text });
    const run = r.json && (r.json.run || r.json);
    need(run && run.status, `${label}-no-status`, { id: runId });
    const st = run.status;
    console.log(`${label} id=${runId} status=${st}`);
    if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(st)) return run;
  }
}

function summarizeMessages(messages) {
  const users = messages.filter((m) => m.role === 'user' || m.author === 'user').length;
  const assts = messages.filter((m) => m.role === 'assistant' || m.author === 'assistant').length;
  return { total: messages.length, users, assistants: assts };
}

function findAssistantByRun(messages, runId) {
  return messages.find((m) =>
    (m.role === 'assistant' || m.author === 'assistant') &&
    (m.validationRunId === runId || m.runId === runId || m.authorRunId === runId || m.run_id === runId)
  );
}

async function main() {
  // 新增 Test
  let r = await api('GET', '/api/workspaces');
  need(r.http === 200, 'list-workspaces', { http: r.http });
  const ws = r.json && r.json.items && r.json.items[0];
  need(ws && ws.id, 'no-workspace', {});
  console.log(`workspace id=${ws.id}`);

  const name = `m3-smoke-${Date.now()}`;
  r = await api('POST', `/api/workspaces/${ws.id}/tests`, { name, description: 'm3 smoke synthetic' });
  need(r.http === 201, 'create-test', { http: r.http, body: r.text });
  const test = r.json && (r.json.test || r.json);
  const testId = test && test.id;
  need(testId, 'create-test-noid', {});
  console.log(`test id=${testId}`);

  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-0', { http: r.http, body: r.text });
  const rev0 = r.json && r.json.revision;
  need(rev0 !== undefined, 'draft-no-revision', {});
  console.log(`draft revision=${rev0}`);

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-0', { http: r.http, body: r.text });
  const conv0 = r.json && (r.json.conversation || r.json);
  const convId0 = conv0 && conv0.id;
  need(convId0, 'conv-no-id', {});
  console.log(`conversation id=${convId0}`);

  // 第一輪：合成需求（只此文字送模型）
  const round1 = `請用 browser_navigate 與 snapshot 探索 fixture 網站 ${FIXTURE}，用 browser_fill 與 click 新增名稱 alpha 的 task，然後用 update_draft 建立完整 @playwright/test TypeScript spec，在此 URL 上重現填 Task name、按 Add task、斷言 listitem alpha 與 status 1 tasks；最後呼叫 request_validation，不要只回程式碼，不要發佈。`;
  r = await api('POST', `/api/tests/${testId}/messages`, { content: round1, revision: rev0 });
  need(r.http === 202, 'msg-round1', { http: r.http, body: r.text });
  const m1 = r.json || {};
  const author1 = (m1.run && m1.run.id) || m1.runId || m1.authorRunId;
  const convId1 = m1.conversationId || (m1.conversation && m1.conversation.id);
  need(author1, 'round1-norun', {});
  console.log(`author1 id=${author1}`);
  if (convId1) need(convId1 === convId0, 'conv-changed-r1', { convId0, convId1 });

  const aRun1 = await pollRun(author1, AUTHOR_MS, 'author1');
  need(aRun1.status === 'succeeded', 'author1-status', { id: author1, status: aRun1.status, error: aRun1.error });

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-1', { http: r.http });
  const conv1 = r.json && (r.json.conversation || r.json);
  need(conv1 && conv1.id === convId0, 'conv-persist-1', { convId0 });
  const msgs1 = conv1.messages || [];
  const a1 = findAssistantByRun(msgs1, author1);
  need(a1, 'assistant1-notfound', { author: author1, summary: summarizeMessages(msgs1) });
  need(a1.appliedRevision !== undefined, 'assistant1-no-appliedRevision', { author: author1 });
  need(a1.validationRunId, 'assistant1-no-validationRunId', { author: author1 });
  console.log(`assistant1 appliedRevision=${a1.appliedRevision} validationRunId=${a1.validationRunId}`);
  if (a1.content !== undefined) console.log(`assistant1 content摘要: ${String(a1.content).slice(0, 200)}`);

  const vRun1 = await pollRun(a1.validationRunId, VALID_MS, 'validation1');
  need(vRun1.status === 'succeeded', 'validation1-status', { id: a1.validationRunId, status: vRun1.status, error: vRun1.error });
  need(vRun1.reportUrl, 'validation1-report', { id: a1.validationRunId });
  console.log(`validation1 id=${a1.validationRunId} status=succeeded reportUrl=present`);

  // 第二輪：同一 conversation + 最新 draft revision
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-1', { http: r.http });
  const rev1 = r.json && r.json.revision;
  need(rev1 !== undefined, 'draft1-no-revision', {});
  console.log(`draft revision=${rev1}`);
  need(rev1 > rev0, 'revision-not-increased-r1', { rev0, rev1 });

  const round2 = `將測試修改為新增 alpha 及 beta 兩項，斷言兩個 listitem 及 status 2 tasks，保留 URL ${FIXTURE}，使用 update_draft 與 request_validation；不需重複探索網站。`;
  r = await api('POST', `/api/tests/${testId}/messages`, { content: round2, revision: rev1 });
  need(r.http === 202, 'msg-round2', { http: r.http, body: r.text });
  const m2 = r.json || {};
  const author2 = (m2.run && m2.run.id) || m2.runId || m2.authorRunId;
  const convId2 = m2.conversationId || (m2.conversation && m2.conversation.id);
  need(author2, 'round2-norun', {});
  console.log(`author2 id=${author2}`);
  if (convId2) need(convId2 === convId0, 'conv-changed-r2', { convId0, convId2 });

  const aRun2 = await pollRun(author2, AUTHOR_MS, 'author2');
  need(aRun2.status === 'succeeded', 'author2-status', { id: author2, status: aRun2.status, error: aRun2.error });

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-2', { http: r.http });
  const conv2 = r.json && (r.json.conversation || r.json);
  need(conv2 && conv2.id === convId0, 'conv-session-same', { convId0 });
  const msgs2 = conv2.messages || [];
  const sum2 = summarizeMessages(msgs2);
  need(sum2.users >= 2 && sum2.assistants >= 2, 'conv-min-2-each', sum2);
  console.log(`conversation total=${sum2.total} user=${sum2.users} assistant=${sum2.assistants} id=${conv2.id}`);
  const a2 = findAssistantByRun(msgs2, author2);
  need(a2, 'assistant2-notfound', { author: author2, summary: sum2 });
  need(a2.appliedRevision !== undefined && a2.validationRunId, 'assistant2-fields', { author: author2 });
  need(a2.appliedRevision > a1.appliedRevision, 'revision-not-increased-r2', { r1: a1.appliedRevision, r2: a2.appliedRevision });
  console.log(`assistant2 appliedRevision=${a2.appliedRevision} validationRunId=${a2.validationRunId}`);

  const vRun2 = await pollRun(a2.validationRunId, VALID_MS, 'validation2');
  need(vRun2.status === 'succeeded', 'validation2-status', { id: a2.validationRunId, status: vRun2.status, error: vRun2.error });
  need(vRun2.reportUrl, 'validation2-report', { id: a2.validationRunId });
  console.log(`validation2 id=${a2.validationRunId} status=succeeded reportUrl=present`);

  // publish 最新 revision
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-2', { http: r.http });
  const revLatest = r.json && r.json.revision;
  const draftScript = r.json && r.json.script;
  need(revLatest !== undefined && draftScript !== undefined, 'draft2-fields', {});
  console.log(`draft latest revision=${revLatest}`);

  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revLatest, confirmed: true });
  need([200, 201].includes(r.http), 'publish', { http: r.http, body: r.text });
  const ver = r.json && (r.json.version || r.json);
  need(ver && ver.id, 'publish-noid', {});
  console.log(`version id=${ver.id} revision=${ver.revision}`);

  // 持久化確認
  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200 && (r.json.conversation || r.json).id === convId0, 'conv-persist-final', {});
  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'draft-final', { http: r.http });
  need((r.json && r.json.script) === draftScript, 'draft-script-persist', {});
  r = await api('GET', `/api/tests/${testId}/versions`);
  need(r.http === 200, 'list-versions', { http: r.http });
  const items = (r.json && r.json.items) || [];
  const found = items.find((v) => v.id === ver.id);
  need(found, 'version-missing', { versionId: ver.id, count: items.length });
  need(found.script === draftScript, 'version-script-match', { versionId: ver.id });
  console.log(`persist ok versions=${items.length} versionScript=draftScript`);

  console.log(`DONE test=${testId} conv=${convId0} author1=${author1} author2=${author2}`);
}

main().catch((e) => {
  console.error(`FAIL exception ${e && e.message || e}`);
  process.exit(1);
});
