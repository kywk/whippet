import { useEffect, useRef, useState } from 'react';
import { createLiveOfferHistory, createLiveSession } from './live';
import type { LiveMode, LiveState } from './live';
import { isActiveRun } from './types';
import type { Run } from './types';
import { runKindLabel } from './components';

export function LiveView({ run, apiBase, onClose }: { run: Run; apiBase: string; onClose: () => void }) {
  return <Viewer target={{ kind: 'run', run }} apiBase={apiBase} onClose={onClose} />;
}

export function SessionLiveView({ sessionId, leaseId, apiBase, onClose }: { sessionId: string; leaseId: string; apiBase: string; onClose: () => void }) {
  return <Viewer target={{ kind: 'session', sessionId, leaseId }} apiBase={apiBase} onClose={onClose} />;
}

type Target = { kind: 'run'; run: Run } | { kind: 'session'; sessionId: string; leaseId: string };

function Viewer({ target, apiBase, onClose }: { target: Target; apiBase: string; onClose: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LiveState>({ phase: 'connecting', mode: 'webrtc' });
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const session = useRef<ReturnType<typeof createLiveSession> | null>(null);
  const preferredMode = useRef<LiveMode>('webrtc');
  const offerHistory = useRef<ReturnType<typeof createLiveOfferHistory> | null>(null);
  if (!offerHistory.current) offerHistory.current = createLiveOfferHistory();
  const runRef = useRef<Run | undefined>(target.kind === 'run' ? target.run : undefined);
  runRef.current = target.kind === 'run' ? target.run : undefined;
  const runId = target.kind === 'run' ? target.run.id : undefined;
  const sessionId = target.kind === 'session' ? target.sessionId : undefined;
  const leaseId = target.kind === 'session' ? target.leaseId : undefined;
  const active = target.kind === 'session' || isActiveRun(target.run);

  useEffect(() => {
    if (!active || !enabled) {
      setState({ phase: active ? 'idle' : 'ended', mode: preferredMode.current, reason: active ? '已停止監看。瀏覽器租約仍會繼續。' : 'Run 已結束，監看資源已釋放；可繼續查看任務結果。' });
      return;
    }
    if (!video.current || !image.current) return;
    const controller = createLiveSession({
      runId, browserSession: sessionId && leaseId ? { sessionId, leaseId } : undefined,
      apiBase, video: video.current, image: image.current, initialMode: preferredMode.current,
      waitingForAttempt: () => Boolean(runRef.current && ['queued', 'dispatched'].includes(runRef.current.status)),
      onChange(next) { preferredMode.current = next.mode; setState(next); },
      offerHistory: offerHistory.current!,
    });
    session.current = controller;
    return () => { controller.close(); if (session.current === controller) session.current = null; };
  }, [runId, sessionId, leaseId, apiBase, active, enabled, revision]);

  const label = state.sensitivePaused ? '敏感輸入暫停' : state.phase === 'streaming' ? state.mode === 'webrtc' ? '監看中：WebRTC' : '監看中：JPEG 備援'
    : ({ idle: '已停止監看', connecting: '監看連線中', waiting: '等待監看畫面', reconnecting: '監看重新連線中', paused: '監看已暫停', ended: '監看已結束', unavailable: '目前無法監看', error: '監看連線失敗' } as const)[state.phase];
  const controlsAvailable = enabled && active && !['ended', 'unavailable', 'error', 'paused'].includes(state.phase);
  function reconnect() { setEnabled(true); setRevision((value) => value + 1); }

  return <section className="live-panel" aria-labelledby="live-title">
    <div className="section-heading"><h3 id="live-title">唯讀監看</h3><button className="button quiet compact" onClick={onClose}>關閉監看面板</button></div>
    <p className="live-run">{target.kind === 'run' ? <>{runKindLabel(target.run)} · Run <span className="identifier">{target.run.id}</span></> : <>瀏覽器 session <span className="identifier">{target.sessionId.slice(0, 8)}</span></>}</p>
    <div className="live-status" role="status" aria-label="監看連線狀態" data-testid="live-status"><strong>{label}</strong>{state.reason ? <p>{state.reason}</p> : null}</div>
    <div className="live-media" data-transport={state.mode}>
      <video ref={video} autoPlay muted playsInline aria-label="WebRTC 唯讀監看畫面" data-testid="live-video" hidden={state.mode !== 'webrtc' || state.phase === 'paused' || !enabled || !active} />
      <img ref={image} alt="JPEG 備援唯讀監看畫面" data-testid="live-jpeg" hidden={state.mode !== 'jpeg' || state.phase === 'paused' || !enabled || !active} />
      {state.phase !== 'streaming' ? <p className="live-placeholder">{label}</p> : null}
    </div>
    <div className="action-row">
      <button className="button secondary" disabled={!active || state.sensitivePaused} onClick={reconnect}>重新連線</button>
      <button className="button secondary" disabled={!controlsAvailable || state.mode === 'jpeg'} onClick={() => session.current?.switchMode('jpeg')}>切換 JPEG 備援</button>
      <button className="button secondary" disabled={!controlsAvailable || state.mode === 'webrtc'} onClick={() => session.current?.switchMode('webrtc')}>嘗試 WebRTC</button>
      {state.needsPlay ? <button className="button primary" disabled={!controlsAvailable} onClick={() => session.current?.play()}>播放監看畫面</button> : null}
      <button className="button quiet" disabled={!enabled || !active} onClick={() => setEnabled(false)}>停止監看</button>
    </div>
    <p className="inline-hint">{target.kind === 'run' ? '僅觀看，不提供鍵盤或滑鼠控制。停止監看或影像中斷不會取消 Run；切換最新 Run 不會自動改變這個監看目標。' : '僅觀看，不提供鍵盤或滑鼠控制。停止或關閉監看不會關閉瀏覽器租約。'}</p>
  </section>;
}
