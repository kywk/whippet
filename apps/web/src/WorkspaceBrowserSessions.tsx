import { useEffect, useState } from 'react';
import { ApiError } from './api';
import { formatDate } from './components';
import { SessionLiveView } from './LiveView';
import type { BrowserSession, WhippetApi } from './types';

export function WorkspaceBrowserSessions({ api, apiBase, workspaceId, active }: { api: WhippetApi; apiBase: string; workspaceId: string; active: boolean }) {
  const [items, setItems] = useState<BrowserSession[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!active || !api.listBrowserSessions) {
      setItems([]); setSelected(undefined); setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setLoading(true);
      try {
        const next = await api.listBrowserSessions!(workspaceId, controller.signal);
        if (controller.signal.aborted) return;
        setItems(next);
        setSelected((id) => next.some((item) => item.sessionId === id && item.state === 'ready') ? id : undefined);
        setError(undefined);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setItems([]); setSelected(undefined);
        setError(cause instanceof ApiError && cause.status === 401 ? '管理 session 已失效，請重新登入。' : '無法取得瀏覽器 session 清單，請稍後重新載入。');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(load, 10_000);
        }
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, workspaceId, active, refresh]);

  const viewed = items.find((item) => item.sessionId === selected && item.state === 'ready');
  return <section className="workspace-browser-sessions" aria-labelledby="browser-sessions-title">
    <div className="section-heading"><h3 id="browser-sessions-title">瀏覽器 session</h3><button className="button quiet compact" disabled={!active || loading} onClick={() => setRefresh((value) => value + 1)}>重新載入</button></div>
    {!api.listBrowserSessions ? <p className="inline-hint">目前無法查看瀏覽器 session。</p> : null}
    {error ? <p className="blocked-hint" role="alert">{error}</p> : null}
    {active && !error && !loading && items.length === 0 ? <p className="inline-hint">目前沒有可列出的瀏覽器 session。</p> : null}
    {items.length ? <ul className="browser-session-list">{items.map((item) => <li key={item.sessionId}>
      <div><strong>Session <span className="identifier">{item.sessionId.slice(0, 8)}</span></strong><p className="settings-meta">{item.state === 'ready' ? '可監看' : '啟動中'} · 建立 {formatDate(item.createdAt)} · 截止 {formatDate(item.deadlineAt)}</p></div>
      {item.state === 'ready' ? <button className="button secondary compact" disabled={!active || selected === item.sessionId} onClick={() => setSelected(item.sessionId)}>開始監看</button> : null}
    </li>)}</ul> : null}
    {active && viewed ? <SessionLiveView key={`${viewed.sessionId}:${viewed.leaseId}`} sessionId={viewed.sessionId} leaseId={viewed.leaseId} apiBase={apiBase} onClose={() => setSelected(undefined)} /> : null}
    <p className="inline-hint">只顯示目前可列出的租約。離開此頁或關閉監看只會停止畫面，不會關閉瀏覽器租約。</p>
  </section>;
}
