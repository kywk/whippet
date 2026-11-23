# CodeGraph 索引

[CodeGraph](https://github.com/colbymchenry/codegraph) 在本機建立程式碼知識圖譜，供 Agent 以單次查詢取代 grep＋Read 迴圈。索引只留在 `.codegraph/`，不進 Git。

## 安裝

```sh
# 1. 安裝 CLI（需要 Node.js；也可改用官方 install.sh）
npm install -g @colbymchenry/codegraph

# 2. 設定 Agent 的 MCP server；--init 同時建立本專案索引
codegraph install --yes --init
```

若已設定過 Agent，只需建立本專案索引：

```sh
codegraph init --local-only --yes
```

## Git hook

```sh
sh scripts/codegraph/install-hooks.sh
```

安裝後 `core.hooksPath` 指向版控中的 `.githooks/`。`post-commit` 只在 `main` 分支執行：

1. 以 `scripts/codegraph/reindex.sh` 背景重建完整索引，不阻塞 commit。
2. 併發觸發會合併成至多一次追加重建，避免連續 commit 疊加重建。
3. 日誌位於 `.codegraph/reindex.log`，hook 啟動錯誤位於 `.codegraph/hook.log`。

自動同步（檔案異動即時更新）仍由 CodeGraph 的背景服務負責；此 hook 是在 `main` 每次提交後補一次完整重建，確保索引與提交一致。

## 驗證

```sh
codegraph status
tail -n 20 .codegraph/reindex.log
```

## 移除

```sh
git config --unset core.hooksPath   # 只移除 hook 設定
codegraph uninit                    # 移除本專案索引
```
