---
name: module-authoring
description: Create or repair a reusable Whippet Module and its verification harness when module work is requested.
---

# Module authoring

Use the pinned platform.module and read_module_draft to establish the immutable slug, moduleKind, exported function signature, named inputs, returned values and observable pre/postconditions. Keep one reusable responsibility. Modules cannot import other Modules or reach another Workspace.

Explore only with provided browser tools and confirmed targets. Read module-authoring/harness through read_skill_reference when designing the separate minimal spec. For locator/assertion examples, read playwright-authoring/recipe only when that auxiliary skill is pinned.

Submit the complete body and full metadata to update_module_candidate; module.harness imports @lib/<slug> and exercises the exported function with meaningful assertions. Body and harness are self-tested together. A failed update preserves the last passing candidate: inspect the actual error and repair without weakening the user's assertions. Login references configured role IDs, never credential values.

After a successful candidate, use request_module_validation to request independent validation after this Worker is reclaimed. Self-test and validation do not publish. Budget failure stops the Stage; Module work does not produce a partial artifact.

Finish with JSON containing only message and optional conversationSummary. State actual evidence and remaining work. The guard supplies the last passing body/metadata and validation flag; model final text cannot select a different candidate. If tools cannot produce a passing candidate, report the blocker without claiming a saved Module or version. Human publication remains separate.
