import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Loading, Notice } from './components';
import { useResource, useRuns } from './hooks';
import { ChevronRightIcon, RefreshIcon } from './icons';
import { RunHistory } from './RunHistory';
import { TestOverview } from './TestOverview';
import { VersionHistory } from './VersionHistory';
import type { Test, WhippetApi, WorkspaceDetail } from './types';
import './access.css';

const kindNames = { test: '一般測試', usecase: 'Use Case', module: 'Module' };

export function ArchivedTests({ api, workspace, onOpenTest }: { api: WhippetApi; workspace: WorkspaceDetail; onOpenTest: (test: Test) => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  const load = useCallback((signal: AbortSignal) => api.listArchivedTests(workspace.id, signal), [api, workspace.id]);
  const tests = useResource(load);
  useEffect(() => { title.current?.focus(); }, []);
  return <section className="access-view" aria-labelledby="archive-title">
    <header className="access-view-header">
      <div><p className="muted">{workspace.name}</p><h1 id="archive-title" ref={title} tabIndex={-1}>已封存測試</h1></div>
      <button type="button" className="button secondary compact" disabled={tests.loading} onClick={tests.retry}><RefreshIcon />重新載入</button>
    </header>
    {tests.loading ? <Loading text="正在載入已封存測試…" /> : null}
    {tests.error ? <Notice message={tests.error} retry={tests.retry} /> : null}
    {tests.data?.length === 0 ? <p className="muted">目前沒有已封存的測試。</p> : null}
    {tests.data?.length ? <ul className="access-list archive-list">
      {tests.data.map((test) => <li key={test.id}>
        <button type="button" onClick={() => onOpenTest(test)}>
          <span><strong>{test.name}</strong><span className="muted">{kindNames[test.kind ?? 'test']}</span></span>
          <ChevronRightIcon />
        </button>
      </li>)}
    </ul> : null}
  </section>;
}

export function ArchivedTestDetail({ api, apiBase, archivedTest, onReturn }: { api: WhippetApi; apiBase: string; archivedTest: Test; onReturn: () => void }) {
  const id = archivedTest.id;
  const loadTest = useCallback((signal: AbortSignal) => api.getTest(id, signal), [api, id]);
  const loadVersions = useCallback((signal: AbortSignal) => api.listVersions(id, signal), [api, id]);
  const test = useResource(loadTest);
  const versions = useResource(loadVersions);
  const history = useRuns(api, id);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);

  const item = test.data ?? archivedTest;
  const version = versions.data?.find((candidate) => candidate.id === item.publishedVersionId);
  const formalRuns = history.runs.filter((run) => !run.kind || run.kind === 'run');
  const editingRuns = history.runs.filter((run) => run.kind === 'author' || run.kind === 'validation');
  const runProps = { api, apiBase, loading: history.loading, error: history.error, polling: history.polling, onRefresh: history.refresh };

  return <div className="test-view">
    <header className="test-head">
      <div className="test-title">
        <h1 ref={title} tabIndex={-1}>{item.name}</h1>
        <div className="test-chips"><span className="chip neutral">已封存</span></div>
      </div>
      <button type="button" className="button secondary compact" onClick={onReturn}>返回已封存測試</button>
    </header>
    <div className="test-mode general-mode overview">
      {test.error ? <Notice message={test.error} retry={test.retry} /> : <TestOverview
        test={item} version={version} loading={test.loading || versions.loading} onRefreshVersions={versions.retry}
        tags={item.tags ?? []} workspaceTags={[]}
        runHistory={<><RunHistory {...runProps} group="formal" runs={formalRuns} />
          {editingRuns.length ? <RunHistory {...runProps} group="editing" runs={editingRuns} /> : null}</>}
        versionHistory={<VersionHistory api={api} apiBase={apiBase} versions={versions.data} runs={history.runs} publishedVersionId={item.publishedVersionId}
          loading={versions.loading} error={versions.error} onRefresh={versions.retry} />}
      />}
    </div>
  </div>;
}

export function ArchiveTestDialog({ api, test, activeEditing, onCancel, onArchived }: {
  api: WhippetApi; test: Test; activeEditing: boolean; onCancel: () => void; onArchived: (test: Test) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { request.current?.abort(); dialog?.close(); };
  }, []);

  async function archive() {
    if (activeEditing || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await api.archiveTest(test.id, controller.signal);
      if (!controller.signal.aborted) onArchived(test);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <dialog ref={dialogRef} className="script-edit-dialog" aria-labelledby="archive-dialog-title" aria-describedby="archive-dialog-description"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="archive-dialog-title">封存「{test.name}」？</h2>
    <p id="archive-dialog-description">{activeEditing ? '請完成發佈或放棄草稿後，再封存這個測試。' : '封存後可從「已封存測試」查看版本與報告。已排入的執行會繼續。'}</p>
    {error ? <Notice message={error} /> : null}
    <div className="action-row">
      <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
      {!activeEditing ? <button type="button" className="button danger-button" disabled={busy} onClick={() => { void archive(); }}>{busy ? '封存中…' : '確認封存'}</button> : null}
    </div>
  </dialog>;
}
