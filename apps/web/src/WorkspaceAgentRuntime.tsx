import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import { Notice } from './components';
import { AGENT_RUNTIME_SKILLS } from './types';
import type { AgentRuntimeProfile, AgentRuntimeSelection, AgentRuntimeSkill, WhippetApi, WorkspaceAgentRuntime } from './types';

const skillLabels: Record<AgentRuntimeSkill, string> = {
  'test-author': '測試產稿', 'workspace-author': 'Workspace 訪談', 'acceptance-summary': '驗收摘要',
  'module-authoring': 'Module 產稿', 'usecase-planner': 'Use Case 規劃',
};
const conflictMessage = 'Workspace 設定版本已變更，本次未儲存。已保留你的選擇；請檢視目前設定，再決定採用目前設定或保留選擇繼續編輯。';

function sameSelection(a: AgentRuntimeSelection, b: AgentRuntimeSelection) {
  return a.profileId === b.profileId && AGENT_RUNTIME_SKILLS.every((skill) => a.skillProfiles[skill] === b.skillProfiles[skill]);
}

function ProfileDetails({ id, profiles }: { id: string; profiles: AgentRuntimeProfile[] }) {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) return <p className="blocked-hint">Profile「{id}」目前不可用，請明確選擇後端提供的 profile；不會自動替換。</p>;
  return <dl className="workspace-snapshot-meta runtime-profile-details">
    <div><dt>有效 profile</dt><dd>{id}</dd></div>
    <div><dt>模型迴圈</dt><dd>{profile.engine === 'builtin' ? 'builtin（內建）' : 'vercel（Vercel AI SDK）'}</dd></div>
    <div><dt>Provider</dt><dd>{profile.provider || '沿用主 skill'}</dd></div>
    <div><dt>Model</dt><dd>{profile.model || '沿用主 skill'}</dd></div>
    <div><dt>推理強度</dt><dd>{profile.reasoningEffort || '沿用主 skill'}</dd></div>
  </dl>;
}

function ProfileOptions({ selected, profiles }: { selected: string; profiles: AgentRuntimeProfile[] }) {
  return <>
    {selected && !profiles.some((profile) => profile.id === selected) ? <option value={selected} disabled>{selected}（目前不可用）</option> : null}
    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id} · {profile.engine}</option>)}
  </>;
}

interface Editor {
  current?: WorkspaceAgentRuntime;
  draft?: AgentRuntimeSelection;
  review: boolean;
  error?: string;
  readError?: string;
  note?: string;
}
interface Props {
  api: WhippetApi;
  workspaceId: string;
  workspaceRevision: number;
  active: boolean;
  blocked: boolean;
  onRefresh: () => Promise<void>;
  onGuardChange: (state: { dirty: boolean; busy: boolean }) => void;
}

