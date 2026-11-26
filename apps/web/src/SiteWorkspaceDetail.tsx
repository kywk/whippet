import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { formatDate, Loading, Notice } from './components';
import { useResource } from './hooks';
import './management-directory.css';
import { ArchiveIcon, RefreshIcon, UsersIcon } from './icons';
import { WorkspaceNameForm } from './WorkspaceNameForm';
import type { ArchiveImpact, ManagedWorkspace, ManagedWorkspaceApi, WorkspaceArchiveMode, WorkspaceManagement } from './types';

const stateLabels = { active: '使用中', archiving: '封存中', archived: '已封存' };
const impactLabels = {
  queuedRuns: '排隊工作', activeRuns: '執行中工作', externalClaims: '外部接單', browserLeases: '瀏覽器租約',
  unreleasedRunSlots: '未釋放的執行名額', provisionJobs: 'Agent 配置工作',
} satisfies Record<keyof ArchiveImpact, string>;
const impactKeys = Object.keys(impactLabels) as (keyof ArchiveImpact)[];

function ImpactCounts({ impact }: { impact: ArchiveImpact }) {
  return <dl className="workspace-impact-counts">
    {impactKeys.map((key) => <div key={key} className={impact[key] > 0 ? 'has-impact' : undefined}><dt>{impactLabels[key]}</dt><dd>{impact[key]}</dd></div>)}
  </dl>;
}

type ArchiveAction = 'archive' | 'cancel' | 'restore';

function canApply(action: ArchiveAction, management: WorkspaceManagement) {
  if (action === 'archive') return management.state === 'active';
  if (action === 'restore') return management.state === 'archived';
  return management.state === 'archiving' && management.archiveMode === 'drain';
}

export function SiteWorkspaceDetail({ api, workspaceId, onMembers, onOpenWorkspace, onAccessChanged }: {
  api: ManagedWorkspaceApi;
  workspaceId: string;
  onMembers: () => void;
  onOpenWorkspace: () => void;
  onAccessChanged: () => void;
}) {
  const load = useCallback((signal: AbortSignal) => api.get(workspaceId, signal), [api, workspaceId]);
  const { data, loading, error, retry, updateData } = useResource(load, true);
  const [renaming, setRenaming] = useState(false);
  const [action, setAction] = useState<ArchiveAction>();
  const [saved, setSaved] = useState<'name' | 'archive' | 'restore'>();
  const heading = useRef<HTMLHeadingElement>(null);
  const workspace = data?.workspace;
  const management = workspace?.management;
  const state = management?.state;
  const busy = loading || Boolean(error);
  const note = saved === 'name' ? '已更新 Workspace 名稱。'
    : saved === 'restore' && state === 'active' ? 'Workspace 已還原。'
    : saved === 'archive' && state === 'archived' ? 'Workspace 已封存。'
    : saved === 'archive' && state === 'archiving' ? '已開始封存，等待工作結束或資源回收。' : '';

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (state !== 'archiving' || loading || renaming || action) return;
    const timer = window.setInterval(() => { if (!document.hidden) retry(); }, 3000);
    return () => window.clearInterval(timer);
  }, [state, loading, renaming, action, retry]);

  async function save(change: Promise<ManagedWorkspace>, signal: AbortSignal) {
    try {
      const updated = await change;
      if (!signal.aborted) {
        updateData(() => updated);
        onAccessChanged();
      }
    } catch (cause) {
      if (!signal.aborted && cause instanceof ApiError && cause.status === 409) {
        retry();
        if (cause.code === 'stale_revision') throw new Error('Workspace 管理狀態已變更，正在重讀。請確認更新後的預覽，再送出。');
      }
      throw cause;
    }
  }

  return <section className="access-view workspace-detail" aria-labelledby="workspace-management-title">
    <header className="access-view-header">
      <div>
        <h1 id="workspace-management-title" ref={heading} tabIndex={-1}>{workspace?.name ?? 'Workspace 詳情'}</h1>
        {workspace ? <p className="access-subtitle identifier muted">{workspace.id}</p> : null}
      </div>
      <div className="action-row site-workspace-actions">
        <button type="button" className="button secondary" disabled={loading || renaming || Boolean(action)} onClick={retry}><RefreshIcon />重新載入</button>
        {workspace?.permissions.manageMembers ? <button type="button" className="button secondary" onClick={onMembers}><UsersIcon />管理成員</button> : null}
        {workspace?.permissions.manageTests && state !== 'archived' ? <button type="button" className="button quiet" onClick={onOpenWorkspace}>開啟工作台</button> : null}
      </div>
    </header>
    {error ? <Notice message={error} retry={retry} /> : null}
    {loading && !data ? <Loading text="正在載入 Workspace 詳情…" /> : null}
    <p className="access-note" role="status">{note}</p>
    {data && workspace && management ? <>
      <section className="workspace-management-panel" aria-labelledby="workspace-name-title">
        <header><h2 id="workspace-name-title">管理名稱</h2>
          {!renaming ? <button type="button" className="button secondary" disabled={busy} onClick={() => { setSaved(undefined); setRenaming(true); }}>變更名稱</button> : null}
        </header>
        {renaming ? <WorkspaceNameForm action="rename" initialName={workspace.name} disabled={busy} onCancel={() => setRenaming(false)} onAccessChanged={onAccessChanged}
          onSave={async (name, signal) => {
            await save(api.rename(workspaceId, management.revision, name, signal), signal);
            if (!signal.aborted) { setSaved('name'); setRenaming(false); }
          }} /> : <p className="muted">管理名稱會顯示在 Workspace 清單與工作台。驗測範圍及登入角色由 Workspace 設定提案管理。</p>}
      </section>
      <section className="workspace-management-panel archive-panel" aria-labelledby="workspace-archive-title">
        <header><h2 id="workspace-archive-title">Workspace 封存</h2>
          <span className={`chip ${state === 'archiving' ? 'warm' : state === 'archived' ? 'neutral' : 'ok'}`}>{stateLabels[management.state]}</span>
        </header>
        {management.archivedAt ? <p className="muted">封存完成於 {formatDate(management.archivedAt)}</p> : management.archiveStartedAt
          ? <p className="muted">封存開始於 {formatDate(management.archiveStartedAt)} · {management.archiveMode === 'drain' ? '等候工作結束' : '取消工作並等待回收'}</p> : null}
        <h3>封存影響</h3>
        <ImpactCounts impact={data.impact} />
        <p className="muted">各項計數可能涵蓋同一個工作。封存會停止接受新工作並取消排隊工作。</p>
        <div className="action-row site-workspace-actions">
          {canApply('archive', management) ? <button type="button" className="button danger-outline" disabled={busy || renaming} onClick={() => setAction('archive')}><ArchiveIcon />封存 Workspace</button> : null}
          {canApply('cancel', management) ? <button type="button" className="button danger-outline" disabled={busy || renaming} onClick={() => setAction('cancel')}>改為取消工作</button> : null}
          {canApply('restore', management) ? <button type="button" className="button secondary" disabled={busy || renaming} onClick={() => setAction('restore')}>還原 Workspace</button> : null}
        </div>
      </section>
      {action ? <ArchiveDialog action={action} data={data} loading={busy} onClose={() => setAction(undefined)} onAccessChanged={onAccessChanged}
        onConfirm={async (mode, signal) => {
          setSaved(undefined);
          const change = action === 'restore' ? api.restore(workspaceId, management.revision, signal) : api.archive(workspaceId, management.revision, mode, signal);
          await save(change, signal);
          if (signal.aborted) return;
          setSaved(action === 'restore' ? 'restore' : 'archive');
          setAction(undefined);
        }} /> : null}
    </> : null}
  </section>;
}

