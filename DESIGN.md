---
name: Whippet
description: Carbonless-slip courier-tracking studio for QA teams authoring and verifying Playwright workflows in Traditional Chinese.
colors:
  primary: "#1f3fae"
  primary-hover: "#18328e"
  primary-active: "#12266e"
  rail-ink: "#101c52"
  rail-surface: "#18286b"
  rail-selected: "#223585"
  rail-foreground: "#eef2ff"
  rail-muted: "#b8c6f2"
  cool-ground: "#f4f6fb"
  paper-white: "#ffffff"
  subtle-wash: "#eef2fa"
  line-rule: "#d6ddec"
  ink-primary: "#16213f"
  ink-muted: "#525e7d"
  slip-yellow: "#f4d35e"
  slip-blue: "#6f9ceb"
  slip-pink: "#e88da3"
  status-ok: "#166d42"
  status-ok-bg: "#e6f5ec"
  status-run: "#965800"
  status-run-bg: "#fff4d6"
  status-bad: "#b3261e"
  status-bad-bg: "#fdecea"
typography:
  display:
    fontFamily: "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1.9rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  title:
    fontFamily: "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.92rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "0em"
  body:
    fontFamily: "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0em"
  label:
    fontFamily: "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.02em"
  mono:
    fontFamily: "\"JetBrains Mono\", \"SFMono-Regular\", Menlo, Consolas, ui-monospace, monospace"
    fontSize: "0.76rem"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0em"
rounded:
  xs: "2px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper-white}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
    height: "38px"
  button-danger-outline:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.status-bad}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
    height: "38px"
  chip-neutral:
    backgroundColor: "{colors.subtle-wash}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  composer-shell:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.xl}"
    padding: "10px 12px 8px"
  triplicate-slip:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
---

# Design System: Whippet

## Overview

**Creative North Star: "The Carbonless Waybill"**

Whippet treats automated end-to-end testing like a courier dispatch desk paired with carbonless triplicate slips rather than a dark code IDE. QA specialists describe what they want checked in plain Traditional Chinese, watch live background progress pass cleanly from station to station, inspect human-readable receipts and rendered verification reports, and only ship a formal release once every dispatch gate is verified and explicitly confirmed.

The visual temperature pairs a deep carbon-ink navigation rail with a cool white working desk so eye-strain stays low across long triage sessions while every running, unread, passed, or blocked state reads at a glance. Semantic color is rationed like ink stamps on a paper waybill: clean hairlines, tabular numbers, and a strict separation between conversational QA work and advanced script overrides keep complexity tucked behind explicit doors.

Confirmed visual rejections include the legacy dark forest-green shell (`#285c46`), raw monospace IDE-first chrome, fake tactile bevels or physical-paper textures, modal blocking alerts on navigation, and colored vertical side stripes on list rows.

**Key Characteristics:**
- Deep indigo ink navigation rail anchoring a high-luminance cool studio workspace
- Carbonless triplicate top edges coding in-chat artifacts (`slip-yellow` trail, `slip-blue` script change, `slip-pink` verification)
- Four-station progress grammar (`改稿 → 驗證 → 摘要 → 發佈`) shared across mini rail bars, inline trail cards, and login orientation
- Monospace restricted strictly to Playwright script lines, diff blocks, timestamps, and identifiers; Traditional Chinese UI labels remain in clean humanist sans

## Colors

The palette contrasts authoritative carbon-blue ink against cool studio paper, holding warm yellow strictly for active attention and unread completion signals.

### Primary
- **Carbon Blue** (`primary`): Primary dispatch CTAs (confirming formal runs, submitting composer turns, confirming publication), active mode indicators, and interactive link accents, shifting to **Carbon Hover** (`primary-hover`) and **Carbon Active** (`primary-active`) on interaction.

### Secondary
- **Deep Dispatch Indigo** (`rail-ink`): Left navigation rail, brand panel on login, and responsive mobile top bar, stepped up cleanly to **Indigo Step** (`rail-surface`) on hover and **Indigo Active** (`rail-selected`) for selected test rows.

### Tertiary
- **Triplicate Slip Pigments** (`slip-yellow`, `slip-blue`, `slip-pink`): Three muted carbonless slip hues reserved strictly for artifact classification bars and unread/active station markers.

### Neutral
- **Cool Studio Desk** (`cool-ground`): Canvas behind the conversational timeline and overview grid.
- **Receipt Paper** (`paper-white`): Clean workspace headers, chat composer dock, inspection panels, and artifact slip bodies.
- **Tonal Wash & Hairlines** (`subtle-wash`, `line-rule`): Segmented mode tracks, hover washes, and single-pixel structural dividers replacing heavy card shadows.
- **Ink & Slate** (`ink-primary`, `ink-muted`): High-contrast dark indigo body ink and secondary metadata ink calibrated for ≥4.5:1 readability.
- **Operational Semantic Pairings** (`status-ok` / `status-ok-bg`, `status-run` / `status-run-bg`, `status-bad` / `status-bad-bg`): Verification pass badges, active running pills, and isolated danger/failure states.

