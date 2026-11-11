import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from './api';
import { formatDate, Loading, Notice, ReportLink } from './components';
import { isActiveRun } from './types';
import type { Run, Test, Version, WhippetApi } from './types';

export function CreateTestForm({ api, workspaceId, onCreated, onCancel }: {
  api: WhippetApi; workspaceId: string; onCreated: (test: Test) => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim()) return;
    lock.current = true; setBusy(true); setError(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const test = await api.createTest(workspaceId, { name: name.trim(), description: description.trim() }, request.signal);
      if (!request.signal.aborted) onCreated(test);
    } catch (cause) {
      if (!request.signal.aborted) setError(`${errorMessage(cause)} 若請求結果不明，請先重新載入列表確認是否已建立，避免重複新增。`);
    } finally { if (!request.signal.aborted) setBusy(false); lock.current = false; }
  }
  return <form className="create-test-form" onSubmit={create}>
    <h2>新增測試</h2><p className="inline-hint">建立後可直接編輯 TypeScript 草稿，再驗證與發佈。</p>
    <label className="field-label" htmlFor="test-name">測試名稱</label>
    <input id="test-name" className="text-input" required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
    <label className="field-label" htmlFor="test-description">描述（選填）</label>
    <textarea id="test-description" className="text-input" rows={4} value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
    {error ? <Notice message={error} /> : null}
    <div className="action-row"><button className="button primary" disabled={busy || !name.trim()} type="submit">{busy ? '建立中…' : '建立測試'}</button>
      <button className="button quiet" disabled={busy} type="button" onClick={onCancel}>返回測試</button></div>
  </form>;
}

export function CancelRunButton({ api, run, onUpdated }: { api: WhippetApi; run: Run; onUpdated: (run: Run) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!isActiveRun(run)) return null;
  async function cancel() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const updated = await api.cancelRun(run.id, request.signal);
      if (!request.signal.aborted) onUpdated(updated);
    } catch (cause) { if (!request.signal.aborted) setError(`${errorMessage(cause)} 請重新整理紀錄確認取消狀態。`); }
    finally { if (!request.signal.aborted) setBusy(false); lock.current = false; }
  }
  return <><button className="button secondary compact" disabled={busy || run.status === 'cancelling'} onClick={cancel} aria-label={`取消 Run ${run.id}`}>{busy || run.status === 'cancelling' ? '取消中…' : '取消執行'}</button>
    {error ? <Notice message={error} /> : null}</>;
}

export function VersionHistory({ api, apiBase, versions, runs, publishedVersionId, loading, error, onRefresh }: {
  api: WhippetApi; apiBase: string; versions?: Version[]; runs: Run[]; publishedVersionId?: string | null;
  loading: boolean; error?: string; onRefresh: () => void;
}) {
  return <section className="versions-section" aria-labelledby="versions-title">
    <div className="section-heading"><h3 id="versions-title">歷史版本 <span className="count">{versions?.length ?? '—'}</span></h3>
      <button className="button secondary compact" disabled={loading} onClick={onRefresh}>重新整理版本</button></div>
    {loading ? <Loading text="正在載入歷史版本…" /> : null}
    {error ? <Notice message={error} retry={onRefresh} /> : null}
    {versions?.length === 0 ? <p className="muted">尚無已發佈版本。完成草稿驗證並確認發佈後，會在這裡保留不可變的腳本與報告入口。</p> : null}
    <ul className="version-list">{versions ? [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((version) => <li key={version.id}>
      <div className="version-heading"><strong>revision {version.revision}{publishedVersionId === version.id ? ' · 目前版本' : ''}</strong><VersionReport api={api} apiBase={apiBase} runId={version.validationRunId} run={runs.find((run) => run.id === version.validationRunId)} /></div>
      <p className="muted">{formatDate(version.createdAt)}</p><p className="version-id identifier">{version.id}</p>
      <details className="version-script"><summary>查看此版本腳本（唯讀）</summary><pre>{version.script || '空腳本'}</pre></details>
    </li>) : null}</ul>
  </section>;
}

function VersionReport({ api, apiBase, runId, run }: { api: WhippetApi; apiBase: string; runId: string; run?: Run }) {
  const [fetched, setFetched] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const result = run ?? fetched;
  async function loadReport() {
    if (controller.current && !controller.current.signal.aborted && busy) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(undefined);
    try { const next = await api.getRun(runId, request.signal); if (!request.signal.aborted) setFetched(next); }
    catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  return result?.reportUrl ? <ReportLink reportUrl={result.reportUrl} apiBase={apiBase} label="查看版本驗證報告" />
    : <div><button className="button quiet compact" disabled={busy} onClick={loadReport}>{busy ? '載入中…' : result ? '重新載入驗證報告' : '載入驗證報告'}</button>{error ? <Notice message={error} /> : null}</div>;
}
