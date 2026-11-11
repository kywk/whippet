import { useCallback, useId, useState } from 'react';
import { resolveReportUrl } from './api';
import { Loading, Notice } from './components';
import { useResource } from './hooks';
import type { RunArtifact, WhippetApi } from './types';

interface Props {
  api: WhippetApi;
  apiBase: string;
  runId: string;
}

export function RunArtifacts({ api, apiBase, runId }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <div className="run-artifacts">
    <button className="button secondary compact" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>下載失敗證據</button>
    {open ? <section id={panelId} className="artifact-panel" aria-label={`Run ${runId} 的失敗證據附件`}>
      <h4>失敗證據附件</h4><p className="artifact-run identifier">Run {runId}</p>
      <ArtifactList api={api} apiBase={apiBase} runId={runId} />
    </section> : null}
  </div>;
}

function ArtifactList({ api, apiBase, runId }: Props) {
  const load = useCallback((signal: AbortSignal) => api.getRunArtifacts(runId, signal), [api, runId]);
  const result = useResource(load);
  const evidence = result.data?.filter((artifact) => /^data\/[0-9a-f]{40}\.(zip|md)$/.test(artifact.name));
  return <>
    <p className="artifact-help">Trace ZIP 請下載後，使用本機 Playwright Trace Viewer 開啟。Markdown 也會下載為檔案。</p>
    {result.loading ? <Loading text="正在載入失敗證據附件…" /> : null}
    {result.error ? <Notice message={result.error} retry={result.retry} retryLabel="重試載入附件" /> : null}
    {evidence?.length === 0 ? <p className="artifact-empty" role="status">未取得 ZIP／Markdown 失敗證據；請以此 Run 的執行狀態與報告判讀結果。</p> : null}
    {evidence?.length ? <ul className="artifact-list" aria-label="ZIP 與 Markdown 下載清單">{evidence.map((artifact) => <ArtifactDownload key={artifact.name} artifact={artifact} apiBase={apiBase} />)}</ul> : null}
    {result.data ? <div className="artifact-footer"><p className="inline-hint">只列已保存的附件；若執行尚未完成，可稍後手動重新載入。</p><button className="button quiet compact" disabled={result.loading} onClick={result.retry}>重新載入附件</button></div> : null}
  </>;
}

function ArtifactDownload({ artifact, apiBase }: { artifact: RunArtifact; apiBase: string }) {
  const zip = artifact.name.endsWith('.zip');
  const type = zip ? 'ZIP' : 'Markdown（MD）';
  const mime = artifact.contentType.split(';')[0].trim().toLowerCase();
  const validType = mime === (zip ? 'application/zip' : 'text/markdown');
  const href = resolveReportUrl(artifact.url, apiBase, window.location.href);
  const filename = artifact.name.slice(artifact.name.lastIndexOf('/') + 1);
  return <li>
    <div><p className="artifact-meta"><strong>{type}</strong><span>{formatSize(artifact.size)}</span></p><p className="artifact-name identifier">{artifact.name}</p></div>
    {href && validType ? <a className="report-link" href={href} download={filename} rel="noreferrer" aria-label={`下載 ${filename}`}>{zip ? '下載 ZIP' : '下載 MD'}</a>
      : <span className="artifact-invalid">{validType ? '下載連結無效' : '附件類型不符，無法下載'}</span>}
  </li>;
}

function formatSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  const unit = size < 1_048_576 ? 'KiB' : 'MiB';
  const value = size / (unit === 'KiB' ? 1_024 : 1_048_576);
  return `${value.toLocaleString('zh-TW', { maximumFractionDigits: 1 })} ${unit}`;
}