export function WorkspaceAgentRuntime({ api, workspaceId, workspaceRevision, active, blocked, onRefresh, onGuardChange }: Props) {
  const [editor, setEditor] = useState<Editor>({ review: false });
  const [pending, setPending] = useState<'loading' | 'saving'>();
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const feedback = useRef<HTMLDivElement | null>(null);
  const { current, draft, review } = editor;
  const dirty = Boolean(current && draft && !sameSelection(current.selection, draft));

  const applyRead = useCallback((next: WorkspaceAgentRuntime, issue?: string) => {
    setEditor((previous) => {
      const changed = previous.current && previous.draft && !sameSelection(previous.current.selection, previous.draft);
      const needsReview = previous.review || Boolean(issue) || Boolean(changed && previous.current?.revision !== next.revision);
      return {
        current: next,
        draft: previous.draft && (changed || needsReview) ? previous.draft : next.selection,
        review: needsReview,
        error: issue ?? (needsReview ? previous.error ?? conflictMessage : undefined),
        note: needsReview ? undefined : previous.note,
      };
    });
  }, []);

  const reload = useCallback(async () => {
    if (!api.getWorkspaceAgentRuntime || lock.current) return;
    lock.current = true;
    const controller = new AbortController(); request.current = controller;
    setPending('loading');
    try {
      const next = await api.getWorkspaceAgentRuntime(workspaceId, controller.signal);
      if (!controller.signal.aborted) applyRead(next);
    } catch (cause) {
      if (!controller.signal.aborted) setEditor((previous) => ({ ...previous, readError: `無法讀取 runtime 設定。${errorMessage(cause)} 請重新載入後再儲存。` }));
    } finally {
      if (!controller.signal.aborted) { lock.current = false; setPending(undefined); }
    }
  }, [api, workspaceId, applyRead]);

  useEffect(() => { if (active) void reload(); }, [active, workspaceRevision, reload]);
  useEffect(() => () => { request.current?.abort(); lock.current = false; }, []);
  useEffect(() => {
    if (!pending && (editor.error || editor.readError)) feedback.current?.focus();
  }, [editor.error, editor.readError, pending]);
  useEffect(() => {
    onGuardChange({ dirty: dirty || review, busy: Boolean(pending) });
    return () => onGuardChange({ dirty: false, busy: false });
  }, [dirty, review, pending, onGuardChange]);

  const profiles = current?.profiles ?? [];
  const unavailable = Boolean(draft && [draft.profileId, ...Object.values(draft.skillProfiles)].some((id) => !profiles.some((profile) => profile.id === id)));
  const locked = blocked || Boolean(pending) || review || Boolean(editor.readError);

  function select(profileId: string, skill?: AgentRuntimeSkill) {
    if (locked || !draft || (profileId && !profiles.some((profile) => profile.id === profileId))) return;
    const next = { ...draft, skillProfiles: { ...draft.skillProfiles } };
    if (!skill) next.profileId = profileId;
    else if (profileId) next.skillProfiles[skill] = profileId;
    else delete next.skillProfiles[skill];
    setEditor((previous) => ({ ...previous, draft: next, error: undefined, note: undefined }));
  }

  async function save() {
    if (!api.updateWorkspaceAgentRuntime || !api.getWorkspaceAgentRuntime || !active || lock.current || locked || !dirty || unavailable || !current || !draft) return;
    lock.current = true;
    const controller = new AbortController(); request.current = controller;
    setPending('saving'); setEditor((previous) => ({ ...previous, error: undefined, note: undefined }));
    try {
      const next = await api.updateWorkspaceAgentRuntime(workspaceId, current.revision, draft, controller.signal);
      if (controller.signal.aborted) return;
      setEditor({ current: next, draft: next.selection, review: false, note: 'Runtime 設定已儲存，只影響新任務；既有 Run 與受控繼續沿用原 runtime。' });
      try { await onRefresh(); }
      catch { if (!controller.signal.aborted) setEditor((previous) => ({ ...previous, error: 'Runtime 已儲存，但 Workspace 同步失敗，請重新載入設定對話確認。' })); }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const issue = cause instanceof ApiError && cause.status === 409 ? conflictMessage
        : `Runtime 儲存失敗。${errorMessage(cause)} 選擇已保留；請先確認目前設定，不會自動重送。`;
      setEditor((previous) => ({ ...previous, review: true, error: issue }));
      // Re-read only. A second PATCH always requires the user's explicit review
      // decision followed by a separate Save, even if the first result is unknown.
      try {
        const next = await api.getWorkspaceAgentRuntime(workspaceId, controller.signal);
        if (!controller.signal.aborted) applyRead(next, issue);
      } catch (readCause) {
        if (!controller.signal.aborted) setEditor((previous) => ({ ...previous, readError: `最新設定尚未取得。${errorMessage(readCause)} 請重新載入。` }));
      }
    } finally {
      if (!controller.signal.aborted) { lock.current = false; setPending(undefined); }
    }
  }

  function resolveReview(keepDraft: boolean) {
    if (!current || pending || editor.readError || blocked) return;
    setEditor((previous) => ({ ...previous, draft: keepDraft ? previous.draft : current.selection, review: false, error: undefined, note: keepDraft ? '已保留你的選擇，尚未儲存；確認後請再按「儲存 runtime 設定」。' : '已採用目前設定。' }));
  }

  return <section className="workspace-agent-runtime" aria-labelledby="agent-runtime-title" aria-busy={Boolean(pending)}>
    <h3 id="agent-runtime-title">Agent runtime 設定</h3>
    <p className="inline-hint">選擇 Whippet Worker 的模型迴圈（builtin／vercel）。上方「AI 撰寫引擎」決定由平台或外部 Agent 接單；本設定不變更接單模式，也不控制外部 Agent 的模型。</p>
    <p className="settings-impact">只影響設定儲存後的新任務。既有 Run 與受控繼續沿用原 runtime；工具與預算仍依原 skill 快照。</p>
    {!api.getWorkspaceAgentRuntime || !api.updateWorkspaceAgentRuntime ? <p className="blocked-hint">此 API client 尚未提供 runtime 設定，請使用支援 M12 的版本。</p> : <>
      {pending ? <p role="status">{pending === 'saving' ? '正在儲存 runtime 設定…' : '正在讀取 runtime 設定…'}</p> : null}
      {editor.error || editor.readError ? <div ref={feedback} tabIndex={-1} className="runtime-feedback" role="group" aria-label="Runtime 設定需要處理">
        {editor.error ? <Notice message={editor.error} /> : null}
        {editor.readError ? <Notice message={editor.readError} /> : null}
      </div> : null}
      <button type="button" className="button quiet compact" disabled={Boolean(pending) || blocked} onClick={() => { void reload(); }}>重新載入 runtime 設定</button>
      {current && draft ? <>
        <p className="settings-meta">目前設定 revision {current.revision}{dirty ? ' · 有未儲存的選擇' : ''}</p>
        {review ? <div className="runtime-review" aria-label="目前 runtime 設定">
          <h4>目前設定（供比對）</h4>
          <dl className="workspace-snapshot-meta"><div><dt>Workspace 預設</dt><dd>{current.selection.profileId}</dd></div>
            {AGENT_RUNTIME_SKILLS.map((skill) => <div key={skill}><dt>{skillLabels[skill]}</dt><dd>{current.selection.skillProfiles[skill] ? `覆寫：${current.selection.skillProfiles[skill]}` : `繼承：${current.selection.profileId}`}</dd></div>)}
          </dl>
          <div className="action-row">
            <button type="button" className="button secondary compact" disabled={Boolean(pending) || Boolean(editor.readError) || blocked} onClick={() => resolveReview(false)}>採用目前設定</button>
            <button type="button" className="button secondary compact" disabled={Boolean(pending) || Boolean(editor.readError) || blocked} onClick={() => resolveReview(true)}>保留我的選擇並繼續編輯</button>
          </div>
        </div> : null}
        <form aria-label="Agent runtime 設定" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset className="settings-fieldset" disabled={locked}>
            <legend>{review ? '你尚未儲存的選擇' : '新任務使用的 runtime'}</legend>
            <label className="settings-field" htmlFor="runtime-default">Workspace 預設 profile</label>
            <select id="runtime-default" className="text-input" value={draft.profileId} aria-invalid={!profiles.some((profile) => profile.id === draft.profileId)} onChange={(event) => select(event.target.value)}>
              <ProfileOptions selected={draft.profileId} profiles={profiles} />
            </select>
            <ProfileDetails id={draft.profileId} profiles={profiles} />
            <p className="inline-hint">內建 builtin／vercel 的 provider、model 與推理強度沿用各主 skill；空白描述代表繼承，不是設定遺失。下列為目前選擇儲存後的有效設定。</p>
            {AGENT_RUNTIME_SKILLS.map((skill) => {
              const override = draft.skillProfiles[skill] ?? '';
              const effective = override || draft.profileId;
              return <div key={skill} className="runtime-skill">
                <label className="settings-field" htmlFor={`runtime-${skill}`}>{skillLabels[skill]} · {skill}</label>
                <select id={`runtime-${skill}`} className="text-input" value={override} aria-invalid={!profiles.some((profile) => profile.id === effective)} onChange={(event) => select(event.target.value, skill)}>
                  <option value="">繼承 Workspace 預設（{draft.profileId}）</option>
                  <ProfileOptions selected={override} profiles={profiles} />
                </select>
                <p className="settings-meta">{override ? '此 skill 覆寫' : '繼承 Workspace 預設'}</p>
                <ProfileDetails id={effective} profiles={profiles} />
              </div>;
            })}
            {unavailable ? <p className="blocked-hint">選擇包含目前不可用的 profile，修正後才能儲存；現有設定未被替換。</p> : null}
            <button className="button secondary compact" type="submit" disabled={!dirty || unavailable}>{pending === 'saving' ? '儲存中…' : '儲存 runtime 設定'}</button>
          </fieldset>
        </form>
      </> : null}
      {editor.note ? <p role="status" className="inline-hint">{editor.note}</p> : null}
    </>}
  </section>;
}
