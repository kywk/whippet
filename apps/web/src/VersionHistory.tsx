import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { scriptOriginLabel } from './capabilities';
import { formatDate, Loading, Notice, ReportLink } from './components';
import { collapseDiff, diffLines, diffStat } from './diff';
import { VersionConversation } from './VersionConversation';
import { VersionMarkdown } from './VersionMarkdown';
import type { ActiveEditingSession, Draft, Run, Version, WhippetApi } from './types';

interface Props {
  api: WhippetApi;
  apiBase: string;
  versions?: Version[];
  runs: Run[];
  publishedVersionId?: string | null;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onEditDraft?: () => void;
  onDiscardDraft?: () => void;
  activeEditingSession?: ActiveEditingSession | null;
  sessionBusy?: boolean;
  knownDraft?: Draft;
  editorGuarded?: boolean;
  deletesTest?: boolean;
}

export function VersionHistory({ api, apiBase, versions, runs, publishedVersionId, loading, error, onRefresh,
  onEditDraft, onDiscardDraft, activeEditingSession, sessionBusy, knownDraft, editorGuarded, deletesTest }: Props) {
  const [viewingId, setViewingId] = useState<string>();
  const index = versions?.findIndex((version) => version.id === viewingId) ?? -1;
  const viewing = index < 0 ? undefined : versions?.[index];
  const hasPublishedVersions = Boolean(publishedVersionId || versions?.length);
  const showDraftControls = Boolean(onEditDraft && onDiscardDraft);
  const showVersions = hasPublishedVersions || !showDraftControls;

  return <section className="versions-section" aria-labelledby="versions-title">
    <div className="section-heading">
      <h2 id="versions-title">{showVersions ? <>版本歷史 <span className="count">{versions?.length ?? '—'}</span></> : '目前草稿'}</h2>
      {showVersions ? <button className="button secondary compact" disabled={loading} onClick={onRefresh}>重新整理版本</button> : null}
    </div>
    {showDraftControls && activeEditingSession ? <div className="draft-version-entry">
      <div className="version-heading">
        <strong>草稿{activeEditingSession.status === 'discarding' ? ' · 正在放棄' : ''}</strong>
        <div className="action-row">
          <button className="button secondary compact" disabled={sessionBusy} onClick={onEditDraft}>{activeEditingSession.status === 'discarding' ? '查看放棄進度' : '繼續修改'}</button>
          <button className="button quiet compact" disabled={sessionBusy || activeEditingSession.status === 'discarding'} onClick={onDiscardDraft}>{deletesTest ? '刪除測試…' : '刪除草稿'}</button>
        </div>
      </div>
      <p className="muted">{activeEditingSession.status === 'discarding' ? '等待本週期任務終止及資源回收。' : editorGuarded ? '切回編輯模式可接續未儲存的內容或進行中的操作。' : `草稿 revision ${knownDraft?.revision ?? activeEditingSession.draftRevision}，尚未發佈。`}</p>
    </div> : showDraftControls && activeEditingSession === undefined ? <p className="mode-empty">草稿狀態尚未確認，請重新載入編輯狀態。</p> : null}
    {showVersions && loading ? <Loading text="正在載入版本歷史…" /> : null}
    {showVersions && error ? <Notice message={error} retry={onRefresh} /> : null}
    {!hasPublishedVersions && !loading && !error && !showDraftControls ? <p className="muted">尚無已發佈版本。</p> : null}
    {!hasPublishedVersions && showDraftControls && activeEditingSession === null ? <p className="muted">開啟對話編輯來建立草稿。</p> : null}
    {versions?.length ? <ol className="version-list" aria-label="已發佈版本">
      {versions.map((version, position) => {
        const previous = versions[position + 1];
        const current = version.id === publishedVersionId;
        const firstLine = version.description?.trim().split('\n', 1)[0]?.replace(/^#{1,6}\s+|^目的[：:]\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim();
        return <li key={version.id} className={current ? 'current-version' : undefined} data-version-id={version.id}>
          <div className="version-heading">
            <strong>revision {version.revision}</strong>
            {current ? <span className="chip ok">目前版本</span> : null}
            <time className="muted" dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
          </div>
          <p className="version-log-title">{firstLine || (previous ? '發佈測試版本' : '首次發佈')}</p>
          {previous ? <p className="version-log-meta">
            相較 revision {previous.revision} · {version.script === previous.script ? '腳本相同' : '腳本有變更'}
            {version.workspaceSettings?.revision !== previous.workspaceSettings?.revision ? ' · 設定有變更' : ''}
          </p> : firstLine && firstLine !== '首次發佈' ? <p className="version-log-meta">首次發佈</p> : null}
          <div className="version-row-actions">
            <button className="button secondary compact" aria-label={`檢視版本 revision ${version.revision}`} aria-haspopup="dialog" onClick={() => setViewingId(version.id)}>檢視版本</button>
            <VersionReport api={api} apiBase={apiBase} runId={version.validationRunId} run={runs.find((run) => run.id === version.validationRunId)} />
          </div>
        </li>;
      })}
    </ol> : null}
    {viewing ? <VersionDetails key={viewing.id} api={api} version={viewing} previous={versions?.[index + 1]} current={viewing.id === publishedVersionId} onClose={() => setViewingId(undefined)} /> : null}
  </section>;
}

function VersionDetails({ api, version, previous, current, onClose }: { api: WhippetApi; version: Version; previous?: Version; current: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  function close() {
    ref.current?.close();
    onClose();
  }

  return <dialog ref={ref} className="version-details-dialog" aria-labelledby="version-details-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="section-heading version-details-header">
      <h2 id="version-details-title">版本詳情 · revision {version.revision}</h2>
      {current ? <span className="chip ok">目前版本</span> : null}
      <button className="button secondary compact" onClick={close}>關閉</button>
    </div>
    <div className="version-details-body">
      <div className="version-details-meta">
        <p><time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time> · {scriptOriginLabel(version.scriptOrigin)}</p>
        <p className="version-id identifier">{version.id}</p>
        {version.workspaceSettings ? <p>版本固定設定 {version.workspaceSettings.revision} · 執行逾時 {version.workspaceSettings.timeoutMs.toLocaleString('zh-TW')} 毫秒</p> : null}
      </div>
      {version.scriptOrigin === 'ai' && version.editingSessionId ? <VersionConversation api={api} testId={version.testId} versionId={version.id} /> : null}
      <h3>與上一個發佈版本比較</h3>
      {previous ? <VersionChanges previous={previous} version={version} /> : <p className="muted">這是第一個已發佈版本。</p>}
      <h3>版本說明</h3>
      <VersionMarkdown text={version.description || '此版本尚無版本說明（舊資料）。'} />
      <details className="version-background">
        <summary>查看版本背景摘要</summary>
        <p className="summary-content">{version.backgroundSummary ?? '此版本尚無背景摘要（舊資料）。'}</p>
      </details>
      <details className="version-background">
        <summary>檢視完整腳本</summary>
        <pre className="code-view" tabIndex={0} aria-label={`revision ${version.revision} 腳本（唯讀）`}>{version.script || '（空腳本）'}</pre>
      </details>
    </div>
  </dialog>;
}

function VersionChanges({ version, previous }: { version: Version; previous: Version }) {
  const same = previous.script === version.script;
  const lines = same ? undefined : diffLines(previous.script, version.script);
  const stats = lines ? diffStat(lines) : undefined;

  return <div className="version-changes">
    <div className="version-change-meta">
      <p className="muted">revision {previous.revision} → revision {version.revision}</p>
      {stats ? <span className="artifact-meta"><span className="add">新增 {stats.added} 行</span><span className="del">移除 {stats.removed} 行</span></span> : null}
    </div>
    {same ? <p>兩版腳本相同。</p> : lines ? <pre className="diff" tabIndex={0} aria-label="腳本逐行差異">
      {collapseDiff(lines).map((line, index) => line.kind === 'skip'
        ? <span key={index} className="diff-line muted">略過 {line.count} 行未變更內容{'\n'}</span>
        : <span key={index} className={`diff-line ${line.kind}`}><i>{line.after ?? line.before}</i><b>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</b>{line.text || ' '}{'\n'}</span>)}
    </pre> : <div className="code-comparison">
      <div><h4>變更前 · revision {previous.revision}</h4><pre tabIndex={0}>{previous.script || '（空腳本）'}</pre></div>
      <div><h4>變更後 · revision {version.revision}</h4><pre tabIndex={0}>{version.script || '（空腳本）'}</pre></div>
    </div>}
  </div>;
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
