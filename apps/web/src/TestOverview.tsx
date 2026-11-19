import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from './api';
import { capabilityReason, scriptOriginLabel } from './capabilities';
import { formatDate, Loading, Notice } from './components';
import { AlertIcon, CloseIcon, LockIcon, PlusIcon } from './icons';
import { ScriptNotesDialog } from './ScriptNotesDialog';
import { MAX_TEST_TAGS, parseTagInput } from './tags';
import { VersionMarkdown } from './VersionMarkdown';
import type { Test, TestMetadataPatch, Version, WorkspaceCapability } from './types';

interface Props {
  test?: Test;
  version?: Version;
  loading: boolean;
  executionCapability?: WorkspaceCapability;
  onRefreshVersions: () => void;
  runHistory: ReactNode;
  versionHistory: ReactNode;
  tags: string[];
  workspaceTags: string[];
  onSaveMetadata: (patch: TestMetadataPatch, signal: AbortSignal) => Promise<void>;
}

export function TestOverview({ test, version, loading, executionCapability, onRefreshVersions, runHistory, versionHistory, tags, workspaceTags, onSaveMetadata }: Props) {
  const [tagInput, setTagInput] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [tagError, setTagError] = useState<string>();
  const tagRequest = useRef<AbortController | null>(null);
  const [notes, setNotes] = useState<{ version: Version; metadataRevision: number }>();
  const metadataRevision = test?.metadataRevision;
  const aiTags = version?.suggestedTags?.filter((tag) => !tags.includes(tag)) ?? [];
  const suggestions = workspaceTags.filter((tag) => !tags.includes(tag) && !aiTags.includes(tag));
  const atLimit = tags.length >= MAX_TEST_TAGS;
  const canEditTags = Boolean(metadataRevision) && !savingTags;
  const published = Boolean(test?.publishedVersionId);
  useEffect(() => () => tagRequest.current?.abort(), []);

  async function saveTags(next: string[], clearInput = false) {
    if (!metadataRevision || tagRequest.current) return;
    if (next.length > MAX_TEST_TAGS) {
      setTagError(`每個測試最多可設定 ${MAX_TEST_TAGS} 個標籤。`);
      return;
    }
    if (next.length === tags.length) {
      if (clearInput) setTagInput('');
      setTagError(undefined);
      return;
    }
    const controller = new AbortController();
    tagRequest.current = controller;
    setSavingTags(true);
    setTagError(undefined);
    try {
      await onSaveMetadata({ metadataRevision, tags: next }, controller.signal);
      if (clearInput && !controller.signal.aborted) setTagInput('');
    } catch (cause) {
      if (!controller.signal.aborted) setTagError(cause instanceof ApiError && cause.status === 409
        ? '標籤或測試資訊已更新，請確認最新內容後再操作。' : errorMessage(cause));
    } finally {
      tagRequest.current = null;
      if (!controller.signal.aborted) setSavingTags(false);
    }
  }

  function addTags(added: string[], clearInput = false) {
    void saveTags([...new Set([...tags, ...added])], clearInput);
  }

  return <div className="overview-frame">
    <div className="overview-main">
      <section className="overview-summary" aria-labelledby="version-description-title">
        <div className="overview-summary-heading">
          <h2 id="version-description-title">腳本說明</h2>
          {version ? <div className="overview-summary-actions">
            <div className="overview-release"><span>目前正式版本</span><strong className="overview-revision mono">revision {version.revision}</strong></div>
            {!loading && metadataRevision ? <button type="button" className="button quiet compact" aria-haspopup="dialog" disabled={savingTags}
              onClick={() => setNotes({ version, metadataRevision })}>編輯說明與背景</button> : null}
          </div> : null}
        </div>
        <div className="overview-description">
          {loading ? <Loading text="正在載入測試資訊…" /> : version ? <>
            <VersionMarkdown text={version.description?.trim() || '此版本尚無說明。'} />
            {version.backgroundSummary?.trim() ? <details className="version-background"><summary>版本背景摘要</summary><p className="summary-content">{version.backgroundSummary}</p></details> : null}
          </> : published ? <Notice message="目前無法載入正式版本。" retry={onRefreshVersions} retryLabel="重新整理版本" />
            : <p className="muted">{test?.description?.trim() || '在對話中描述測試步驟與預期結果。'}</p>}
        </div>
        {version ? <div className="overview-release-meta">
          <p className="overview-release-time"><span>發佈時間</span><time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time></p>
          {executionCapability?.available !== true ? <p id="formal-execution-reason" className="overview-execution-note"><AlertIcon /><span>{capabilityReason(executionCapability)}</span></p> : null}
        </div> : null}
      </section>
      {runHistory}
    </div>

    <aside className="overview-side" aria-label="標籤、腳本與版本">
      <section className="test-tags-section" aria-labelledby="test-tags-title">
        <div className="section-heading"><h2 id="test-tags-title">標籤</h2></div>
        <div className="tag-editor">
          {tags.length ? <div className="tag-list" aria-label="已設定的標籤">
            {tags.map((tag) => <span key={tag} className="tag-pill">
              <span>#{tag}</span>
              <button type="button" className="tag-remove" aria-label={`移除標籤 ${tag}`} disabled={!canEditTags}
                onClick={() => { void saveTags(tags.filter((value) => value !== tag)); }}><CloseIcon /></button>
            </span>)}
          </div> : null}
          <form className="tag-form" onSubmit={(event) => { event.preventDefault(); addTags(parseTagInput(tagInput), true); }}>
            <input type="text" className="text-input tag-input" value={tagInput} maxLength={32} disabled={!canEditTags || atLimit}
              placeholder="輸入標籤" aria-label="新增測試標籤" onChange={(event) => setTagInput(event.target.value)} />
            <button type="submit" className="button secondary" disabled={!canEditTags || atLimit || !parseTagInput(tagInput).length}><PlusIcon />新增標籤</button>
          </form>
          {atLimit ? <p className="inline-hint">每個測試最多可設定 {MAX_TEST_TAGS} 個標籤。</p> : null}
          {aiTags.length ? <div className="tag-suggestions" role="group" aria-label="AI 建議標籤">
            <span className="muted">AI 建議</span>
            {aiTags.map((tag) => <button key={tag} type="button" className="tag-suggestion" disabled={!canEditTags || atLimit}
              aria-label={`採用 AI 建議標籤 ${tag}`} onClick={() => addTags([tag])}>+ #{tag}</button>)}
          </div> : null}
          {suggestions.length ? <div className="tag-suggestions" role="group" aria-label="Workspace 常用標籤">
            {suggestions.map((tag) => <button key={tag} type="button" className="tag-suggestion" disabled={!canEditTags || atLimit}
              onClick={() => addTags([tag])}>+ #{tag}</button>)}
          </div> : null}
          {savingTags ? <p className="inline-hint" role="status">正在儲存標籤…</p> : null}
          {tagError ? <Notice message={tagError} /> : null}
        </div>
      </section>
      {version ? <section className="published-script-section" aria-labelledby="published-script-title">
        <div className="section-heading"><h2 id="published-script-title">腳本內容</h2><span className="overview-readonly"><LockIcon />唯讀</span></div>
        <p className="script-version-label">{scriptOriginLabel(version.scriptOrigin)}</p>
        <textarea className="overview-code" aria-label="正式版本腳本（唯讀）" readOnly spellCheck={false} rows={8} value={version.script} />
      </section> : null}
      {versionHistory}
    </aside>
    {notes ? <ScriptNotesDialog version={notes.version} metadataRevision={notes.metadataRevision} onSave={onSaveMetadata} onClose={() => setNotes(undefined)} /> : null}
  </div>;
}