### Named Rules
**The Three-Slip Top Edge Rule.** The triplicate slip pigments (`slip-yellow`, `slip-blue`, `slip-pink`) appear exclusively as 3px top accent borders marking in-chat artifact types (plus the unread completion indicator and active segment on `slip-yellow`) — never as vertical left/right borders on list rows or arbitrary decorative chips.

**The Cool Ground Purity Rule.** Workspace backgrounds stay strictly on `cool-ground` and `paper-white` neutrals; warm cream grounds are excluded so ink-blue controls and amber running stamps hold crisp separation.

## Typography

**Display Font:** Noto Sans TC (with PingFang TC, Microsoft JhengHei, system sans fallback)
**Body Font:** Noto Sans TC (with PingFang TC, Microsoft JhengHei, system sans fallback)
**Label/Mono Font:** JetBrains Mono (with SFMono-Regular, Menlo, Consolas, ui-monospace fallback)

**Character:** Humanist CJK sans conveys calm operational clarity without programmer jargon, paired with tabular monospace numerals and crisp code columns only where identifiers, times, and Playwright scripts appear.

### Hierarchy
- **Display** (`weight: 700`, `1.9rem`, `line-height: 1.35`, `letter-spacing: -0.03em`): Login workspace headline only.
- **Headline** (`weight: 700`, `1.25rem`, `line-height: 1.35`, `letter-spacing: -0.02em`): Active test title and workspace conversation header.
- **Title** (`weight: 700`, `0.92rem`, `line-height: 1.45`): Section titles, card headers, and button labels (`0.84rem`, `weight: 600`).
- **Body** (`weight: 400`, `0.875rem`, `line-height: 1.65`): Conversation prose capped around `68ch` measure for easy reading.
- **Label** (`weight: 600`, `0.75rem`, `line-height: 1.4`): Status pills, metadata keys, and form hints.
- **Mono** (`weight: 400`, `0.76rem`, `line-height: 1.65`, `tabular-nums`): Playwright script viewers, line diffs, run IDs, revision numbers, and timestamps.

### Named Rules
**The Mono Scoped to Tokens Rule.** Never apply the monospace font stack to mixed Traditional Chinese copy (`設定 revision 2`, `已儲存`); apply monospace solely to the code block, diff, count badge, timestamp, revision numeral, or run identifier.

## Layout

Desktop uses a full-height (`100svh`) non-scrolling outer frame split into two columns: a fixed `288px` left dispatch rail and a flexible main workspace pane (`minmax(0, 1fr)`). Inside editing mode, the workspace divides again into a fluid centered conversational column (`720px` chat column + `768px` bottom-docked composer) and a `440px` right inspection drawer with four tabs (`腳本`, `驗證與發佈`, `紀錄與畫面`, `背景`).

Overview mode switches the main pane into a scrollable `1320px` two-column summary (`1.25fr` formal run status & history, `0.95fr` version list & read-only formal script).

Responsive breakpoints adapt in two clean steps without horizontal overflow:
- **`≤ 1220px` (Tablet / Compact Desktop):** The `440px` inspection panel slides out as a fixed right drawer toggled from the chat bar, expanding the chat column to full workspace width.
- **`≤ 960px` (Narrow Tablet / Mobile Shell):** A persistent deep-indigo top bar replaces the fixed rail, sliding the `288px` rail in from the left as an overlay drawer; the overview grid collapses into one column.
- **`≤ 680px` (Phone):** Test headers stack vertically with full-width primary action, mobile chat toolbar compacts onto a single non-wrapping line, composer keeps voice input + truncated hint + pinned right submit button on one row, and data tables tighten cell padding to fit within `390px`.

## Elevation & Depth

Whippet relies primarily on crisp tonal contrast (`cool-ground` behind `paper-white` sheets) and `1px` `line-rule` hairlines rather than drop-shadow stacks. Surfaces sit flat at rest; mild ambient shadows are reserved exclusively for floating interactive docks, overlays, and slide-over drawers.

### Shadow Vocabulary
- **Slip Ambient (`box-shadow: 0 2px 6px rgba(16, 28, 82, .04)`)**: Subtle lift separating in-chat triplicate artifacts from the cool workspace canvas.
- **Composer Dock (`box-shadow: 0 8px 24px rgba(16, 28, 82, .07)`)**: Grounding lift around the always-typable bottom input box.
- **Floating Control / Card (`box-shadow: 0 6px 16px rgba(16, 28, 82, .12)` to `0 12px 32px rgba(16, 28, 82, .06)`)**: Jump-to-latest pill and login form panel.
- **Slide-Over Drawer (`box-shadow: -12px 0 36px rgba(16, 28, 82, .18)`)**: Mobile and tablet inspection drawer over darkened scrim (`rgba(16, 28, 82, .32–.48)`).

### Named Rules
**The Flat-By-Default Rule.** Overview panels, history summaries, and draft version rows never nest boxed borders or tinted rounded sub-cards inside already bordered white sections; separate nested entries with whitespace and hairline horizontal rules only.

