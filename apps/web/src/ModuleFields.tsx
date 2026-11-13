import type { ModuleMetadata } from './types';

export const emptyModule = (slug: string): ModuleMetadata => ({ slug, moduleKind: 'step', exportName: '', signature: '', inputs: '', returns: '', preconditions: '', postconditions: '', harness: '' });
export function moduleProblem(module: ModuleMetadata, slug: string | undefined, script: string): string | undefined {
  if (!slug || module.slug !== slug) return '缺少或不符原 Module slug，請重新載入；不會猜測識別名稱。';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(module.exportName)) return '請填入有效的 exportName JavaScript 識別字。';
  if (!script.trim() || !module.harness.trim()) return '請填入 Module 本體與 Harness 驗證入口。';
  if ([script, module.harness].some(value => new TextEncoder().encode(value).length > 2 * 1024 * 1024)) return 'Module 本體與 Harness 各不得超過 2 MiB。';
}
export function ModuleFields({ value, disabled, onChange }: { value: ModuleMetadata; disabled: boolean; onChange: (value: ModuleMetadata) => void }) {
  const fields = [['exportName', '匯出名稱（exportName）'], ['signature', '函式簽章'], ['inputs', '輸入參數'], ['returns', '回傳值'], ['preconditions', '前置條件'], ['postconditions', '後置條件'], ['harness', 'Harness · Playwright 驗證入口']] as const;
  return <fieldset className="module-fields" disabled={disabled}>
    <legend>Module metadata 與 Harness</legend>
    <p className="inline-hint">slug：<code>{value.slug || '尚未取得'}</code>（建立後不可修改）。本體儲存於 lib/{value.slug}.ts；Harness 為 tests/test.spec.ts。修改後須重新驗證。</p>
    <label className="field-label" htmlFor="module-kind">模組類型</label>
    <select id="module-kind" value={value.moduleKind} onChange={event => onChange({ ...value, moduleKind: event.target.value as ModuleMetadata['moduleKind'] })}>
      <option value="setup">setup</option><option value="step">step</option><option value="page">page</option>
    </select>
    {fields.map(([key, label]) => <div key={key}>
      <label className="field-label" htmlFor={`module-${key}`}>{label}</label>
      <textarea id={`module-${key}`} className={key === 'harness' ? 'script-editor' : 'module-text'} rows={key === 'harness' ? 12 : 2} value={value[key]} spellCheck={false} onChange={event => onChange({ ...value, [key]: event.target.value })} />
    </div>)}
    <p className="inline-hint">以上內容與 Module 本體一起按「儲存草稿」才會送出；尚未儲存不會用於驗證。</p>
  </fieldset>;
}
