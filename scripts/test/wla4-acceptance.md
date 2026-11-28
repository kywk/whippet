# WLA-4 本機黑箱驗收

`w1` 驗訪客設定，需整合 WLA-1 的三端。`final` 另驗 WLA-2、WLA-3，應在這兩波整合後執行。兩者都由同一份來源快照建置 Web、Server、Manager 與 Worker。驗收條件依 [v15 契約](../../contracts/mvp-v15.md)及 [A1–A6](../../docs/requirements/workspace-test-accounts/spec.md#驗收情境)。

## 建置

本機需有 Git、Docker、Node、Go、Python 3.9 以上、OpenSSL、Python Playwright 及 Chromium。使用已有的 `postgres:16`，也可在執行時以 `--postgres-image` 指定本機映像。Server 預設以 Docker daemon 的架構建置為 Linux 執行檔，建置時可用 `--linux-goarch arm64` 或 `--linux-goarch amd64` 指定。Manager 在本機執行。

從整合 checkout 根目錄執行。`--commit` 可傳入任一包含 WLA-4 的整合 commit。要驗目前的檔案，改用 `--worktree`。它會納入 Git 追蹤檔、目前的編輯與 Git 未忽略的新增檔；擷取快照期間請暫停編輯。快照排除 Git 中繼資料、慣用的本機機密路徑（如 `.env.local`、`.npmrc`、私鑰檔）、已知的建置產物與依賴目錄。公開的 `.env.example` 範本可保留。

~~~sh
WLA_LAB=$(mktemp -d /tmp/whippet-wla4.XXXXXX)
WLA_BUILD="$WLA_LAB/build"
python3 scripts/test/wla4-build.py build --commit HEAD --out "$WLA_BUILD"
# 工作目錄模式可用同一個新輸出路徑取代上面那行
# python3 scripts/test/wla4-build.py build --worktree --out "$WLA_BUILD"
~~~

建置目錄須在 checkout 外且尚未存在。`source/` 保存快照，`web-build/` 是供 `npm ci`、Vite 及預覽使用的副本。`build.json` 記錄來源模式、完整基準 commit、來源 SHA-256、Web `dist` 摘要、兩個 Go 執行檔的 SHA-256，以及正式 Worker 與 WLA 測試映像的 Docker ID 和標籤。比對 `source.sha256` 可確認重建的來源內容是否相同，摘要涵蓋相對路徑、檔案內容與可執行位元。建置失敗時，紀錄保留已完成的產物及停止階段。

## 執行

`run` 核對已建置的快照與產物，使用映像 ID 啟動快照內的 `adm4-local.py`。`--` 後面的選項傳給既有 runner，可加 `--browser-executable` 指定已安裝的 Chromium。每次執行使用 checkout 外的新 `--out`，避免後續快照納入驗收產物。

~~~sh
python3 scripts/test/wla4-build.py run --build-dir "$WLA_BUILD" --out "$WLA_LAB/w1" -- --wla w1

python3 scripts/test/wla4-build.py run --build-dir "$WLA_BUILD" --out "$WLA_LAB/final" -- --wla final
~~~

定向重跑時，沿用 `--build-dir` 並指定新的 `--out`。在 `--wla final` 後可加 `--wla-focus`，選擇 `a2`、`a3`、`a4`、`a5`、`a6` 或 A5 的單一入口 `builtin`、`vercel`、`pi`、`mcp-interactive`、`mcp-claim`。例如下列指令只驗 MCP 接單與它需要的已驗證帳號和訪客 Workspace。

~~~sh
python3 scripts/test/wla4-build.py run --build-dir "$WLA_BUILD" --out "$WLA_LAB/retry-claim" -- \
  --wla final --wla-focus mcp-claim
~~~

測試映像保留正式 Worker，僅用 preload 回應 `.invalid` 的 Responses 呼叫。Go Server 將意圖檢查送到 Manager，由 Manager 呼叫綁定 loopback 的 HTTPS 合成供應商。`final` 會核對快照與 Worker 映像內的工具 registry、合成供應商檔案及登入驗證入口。`adm4-local.py` 每次啟用獨立 PostgreSQL、loopback Web、TLS Server、Manager、Docker bridge 商店及工作目錄，離開時按該次資源名稱與 Manager label 清理。兩個登入目標用不同連接埠形成不同 origin，共用第三個登入 origin 與 `m10-shop` 帳密表單。

| 情境 | 實際檢查 |
| --- | --- |
| A1 訪客，兩波皆執行 | Web 建 Workspace、送訪談、重開原提案、使用逐站回覆按鈕並套用只測訪客。Server 拒絕未知與缺登入證據的提案，零帳號訪客套用成功。 |
| A2 多站 | 同一合成登入服務供兩個不同 origin 使用。第一站驗過後，第二站的已送出表單仍無法套用。修正成功條件並取得第二站證據後，從 Web 套用。 |
| A3 失敗與重試 | 第二因素提示、錯誤密碼、重開、修正後重試。結果轉送器暫存真 Manager 的成功 frame，等新提案完成失敗驗證後原樣放行，核對新提案仍受阻。 |
| A4 管理 | 管理員修改兩個同角色帳號的用途，QA 寫入遭拒。新任務觀察新用途，輪替一個帳號保留其他證據，草稿期間正式設定繼續有效。 |
| A5 各入口與隔離 | 內建、Vercel、Pi 各驗錯站拒絕、指定帳號及受保護頁面、回報缺項。MCP 互動與接單使用真瀏覽器租約並驗另區帳號拒絕。接單腳本經正式 Worker 驗證，一個帳號建立新訂單，另一帳號登入後讀取回 404。 |
| A6 舊角色 | 只在該次 PostgreSQL 預置 v8 設定與角色 ID，沿舊專用欄位保存測試帳密。以舊 `loginAs` 腳本在重開提案前後驗證，確認缺證據與過期版本遭拒，既有 Run 快照內容可重讀。 |

每次 `run` 的輸出目錄都有同一份 `build.json`。`wla/wla4-acceptance.json` 記錄各通過項、Run／attempt 識別、定向案例 `focus` 和失敗階段，`wla/runtime.json` 記錄實際使用的測試映像 ID。`wla/keys-scan.json` 掃描落地證據、ZIP 及 Playwright HTML 內嵌報告中的合成帳密標記。合成供應商另外在真模型傳輸接點拒收任何帶標記的模型請求。掃描涵蓋資料與檔案內容，LiveView 影格的視覺遮蔽須另實測。

## 重跑同源建置驗收 A1

在獨立 checkout 為 Web 和 Server 加入可辨識的未提交標記。Web 同時加入一個新的靜態檔，並以合成 `.env.local` 和過期 `dist` 檔檢查快照排除條件。兩份建置各執行 `w1` 訪客案例。驗收情境見[整合驗收規格](../../docs/requirements/acceptance-reliability/spec.md#驗收情境)。

~~~sh
WLA_ROOT=$(git rev-parse --show-toplevel)
WLA_ENTRY="$WLA_ROOT/scripts/test/wla4-build.py"
WLA_A1=$(mktemp -d /tmp/whippet-wla4-a1.XXXXXX)
git clone --quiet --shared "$WLA_ROOT" "$WLA_A1/checkout"
cd "$WLA_A1/checkout"
WLA_BASE=$(git rev-parse HEAD)

python3 - <<'PY'
from pathlib import Path

html = Path("apps/web/index.html")
original = html.read_text(encoding="utf-8")
assert "<title>" in original
html.write_text(original.replace("<title>", "<title>wla-a1-web-probe ", 1), encoding="utf-8")
Path("apps/web/public").mkdir(exist_ok=True)
Path("apps/web/public/val1-new-source.txt").write_text("wla-a1-web-added\n")
Path("services/server/cmd/server/wla_source_probe.go").write_text(
    'package main\n\nimport "log"\n\nfunc init() { log.Print("wla-a1-server-probe") }\n'
)
Path("apps/web/.env.local").write_text("WLA_TEST_CREDENTIAL=val1-synthetic\n")
Path("apps/web/dist").mkdir(exist_ok=True)
Path("apps/web/dist/val1-stale.txt").write_text("stale output\n")
PY

python3 "$WLA_ENTRY" build --commit "$WLA_BASE" --out "$WLA_A1/commit"
python3 "$WLA_ENTRY" build --worktree --out "$WLA_A1/worktree"
for mode in commit worktree; do
  python3 "$WLA_ENTRY" run --build-dir "$WLA_A1/$mode" --out "$WLA_A1/$mode-w1" -- --wla w1
done

python3 - "$WLA_A1" "$WLA_BASE" <<'PY'
import json
from pathlib import Path
import sys

root, base = Path(sys.argv[1]), sys.argv[2]
source_ids = {}
for mode in ("commit", "worktree"):
    edited = mode == "worktree"
    build, evidence = root / mode, root / f"{mode}-w1"
    manifest = json.loads((build / "build.json").read_text())
    assert manifest["status"] == "passed" and manifest["source"]["mode"] == mode
    assert manifest["source"]["baseCommit"] == base
    source_ids[mode] = manifest["source"]["sha256"]
    dist = build / manifest["artifacts"]["web"]["path"]
    assert ("wla-a1-web-probe" in (dist / "index.html").read_text(encoding="utf-8")) == edited
    assert (dist / "val1-new-source.txt").is_file() == edited
    assert (b"wla-a1-server-probe" in (build / "server").read_bytes()) == edited
    assert (b"wla-a1-server-probe" in (evidence / "wla/server.log").read_bytes()) == edited
    assert not (build / "source/apps/web/.env.local").exists()
    assert not (build / "source/apps/web/dist").exists()
    assert json.loads((evidence / "build.json").read_text()) == manifest
    assert json.loads((evidence / "wla/wla4-acceptance.json").read_text())["status"] == "passed"
    assert json.loads((evidence / "wla/runtime.json").read_text())["workerDigest"] == manifest["artifacts"]["wlaWorker"]["imageId"]
assert source_ids["commit"] != source_ids["worktree"]
print(json.dumps(source_ids))
PY
~~~
