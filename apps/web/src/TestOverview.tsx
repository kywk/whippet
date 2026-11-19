import { useState } from 'react';
import type { ReactNode } from 'react';
import { capabilityReason, scriptOriginLabel } from './capabilities';
import { formatDate, Loading, Notice } from './components';
import { AlertIcon, CloseIcon, LockIcon, PlusIcon } from './icons';
import { VersionMarkdown } from './VersionMarkdown';
import type { Test, Version, WorkspaceCapability } from './types';

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
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}

export function TestOverview({ test, version, loading, executionCapability, onRefreshVersions, runHistory, versionHistory, tags, workspaceTags, onAddTag, onRemoveTag }: Props) {
  const [tagInput, setTagInput] = useState('');
  const suggestions = workspaceTags.filter((tag) => !tags.includes(tag));
  const published = Boolean(test?.publishedVersionId);

  function submitTag() {
    if (!tagInput.trim()) return;
    onAddTag(tagInput);
    setTagInput('');
  }

  return <div className="overview-frame">
    <div className="overview-main">
      <section className="overview-summary" aria-labelledby="version-description-title">
        <div className="overview-summary-heading">
          <h2 id="version-description-title">腳本說明</h2>
          {version ? <div className="overview-release"><span>目前正式版本</span><strong className="overview-revision mono">revision {version.revision}</strong></div> : null}
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
              <button type="button" className="tag-remove" aria-label={`移除標籤 ${tag}`} onClick={() => onRemoveTag(tag)}><CloseIcon /></button>
            </span>)}
          </div> : null}
          <form className="tag-form" onSubmit={(event) => { event.preventDefault(); submitTag(); }}>
            <input type="text" className="text-input tag-input" value={tagInput} maxLength={32} placeholder="輸入標籤" aria-label="新增測試標籤" onChange={(event) => setTagInput(event.target.value)} />
            <button type="submit" className="button secondary" disabled={!tagInput.trim()}><PlusIcon />新增標籤</button>
          </form>
          {suggestions.length ? <div className="tag-suggestions" role="group" aria-label="Workspace 常用標籤">
            {suggestions.map((tag) => <button key={tag} type="button" className="tag-suggestion" onClick={() => onAddTag(tag)}>+ #{tag}</button>)}
          </div> : null}
        </div>
      </section>
      {version ? <section className="published-script-section" aria-labelledby="published-script-title">
        <div className="section-heading"><h2 id="published-script-title">腳本內容</h2><span className="overview-readonly"><LockIcon />唯讀</span></div>
        <p className="script-version-label">{scriptOriginLabel(version.scriptOrigin)}</p>
        <textarea className="overview-code" aria-label="正式版本腳本（唯讀）" readOnly spellCheck={false} rows={8} value={version.script} />
      </section> : null}
      {versionHistory}
    </aside>
  </div>;
}
