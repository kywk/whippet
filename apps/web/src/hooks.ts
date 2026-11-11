import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { errorMessage } from './api';
import { isActiveRun } from './types';
import type { Run, WhippetApi } from './types';

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: true });
  const [revision, retry] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    load(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ data, loading: false }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ loading: false, error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [load, revision]);
  return { ...state, retry };
}

function newestFirst(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function useRuns(api: WhippetApi, testId: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const mutation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const startedAtMutation = mutation.current;
    setLoading(true);
    api.listRuns(testId, controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return;
        // 讀取歷史期間若剛建立新 Run，保留該筆，避免較早的 GET 蓋掉 POST 結果。
        setRuns((current) => newestFirst(mutation.current === startedAtMutation ? items : [
          ...items, ...current.filter((run) => !items.some((item) => item.id === run.id)),
        ]));
        setError(undefined);
        setUpdatedAt(new Date());
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [api, testId, revision]);

  const activeIds = runs.filter(isActiveRun).map((run) => run.id).sort().join(',');
  useEffect(() => {
    if (!activeIds) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const results = await Promise.allSettled(activeIds.split(',').map((id) => api.getRun(id, controller.signal)));
      if (controller.signal.aborted) return;
      const updates: Run[] = [];
      const failures: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') updates.push(result.value);
        else failures.push(errorMessage(result.reason));
      }
      setRuns((current) => newestFirst(current.map((run) => updates.find((item) => item.id === run.id) ?? run)));
      setError(failures.length ? `狀態更新暫時失敗，將自動重試。${failures[0]}` : undefined);
      if (updates.length) setUpdatedAt(new Date());
      timer = setTimeout(poll, 2_000);
    }
    timer = setTimeout(poll, 2_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, activeIds]);

  const addRun = useCallback((run: Run) => {
    mutation.current += 1;
    setRuns((current) => newestFirst([run, ...current.filter((item) => item.id !== run.id)]));
    setUpdatedAt(new Date());
  }, []);

  return { runs, loading, error, updatedAt, refresh, addRun, polling: Boolean(activeIds) };
}
