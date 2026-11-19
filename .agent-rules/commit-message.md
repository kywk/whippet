# 提交訊息

[主規範](../AGENTS.md)

- 採用 Conventional Commits 1.0.0。標題格式為 `type(scope): subject`，`scope` 用主要模組名稱，例如 `web`、`server`、`worker`。省略範圍時使用 `type: subject`。[Conventional Commits 規格](https://www.conventionalcommits.org/en/v1.0.0/)
- `feat` 用於新增功能，`fix` 用於修正錯誤。其他類型依目的選用 `docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 或 `revert`。
- 冒號後的 `subject` 用英文小寫動詞原形開頭，具體描述變更，最多 50 個字元，結尾省略句點。
- 需要補充動機或影響時，標題後空一行再寫內文，每行約 72 個字元。相關 issue 可放在尾註，與前一段空一行。[Git Book 的提交指引](https://git-scm.com/book/en/v2/Distributed-Git-Contributing-to-a-Project.html#_commit_guidelines)
- 破壞相容性時，在標題的冒號前加 `!`，或用 `BREAKING CHANGE: <description>` 尾註。說明受影響的用法與遷移方式。
- 提交前對照將納入的變更，確認訊息反映實際內容。已暫存的變更可用 `git diff --cached` 檢查。

```text
feat(tests): confirm similar cases before authoring
fix(author): support intent providers with implicit tool choice
docs: define commit message conventions
```
