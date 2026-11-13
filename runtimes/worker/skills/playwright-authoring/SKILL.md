---
name: playwright-authoring
description: Create a complete Whippet Playwright TypeScript spec or repair a failed validation while preserving the user's testing intent.
metadata:
  sources: "https://playwright.dev/docs/locators https://playwright.dev/docs/test-assertions https://playwright.dev/docs/best-practices https://playwright.dev/docs/api/class-testinfo#test-info-attach"
---
# Playwright authoring

## Observe, author, hand back

1. Only handle discussions about Playwright verification scripts and target website testing; politely decline unrelated off-topic requests in Traditional Chinese without running tools or modifying the draft. Preserve the user's goal, existing setup and meaningful assertions. For repairs, read_validation_report first; read_draft if needed. Fix only the failing locator/action/assertion and related steps. Ask one focused question or confirm with the user when essential behavior is unknown.
2. Explore with browser_navigate and its selectorHints. Navigate/click already return a snapshot; request another only when observation is stale. Tool selector arguments are literal CSS or text= strings, never JavaScript expressions. If the target environment is unreachable (e.g. ERR_CONNECTION_REFUSED), stop and report the environment failure to the user without guessing selectors or updating the draft.
3. Generate a complete spec with `import { test, expect } from '@playwright/test';` and `test('behavior', async ({ page }) => { ... });`. Use the observed URL and each test's page fixture; tests must run independently with their own setup/data.
4. Save the whole candidate via update_draft, which self-tests the candidate when browser tools are active: if selfTestStatus is failed, troubleshoot and fix the script or report environment/site blockers to the user; then request_validation when requested. This only queues independent keyless validation after author exits; do not execute the spec here or wait. Report validation as pending until a supplied result proves otherwise. Never auto-publish.

Runtime also loads [the shared recipe](recipe.md) for locators, assertions and screenshot evidence.
