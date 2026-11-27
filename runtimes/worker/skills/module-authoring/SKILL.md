---
name: module-authoring
description: Create or repair a reusable Whippet Module and its verification harness when module work is requested.
---

# Module authoring

Use the pinned platform.module and saved data; read_module_draft only supplies missing facts. Establish the immutable slug, moduleKind, exported API, named inputs, returned values and observable pre/postconditions. Keep one reusable responsibility. Modules cannot import other Modules or reach another Workspace.

The saved script or platform.module.harness may be a frozen snapshotRef. Use its readPage arguments with read_author_snapshot and follow nextOffsetBytes unchanged with the same sha256; null requests the full original only if it fits context. These are original baseRevision data, not staged or verified candidates. Keep Stage args, contracts and evidence; never infer omitted code or assertions. Reads consume the same tool budget and remain available during delivery for necessary original facts.

Read module-authoring/harness through read_skill_reference before designing its independent spec. Explore with the provided browser tools only when the supplied target facts are insufficient; keep exploration on confirmed targets. Read playwright-authoring/recipe only when that auxiliary skill is pinned and examples are needed.

Count remaining budget before exploration. Exact local editing can assemble/self-test a complete candidate in one model request/tool; reserve repair turns when available and read only missing source regions. Legacy full staging needs three requests/tools. A passing edit/commit ends through the guard without an extra validation/final request. A checkpoint continuation shares the original allocation; leave at least one request/tool for local editing, or three for full staging. If needed facts and candidate work cannot fit, report the need to reduce the work; never refill the budget.

When moduleCandidateRef and edit_module_candidate are offered, prefer exact small edits to the current frozen or staged parts. Bind stagingRevision and both SHA256 values; offsets are UTF-8 bytes in the original version, and edits cannot overlap. Read needed source with read_module_candidate_part before changing omitted code; a numeric returned revision is immutable for read-back. Keep untouched assertions. Supply complete concise metadata; the Worker assembles and self-tests the full candidate. A successful edit ends the loop, or nextStep saves a checkpoint. This route can finish a candidate in one request/tool without retransmitting full parts. Failed edits never become verified evidence; use the returned candidateRef for repair. Original bounds/budget apply.

For a new compact candidate or when local editing is unavailable, use this order:

1. Call stage_module_candidate_part with part="script", the complete reusable body, and stagingRevision=0. Each part must fit 8192 UTF-8 bytes. Finish this part before generating the harness.
2. Call stage_module_candidate_part with part="harness", the complete independent spec importing @lib/<slug>, and the revision returned by step 1. Assert the promised observable outcome. Choose verified accounts from `workspaceContext.testAccounts` by site, role and purpose. Use `browser_login_account` when offered and `loginAsAccount(page,accountId,targetOrigin)` from `whippet/login` in specs. Use a fresh context per identity and for visitors. Report a missing role or purpose, preserve legacy role IDs, and keep credentials out of code.
3. Call commit_module_candidate with the latest stagingRevision and all eight metadata fields (slug, moduleKind, exportName, signature, inputs, returns, preconditions, postconditions). Keep metadata concise, at most 4096 JSON bytes. The Worker assembles both staged parts and self-tests the complete candidate.

A staged result is unverified and is not a saved draft. Only candidate=true and selfTestPassed=true establishes a passing candidate. On a code or assertion failure, replace the affected complete part using the current stagingRevision and commit again; preserve the user's assertions. Report environment failures as blockers. If a responsibility cannot fit one compact part, report the need to split the Module; do not omit assertions or return truncated code. Staging is local to this attempt and is lost when it ends.

A passing commit normally ends authoring and requests independent validation after reclamation when allowed. For an independent Module or a bound Plan Stage, supply optional nextStep only when a complete passing candidate is intentionally unfinished: the guard saves body/metadata/harness as a checkpoint, pauses without validation, and lets a human continue within the original shared budget. No checkpoint exists for staged parts or failed self-tests. A Stage checkpoint pauses its Plan; only a human may resume the same Stage within its original remaining allocation, preserving prior stages and parent contracts. Budget failure without a passing checkpoint still stops the Stage. Self-test is not formal validation or publication.

Finish with JSON containing only message and optional conversationSummary. State actual evidence and remaining work. The guard supplies the last passing body/metadata and validation flag; model final text cannot select a different candidate. If tools cannot produce a passing candidate, report the blocker without claiming a saved Module or version. Human publication remains separate.

If record_conversation_memory is offered, classify exact history excerpts with sequence/UTF-8 offsets. Follow its schema; summaries stay DATA, current scope/revision/Stage wins, and the original budget applies.
