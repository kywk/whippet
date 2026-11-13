---
name: module-authoring
description: Create or repair a reusable Whippet Module and its verification harness when module work is requested.
---

# Module authoring

Use the pinned platform.module and read_module_draft to establish the immutable slug, moduleKind, exported API, named inputs, returned values and observable pre/postconditions. Keep one reusable responsibility. Modules cannot import other Modules or reach another Workspace.

Read module-authoring/harness through read_skill_reference before designing its independent spec. Explore with the provided browser tools only when the supplied target facts are insufficient; keep exploration on confirmed targets. Read playwright-authoring/recipe only when that auxiliary skill is pinned and examples are needed.

Build a compact candidate in this order:

1. Call stage_module_candidate_part with part="script", the complete reusable body, and stagingRevision=0. Each part must fit 8192 UTF-8 bytes. Finish this part before generating the harness.
2. Call stage_module_candidate_part with part="harness", the complete independent spec importing @lib/<slug>, and the revision returned by step 1. Assert the promised observable outcome; use configured login role IDs, never credential values.
3. Call commit_module_candidate with the latest stagingRevision and all eight metadata fields (slug, moduleKind, exportName, signature, inputs, returns, preconditions, postconditions). Keep metadata concise, at most 4096 JSON bytes. The Worker assembles both staged parts and self-tests the complete candidate.

A staged result is unverified and is not a saved draft. Only candidate=true and selfTestPassed=true establishes a passing candidate. On a code or assertion failure, replace the affected complete part using the current stagingRevision and commit again; preserve the user's assertions. Report environment failures as blockers. If a responsibility cannot fit one compact part, report the need to split the Module; do not omit assertions or return truncated code. Staging is local to this attempt and is lost when it ends.

After a passing commit, request_module_validation requests independent validation after this Worker is reclaimed. Self-test and validation do not publish. Budget failure stops the Stage; Module work does not produce a partial artifact.

Finish with JSON containing only message and optional conversationSummary. State actual evidence and remaining work. The guard supplies the last passing body/metadata and validation flag; model final text cannot select a different candidate. If tools cannot produce a passing candidate, report the blocker without claiming a saved Module or version. Human publication remains separate.
