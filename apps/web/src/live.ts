export type LiveMode = 'webrtc' | 'jpeg';
export type LivePhase = 'idle' | 'connecting' | 'waiting' | 'streaming' | 'reconnecting' | 'paused' | 'ended' | 'unavailable' | 'error';

export interface LiveState {
  phase: LivePhase;
  mode: LiveMode;
  reason?: string;
  viewerId?: string;
  needsPlay?: boolean;
  retryAttempt?: number;
  sensitivePaused?: boolean;
}

export interface LiveOfferHistory {
  requireId: boolean;
  legacyAccepted: boolean;
  seenIds: Set<string>;
}

export function createLiveOfferHistory(): LiveOfferHistory {
  return { requireId: false, legacyAccepted: false, seenIds: new Set() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Options {
  runId: string;
  apiBase: string;
  video: HTMLVideoElement;
  image: HTMLImageElement;
  initialMode: LiveMode;
  waitingForAttempt: () => boolean;
  onChange: (state: LiveState) => void;
  offerHistory?: LiveOfferHistory;
}

export function liveSocketUrl(apiBase: string, runId: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const url = new URL(`${apiBase.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}/live`, page);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== page.origin) {
    throw new Error('即時監看需要同源 API，請使用 /api 代理。');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function parseIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) throw new Error('ICE 設定格式不符。');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('ICE 設定格式不符。');
    const server = item as Record<string, unknown>;
    if (!(typeof server.urls === 'string' || (Array.isArray(server.urls) && server.urls.every((url: unknown) => typeof url === 'string')))) throw new Error('ICE 設定格式不符。');
    if ((server.username != null && typeof server.username !== 'string') || (server.credential != null && typeof server.credential !== 'string')) throw new Error('ICE 設定格式不符。');
    return { urls: server.urls as string | string[], username: server.username as string | undefined, credential: server.credential as string | undefined };
  });
}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new DOMException('已停止協商', 'AbortError')); };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, 8_000);
    function cleanup() { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', abort); }
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else changed();
  });
}

