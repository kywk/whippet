import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, resolveReportUrl } from './api';
import { formatDate, Loading, Notice, ReportLink, StatusBadge } from './components';
import { useResource } from './hooks';
import { ConversationPanel } from './ConversationPanel';
import { isActiveRun } from './types';
import type { Draft, Run, Version, WhippetApi } from './types';

interface Props {
  api: WhippetApi;
  apiBase: string;
  testId: string;
  runs: Run[];
  onRun: (run: Run) => void;
  onPublished: (version: Version) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRefreshRuns: () => void;
}

export function DraftEditor(props: Props) {
  const load = useCallback((signal: AbortSignal) => props.api.getDraft(props.testId, signal), [props.api, props.testId]);
  const resource = useResource(load);
  return <section className="draft-section" aria-labelledby="draft-title">
    <h3 id="draft-title">草稿編輯</h3>
    {resource.loading ? <Loading text="正在載入草稿…" /> : null}
    {resource.error ? <Notice message={resource.error} retry={resource.retry} /> : null}
    {resource.data ? <DraftForm {...props} initial={resource.data} /> : null}
  </section>;
}

function DraftForm({ api, apiBase, testId, initial, runs, onRun, onPublished, onDirtyChange, onRefreshRuns }: Props & { initial: Draft }) {
  const [draft, setDraft] = useState(initial);
  const [script, setScript] = useState(initial.script);
  const [busy, setBusy] = useState<'save' | 'validate' | 'publish' | 'reload'>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloadWarning, setReloadWarning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qualificationFresh, setQualificationFresh] = useState(true);
  const actionLock = useRef(false);
  const actionController = useRef<AbortController | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const dirty = script !== draft.script;
  const editorState = useRef({ draft, script, busy });
  editorState.current = { draft, script, busy };
  const synchronizeDraft = useCallback((next: Draft) => {
    const current = editorState.current;
    const changed = next.revision !== current.draft.revision || next.script !== current.draft.script;
    setConfirmed(false);
    if (changed && (current.script !== current.draft.script || current.busy)) {
      setConflict(true); setQualificationFresh(false);
      setError('AI 完成後 Server 草稿已變更；目前本機編輯已保留，請先檢視對照，再決定是否重新載入。');
      return;
    }
    setDraft(next); setQualificationFresh(true); setConflict(false); setError(undefined);
    if (changed) {
      setScript(next.script);
      setMessage(`已同步 AI 完成後的草稿 revision ${next.revision}，仍需驗證與人工確認發佈。`);
    }
  }, []);
  const useCandidate = useCallback((candidate: string): boolean => {
    const current = editorState.current;
    if (current.busy) return false;
    if (current.script !== current.draft.script && !window.confirm('帶入候選腳本會取代目前未儲存內容。請先複製需要保留的內容，確定繼續？')) return false;
    setScript(candidate); setConfirmed(false);
    setMessage('候選腳本已帶入編輯器，尚未儲存。請檢視、儲存並重新驗證。');
    return true;
  }, []);
  // 請求中的變更也應受導覽保護，避免切頁後誤認 POST 未送出。
  const guarded = dirty || Boolean(busy);

  useEffect(() => {
    onDirtyChange(guarded);
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    if (guarded) window.addEventListener('beforeunload', beforeUnload);
    return () => {
      onDirtyChange(false);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [guarded, onDirtyChange]);
  useEffect(() => () => actionController.current?.abort(), []);

  const validation = runs.find((run) => run.id === draft.validationRunId);
  const completedValidation = validation && !isActiveRun(validation) ? `${validation.id}:${validation.status}:${validation.reportUrl ?? ''}` : '';
  const savedRevision = draft.revision;
  const savedScript = draft.script;
  useEffect(() => {
    if (!completedValidation && syncRevision === 0) return;
    const controller = new AbortController();
    setSyncing(true);
    api.getDraft(testId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        if (next.revision !== savedRevision || next.script !== savedScript) {
          setConflict(true);
          setQualificationFresh(false);
          setConfirmed(false);
          setError('Server 草稿已變更，目前編輯內容已保留。請重新載入並確認最新 revision。');
        } else {
          setDraft(next);
          setQualificationFresh(true);
          setConfirmed(false);
          setError(undefined);
        }
        setSyncing(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(`無法同步草稿驗證資格，請重新整理驗證狀態。${errorMessage(cause)}`);
        setQualificationFresh(false);
        setConfirmed(false);
        setSyncing(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, savedRevision, savedScript, completedValidation, syncRevision]);

  const report = resolveReportUrl(draft.reportUrl, apiBase, window.location.href);
  const validating = validation ? isActiveRun(validation) : Boolean(draft.validationStatus && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(draft.validationStatus));
  const eligible = !dirty && !conflict && !syncing && qualificationFresh && draft.validationStatus === 'succeeded' && Boolean(draft.validationRunId && report);

  async function perform(kind: NonNullable<typeof busy>, discard = false) {
    if (actionLock.current) return;
    if (kind === 'reload' && dirty && !discard) { setReloadWarning(true); return; }
    if ((kind === 'validate' && (dirty || conflict || !script.trim())) || (kind === 'publish' && (!eligible || !confirmed))) return;
    actionLock.current = true;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(kind); setError(undefined); setMessage(undefined);
    try {
      if (kind === 'save' || kind === 'reload') {
        const next = kind === 'save' ? await api.saveDraft(testId, draft.revision, script, controller.signal) : await api.getDraft(testId, controller.signal);
        if (controller.signal.aborted) return;
        setDraft(next); setScript(next.script); setConflict(false); setReloadWarning(false); setConfirmed(false);
        setQualificationFresh(true);
        setMessage(kind === 'save' ? `已儲存 revision ${next.revision}。` : `已載入 revision ${next.revision}。`);
      } else if (kind === 'validate') {
        const run = await api.validateDraft(testId, draft.revision, controller.signal);
        if (controller.signal.aborted) return;
        setDraft((current) => ({ ...current, validationRunId: run.id, validationStatus: run.status, reportUrl: undefined }));
        setQualificationFresh(false);
        setConfirmed(false); onRun(run);
        setMessage(`revision ${draft.revision} 已送出驗證，進度與取消操作可在執行紀錄查看。`);
      } else {
        const version = await api.publishTest(testId, draft.revision, controller.signal);
        if (controller.signal.aborted) return;
        setConfirmed(false); onPublished(version);
        setMessage(`已發佈 revision ${version.revision}，版本 ${version.id}。`);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setConfirmed(false); }
      const uncertain = kind === 'validate' || kind === 'publish' ? ' 請先重新整理紀錄確認結果，再決定是否重送。' : '';
      setError(`${errorMessage(cause)}${uncertain}`);
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      actionLock.current = false;
    }
  }

  return <>
    <ConversationPanel api={api} apiBase={apiBase} testId={testId} draft={draft} draftDirty={dirty} draftBusy={Boolean(busy) || syncing || conflict} runs={runs} onRun={onRun} onRefreshRuns={onRefreshRuns} onSynchronized={synchronizeDraft} onUseCandidate={useCandidate} />
    <div className="draft-meta"><span>revision {draft.revision}{dirty ? ' · 有未儲存變更' : ' · 已儲存'}</span><span>更新：{formatDate(draft.updatedAt)}</span></div>
    <label className="field-label" htmlFor="draft-script">Playwright TypeScript 腳本</label>
    <textarea id="draft-script" className="script-editor" rows={16} value={script} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={Boolean(busy)} onChange={(event) => { setScript(event.target.value); setConfirmed(false); setMessage(undefined); }} aria-describedby="draft-help" />
    <p id="draft-help" className="inline-hint">先儲存，再驗證目前 revision。修改腳本後，必須重新儲存並驗證，才可發佈。</p>
    <div className="action-row">
      <button className="button secondary" disabled={Boolean(busy) || !dirty || conflict} onClick={() => perform('save')}>{busy === 'save' ? '儲存中…' : '儲存草稿'}</button>
      <button className="button secondary" disabled={Boolean(busy) || dirty || conflict || validating || !script.trim()} onClick={() => perform('validate')}>{busy === 'validate' ? '送出中…' : validating ? '驗證進行中' : '驗證此 revision'}</button>
      <button className="button quiet" disabled={Boolean(busy)} onClick={() => perform('reload')}>重新載入草稿</button>
    </div>
    {conflict ? <Notice message="目前 revision 或驗證資格已過期（409），不會自動覆寫 Server。編輯內容仍保留在上方；可先複製，再重新載入最新草稿。" /> : null}
    {reloadWarning ? <div className="confirmation-panel"><p>重新載入會放棄目前未儲存內容，請先複製需要保留的腳本。</p><div className="action-row">
      <button className="button secondary" disabled={Boolean(busy)} onClick={() => perform('reload', true)}>確定放棄並重新載入</button>
      <button className="button quiet" disabled={Boolean(busy)} onClick={() => setReloadWarning(false)}>繼續編輯</button>
    </div></div> : null}
    {error ? <Notice message={error} /> : null}
    {message ? <p className="action-message" role="status">{message}</p> : null}
    <div className="publish-panel">
      <div className="section-heading"><h4>驗證與發佈</h4><button className="button quiet compact" disabled={Boolean(busy) || syncing} onClick={() => setSyncRevision((value) => value + 1)}>{syncing ? '同步中…' : '重新整理驗證狀態'}</button></div>
      <div className="validation-summary">
        {validation ? <StatusBadge status={validation.status} /> : draft.validationStatus ? <StatusBadge status={draft.validationStatus} /> : <span className="muted">尚未驗證目前 revision</span>}
        <ReportLink reportUrl={draft.reportUrl} apiBase={apiBase} label="查看草稿驗證報告" />
      </div>
      {validation?.error ? <pre className="run-error">{validation.error}</pre> : null}
      <p className="inline-hint">{dirty ? '目前有未儲存變更，上方驗證結果只對應已儲存腳本。' : eligible ? '目前 revision 驗證通過且報告就緒。請先檢視報告，再明確確認發佈。' : '需目前 revision 驗證通過、報告就緒，且沒有未儲存變更，才可發佈。'}</p>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={!eligible || Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} />我已檢視驗證報告，確認發佈 revision {draft.revision}</label>
      <button className="button primary" disabled={!eligible || !confirmed || Boolean(busy)} onClick={() => perform('publish')}>{busy === 'publish' ? '發佈中…' : `確認發佈 revision ${draft.revision}`}</button>
    </div>
  </>;
}
