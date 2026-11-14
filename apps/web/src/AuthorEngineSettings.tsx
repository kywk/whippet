import type { AuthorEngine } from './types';

interface Props {
  current: AuthorEngine;
  selected: AuthorEngine;
  disabled: boolean;
  busy: boolean;
  onSelect: (engine: AuthorEngine) => void;
  onSave: () => void;
}

export function AuthorEngineSettings({ current, selected, disabled, busy, onSelect, onSave }: Props) {
  const locked = disabled || busy;
  return <form className="workspace-snapshot" aria-label="AI 撰寫引擎設定" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (!locked && selected !== current) onSave(); }}>
    <fieldset className="settings-fieldset" disabled={locked}>
      <legend>AI 撰寫引擎</legend>
      <p className="settings-meta">目前：{current === 'external' ? '外部 Agent' : '內建引擎'}</p>
      <label className="settings-field"><input type="radio" name="author-engine" value="builtin" checked={selected === 'builtin'} onChange={() => onSelect('builtin')} /> 內建引擎</label>
      <label className="settings-field"><input type="radio" name="author-engine" value="external" checked={selected === 'external'} onChange={() => onSelect('external')} /> 外部 Agent</label>
      <p className="inline-hint">外部 Agent 支援一般 Test 與 Module 產稿、Use Case Plan 提案與確認後的 Stage 產稿、Workspace 訪談，以及一般 Test、Module、Use Case 整批驗收摘要。Plan、Workspace 網站範圍與發佈仍須由你確認；未確認範圍的訪談只能處理文字。設定只影響後續新 Run，既有 Run 沿建立時的引擎快照繼續。</p>
      <button className="button secondary compact" type="submit" disabled={selected === current}>{busy ? '儲存中…' : '儲存引擎設定'}</button>
    </fieldset>
  </form>;
}
