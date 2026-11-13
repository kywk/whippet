import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isActiveRun } from './types';
import { publishedTrail, trailFromRuns } from './trail';
import type { Stage } from './trail';
import type { Run, Test, WhippetApi } from './types';

export interface TestActivity {
  stages: Stage[];
  label: string;
  /** 有 Run 正在背景進行 */
  running: boolean;
  /** 最近一站未成功（失敗、逾時、中斷或取消） */
  bad: boolean;
  /** 有尚未看過的結果 */
  unread: boolean;
}

const SEEN_KEY = 'whippet.seen.v1';
const FAST_MS = 3_000;
const SLOW_EVERY = 7; // 每 7 個快速週期（約 21 秒）輪詢全部測試

function readSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function writeSeen(value: Record<string, string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(value)); } catch { /* 無法保存時只失去「未讀」記憶，不影響功能。 */ }
}
const signature = (runs: Run[]): string => {
  const latest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return latest && !isActiveRun(latest) ? `${latest.id}:${latest.status}` : '';
};

/**
 * 全 Workspace 的背景任務觀察：
 * 離開某個測試後，任務仍在 Server 執行；這裡持續讀取各測試的 Run，
 * 讓左欄顯示目前停在哪一站，結果完成但還沒看過的測試會亮燈。
 */
export function useActivity(api: WhippetApi, tests: Test[], selectedId: string | undefined) {
  const [runsByTest, setRunsByTest] = useState<Record<string, Run[]>>({});
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const testsRef = useRef(tests); testsRef.current = tests;
  const runsRef = useRef(runsByTest); runsRef.current = runsByTest;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const previous = useRef(new Map<string, string>());
  const ids = tests.map((test) => test.id).join(',');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cycle = 0;
    const controller = new AbortController();
    async function load(targets: Test[]) {
      const results = await Promise.allSettled(targets.map((test) => api.listRuns(test.id, controller.signal)));
      if (stopped) return;
      setRunsByTest((current) => {
        const next = { ...current };
        results.forEach((result, index) => { if (result.status === 'fulfilled') next[targets[index].id] = result.value; });
        return next;
      });
    }
    async function tick() {
      const all = testsRef.current;
      const hot = all.filter((test) => test.activeEditingSession || (runsRef.current[test.id] ?? []).some(isActiveRun));
      await load(cycle % SLOW_EVERY === 0 ? all : hot);
      cycle += 1;
      if (!stopped) timer = setTimeout(tick, FAST_MS);
    }
    void tick();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [api, ids]);

  // 首次看到某測試時，以目前結果為已讀基準，避免第一次開啟就全部亮燈。
  useEffect(() => {
    setSeen((current) => {
      let changed = false;
      const next = { ...current };
      for (const test of testsRef.current) {
        const runs = runsByTest[test.id];
        if (runs && next[test.id] === undefined) { next[test.id] = signature(runs); changed = true; }
      }
      if (changed) writeSeen(next);
      return changed ? next : current;
    });
  }, [runsByTest]);

  const markSeen = useCallback((testId: string) => {
    setSeen((current) => {
      const sig = signature(runsRef.current[testId] ?? []);
      if (current[testId] === sig) return current;
      const next = { ...current, [testId]: sig };
      writeSeen(next);
      return next;
    });
  }, []);

  // 正在檢視的測試，結果出現時視為已讀。
  const selectedSig = selectedId ? signature(runsByTest[selectedId] ?? []) : '';
  useEffect(() => {
    if (!selectedId || document.hidden) return;
    markSeen(selectedId);
  }, [selectedId, selectedSig, markSeen]);
  useEffect(() => {
    function visible() { if (!document.hidden && selectedRef.current) markSeen(selectedRef.current); }
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [markSeen]);

  // 背景完成通知：Run 由進行中轉為結束，且使用者不在該測試畫面時提醒。
  useEffect(() => {
    for (const test of testsRef.current) {
      for (const run of runsByTest[test.id] ?? []) {
        const before = previous.current.get(run.id);
        previous.current.set(run.id, run.status);
        if (before && ['queued', 'dispatched', 'running', 'collecting', 'cancelling'].includes(before) && !isActiveRun(run)
          && permission === 'granted' && (document.hidden || selectedRef.current !== test.id)) {
          const label = run.kind === 'author' ? (run.authorMode === 'summary' ? '驗收摘要' : 'AI 撰寫') : run.kind === 'validation' ? '草稿驗證' : '正式執行';
          try { new Notification(`${test.name}`, { body: `${label}${run.authorPartial ? '部分完成，等待繼續' : run.status === 'succeeded' ? '已完成' : '未成功'}`, tag: run.id }); } catch { /* 通知失敗不影響任務。 */ }
        }
      }
    }
  }, [runsByTest, permission]);

  const activity = useMemo(() => {
    const map: Record<string, TestActivity> = {};
    for (const test of tests) {
      const runs = runsByTest[test.id] ?? [];
      const session = test.activeEditingSession;
      let stages: Stage[]; let label: string; let running = false; let bad = false;
      if (session) {
        const trail = trailFromRuns(runs, { id: session.id, draftRevision: session.draftRevision });
        stages = trail.stages; running = trail.running; bad = trail.failed;
        label = session.status === 'discarding' ? '正在放棄草稿' : `${trail.headline} · 第 ${trail.step}／4 站`;
        if (test.kind === 'usecase' && session.status !== 'discarding') {
          // Single-Test runs do not describe Plan Stage/batch-summary progress.
          stages = [];
          running = runs.some((run) => run.editingSessionId === session.id && isActiveRun(run));
          bad = false;
          label = running ? 'Use Case 任務進行中 · 詳見 Plan' : 'Use Case · 至編輯頁檢視 Plan';
        }
      } else if (test.publishedVersionId) {
        stages = publishedTrail;
        const formal = runs.filter((run) => !run.kind || run.kind === 'run').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        running = Boolean(formal && isActiveRun(formal));
        bad = Boolean(formal && !isActiveRun(formal) && formal.status !== 'succeeded');
        label = running ? '已發佈 · 正在執行' : bad ? '已發佈 · 最近執行未通過' : formal ? '已發佈 · 最近執行通過' : '已發佈';
      } else {
        stages = publishedTrail.map((stage) => ({ ...stage, state: 'todo' as const }));
        label = '尚未開始編輯';
      }
      const sig = signature(runs);
      map[test.id] = { stages, label, running, bad, unread: Boolean(sig) && seen[test.id] !== undefined && seen[test.id] !== sig && !(test.id === selectedId && !document.hidden) };
    }
    return map;
  }, [tests, runsByTest, seen, selectedId]);

  const running = Object.values(activity).filter((item) => item.running).length;
  const unread = Object.values(activity).filter((item) => item.unread).length;
  useEffect(() => {
    document.title = `${running ? '● ' : ''}${unread ? `(${unread}) ` : ''}Whippet · 測試工作台`;
    return () => { document.title = 'Whippet · 測試工作台'; };
  }, [running, unread]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    setPermission(await Notification.requestPermission());
  }, []);

  return { activity, running, unread, permission, enableNotifications };
}
