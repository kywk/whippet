#!/usr/bin/env node
// M3 repair smoke（同 session 故障後修復驗收）：只接續既有 testId，不掩蓋原始失敗。
// Node 原生 fetch，無認證，POST 不重試，只一回合模型；只印 id/status/name，不印模型原文。
// TEST_ID 取 WHIPPET_TEST_ID；BASE 預設 http://127.0.0.1:18081。
'use strict';

const BASE = (process.env.WHIPPET_API_URL || 'http://127.0.0.1:18081').replace(/\/$/, '');
const TEST_ID = process.env.WHIPPET_TEST_ID || '';
const OVERALL_MS = 9 * 60 * 1000;
const AUTHOR_MS = 210 * 1000;
const VALID_MS = 180 * 1000;
const POLL_MS = 3000;
const t0 = Date.now();

const REPAIR_CONTENT = '請先呼叫 read_validation_report 查看目前驗證失敗摘要，修正目前草稿，不要弱化測試。並將流程改成依序新增 alpha 和 beta 兩項，保留原本測試URL。listitem 不以 accessible name 定位，請用 getByRole(\'listitem\') 搭配 toHaveText([\'alpha\',\'beta\']) 斷言兩筆內容，再斷言 role=status 的文字為 2 tasks。使用 update_draft 寫完整spec，最後 request_validation；不要發佈，不需再探索網站。';

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
    console.log(`${label} id=${runId} status=${run.status}`);
    if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status)) return run;
  }
}

function findAssistantByRun(messages, runId) {
  return messages.find((m) =>
    (m.role === 'assistant' || m.author === 'assistant') &&
    (m.validationRunId === runId || m.runId === runId || m.authorRunId === runId || m.run_id === runId)
  );
}

async function main() {
  need(TEST_ID, 'missing-WHIPPET_TEST_ID', {});
  const testId = TEST_ID;
  console.log(`test id=${testId}`);

  let r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-orig', { http: r.http, body: r.text });
  const revOrig = r.json && r.json.revision;
  need(revOrig !== undefined, 'draft-no-revision', {});
  console.log(`draft orig revision=${revOrig}`);

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-orig', { http: r.http, body: r.text });
  const convOrig = r.json && (r.json.conversation || r.json);
  const convId0 = convOrig && convOrig.id;
  need(convId0, 'conv-no-id', {});
  const n0 = (convOrig.messages || []).length;
  console.log(`conversation id=${convId0} messages=${n0}`);

  r = await api('POST', `/api/tests/${testId}/messages`, { revision: revOrig, content: REPAIR_CONTENT });
  need(r.http === 202, 'post-repair', { http: r.http, body: r.text });
  const m = r.json || {};
  const authorId = (m.run && m.run.id) || m.runId || m.authorRunId;
  need(authorId, 'repair-norun', {});
  console.log(`author id=${authorId}`);

  const aRun = await pollRun(authorId, AUTHOR_MS, 'author');
  need(aRun.status === 'succeeded', 'author-status', { id: authorId, status: aRun.status, error: aRun.error });

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-1', { http: r.http });
  const conv1 = r.json && (r.json.conversation || r.json);
  need(conv1 && conv1.id === convId0, 'conv-id-changed', { convId0 });
  const msgs1 = conv1.messages || [];
  const a = findAssistantByRun(msgs1, authorId);
  need(a, 'assistant-notfound', { author: authorId, total: msgs1.length });
  need(a.appliedRevision !== undefined && a.appliedRevision > revOrig, 'appliedRevision-not-increased', { orig: revOrig, applied: a.appliedRevision });
  need(a.validationRunId, 'assistant-no-validationRunId', { author: authorId });
  console.log(`assistant appliedRevision=${a.appliedRevision} validationRunId=${a.validationRunId}`);

  const vRun = await pollRun(a.validationRunId, VALID_MS, 'validation');
  need(vRun.status === 'succeeded', 'validation-status', { id: a.validationRunId, status: vRun.status, error: vRun.error });
  need(vRun.reportUrl, 'validation-report', { id: a.validationRunId });
  console.log(`validation id=${a.validationRunId} status=succeeded reportUrl=present`);

  r = await api('GET', `/api/tests/${testId}/draft`);
  need(r.http === 200, 'get-draft-1', { http: r.http });
  const revNew = r.json && r.json.revision;
  const draftScript = r.json && r.json.script;
  need(revNew === a.appliedRevision, 'draft-revision-mismatch', { draft: revNew, applied: a.appliedRevision });
  console.log(`draft revision=${revNew}`);

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-2', { http: r.http });
  const conv2 = r.json && (r.json.conversation || r.json);
  need(conv2 && conv2.id === convId0, 'conv-id-changed-2', {});
  const msgs2 = conv2.messages || [];
  need(msgs2.length === n0 + 2, 'conv-not-plus2', { before: n0, after: msgs2.length });
  const a2 = findAssistantByRun(msgs2, authorId);
  need(a2 && a2.baseScript && a2.proposedScript, 'assistant-scripts-missing', { author: authorId });
  console.log(`conversation messages=${msgs2.length} baseScript=present proposedScript=present`);

  r = await api('POST', `/api/tests/${testId}/publish`, { revision: revNew, confirmed: true });
  need([200, 201].includes(r.http), 'publish', { http: r.http, body: r.text });
  const ver = r.json && (r.json.version || r.json);
  need(ver && ver.id, 'publish-noid', {});
  console.log(`version id=${ver.id} revision=${ver.revision}`);

  r = await api('GET', `/api/tests/${testId}/versions`);
  need(r.http === 200, 'list-versions', { http: r.http });
  const items = (r.json && r.json.items) || [];
  const found = items.find((v) => v.id === ver.id);
  need(found, 'version-missing', { versionId: ver.id, count: items.length });
  need(found.script === draftScript, 'version-script-match', { versionId: ver.id });
  console.log(`version script=draft script versions=${items.length}`);

  r = await api('GET', `/api/tests/${testId}`);
  need(r.http === 200, 'get-test', { http: r.http });
  const tname = (r.json && (r.json.test || r.json).name) || '';
  console.log(`test name=${tname}`);

  r = await api('GET', `/api/tests/${testId}/conversation`);
  need(r.http === 200, 'get-conv-final', { http: r.http });
  const nFinal = ((r.json.conversation || r.json).messages || []).length;
  need(nFinal >= 4, 'conv-final-count', { count: nFinal });
  console.log(`conversation final messages=${nFinal}`);

  console.log(`DONE test=${testId} name=${tname} author=${authorId} validation=${a.validationRunId} version=${ver.id}`);
}

main().catch((e) => {
  console.error(`FAIL exception ${e && e.message || e}`);
  process.exit(1);
});
