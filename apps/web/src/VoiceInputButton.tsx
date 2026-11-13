import { useEffect, useRef, useState } from 'react';
import { MicIcon } from './icons';

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { results: ArrayLike<SpeechResult>; resultIndex: number };
type SpeechFailure = { error: string };
type SpeechRecognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: SpeechFailure) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechConstructor = new () => SpeechRecognizer;

function browserSpeechRecognition(): SpeechConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const browser = window as Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export function VoiceInputButton({ disabled, onTranscript }: { disabled: boolean; onTranscript: (text: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const recognition = useRef<SpeechRecognizer | null>(null);
  const wantsListening = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcript = useRef(onTranscript);
  transcript.current = onTranscript;

  useEffect(() => {
    setSupported(Boolean(browserSpeechRecognition()));
    return () => {
      wantsListening.current = false;
      if (restartTimer.current) clearTimeout(restartTimer.current);
      recognition.current?.abort(); recognition.current = null;
    };
  }, []);

  useEffect(() => {
    if (disabled) stopListening();
  }, [disabled]);

  if (!supported) return null;

  function stopListening() {
    wantsListening.current = false;
    if (restartTimer.current) { clearTimeout(restartTimer.current); restartTimer.current = null; }
    recognition.current?.stop();
    setListening(false);
  }

  function startRecognition() {
    if (!wantsListening.current) return;
    const Constructor = browserSpeechRecognition();
    if (!Constructor) { wantsListening.current = false; setListening(false); setSupported(false); return; }
    const next = new Constructor();
    next.lang = navigator.language || 'zh-TW';
    next.continuous = true;
    next.interimResults = false;
    next.onresult = (event) => {
      const words: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result?.isFinal) words.push(result[0]?.transcript ?? '');
      }
      const text = words.join(' ').trim();
      if (text) transcript.current(text);
    };
    next.onerror = (event) => {
      if (event.error === 'no-speech') return;
      wantsListening.current = false;
      setListening(false);
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? '麥克風權限遭拒，請檢查瀏覽器權限。'
        : '語音辨識失敗，請再試一次。');
      try { next.stop(); } catch { /* Browser may have already stopped recognition. */ }
    };
    next.onend = () => {
      if (recognition.current !== next) return;
      recognition.current = null;
      if (wantsListening.current) restartTimer.current = setTimeout(() => { restartTimer.current = null; startRecognition(); }, 250);
      else setListening(false);
    };
    recognition.current = next;
    try { next.start(); setListening(true); }
    catch { recognition.current = null; wantsListening.current = false; setListening(false); setError('無法啟動語音辨識，請檢查麥克風權限。'); }
  }

  function toggle() {
    if (wantsListening.current) { stopListening(); return; }
    wantsListening.current = true;
    setError(undefined);
    startRecognition();
  }

  return <>
    <button className="button quiet compact voice-input-button" type="button" disabled={disabled && !listening} aria-label={listening ? '停止語音輸入' : '開始語音輸入'} aria-pressed={listening} onClick={toggle}>
      <MicIcon />
      <span>{listening ? '停止錄音' : '語音輸入'}</span>
    </button>
    {listening ? <span className="voice-input-status" role="status">正在聆聽…</span> : null}
    {error ? <span className="voice-input-error" role="alert">{error}</span> : null}
  </>;
}