## Shapes

Corners follow a restrained, functional radius ladder: sharp `2px` ticks on mini rail progress segments, `6px` on compact interior badges and tab switches, `8px` (`rounded.md`) on interactive controls (buttons, inputs, rail test items), `10px–12px` (`rounded.lg`) on structured artifact cards and panels, `14px` (`rounded.xl`) on the composer container, and full pills (`999px`) exclusively for status badges, station nodes, and jump-to-latest actions.

Icons use uniform `1.6px` stroke geometry on a crisp `20×20` viewBox (`18×18` default render) alongside a stacked triplicate-slip `W` brand emblem.

## Components

### Buttons
Confidence through clean fill hierarchy and tactile `150ms ease-out` color transitions without scale jumps.
- **Shape:** Gently rounded (`8px`), `38px` minimum touch target height (`32px` compact toolbar variant).
- **Primary:** Solid Carbon Blue (`#1f3fae`) with white label, `7px 14px` padding; reserved for `執行正式版本`, sending chat turns, and the final enabled `確認發佈` gate.
- **Hover / Focus:** Shifts to `#18328e` on hover (`#12266e` active) with high-visibility `2px solid #2b54db` focus ring offset `2px`.
- **Secondary / Quiet / Danger:** Outlined white surface with hairline border for verification and workspace actions; transparent quiet style for inline reloads; outlined/solid `#b3261e` isolated strictly inside the danger zone for test/draft deletion.

### Chips
Compact pill indicators distinguishing status at a glance without competing with primary CTAs.
- **Style:** Full pill (`999px`), `2px 9px` padding, `0.75rem` weight `600`, paired semantic text on soft background washes (`status-ok`, `status-run`, `status-bad`, or neutral `subtle-wash`).

### Cards / Containers
Structured sheets with hairline borders; never double-nested with extra rounded inner boxes.
- **Corner Style:** Rounded panel corners (`12px` overview/inspector cards, `10px` chat slips).
- **Background:** Crisp `paper-white` on `cool-ground`, `#fbfcff` header/footer strips on artifact slips.
- **Shadow Strategy:** Flat `1px` border at rest on overview cards; subtle `Slip Ambient` shadow on in-chat artifacts.

### Inputs / Fields
Clean rectangular text inputs and expandable composer dock with explicit contrast and IME safety.
- **Style:** `1px solid #c3cde3` border, `paper-white` fill, `8px` radius on standard inputs (`14px` on composer container), `#5b6888` placeholder ink (≥4.5:1 contrast).
- **Focus:** Smooth `140ms ease-out` border shift to `primary` (`#1f3fae`) plus `2px` focus-visible ring on interactive elements.

### Navigation
High-contrast `288px` Deep Indigo rail listing workspaces, test search, test items with live 4-segment mini progress bars and unread yellow indicator dots, and collapsed workspace capability drawer; switches cleanly to an overlay drawer below `960px`.
- **Selected Item State:** Elevated `rail-selected` fill (`#223585`) with full-perimeter `1px` inset border (`#4b62b8`) — no colored side stripe.

### Triplicate Slip Artifacts & Tracking Trail
In-chat structural cards anchored by a `3px` top colored edge classifying the artifact:
- **Tracking Trail (`slip-yellow` top bar):** Vertical 4-station timeline (`改稿 → 驗證 → 摘要 → 發佈`) with circular completed/active/failed station nodes, timestamps, background-safe hint, and direct action footer (`前往確認發佈` / `監看與紀錄` / `取消執行`).
- **Script Change (`slip-blue` top bar):** Collapsible LCS line diff with green/red change highlights, `+N -M` counts, and non-destructive candidate script application.
- **Validation Slip (`slip-pink` top bar):** Continuation validation status badge, verification report link, and expandable error trace.

## Do's and Don'ts

### Do:
- **Do** keep left-rail 4-segment trails and `slip-yellow` unread lights synced with background server execution so QA users can switch tests freely without confirmation blockers.
- **Do** isolate engineer script editing behind the explicit collapsible advanced drawer and keep credentials strictly inside the dedicated `登入資料` tab.
- **Do** reserve Carbon Blue filled primary buttons for canonical dispatch milestones (`執行正式版本`, composer send, enabled `確認發佈`).
- **Do** apply tabular monospace (`font-mono`) strictly to scripts, diffs, counts, IDs, revision numbers, and timestamps.

### Don't:
- **Don't** add colored vertical left/right accent stripes (`border-left`, inset side shadow) to rail items, cards, or alerts.
- **Don't** nest bordered or tinted sub-cards inside overview cards or side-panel sections; use whitespace and `1px` horizontal rules instead.
- **Don't** interrupt chat navigation with unsaved/busy confirmation dialogs for AI background runs; persist unsent composer text in `localStorage` instead.
- **Don't** drop `.send-button` onto a second row on narrow mobile screens; keep voice trigger, truncated helper copy, and submit button aligned on a single composer row.
