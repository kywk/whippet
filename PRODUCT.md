# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要使用者是不懂 Playwright 的 QA，在桌面瀏覽器日常使用；偶爾有工程師進入「手動修改腳本」的進階入口。使用者的工作是用自然語言描述要驗證的流程，讓 AI 產生 Playwright 測試，檢視驗證結果後明確確認發佈，之後從測試詳情執行正式版本並查看報告。使用者會同時關心多個 Workspace 與多個測試，不一定盯著畫面等 AI 完成。

## Product Purpose

Whippet 是 self-hosted 的 Playwright 測試工作台：QA 透過對話建立與修改測試，AI 在受限範圍內探索網站、改寫腳本並執行真實驗證，QA 看過報告與驗收摘要後才發佈不可變版本；已發佈版本由遠端 Worker 執行並提供報告與唯讀即時畫面。成功是 QA 不必看懂程式，也能完成建立、對話修改、驗證、確認發佈與正式執行。

## Positioning

「對話產出的是真實可驗證的測試資產」：AI 文字不能代替測試通過；驗證是綁定 revision 的真實 Run，發佈資格由 Server 強制，且須人工明確確認。對手的聊天工具不會把驗證、報告、版本與發佈資格放進同一條對話。

## Operating Context

- 資料單位：Workspace（驗測目的、網站範圍、登入角色、非機密背景）→ Test → 編輯週期（草稿 revision、專屬對話）→ 驗證 Run → 發佈版本 → 正式 Run 與報告。
- AI 任務、驗證與正式執行都是 Server 端 Run（排隊、執行、取消、逾時、失敗、中斷待對帳）；對話等待使用者時釋放 Worker。
- 對話與草稿由 Server 保存，離開再回來可接續；連線中斷不自動重跑任務。
- 機密（帳密）只走專用欄位，不進對話或模型。

## Capabilities and Constraints

- 已確認需求見 docs/requirements/mvp.md 與 docs/requirements/ai-workspace.md；前端位於 apps/web（React + Vite + TypeScript），後端契約見 contracts/。
- 使用者要求（2026-11-13）：對話編輯工作區的互動應像 ChatGPT／Claude 等 AI 聊天，一來一往，過程產物（腳本變更、驗證、報告、摘要）以對話中的產物呈現；AI 任務可在背景等候與完成，使用者不必停留在前景。
- 發佈規則不可弱化：最新 revision 成功驗證、報告保存、摘要有效、無未儲存變更，且 QA 明確確認。
- 工程師手動修改腳本保留，置於明確進階入口。
- MVP 不含：平台真實登入／RBAC、多人即時協作、Workspace 刪除、排程／CI 觸發。

## Brand Commitments

只保留名稱 Whippet。現有綠色 logo 與主色 #285c46 不受保留約束，視覺世界可完全重來（使用者確認）。語言為繁體中文（台灣用語）。

## Evidence on Hand

真實契約與流程文件、apps/web 既有功能與 mock 模式（VITE_USE_MOCK=true）。沒有真實客戶、使用數據或第三方證言；不可捏造。

## Product Principles

1. 對話是工作的主線：QA 在一條時間軸上看到需求、AI 回覆與每一項過程產物，不必在多個區塊間跳轉。
2. 真實證據勝過 AI 文字：驗證狀態與報告來自 Server，任何「已通過」都能追溯到 Run。
3. 離開不等於中斷：任務在背景完成，回來時看到結果；任何進行中的工作不應綁住畫面。
4. 發佈是明確的人為決定：資格條件清楚可見，確認動作不被隱藏也不被簡化成預設。
5. 工程師入口存在但不搶主流程。

## Accessibility & Inclusion

桌面優先，仍須可用鍵盤操作、有可見焦點、足夠對比；狀態不只靠顏色；尊重 reduced motion。介面為繁體中文，須可容納長中文與長英文 identifier 換行。
