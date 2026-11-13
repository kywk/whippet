import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { formatDate } from './components';
import { BrandMark, ChevronDownIcon, SendIcon } from './icons';
import { VoiceInputButton } from './VoiceInputButton';
import type { Message } from './types';

/** 未送出的訊息保存在本機，離開、換測試或重新整理後仍在；送出成功後清除。 */
export function useStoredText(key: string): [string, (value: string) => void] {
  const storageKey = `whippet.composer.v1.${key}`;
  const [value, setValue] = useState(() => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const update = useCallback((next: string) => {
    setValue(next);
    try { if (next) localStorage.setItem(storageKey, next); else localStorage.removeItem(storageKey); } catch { /* 本機儲存不可用時，只是不保留草稿。 */ }
  }, [storageKey]);
  return [value, update];
}

export function TypingDots({ label = 'AI 處理中' }: { label?: string }) {
  return <span className="typing" role="status" aria-label={label}><i /><i /><i /></span>;
}

/** 訊息捲動區：貼近底部時自動跟隨新內容；往上看舊訊息時不搶捲動，改顯示「跳到最新」。 */
export function ChatScroll({ children, watch, label }: { children: ReactNode; watch: unknown; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  }, []);
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [watch, toBottom]);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const inner = element.firstElementChild;
    if (!inner) return;
    const observer = new ResizeObserver(() => { if (stick.current) toBottom(); });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [toBottom]);
  return <div className="chat-scroll-wrap">
    <div className="chat-scroll" ref={scroller} role="log" aria-label={label} aria-live="off" tabIndex={0}
      onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96; setAway(!stick.current); }}>
      <div className="chat-column">{children}</div>
    </div>
    {away ? <button className="jump-latest" onClick={() => { stick.current = true; setAway(false); toBottom(true); }}><ChevronDownIcon />跳到最新</button> : null}
  </div>;
}

export function UserTurn({ message }: { message: Message }) {
  return <li className="turn user"><div className="bubble"><p className="message-content">{message.content}</p></div><time className="turn-time" dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></li>;
}

export function AssistantTurn({ name = 'Whippet', time, children, pending = false }: { name?: string; time?: string; children: ReactNode; pending?: boolean }) {
  return <li className={`turn assistant${pending ? ' pending' : ''}`}>
    <span className="avatar" aria-hidden="true"><BrandMark className="avatar-mark" /></span>
    <div className="turn-body">
      <div className="turn-name"><strong>{name}</strong>{time ? <time dateTime={time}>{formatDate(time)}</time> : null}</div>
      {children}
    </div>
  </li>;
}

interface ComposerProps {
  id: string; value: string; onChange: (value: string) => void; onSubmit: () => void;
  placeholder: string; sending: boolean; canSend: boolean; reason?: string; maxLength?: number; ariaDescribedBy?: string;
  helper?: ReactNode; extraActions?: ReactNode; label: string; showVoice?: boolean;
}

/** 底部固定的輸入區：Enter 送出、Shift+Enter 換行（輸入法組字中不送出）；AI 忙碌時仍可先輸入下一則。 */
export function Composer({ id, value, onChange, onSubmit, placeholder, sending, canSend, reason, maxLength = 16_000, helper, extraActions, label, showVoice = true }: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const count = Array.from(value).length;
  const over = count > maxLength;
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value]);
  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend && value.trim() && !over) onSubmit();
  }
  function submit(event: FormEvent) { event.preventDefault(); if (canSend && value.trim() && !over) onSubmit(); }
  return <form className="composer" onSubmit={submit}>
    {reason ? <p className="composer-reason" role="status">{reason}</p> : null}
    <div className="composer-box">
      <label className="sr-only" htmlFor={id}>{label}</label>
      <textarea id={id} ref={field} rows={1} value={value} placeholder={placeholder} disabled={sending} onChange={(event) => onChange(event.target.value)} onKeyDown={key} aria-invalid={over} aria-describedby={`${id}-help`} />
      <div className="composer-row">
        <div className="composer-tools">{showVoice ? <VoiceInputButton disabled={sending} onTranscript={(text) => onChange(value.trim() ? `${value.trimEnd()} ${text}` : text)} /> : null}{extraActions}</div>
        <span id={`${id}-help`} className={`composer-help${over || count > maxLength - 2000 ? ' warn' : ''}`}>{count > maxLength - 2000 ? `${count.toLocaleString('zh-TW')} / ${maxLength.toLocaleString('zh-TW')} 字元` : helper ?? 'Enter 送出 · Shift+Enter 換行'}</span>
        <button className="send-button" type="submit" disabled={!canSend || !value.trim() || over} aria-label={sending ? '送出中' : '送出訊息'} title={sending ? '送出中…' : '送出訊息（Enter）'}><SendIcon /></button>
      </div>
    </div>
  </form>;
}