function ArchiveDialog({ action, data, loading, onClose, onConfirm, onAccessChanged }: {
  action: ArchiveAction;
  data: ManagedWorkspace;
  loading: boolean;
  onClose: () => void;
  onConfirm: (mode: WorkspaceArchiveMode, signal: AbortSignal) => Promise<void>;
  onAccessChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [mode, setMode] = useState<WorkspaceArchiveMode>(action === 'cancel' ? 'cancel' : 'drain');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const available = canApply(action, data.workspace.management);
  const restoring = action === 'restore';
  const title = restoring ? '還原 Workspace' : action === 'cancel' ? '取消執行中工作' : '封存 Workspace';

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    returnButton.current?.focus();
    return () => { request.current?.abort(); dialog?.close(); };
  }, []);

  async function confirm() {
    if (!available || loading || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try { await onConfirm(mode, controller.signal); }
    catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessChanged();
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <dialog ref={dialogRef} className="script-edit-dialog workspace-archive-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId}>「{data.workspace.name}」{restoring ? '還原後可依目前授權接受新工作，已取消的工作保留原狀態。'
      : action === 'cancel' ? '進行中的工作與瀏覽器租約將取消，資源回收後完成封存。'
      : '將停止接受新工作並取消排隊工作，保留成員、版本及報告。'}</p>
    {!restoring ? <ImpactCounts impact={data.impact} /> : null}
    {!available ? <Notice message="目前狀態已更新，請關閉視窗後查看可用操作。" /> : error ? <Notice message={error} /> : null}
    <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      {action === 'archive' ? <fieldset className="workspace-archive-modes" disabled={busy || loading || !available}>
        <legend>執行中工作與既有租約</legend>
        <label><input type="radio" name="mode" value="drain" checked={mode === 'drain'} onChange={() => setMode('drain')} />等候結束</label>
        <label><input type="radio" name="mode" value="cancel" checked={mode === 'cancel'} onChange={() => setMode('cancel')} />取消並等待回收</label>
      </fieldset> : null}
      <div className="action-row site-workspace-actions">
        <button type="button" className="button secondary" ref={returnButton} disabled={busy} onClick={onClose}>返回</button>
        <button type="submit" className={`button ${restoring ? 'primary' : 'danger-button'}`} disabled={busy || loading || !available}>
          {busy ? '送出中…' : restoring ? '確認還原' : action === 'cancel' ? '確認取消工作' : '確認封存'}
        </button>
      </div>
    </form>
  </dialog>;
}
