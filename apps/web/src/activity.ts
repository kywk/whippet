import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isActiveRun, STATUS_LABELS } from './types';
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
  /** 尚未看過的 AI 對話結果 */
  unreadAuthor?: string;
}

export interface BackgroundCompletion {
  id: string;
  testName: string;
  message: string;
}

const SEEN_KEY = 'whippet.seen.v1';
const AUTHOR_SEEN_KEY = 'whippet.author-seen.v1';
const FAST_MS = 3_000;
const SLOW_EVERY = 7; // 每 7 個快速週期（約 21 秒）輪詢全部測試

function readSeen(key: string): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, string> : {};
  } catch { return {}; }
}

function useSeenSignatures(key: string, signatures: Record<string, string>, viewedId?: string) {
  const [seen, setSeen] = useState(() => readSeen(key));
  useEffect(() => {
    function remember() {
      const visible = !document.hidden;
      setSeen((current) => {
        let next = current;
        for (const [id, signature] of Object.entries(signatures)) {
          if (current[id] === signature || (current[id] !== undefined && (id !== viewedId || !visible))) continue;
          if (next === current) next = { ...current };
          next[id] = signature;
        }
        return next;
      });
    }
    remember();
    document.addEventListener('visibilitychange', remember);
    return () => document.removeEventListener('visibilitychange', remember);
  }, [signatures, viewedId]);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(seen)); } catch { /* 儲存不可用時仍可在目前分頁追蹤未讀。 */ }
  }, [key, seen]);
  return seen;
}

const runSignature = (run?: Run) => run ? `${run.id}:${run.status}` : '';
const signature = (runs: Run[]): string => {
  const latest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return latest && !isActiveRun(latest) ? runSignature(latest) : '';
};

function latestAuthorResult(runs: Run[]) {
  let latest: Run | undefined;
  let finished = 0;
  for (const run of runs) {
    if (run.kind !== 'author' || isActiveRun(run)) continue;
    const time = Date.parse(run.finishedAt ?? run.createdAt);
    if (!latest || time > finished) { latest = run; finished = time; }
  }
  return latest;
}

function authorResultMessage(run: Run) {
  if (run.authorPartial) return 'AI 部分完成，等待繼續';
  if (run.status !== 'succeeded') return `AI 任務${STATUS_LABELS[run.status]}`;
  if (run.authorMode === 'summary') return 'AI 摘要已完成';
  return run.authorRepliedOnly ? 'AI 已回覆' : 'AI 已完成';
}

/**
 * 全 Workspace 的背景任務觀察：
 * 離開某個測試後，任務仍在 Server 執行；這裡持續讀取各測試的 Run，
 * 讓左欄顯示目前停在哪一站，結果完成但還沒看過的測試會亮燈。
 */
