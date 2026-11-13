import type { Plan, PlanStageInput, PlanSummary } from './types';

export function editableStage(stage: PlanStageInput): PlanStageInput {
  return { id: stage.id, title: stage.title, action: stage.action,
    ...(stage.action !== 'create' && stage.moduleTestId ? { moduleTestId: stage.moduleTestId } : {}),
    ...(stage.action !== 'create' && stage.moduleVersionId ? { moduleVersionId: stage.moduleVersionId } : {}),
    ...(stage.module ? { module: { slug: stage.module.slug, moduleKind: stage.module.moduleKind, description: stage.module.description } } : {}),
    args: stage.args, ...(stage.bind ? { bind: stage.bind } : {}) };
}

export function parseStageEditor(text: string): PlanStageInput[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('Plan 必須包含 1–32 個 Stage。');
  const seen = new Set<string>();
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  for (const item of value) {
    if (!object(item) || Object.keys(item).some((key) => !['id', 'title', 'action', 'moduleTestId', 'moduleVersionId', 'module', 'args', 'bind'].includes(key))) throw new Error('Stage 只可編輯 id/title/action/moduleTestId/moduleVersionId/module/args/bind，不可送出執行狀態。');
    if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 64 || seen.has(item.id) || typeof item.title !== 'string' || !item.title.trim()) throw new Error('Stage id 必須唯一且非空，title 不可空白。');
    if (!['reuse', 'modify', 'create'].includes(String(item.action))) throw new Error('Stage action 僅支援 reuse、modify、create。');
    if (item.action === 'create') {
      const module = item.module;
      if (!object(module) || Object.keys(module).some((key) => !['slug', 'moduleKind', 'description'].includes(key)) || typeof module.slug !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(module.slug) || !['setup', 'step', 'page'].includes(String(module.moduleKind)) || typeof module.description !== 'string' || item.moduleVersionId !== undefined || item.moduleTestId !== undefined) throw new Error('新建 Stage 需合法 slug、moduleKind、description，不可指定既有模組版本。');
    } else if (typeof item.moduleVersionId !== 'string' || !item.moduleVersionId.trim() || item.module !== undefined) throw new Error('複用／修改 Stage 需固定 moduleVersionId，不可提供新建 module。');
    if (item.moduleTestId !== undefined && typeof item.moduleTestId !== 'string') throw new Error('moduleTestId 必須是字串。');
    if (item.bind !== undefined && typeof item.bind !== 'string') throw new Error('bind 必須是字串。');
    if (!object(item.args)) throw new Error('args 必須是參數物件。');
    for (const [key, arg] of Object.entries(item.args)) {
      if (['page', '__proto__', 'prototype', 'constructor'].includes(key) || !object(arg)) throw new Error('參數不可覆寫 page 或保留鍵。');
      if (arg.kind === 'binding') {
        if (Object.keys(arg).some((key) => !['kind', 'stageId', 'path'].includes(key)) || typeof arg.stageId !== 'string' || !seen.has(arg.stageId) || !Array.isArray(arg.path) || arg.path.some((part) => typeof part !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('binding 只能引用前面 Stage，path 必須是安全字串陣列。');
      } else if (arg.kind !== 'literal' || !Object.hasOwn(arg, 'value') || Object.keys(arg).some((key) => !['kind', 'value'].includes(key))) throw new Error('參數需為 literal/value 或 binding/stageId/path。');
    }
    seen.add(item.id);
  }
  return (value as PlanStageInput[]).map(editableStage);
}

export function batchPublishReady(plan: Plan | null | undefined, summary: PlanSummary | null | undefined): boolean {
  if (!plan || !summary || plan.status !== 'composed' || summary.planId !== plan.id || summary.planRevision !== plan.revision || summary.status !== 'succeeded' || summary.stale || !summary.publishReady || !summary.description?.trim() || !summary.backgroundSummary?.trim()) return false;
  // Verify that the visible batch lists every create/modify candidate, never reuse.
  const expected = new Map<string, string>();
  for (const stage of plan.stages) {
    if (stage.status !== 'ready') return false;
    if (stage.action !== 'reuse') {
      if (!stage.candidateVersionId || !stage.moduleTestId) return false;
      expected.set(stage.candidateVersionId, stage.moduleTestId);
    }
  }
  return expected.size === summary.candidates.length && new Set(summary.candidates.map((item) => item.versionId)).size === summary.candidates.length && summary.candidates.every((item) => expected.get(item.versionId) === item.testId);
}
