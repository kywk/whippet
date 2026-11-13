import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { formatDate, Loading, Notice, ReportLink } from './components';
import { isActiveRun } from './types';
import { scriptOriginLabel } from './capabilities';
import type { ActiveEditingSession, Draft, Run, Version, WhippetApi } from './types';

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

export function VersionHistory({ api, apiBase, versions, runs, publishedVersionId, loading, error, onRefresh, selectedVersionId, onSelectVersion, onEditDraft, onDiscardDraft, activeEditingSession, sessionBusy, knownDraft, editorGuarded }: {
  api: WhippetApi; apiBase: string; versions?: Version[]; runs: Run[]; publishedVersionId?: string | null;
  loading: boolean; error?: string; onRefresh: () => void;
  selectedVersionId?: string | null; onSelectVersion?: (version: Version) => void;
  onEditDraft?: () => void; knownDraft?: Draft; editorGuarded?: boolean;
  onDiscardDraft?: () => void; activeEditingSession?: ActiveEditingSession | null; sessionBusy?: boolean;
}) {
  return <section className="versions-section" aria-labelledby="versions-title">
    <div className="section-heading"><h3 id="versions-title">歷史版本 <span className="count">{versions?.length ?? '—'}</span></h3>
      <button className="button secondary compact" disabled={loading} onClick={onRefresh}>重新整理版本</button></div>
    {loading ? <Loading text="正在載入歷史版本…" /> : null}
    {error ? <Notice message={error} retry={onRefresh} /> : null}
    {versions?.length === 0 ? <p className="muted">尚無已發佈版本。完成草稿驗證並確認發佈後，會在這裡保留不可變的腳本與報告入口。</p> : null}
    <ul className="version-list">
      {onEditDraft && activeEditingSession ? <li className="draft-version-entry"><div className="version-heading"><strong>草稿{activeEditingSession.status === 'discarding' ? ' · 正在放棄' : ''}</strong><div className="action-row"><button className="button secondary compact" disabled={sessionBusy} onClick={onEditDraft}>{activeEditingSession.status === 'discarding' ? '查看放棄進度' : '繼續修改'}</button>{onDiscardDraft ? <button className="button quiet compact" disabled={sessionBusy || activeEditingSession.status === 'discarding'} onClick={onDiscardDraft}>刪除草稿</button> : null}</div></div>
        <p className="muted">{activeEditingSession.status === 'discarding' ? '等待本週期任務終止及資源回收；草稿尚未視為已刪除。' : editorGuarded ? '有未儲存內容或進行中的操作，切回編輯模式可繼續。' : `草稿 revision ${knownDraft?.revision ?? activeEditingSession.draftRevision}，尚未發佈；修改不影響目前正式版本。`}</p>
      </li> : null}
      {onEditDraft && activeEditingSession === undefined ? <li className="mode-empty">草稿狀態尚未確認，請重新載入編輯狀態。</li> : null}
      {versions ? [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((version) => <li key={version.id} className={selectedVersionId === version.id ? 'selected-version' : undefined} data-version-id={version.id}>
      <div className="version-heading"><strong>revision {version.revision}{publishedVersionId === version.id ? ' · 目前版本' : ''}</strong><VersionReport api={api} apiBase={apiBase} runId={version.validationRunId} run={runs.find((run) => run.id === version.validationRunId)} /></div>
      <p className="muted">{formatDate(version.createdAt)}</p><p className="version-id identifier">{version.id}</p>
      <p className="inline-hint">版本腳本來源：{scriptOriginLabel(version.scriptOrigin)}</p>
      {version.workspaceSettings ? <p className="inline-hint">版本固定設定 {version.workspaceSettings.revision} · 執行逾時 {version.workspaceSettings.timeoutMs.toLocaleString('zh-TW')} 毫秒</p> : null}
      {onSelectVersion ? <button className="button quiet compact" aria-label={`檢視版本 ${version.id}`} aria-pressed={selectedVersionId === version.id} aria-controls="published-script-panel" onClick={() => onSelectVersion(version)}>檢視版本</button> : <details className="version-script"><summary>查看此版本腳本（唯讀）</summary><pre>{version.script || '空腳本'}</pre></details>}
    </li>) : null}</ul>
  </section>;
}

function VersionReport({ api, apiBase, runId, run }: { api: WhippetApi; apiBase: string; runId: string | null; run?: Run }) {
  const [fetched, setFetched] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const result = run ?? fetched;
  async function loadReport() {
    if (!runId) return;
    if (controller.current && !controller.current.signal.aborted && busy) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(undefined);
    try { const next = await api.getRun(runId, request.signal); if (!request.signal.aborted) setFetched(next); }
    catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  if (runId === null) return <span className="muted">此歷史版本未保留驗證紀錄（舊版資料）</span>;
  return result?.reportUrl ? <ReportLink reportUrl={result.reportUrl} apiBase={apiBase} label="查看版本驗證報告" />
    : <div><button className="button quiet compact" disabled={busy} onClick={loadReport}>{busy ? '載入中…' : result ? '重新載入驗證報告' : '載入驗證報告'}</button>{error ? <Notice message={error} /> : null}</div>;
}
