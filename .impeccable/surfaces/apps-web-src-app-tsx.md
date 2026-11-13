---
version: 1
slug: "apps-web-src-app-tsx"
primary_target: "apps/web/src/App.tsx"
related_targets: []
---

# Surface brief: Whippet web app (apps/web)

Scope: whole front end. Mode: Operate. Primary surface: the chat editing workspace. Audience: QA who do not know Playwright; desktop-first; occasional engineers. Task: describe a test in conversation, watch AI work, verify, explicitly publish, run formal versions, read reports. Constraint: AI turns run in the background; leaving must never need a confirm and returning shows results.

## Direction contract

THESIS: Every AI turn is a parcel with a tracking trail (改稿 → 驗證 → 摘要 → 待發佈); the refused default is a plain chat with a spinner and a form page of stacked panels.
OWN-WORLD: Taiwan courier tracking plus carbonless triplicate forms. Carbon-blue ink (#1f3fae) on a deep ink-blue rail, cool white ground; yellow, pink and pale-blue copy colours used only as 3px top edges marking artifact kind. System sans plus tabular figures; mono for script and ids only.
STORY: QA sees which tests are at which station without opening them, leaves, and returns to a lit item; publishing stays an explicit human act with visible conditions.
FIRST VIEWPORT: 288px ink-blue rail (workspace switcher, new test, tests each with a four-segment trail and unread light); centre feed (user bubbles right, assistant turns with trail card and script-diff artifact, composer docked at bottom, typing allowed while AI runs); 440px right panel with tabs 腳本 / 驗證與發佈 / 紀錄與畫面 / 背景.
FORM: shipping-tracking timeline in an app shell, candidate A from list position 7. seed: 4570077f47693da0
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