// 一個 controller 只屬於一個被使用者選定的 Run；沒有任何 Run 建立／取消操作。
export function createLiveSession(options: Options) {
  const { video, image } = options;
  const offerHistory = options.offerHistory ?? createLiveOfferHistory();
  let disposed = false;
  let halted = false;
  let suspended = document.hidden;
  let mode = options.initialMode;
  let state: LiveState = { phase: 'connecting', mode };
  let socket: WebSocket | undefined;
  let peer: RTCPeerConnection | undefined;
  let media: MediaStream | undefined;
  let negotiation: AbortController | undefined;
  let sensitivePaused = false;
  let resumeOfferAllowed = false;
  let resumeOfferId: string | undefined;
  let resumeEpochId: string | undefined;
  const seenResumeIds = new Set<string>();
  let viewerId: string | undefined;
  let mediaEpoch = 0;
  let activeOffer: string | undefined;
  let generation = 0;
  let iceServers: RTCIceServer[] = [];
  let ready = false;
  let imageUrl: string | undefined;
  let videoFrameHandle: number | undefined;
  let retryCount = 0;
  let lastPong = 0;
  let lastFrameAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function emit(phase: LivePhase, reason?: string, extra: Partial<LiveState> = {}) {
    state = { ...state, phase, mode, reason, ...extra, sensitivePaused };
    if (!disposed) options.onChange(state);
  }

  function clearVideo() {
    mediaEpoch += 1; activeOffer = undefined;
    negotiation?.abort(); negotiation = undefined;
    if (videoFrameHandle !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(videoFrameHandle);
    videoFrameHandle = undefined;
    video.onplaying = null; video.onloadeddata = null; video.onwaiting = null; video.onstalled = null;
    if (peer) {
      peer.ontrack = null; peer.onconnectionstatechange = null;
      peer.close(); peer = undefined;
    }
    media?.getTracks().forEach((track) => track.stop()); media = undefined;
    video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  }

  function clearImage() {
    image.onload = null; image.onerror = null; image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
  }

  function releaseConnection() {
    generation += 1;
    clearTimeout(connectTimer); clearTimeout(fallbackTimer); clearInterval(heartbeat);
    connectTimer = undefined; fallbackTimer = undefined; heartbeat = undefined;
    clearVideo(); clearImage();
    ready = false; viewerId = undefined; resumeOfferAllowed = false; resumeOfferId = undefined; resumeEpochId = undefined; lastFrameAt = 0;
    if (socket) {
      const previous = socket; socket = undefined;
      previous.onopen = null; previous.onmessage = null; previous.onclose = null; previous.onerror = null;
      try { previous.close(1000, 'viewer detached'); } catch { /* 仍由 Server 租約回收。 */ }
    }
  }

  function send(message: unknown): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; }
    catch { return false; }
  }

  function retryConnection(reason: string, waiting = false) {
    if (disposed || suspended || sensitivePaused) return;
    clearTimeout(reconnectTimer); releaseConnection();
    if (waiting || options.waitingForAttempt()) {
      emit('waiting', '等待執行節點或作用中的 attempt；將自動重試。', { viewerId: undefined, needsPlay: false });
      reconnectTimer = setTimeout(connect, 3_000);
      return;
    }
    if (retryCount >= 3) { finish('error', `${reason} 自動重連已達上限，可按「重新連線」再試。`); return; }
    retryCount += 1;
    emit('reconnecting', reason, { viewerId: undefined, needsPlay: false, retryAttempt: retryCount });
    reconnectTimer = setTimeout(connect, Math.min(2 ** retryCount * 1_000, 8_000));
  }

  function finish(phase: 'ended' | 'unavailable' | 'error', reason: string) {
    halted = true;
    sensitivePaused = false; resumeOfferAllowed = false; resumeOfferId = undefined; resumeEpochId = undefined;
    clearTimeout(reconnectTimer); releaseConnection();
    emit(phase, reason, { viewerId: undefined, needsPlay: false });
  }

  function startFallbackClock() {
    if (sensitivePaused || disposed || suspended || halted || fallbackTimer !== undefined || mode !== 'webrtc') return;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      switchMode('jpeg', '20 秒內沒有可播放 video，已切換 JPEG 備援。');
    }, 20_000);
  }

  function switchMode(next: LiveMode, reason?: string) {
    if (disposed || halted || sensitivePaused || mode === next) return;
    offerHistory.requireId = true;
    mode = next;
    clearTimeout(fallbackTimer); fallbackTimer = undefined;
    clearVideo(); clearImage(); lastFrameAt = 0;
    emit('waiting', reason || (mode === 'jpeg' ? '已切換 JPEG 備援，等待第一張可顯示畫面。' : '正在重新協商 WebRTC，等待可播放影格。'), { needsPlay: false });
    if (ready && !send({ type: 'mode', mode })) { retryConnection('無法送出影像模式，正在重新連線。'); return; }
    if (ready && mode === 'webrtc') startFallbackClock();
  }

  function playableVideo(currentPeer: RTCPeerConnection) {
    if (disposed || suspended || sensitivePaused || peer !== currentPeer || mode !== 'webrtc') return false;
    const playable = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused && Boolean(media?.getVideoTracks().some((track) => track.readyState === 'live'));
    if (!playable) return false;
    lastFrameAt = Date.now(); retryCount = 0;
    video.hidden = false;
    clearTimeout(fallbackTimer); fallbackTimer = undefined;
    if (state.phase !== 'streaming' || state.needsPlay) emit('streaming', undefined, { needsPlay: false, retryAttempt: 0 });
    return true;
  }

  function pauseSensitive() {
    sensitivePaused = true; resumeOfferAllowed = false; resumeOfferId = undefined; resumeEpochId = undefined; offerHistory.requireId = true;
    clearTimeout(reconnectTimer); clearTimeout(connectTimer); clearTimeout(fallbackTimer);
    reconnectTimer = undefined; connectTimer = undefined; fallbackTimer = undefined;
    clearVideo(); clearImage(); lastFrameAt = 0;
    video.hidden = true; image.hidden = true;
    emit('paused', '敏感輸入期間已清除監看畫面，等待執行端確認恢復。', { needsPlay: false });
  }

  async function acceptOffer(sdp: string, offerId: string | undefined, currentGeneration: number) {
    if (mode !== 'webrtc' || !ready || sensitivePaused || disposed || suspended || halted) return;
    clearVideo();
    const controller = new AbortController(); negotiation = controller;
    const epoch = mediaEpoch;
    const offerKey = offerId?.toLowerCase() ?? 'legacy'; activeOffer = offerKey;
    emit('waiting', '正在協商新的 WebRTC 畫面，等待可播放影格。', { needsPlay: false });
    let currentPeer: RTCPeerConnection | undefined;
    const valid = () => !disposed && !suspended && !halted && !sensitivePaused && !controller.signal.aborted && negotiation === controller && generation === currentGeneration && mediaEpoch === epoch && activeOffer === offerKey && peer === currentPeer && mode === 'webrtc' && ready;
    try {
      if (typeof RTCPeerConnection === 'undefined') { switchMode('jpeg', '此瀏覽器無法使用 WebRTC，已切換 JPEG 備援。'); return; }
      const nextPeer = new RTCPeerConnection({ iceServers }); currentPeer = nextPeer; peer = nextPeer;
      nextPeer.onconnectionstatechange = () => {
        if (!valid()) return;
        if (nextPeer.connectionState === 'failed') switchMode('jpeg', 'WebRTC 連線失敗，已切換 JPEG 備援。');
        else if (nextPeer.connectionState === 'disconnected') { emit('waiting', 'WebRTC 連線暫時中斷，正在等待恢復。'); startFallbackClock(); }
      };
      nextPeer.ontrack = (event) => {
        if (!valid()) { event.track.stop(); return; }
        if (event.track.kind !== 'video') { event.track.stop(); return; }
        if (!media) media = new MediaStream();
        media.addTrack(event.track); video.srcObject = media;
        const confirmFrame = () => {
          if (!valid()) return;
          playableVideo(nextPeer);
          if (typeof video.requestVideoFrameCallback === 'function') videoFrameHandle = video.requestVideoFrameCallback(confirmFrame);
        };
        if (videoFrameHandle !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(videoFrameHandle);
        if (typeof video.requestVideoFrameCallback === 'function') videoFrameHandle = video.requestVideoFrameCallback(confirmFrame);
        video.onplaying = () => { if (valid() && typeof video.requestVideoFrameCallback !== 'function') playableVideo(nextPeer); };
        video.onloadeddata = video.onplaying;
        video.onwaiting = () => { if (valid()) { emit('waiting', '正在等待可播放的 WebRTC 影格。'); startFallbackClock(); } };
        video.onstalled = video.onwaiting;
        void video.play().catch(() => { if (valid()) emit('waiting', '瀏覽器暫停自動播放，可按「播放監看畫面」。', { needsPlay: true }); });
      };
      await nextPeer.setRemoteDescription({ type: 'offer', sdp });
      if (!valid()) return;
      const answerDescription = await nextPeer.createAnswer();
      if (!valid()) return;
      await nextPeer.setLocalDescription(answerDescription);
      if (!valid()) return;
      await waitForIce(nextPeer, controller.signal);
      if (!valid()) return;
      const answer = nextPeer.localDescription?.sdp;
      if (!answer || !send({ type: 'answer', viewerId, offerId, sdp: answer })) retryConnection('無法完成 WebRTC 協商，正在重新連線。');
    } catch {
      if (valid()) switchMode('jpeg', 'WebRTC 協商失敗，已切換 JPEG 備援。');
    }
  }

  function receiveImage(data: Blob | ArrayBuffer, currentGeneration: number) {
    if (mode !== 'jpeg' || disposed || suspended || sensitivePaused || !ready || currentGeneration !== generation) return;
    const epoch = mediaEpoch;
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (!size || size > 1_048_576) { emit('waiting', '影格大小不符（上限 1 MiB），等待下一張畫面。'); return; }
    const nextUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = nextUrl;
    image.onload = () => {
      if (disposed || suspended || sensitivePaused || currentGeneration !== generation || epoch !== mediaEpoch || mode !== 'jpeg' || imageUrl !== nextUrl || !image.complete || !image.naturalWidth) return;
      lastFrameAt = Date.now(); retryCount = 0;
      image.hidden = false;
      if (state.phase !== 'streaming') emit('streaming', undefined, { retryAttempt: 0 });
    };
    image.onerror = () => { if (!disposed && !sensitivePaused && epoch === mediaEpoch && currentGeneration === generation && imageUrl === nextUrl) emit('waiting', '無法顯示此 JPEG，等待下一張畫面。'); };
    image.src = nextUrl;
  }

  function receiveJson(raw: string, currentGeneration: number) {
    if (raw.length > 1_048_576) { finish('error', '監看控制訊息超過大小上限。'); return; }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { finish('error', '監看協定回應格式不符，請重新連線。'); return; }
    if (viewerId !== undefined && message.viewerId != null && message.type !== 'ready' && message.viewerId !== viewerId) return;
    switch (message.type) {
      case 'ready':
        if (ready) return;
        if (typeof message.viewerId !== 'string' || !message.viewerId) { finish('error', '監看 session 缺少 viewerId。'); return; }
        try { iceServers = parseIceServers(message.iceServers); }
        catch { finish('error', '媒體協商設定格式不符，請確認 Server 設定。'); return; }
        ready = true; viewerId = message.viewerId; lastPong = Date.now();
        if (sensitivePaused) { emit('paused', '敏感輸入期間已清除監看畫面，等待執行端確認恢復。', { viewerId, needsPlay: false }); break; }
        emit('waiting', '已連接監看通道，等待瀏覽器畫面。', { viewerId });
        if (mode === 'jpeg') send({ type: 'mode', mode });
        else startFallbackClock();
        break;
      case 'pong': lastPong = Date.now(); break;
      case 'offer': {
        let offerId: string | undefined;
        if (message.offerId !== undefined) {
          offerHistory.requireId = true;
          if (typeof message.offerId !== 'string' || !UUID.test(message.offerId)) return;
          offerId = message.offerId;
          const key = offerId.toLowerCase();
          if (offerHistory.seenIds.has(key)) return;
          if (offerHistory.seenIds.size >= 1024) { finish('error', '媒體協商次數超過上限，請關閉後重開監看。'); return; }
          offerHistory.seenIds.add(key);
        } else if (offerHistory.requireId || offerHistory.legacyAccepted || sensitivePaused) return;
        if (!ready || suspended || mode !== 'webrtc' || typeof message.sdp !== 'string' || !message.sdp) return;
        if (sensitivePaused) {
          if (!resumeOfferAllowed || !offerId || (resumeOfferId && offerId.toLowerCase() !== resumeOfferId)) return;
          sensitivePaused = false; resumeOfferAllowed = false; resumeOfferId = undefined;
          emit('waiting', '敏感輸入已結束，正在等待新 WebRTC 影格。', { needsPlay: false });
        }
        if (!offerId) offerHistory.legacyAccepted = true;
        lastPong = Date.now();
        clearTimeout(fallbackTimer); fallbackTimer = undefined;
        void acceptOffer(message.sdp, offerId, currentGeneration);
        startFallbackClock();
        break;
      }
      case 'state': {
        const reason = typeof message.reason === 'string' ? message.reason : undefined;
        if (message.state === 'waiting' && reason === 'sensitive_input') { pauseSensitive(); return; }
        if (message.state === 'ended') { finish('ended', reason || '此次監看已結束，測試結果請查看執行紀錄。'); return; }
        if (sensitivePaused) {
          if (message.state === 'waiting' && reason === 'sensitive_input_complete' && message.viewerId === viewerId && ready && message.transport === mode) {
            if (message.offerId !== undefined) {
              if (typeof message.offerId !== 'string' || !UUID.test(message.offerId)) return;
              const key = message.offerId.toLowerCase();
              if (resumeEpochId !== key && (seenResumeIds.has(key) || offerHistory.seenIds.has(key))) return;
              if (!seenResumeIds.has(key) && seenResumeIds.size >= 1024) { finish('error', '媒體恢復次數超過上限，請關閉後重開監看。'); return; }
              seenResumeIds.add(key); resumeEpochId = key;
            }
            lastPong = Date.now();
            if (mode === 'jpeg') {
              sensitivePaused = false; resumeOfferAllowed = false; resumeOfferId = undefined; clearVideo(); clearImage();
              emit('waiting', '敏感輸入已結束，等待新的 JPEG 畫面。', { needsPlay: false });
            } else {
              resumeOfferAllowed = true;
              resumeOfferId = typeof message.offerId === 'string' ? message.offerId.toLowerCase() : undefined;
              emit('paused', '敏感輸入已結束，等待新的 WebRTC 協商與影格。', { needsPlay: false });
            }
          }
          return;
        }
        if (message.state === 'unavailable') {
          if (options.waitingForAttempt()) retryConnection(reason || '正在等待作用中的 attempt。', true);
          else finish('unavailable', reason || '目前沒有可監看的瀏覽器畫面，可稍後重新連線。');
          return;
        }
        if (message.transport && message.transport !== mode) return;
        // Server streaming 只代表上游狀態；必須由 video/圖片實際播放事件確認成功。
        if (state.phase !== 'streaming') emit(message.state === 'connecting' ? 'connecting' : 'waiting', reason || '正在等待可顯示畫面。');
        break;
      }
      case 'error': {
        if (sensitivePaused) return;
        const code = typeof message.code === 'string' ? message.code : 'LIVE_ERROR';
        const detail = typeof message.message === 'string' ? message.message : '監看通道發生錯誤。';
        const normalized = code.toLowerCase().replace(/[^a-z]/g, '');
        if (normalized.includes('busy')) { finish('unavailable', `此 Run 已有其他觀看者，請稍後重新連線。（${code}）`); return; }
        if (options.waitingForAttempt() || normalized.includes('noactiveattempt') || normalized.includes('noattempt') || normalized.includes('notready') || normalized.includes('nomanager')) {
          retryConnection(detail, true); return;
        }
        finish('unavailable', `${detail}（${code}）`);
        break;
      }
    }
  }

  function connect() {
    if (disposed || suspended || halted) return;
    clearTimeout(reconnectTimer); releaseConnection();
    emit(sensitivePaused ? 'paused' : retryCount ? 'reconnecting' : 'connecting', sensitivePaused ? '敏感輸入期間已清除監看畫面，等待執行端確認恢復。' : '正在連接唯讀監看通道。', { viewerId: undefined, needsPlay: false });
    const currentGeneration = generation;
    let currentSocket: WebSocket;
    try { currentSocket = new WebSocket(liveSocketUrl(options.apiBase, options.runId, window.location.href)); }
    catch { finish('error', '無法建立監看連線，請確認同源 /api 代理與瀏覽器 WebSocket 支援。'); return; }
    socket = currentSocket; currentSocket.binaryType = 'blob';
    const valid = () => !disposed && !suspended && socket === currentSocket && generation === currentGeneration;
    connectTimer = setTimeout(() => { if (valid()) retryConnection('監看連線逾時，正在重新連線。'); }, 12_000);
    currentSocket.onopen = () => {
      if (!valid()) return;
      clearTimeout(connectTimer); lastPong = Date.now();
      heartbeat = setInterval(() => {
        if (!valid()) return;
        if (!sensitivePaused && Date.now() - lastPong >= 30_000) { retryConnection('監看心跳逾時，正在重新連線。'); return; }
        if (!send({ type: 'ping' })) { if (!sensitivePaused) retryConnection('監看連線已中斷。'); return; }
        if (sensitivePaused) return;
        if (lastFrameAt && Date.now() - lastFrameAt > 20_000) {
          if (mode === 'webrtc' && typeof video.requestVideoFrameCallback === 'function') switchMode('jpeg', 'WebRTC 影像停滯，已切換 JPEG 備援。');
          else if (mode === 'jpeg') emit('waiting', '暫時沒有新的 JPEG 畫面，可重新連線。');
        }
      }, 10_000);
    };
    currentSocket.onmessage = (event: MessageEvent<unknown>) => {
      if (!valid()) return;
      if (typeof event.data === 'string') receiveJson(event.data, currentGeneration);
      else if (event.data instanceof Blob || event.data instanceof ArrayBuffer) receiveImage(event.data, currentGeneration);
    };
    currentSocket.onclose = () => { if (valid()) retryConnection('監看通道已斷線，正在重新連線。'); };
    currentSocket.onerror = () => { if (valid()) retryConnection('監看通道無法連線，請確認 Server 與代理。'); };
  }

  function suspend() {
    if (disposed || suspended || halted) return;
    suspended = true; clearTimeout(reconnectTimer); releaseConnection();
    emit('paused', '頁面暫時不可見，已停止影像資源；返回後會重新連線。', { viewerId: undefined, needsPlay: false });
  }
  function resume() {
    if (disposed || halted || !suspended || document.hidden) return;
    suspended = false; retryCount = 0; connect();
  }
  function visibilityChanged() { if (document.hidden) suspend(); else resume(); }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  // 延後一個 tick，讓 React StrictMode 的試掛載能先完成清理，避免佔用兩個 viewer。
  if (suspended) emit('paused', '頁面不可見，尚未啟動監看。');
  else reconnectTimer = setTimeout(connect, 0);

  return {
    switchMode(next: LiveMode) { switchMode(next); },
    play() {
      if (sensitivePaused || disposed || suspended || halted || !peer) return;
      const currentPeer = peer; const epoch = mediaEpoch;
      void video.play().then(() => { if (!sensitivePaused && mediaEpoch === epoch && peer === currentPeer && typeof video.requestVideoFrameCallback !== 'function') playableVideo(currentPeer); }).catch(() => { if (!disposed && !sensitivePaused && mediaEpoch === epoch && peer === currentPeer) emit('waiting', '無法播放 video，可切換 JPEG 備援。', { needsPlay: true }); });
    },
    close() {
      if (disposed) return;
      disposed = true; clearTimeout(reconnectTimer); releaseConnection();
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
    },
  };
}
