// Synthetic rendering check for the author engine badge and Run-derived state.
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = await mkdtemp(path.join(scriptsDir, '.m11-author-ui-'));
const outfile = path.join(buildDir, 'check.mjs');
const source = `
  import assert from 'node:assert/strict';
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { AuthorEngineStatus } from '../src/AuthorEngineStatus.tsx';
  import { AuthorEngineSettings } from '../src/AuthorEngineSettings.tsx';
  import { WorkspaceConversation } from '../src/WorkspaceConversation.tsx';
  import { AuthorLiveStatus } from '../src/trail.tsx';
  import { ConversationPanel } from '../src/ConversationPanel.tsx';
  import { RunHistory } from '../src/RunHistory.tsx';

  function render(engine, status) {
    return renderToStaticMarkup(React.createElement(AuthorEngineStatus, { engine, status }));
  }
  for (const [status, expected] of [
    ['queued', '接單中'],
    ['dispatched', '接單中'],
    ['running', '作業中'],
    ['collecting', '作業中'],
    ['succeeded', '完成'],
    ['failed', '失敗'],
    ['timed_out', '失敗'],
    ['interrupted', '失敗'],
    ['cancelled', '已取消'],
  ]) {
    const html = render('external', status);
    assert.match(html, /AI 來源：外部 Agent/);
    assert.match(html, new RegExp(expected));
    assert.match(html, /role="status"/);
  }
  const builtin = render('builtin', 'running');
  assert.match(builtin, /AI 來源：內建引擎/);
  assert.doesNotMatch(builtin, /外部 Agent/);

  const settings = renderToStaticMarkup(React.createElement(AuthorEngineSettings, {
    current: 'builtin', selected: 'external', disabled: false, busy: false,
    onSelect() {}, onSave() {},
  }));
  assert.match(settings, /AI 撰寫引擎/);
  assert.match(settings, /目前：內建引擎/);
  assert.match(settings, /外部 Agent/);
  assert.match(settings, /<input(?=[^>]*checked)(?=[^>]*value="external")[^>]*>/);
  assert.match(settings, /儲存引擎設定/);
  assert.doesNotMatch(settings, /button[^>]*disabled/);

  const workspace = {
    id: 'workspace-fixture', name: '合成工作區', revision: 3, authorEngine: 'external',
    sites: [], defaultTestUrl: '', timeoutMs: 60000, lifecycle: 'active',
    authorizationRevision: 1, scopeStatus: 'confirmed', settings: null,
    conversationId: 'conversation-fixture', activeRunId: null, currentProposal: null,
    roles: [], secretsAvailable: true, executionAvailable: true, unavailableReason: null,
  };
  const page = renderToStaticMarkup(React.createElement(WorkspaceConversation, {
    api: {}, apiBase: '/api', workspace, active: false,
    onReturn() {}, onDirtyChange() {}, onCreated() {}, onWorkspaceUpdated() {}, onRefreshList() {},
  }));
  assert.match(page, /AI 撰寫引擎設定/);
  assert.match(page, /value="external"/);
  assert.match(page, /一般 Test、Module、Use Case Plan 整批的驗收摘要/);

  const waiting = renderToStaticMarkup(React.createElement(AuthorLiveStatus, {
    run: { id: 'run-fixture', testId: 'test-fixture', kind: 'author', status: 'queued', authorEngine: 'external', createdAt: '2026-11-14T00:00:00Z' },
  }));
  assert.match(waiting, /等待外部 Agent 接單/);
  assert.doesNotMatch(waiting, /Worker 啟動/);
  const working = renderToStaticMarkup(React.createElement(AuthorLiveStatus, {
    run: { id: 'run-fixture', testId: 'test-fixture', kind: 'author', status: 'running', authorEngine: 'external', createdAt: '2026-11-14T00:00:00Z' },
  }));
  assert.match(working, /外部 Agent 正在處理/);

  const conversation = renderToStaticMarkup(React.createElement(ConversationPanel, {
    api: {}, apiBase: '/api', testId: 'test-fixture', editingSessionId: 'session-fixture',
    draft: { testId: 'test-fixture', revision: 1, script: '', updatedAt: '2026-11-14T00:00:00Z' },
    draftDirty: false, draftBusy: false,
    runs: [{ id: 'run-fixture', testId: 'test-fixture', editingSessionId: 'session-fixture', kind: 'author', authorMode: 'edit', status: 'queued', authorEngine: 'external', createdAt: '2026-11-14T00:00:00Z' }],
    onRun() {}, onRefreshRuns() {}, onSynchronized() {}, onUseCandidate() { return false; },
    onOpenManual() {}, onGuardChange() {}, onConversationChanged() {},
    async onRefreshSession() { return undefined; }, onShowTab() {}, publishReady: false,
  }));
  assert.match(conversation, /AI 來源：外部 Agent/);
  assert.match(conversation, /接單中/);
  const nextTask = renderToStaticMarkup(React.createElement(ConversationPanel, {
    api: {}, apiBase: '/api', testId: 'test-fixture', editingSessionId: 'session-fixture',
    authorEngine: 'external', testKind: 'test',
    draft: { testId: 'test-fixture', revision: 1, script: '', updatedAt: '2026-11-14T00:00:00Z' },
    draftDirty: false, draftBusy: false, runs: [],
    onRun() {}, onRefreshRuns() {}, onSynchronized() {}, onUseCandidate() { return false; },
    onOpenManual() {}, onGuardChange() {}, onConversationChanged() {},
    async onRefreshSession() { return undefined; }, onShowTab() {}, publishReady: false,
  }));
  assert.match(nextTask, /新對話任務：外部 Agent/);

  const history = renderToStaticMarkup(React.createElement(RunHistory, {
    api: {}, apiBase: '/api', group: 'editing', loading: false, polling: false,
    runs: [{ id: 'run-fixture', testId: 'test-fixture', kind: 'author', authorMode: 'edit', status: 'succeeded', authorEngine: 'external', createdAt: '2026-11-14T00:00:00Z' }],
    onRefresh() {}, onRun() {}, onWatch() {},
  }));
  assert.match(history, /AI 來源：外部 Agent/);
  assert.match(history, /完成/);
  const pendingHistory = renderToStaticMarkup(React.createElement(RunHistory, {
    api: {}, apiBase: '/api', group: 'editing', loading: false, polling: true,
    runs: [{ id: 'run-fixture', testId: 'test-fixture', kind: 'author', authorMode: 'edit', status: 'queued', authorEngine: 'external', createdAt: '2026-11-14T00:00:00Z' }],
    onRefresh() {}, onRun() {}, onWatch() {},
  }));
  assert.doesNotMatch(pendingHistory, /開始監看/);
`;

try {
  await build({
    stdin: { contents: source, resolveDir: scriptsDir, sourcefile: 'check-m11-author-ui.tsx', loader: 'tsx' },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  await import(pathToFileURL(outfile).href);
  console.log('M11 author UI synthetic checks passed');
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
