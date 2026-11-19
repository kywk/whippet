# 提交訊息

[主規範](../AGENTS.md)

- 每筆提交都須包含標題與內文，兩者之間空一行。
- 採用 Conventional Commits 1.0.0。標題格式為 `type(scope): subject`，`scope` 用主要模組名稱，例如 `web`、`server`、`worker`。省略範圍時使用 `type: subject`。[Conventional Commits 規格](https://www.conventionalcommits.org/en/v1.0.0/)
- `feat` 用於新增功能，`fix` 用於修正錯誤。其他類型依目的選用 `docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 或 `revert`。
- 冒號後的 `subject` 用英文小寫動詞原形開頭，具體描述變更，最多 50 個字元，結尾省略句點。
- 內文交代變更動機與具體改動，有使用影響時一併說明。可補上相關驗證的實際結果。每行約 72 個字元。[Git Book 的提交指引](https://git-scm.com/book/en/v2/Distributed-Git-Contributing-to-a-Project.html#_commit_guidelines)
- 尾註與內文空一行。相關 issue 可列在尾註。
- 破壞相容性時，在標題的冒號前加 `!`，或用 `BREAKING CHANGE: <description>` 尾註。說明受影響的用法與遷移方式。
- Agent 提交時，最後一行使用 `Co-Authored-By: <LLM Model>`。列出實際參與這筆變更的主 Agent 與 subagent 所使用的模型名稱。同一模型只列一次，多個模型以 `, ` 分隔。
- 提交前用 `git diff --cached` 核對標題與內文，並確認尾註列出的模型。提交後用 `git log -1 --format=%B` 確認實際寫入的內文與尾註完整。

## 多模型提交範例

```text
feat(tests): confirm similar cases before authoring

Authors need to see existing coverage before starting a similar test.

Compare early requests with published test names, descriptions and
tags. Offer to edit the matching test or continue creating a new one.
Clear the suggested case from the new task context when users continue.

Co-Authored-By: Muse Spark 1.3 Contributor, GPT-6.2-Sol
```
