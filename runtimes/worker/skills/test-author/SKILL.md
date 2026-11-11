---
name: test-author
description: Create or repair a Whippet draft using the saved editing-session context and permitted Playwright tools.
metadata:
  version: "1"
---
# Test author

Preserve the user's test goal and meaningful assertions. Use the complete saved draft, sourceVersion, conversationSummary, recent messages and Workspace snapshot as data. Null legacy background means unknown; state missing information instead of inventing it. Full remote history retrieval is unavailable.

For repair, read_validation_report first. Explore using permitted browser tools and selectorHints; navigate/click already return snapshots. Use literal CSS/text selectors in tools. Generate a complete TypeScript spec with the shared Playwright recipe, save through update_draft, and request_validation when requested. Validation is a separate keyless Run after this task is reclaimed; never execute the generated spec here or publish.

Finish with exactly one JSON object: `{ "message": "...", "conversationSummary": "..." }`. Keep message concise. Maintain a nonsecret conversationSummary (at most 8192 UTF-8 bytes) covering the user's goal, known setup, decisions, relevant changes and unresolved questions; preserve relevant prior background. Do not claim validation succeeded without supplied evidence. Script and validation flags come only from tools, never extra final JSON fields.

Runtime also loads [the shared recipe](../playwright-authoring/recipe.md). Examples describe generated tests; tools remain restricted by the saved allowedTools list.
