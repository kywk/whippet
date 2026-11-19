import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { AssistantTurn, UserTurn } from './chat';
import { Loading, Notice } from './components';
import type { VersionConversationMessage, WhippetApi } from './types';

type Props = { api: WhippetApi; testId: string; versionId: string };

export function VersionConversation(props: Props) {
  const [opened, setOpened] = useState(false);
  return <details className="version-background version-conversation" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>查看對話歷程</summary>
    {opened ? <ConversationPages {...props} /> : null}
  </details>;
}

function ConversationPages({ api, testId, versionId }: Props) {
  const [messages, setMessages] = useState<VersionConversationMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async (after: string | null) => {
    if (pending.current && !pending.current.signal.aborted) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.getVersionConversation(testId, versionId, after, controller.signal);
      if (controller.signal.aborted) return;
      setMessages((current) => after === null ? page.messages : [...current, ...page.messages]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api, testId, versionId]);

  useEffect(() => {
    void load(null);
    return () => pending.current?.abort();
  }, [load]);

  return <>
    {messages.length ? <ol className="turns" role="list" aria-label="版本對話歷程">
      {messages.map((message) => message.role === 'user'
        ? <UserTurn key={message.id} message={message} />
        : <AssistantTurn key={message.id} time={message.createdAt}><p className="message-content">{message.content}</p></AssistantTurn>)}
    </ol> : !loading && !error ? <p className="muted">這次發佈的編輯週期沒有對話訊息。</p> : null}
    {loading ? <Loading text="正在載入對話歷程…" /> : null}
    {error ? <Notice message={error} retry={() => { void load(nextCursor); }} /> : null}
    {!loading && !error && nextCursor !== null ? <button className="button secondary compact" onClick={() => { void load(nextCursor); }}>載入更多訊息</button> : null}
  </>;
}