export function useActivity(api: WhippetApi, tests: Test[], viewing: { testId?: string; authorTestId?: string }, userId: string, notify: (batch: BackgroundCompletion[]) => void) {
  const { testId: selectedId, authorTestId: viewedAuthorId } = viewing;
  const [{ runsByTest, failedRunLoads }, setHistory] = useState({ runsByTest: {} as Record<string, Run[]>, failedRunLoads: new Set<string>() });
  const [refreshingRuns, setRefreshingRuns] = useState(false);
  const [refreshRevision, refreshRuns] = useReducer((revision: number) => revision + 1, 0);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const testsRef = useRef(tests); testsRef.current = tests;
  const runsRef = useRef(runsByTest); runsRef.current = runsByTest;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const viewedAuthorRef = useRef(viewedAuthorId); viewedAuthorRef.current = viewedAuthorId;
  const previous = useRef(new Map<string, Map<string, boolean>>());
  const ids = tests.map((test) => test.id).join(',');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cycle = 0;
    const controller = new AbortController();
    async function load(targets: Test[]) {
      if (!targets.length) return;
      const results = await Promise.allSettled(targets.map((test) => api.listRuns(test.id, controller.signal)));
      if (stopped) return;
      setHistory((current) => {
        const nextRuns = { ...current.runsByTest };
        const nextFailures = new Set(current.failedRunLoads);
        results.forEach((result, index) => {
          const id = targets[index].id;
          if (result.status === 'fulfilled') {
            nextRuns[id] = result.value;
            nextFailures.delete(id);
          } else {
            nextFailures.add(id);
          }
        });
        return { runsByTest: nextRuns, failedRunLoads: nextFailures };
      });
    }
    async function tick() {
      const all = testsRef.current;
      const hot = all.filter((test) => test.activeEditingSession || (runsRef.current[test.id] ?? []).some(isActiveRun));
      await load(cycle % SLOW_EVERY === 0 ? all : hot);
      cycle += 1;
      if (!stopped) {
        if (cycle === 1) setRefreshingRuns(false);
        timer = setTimeout(tick, FAST_MS);
      }
    }
    setRefreshingRuns(Boolean(ids));
    void tick();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [api, ids, refreshRevision]);

  // AI 未讀獨立保存，後續正式執行或驗證不會蓋掉對話結果。
  const { runKeys, authorKeys, authors } = useMemo(() => {
    const runKeys: Record<string, string> = {};
    const authorKeys: Record<string, string> = {};
    const authors: Record<string, Run | undefined> = {};
    for (const [id, runs] of Object.entries(runsByTest)) {
      runKeys[id] = signature(runs);
      authors[id] = latestAuthorResult(runs);
      authorKeys[id] = runSignature(authors[id]);
    }
    return { runKeys, authorKeys, authors };
  }, [runsByTest]);
  const seen = useSeenSignatures(SEEN_KEY, runKeys, selectedId);
  const seenAuthors = useSeenSignatures(`${AUTHOR_SEEN_KEY}.${userId}`, authorKeys, viewedAuthorId);

  // 首次讀取僅建立基準。之後也處理在兩次輪詢之間已完成的 AI Run。
  useEffect(() => {
    const batch: BackgroundCompletion[] = [];
    for (const test of testsRef.current) {
      const runs = runsByTest[test.id];
      if (!runs) continue;
      const before = previous.current.get(test.id);
      const known = before ?? new Map<string, boolean>();
      previous.current.set(test.id, known);
      for (const run of runs) {
        const active = isActiveRun(run);
        const wasActive = known.get(run.id);
        known.set(run.id, active);
        if (!before || active || wasActive === false) continue;
        const author = run.kind === 'author';
        const viewed = author ? viewedAuthorRef.current : selectedRef.current;
        if ((viewed === test.id && !document.hidden) || (!author && !wasActive)) continue;
        const message = author ? authorResultMessage(run) : `${run.kind === 'validation' ? '草稿驗證' : '正式執行'}${run.status === 'succeeded' ? '已完成' : '未成功'}`;
        if (author) batch.push({ id: run.id, testName: test.name, message });
        if (permission === 'granted' && (!author || document.hidden)) {
          try { new Notification(test.name, { body: message, tag: run.id }); } catch { /* 通知失敗不影響任務。 */ }
        }
      }
    }
    if (batch.length) notify(batch);
  }, [runsByTest, permission, notify]);

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
      const sig = runKeys[test.id];
      const author = authors[test.id];
      const unreadAuthor = author && seenAuthors[test.id] !== undefined && seenAuthors[test.id] !== authorKeys[test.id] && (test.id !== viewedAuthorId || document.hidden)
        ? authorResultMessage(author) : undefined;
      const unread = Boolean(sig) && seen[test.id] !== undefined && seen[test.id] !== sig && (test.id !== selectedId || document.hidden);
      map[test.id] = { stages, label, running, bad, unread: unread || Boolean(unreadAuthor), unreadAuthor };
    }
    return map;
  }, [tests, runsByTest, runKeys, authors, authorKeys, seen, seenAuthors, selectedId, viewedAuthorId]);

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

  return { activity, running, unread, permission, enableNotifications, runHistory: { runsByTest, failedRunLoads, refreshingRuns, refreshRuns } };
}
