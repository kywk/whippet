import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Notice } from './components';
import { isActiveRun } from './types';
import type { Run, WhippetApi } from './types';

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
