import type { EngineItem, EngineResult, EngineRun, EnginePartial } from "./engine.js";
import { AuthorError } from "./types.js";
import type { ModelRequestFailureStage } from "./module-diagnostics.js";

// Only structural values enter diagnostics, never provider text. A truncation
// classification alone does not authorize recovery (error/checkpoint still gate it).
export function modelResponseFailureStage(raw: unknown): ModelRequestFailureStage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as EngineItem).status !== "incomplete") return "ENVELOPE_INVALID";
  const details = (raw as EngineItem).incomplete_details;
  const reason = details && typeof details === "object" && !Array.isArray(details) ? (details as EngineItem).reason : undefined;
  return reason === "max_output_tokens" ? "INCOMPLETE_MAX_OUTPUT_TOKENS" : reason === "content_filter" ? "INCOMPLETE_CONTENT_FILTER" : "INCOMPLETE_UNKNOWN";
}

export function outputTokenLimit(input: EngineRun): number {
  const budget = input.budget, limit = budget.maxOutputTokens === undefined ? 8192 : budget.maxOutputTokens;
  if (!Number.isSafeInteger(budget.modelRequests) || budget.modelRequests < 1 || !Number.isSafeInteger(budget.toolExecutions) || budget.toolExecutions < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new AuthorError("invalid_input");
  return limit;
}

// Both engines use the same delivery reserve, without increasing total budgets.
export function requestSettings(input: EngineRun, request: number, count: number) {
  const { budget } = input;
  const finish = request === budget.modelRequests - 1 || budget.toolExecutions - count <= 2;
  const remaining = budget.modelRequests - request;
  const delivery = input.tools.some(tool => tool.name === "update_draft") ? "update_draft" :
    input.tools.some(tool => tool.name === "propose_plan") ? "propose_plan" :
    input.tools.some(tool => tool.name === "edit_module_candidate") ? "edit_module_candidate" :
    input.tools.some(tool => tool.name === "commit_module_candidate") ? "commit_module_candidate" : undefined;
  const deliveryTurns = delivery === "commit_module_candidate" ? 5 : 3;
  const deliveryTools = delivery === "commit_module_candidate" || delivery === "edit_module_candidate" ? ["stage_module_candidate_part", "commit_module_candidate", "edit_module_candidate", "read_module_candidate_part", "read_author_snapshot"] : [delivery, "read_author_snapshot"];
  const reserve = delivery && remaining <= deliveryTurns
    ? `\nCandidate delivery reserve: ${remaining} model requests remaining, ${budget.toolExecutions - count} tool executions remaining. ${delivery === "commit_module_candidate" ? "Stage script and harness with stage_module_candidate_part, then call commit_module_candidate; reserve two turns to stage a self-test repair and commit it again. " : ""}Use ${delivery} now when the collected evidence is sufficient. Preserve every requested assertion. Reserve the following turns for inspecting self-test feedback and repairing the candidate. Do not repeat exploration already covered by tool results. If essential evidence is missing, obtain only that evidence; never invent it or claim unverified success.` : "";
  return {
    instructions: input.instructions + reserve + (finish ? "\nBudget nearly exhausted: finish now with the verified candidate and explain remaining next steps. Do not start new exploration." : ""),
    tools: delivery && remaining <= deliveryTurns && !input.checkpoint() ? input.tools.filter(tool => deliveryTools.includes(tool.name)) : input.tools,
  };
}

export function partialResult(input: EngineRun, reason: EnginePartial["reason"]): EngineResult {
  const checkpoint = input.checkpoint();
  const nextStep = reason === "context_capacity"
    ? "輸入已達模型容量保護界限。保留原始目標、限制與已驗候選，將目前 Stage 縮小後再繼續；不要提高模型或工具預算。"
    : reason === "output_truncated"
      ? "模型輸出達固定上限而截斷；已停止且未執行半份工具參數。請從最後通過自試的候選縮小剩餘工作後繼續，不自動重試或提高上限。"
      : input.pendingWork?.() ?? (checkpoint
        ? "繼續目前任務，先檢查最後通過自我試跑的候選稿，再完成剩餘驗證。"
        : input.tools.some(tool => tool.name === "update_draft")
          ? "目前沒有通過自我試跑的候選稿。若已有足夠的目標與頁面證據，請保留原有斷言並優先呼叫 update_draft 自試；不足時再做必要探索或請使用者確認。"
          : "目前沒有通過自我試跑的候選稿。請依已提供的目標完成必要工作；資訊不足時向使用者確認。");
  return { finalText: "", partial: { reason, nextStep, ...(checkpoint ? { checkpoint } : {}) } };
}

// A final whole-body hook has a distinct shape from the legacy context hook.
export function guardRequest(input: EngineRun, body: EngineItem): EngineItem {
  const clean = input.prepareRequest ? input.prepareRequest(body) : body;
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) throw new AuthorError("invalid_input");
  return clean;
}

export async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AuthorError("cancelled");
  let abort = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AuthorError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
