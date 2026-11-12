# 本機映像第三方組件與待補聲明

2026-11-12（Asia/Taipei）實物盤點。已核實五個本機映像的 OS、主要 runtime、部分授權檔位置與 SHA-256；**尚未完成可發布的完整第三方聲明**。本文件不作法律合規結論，也不替 Whippet 選定 LICENSE。

## 證據範圍

- 依指定 QA 映像實物取證，不以 Dockerfile 標籤、Playwright 授權或套件 metadata 代表整張映像。
- 映像皆為 `linux/arm64`。這批沿用既有 runtime、以 COPY 更新產物的 QA 映像，不是正常 Dockerfile 乾淨建置、基底來源或其他架構的驗收證據。
- 僅讀取映像 ID／RepoDigests／OS／architecture；未 inspect Env、讀取部署環境檔、掛載 repo／Docker socket、使用網路、安裝或下載。
- 版本探測使用新建的離線唯讀容器，覆寫產品 entrypoint，不啟動服務；完成即移除該容器及其匿名 volume。既有服務、容器及 volume 未操作。
- Go 版本取自映像內 binary 的內嵌 build info，不執行 Server／Manager；瀏覽器只取版本，不代表完成瀏覽器功能驗收。

| 本機 tag | 核實的 image ID（SHA-256） |
| --- | --- |
| `whippet-server:m9-qa` | `301c06c4dc6a3bf84df4d3f7b3e3db8544afec9ff232a693c06fc5221dc10333` |
| `whippet-manager:m9-qa` | `386ee8341ec600d1f32872e2167605bae26d359ad16f8dc8fa7edfc168666474` |
| `whippet-worker:m9-qa` | `d5a1dae17cd62f2d0be38ab850f20fdb31c6e14b41ee85b99d02a3ef9fac4595` |
| `whippet-web:m8-real-qa` | `9ab5c3ca7cc0175343cae5461a449d345d79003752fc81b9e9bc9b34e404b157` |
| `postgres:16.11-bookworm` | `a2420e9555e2224583fe84d0bb3f0b967e69354ae3a0be55a9c14e251388c4eb` |

本機 RepoDigests 亦有對應值，但未向 registry 核對來源或驗證簽章。後續若 tag 的 ID 改變，需重跑盤點。

上表 Worker 舊 ID 為盤點時快照；依 PM 交付說明，最新 ID `sha256:cda295c1ca394034bfd9de698722c37ea2cfd30e9b9669b24048bba8c0c68ddb` 僅 COPY `dist`／`skills` 後更新功能修正，無依賴或 runtime 變更，未重跑完整盤點，不宣稱新 ID 已全面核實。

## 已核實版本

| 映像 | OS 實物 | 主要 runtime／組件 | 取證方式 |
| --- | --- | --- | --- |
| Server | Distroless／Debian 12，`debian_version=12.15` | 編入 Go `1.23.12`；websocket `v1.5.3`、pq `v1.10.9` | `/etc/os-release`、`/etc/debian_version`、binary build info |
| Manager | Alpine `3.23.2` | 編入 Go `1.27.4`；x/net `v0.56.0`；Docker CLI `29.5.2`（apk `29.5.2-r0`） | OS 檔、binary build info、`docker --version`、apk DB |
| Worker | Ubuntu `24.04.5 LTS`（noble） | Node `26.13.0`（deb `26.13.0-1nodesource1`）；npm `11.20.0`；playwright-core `1.64.1` | `node --version`、`npm --version`、dpkg DB、套件 metadata |
| Web | Alpine `3.21.5` | Nginx `1.28.0`（apk `1.28.0-r1`） | OS 檔、`nginx -v`、apk DB |
| PostgreSQL | Debian `12.13`（bookworm） | PostgreSQL `16.11`（deb `16.11-1.pgdg12+1`） | OS 檔、`postgres --version`、dpkg DB |

Manager／Web／PostgreSQL 的 `node`、`npm` 探測皆回傳 127（PATH 未找到），未將 Web build stage 的 `node:22.16.0-alpine` 當成已交付 runtime。Server 無 shell，未做 Node／npm 探測。

| Worker 內組件 | 實際執行版本 | 其他可比對資料 |
| --- | --- | --- |
| Chromium | Google Chrome for Testing `156.0.8078.80` | 目錄 revision `1248`；browsers.json 宣告 `156.0.8078.4`，與實物不同，採實物回報 |
| Chromium headless shell | Google Chrome for Testing `156.0.8078.80` | 目錄 revision `1248`；同樣不能只採 metadata 的 `.4` |
| Firefox | Mozilla Firefox `157.0` | 目錄 revision `1555`；版本命令 exit 0，另有 user namespace EPERM 訊息；未測實際啟動 |
| WebKit WPE | `WPE WebKit 2.55.0 (unknown)` | revision `2370`；`pw_run.sh --headless --version` exit 0，唯讀探測有字型快取警告。browsers.json 的 `browserVersion=27.2` 是另一欄位；GTK 入口未探測 |
| FFmpeg | `n7.0.1-playwright-build-1013` | `ffmpeg-linux -version`；編譯設定含 `--enable-static --enable-libvpx --enable-zlib`，尚未核實內含 libvpx／zlib 版本與完整聲明 |

Worker 的 `/etc/debian_version` 是 `trixie/sid`，OS 識別採 `os-release` 的 Ubuntu noble，未據此誤列成 Debian runtime。

## 已取得的授權／聲明檔證據

下列為**檔案存在與內容雜湊**，未表示每個檔案已涵蓋該組件所有第三方項目。所有路徑皆在該映像內；不附冗長全文。OS 套件各有授權，不能替整個 OS 指定單一授權。

| 映像／組件 | 映像內路徑 | SHA-256 |
| --- | --- | --- |
| Server／Worker／PostgreSQL 基底文件 | `/usr/share/doc/base-files/copyright` | `fd7e4aae7e7b05f217bcf2d02322825c360e66c52c4c2f1b28d784d6297a1c23` |
| Server／Worker 憑證套件 | `/usr/share/doc/ca-certificates/copyright` | `e85e1bcad3a915dc7e6f41412bc5bdeba275cadd817896ea0451f2140a93967c` |
| Worker libc6 | `/usr/share/doc/libc6/copyright` | `d3c95b56fa33e28b57860580f0baf4e4f4de2a268a2b80f1d031a5191bade265` |
| Worker Node | `/usr/share/doc/nodejs/copyright` | `8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c` |
| Worker Playwright core | `/opt/whippet/worker/node_modules/playwright-core/LICENSE` | `45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb` |
| Worker Playwright core NOTICE | `/opt/whippet/worker/node_modules/playwright-core/NOTICE` | `6d602191187b35b9b01d2cffa01c8469c2c8d9de8a96f1bf868e0f264f51c81d` |
| Worker Chromium ABOUT | `/ms-playwright/chromium-1248/chrome-linux-arm64/ABOUT` | `34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb` |
| Worker Chromium 額外組件 | `/ms-playwright/chromium-1248/chrome-linux-arm64/WidevineCdm/LICENSE` | `20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386` |
| Worker headless shell | `/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/LICENSE.headless_shell` | `80253764cf5dde31aae6aa57ff29d460947d110f3eae31cb9cf208fb5ffcc089` |
| Worker FFmpeg | `/ms-playwright/ffmpeg-1013/COPYING.LGPLv2.1` | `b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe` |
| Web Nginx | `/usr/share/licenses/nginx/COPYRIGHT` | `4f72e2bccf0bcd839dd447ab6f359336f428caa1987a9afec2bc9ade5711658a` |
| Web Nginx njs 模組 | `/usr/share/licenses/nginx-module-njs/COPYRIGHT` | `bf0746e75035cc2b9c3346feb08fd7aa414c088719c00e76734c6d7fe9c0647d` |
| PostgreSQL server／封裝 | `/usr/share/doc/postgresql-16/copyright` | `afcc052a946b4117667527211b4ca303f07044f5585222f4c8f577e0764b2123` |
| PostgreSQL libc6 | `/usr/share/doc/libc6/copyright` | `40c7e1f2118531f038ca22999bd976901254e1bc5cd1b0f0211bdd064c599987` |

另已核實 Worker 的 `node_modules/playwright/LICENSE`／`NOTICE` 分別與上述 core 檔相同；headless shell 的 ABOUT 與 Chromium ABOUT 相同。Web 的 geoip／image-filter／xslt 模組 COPYRIGHT 與 Nginx 該檔雜湊相同；仍各自保留其路徑，不能由相同雜湊推論其他組件也已涵蓋。

Firefox 授權頁已從映像內 archive 直接讀取，未抽出到主機：

| 項目 | 路徑／SHA-256 |
| --- | --- |
| archive | `/ms-playwright/firefox-1555/firefox/omni.ja` |
| archive SHA-256 | `3c68171cd0f373650e644a1b778af7cf83c3b366a6bf256179f6d3834538a49c` |
| archive 內成員 | `chrome/toolkit/content/global/license.html` |
| 成員 SHA-256 | `41a29ce927b2237426a93ae6c9f73de433db326ea452bb53c415b89b1cdddf25` |

套件與授權候選檔的掃描數量如下。候選是按檔名及固定根目錄搜尋，**不是已逐項審核的授權覆蓋率**；不遍歷壓縮檔，僅額外讀取上述 Firefox 授權頁。

| 映像 | 套件紀錄數 | 授權／聲明候選檔數 | 資料來源 |
| --- | ---: | ---: | --- |
| Server | 5 | 5 | `/var/lib/dpkg/status.d/*`、`/usr/share/doc`；Distroless 為裁切後紀錄 |
| Manager | 18 | 0 | `/lib/apk/db/installed`；指定搜尋範圍未找到授權檔 |
| Worker | 511 | 531，另有 Firefox archive 成員 1 份 | dpkg DB、OS 文件、瀏覽器及 Node／npm／Worker 套件目錄 |
| Web | 68 | 5 | apk DB、`/usr/share/licenses` |
| PostgreSQL | 144 | 141 | dpkg DB、`/usr/share/doc` |

npm `package.json` 的 `Artistic-2.0` 與 Alpine DB 的 license 欄位僅是 metadata。npm 根目錄的完整 LICENSE／NOTICE 未於本次搜尋取得；不能用 metadata 補稱已有完整文件。Playwright 的 Apache-2.0 亦不概括 Node、瀏覽器或 FFmpeg。

## 發布前仍需處理

| 缺口 | 本輪可交付證據 | 下一步 |
| --- | --- | --- |
| OS／Alpine 套件聲明 | 版本、完整套件紀錄與既有 copyright 候選索引；Manager 搜尋結果 0，Web 僅 5 份 | 依同一映像的套件版本補齊各組件原始授權／聲明與適用來源資料；不能以 apk license 字串結案 |
| Node／npm 與傳遞依賴 | 真實版本、Node copyright、套件檔案候選 | 補查 npm 主套件完整授權及隨映像分發的依賴；確認 Node copyright 內容涵蓋範圍，保存實際文件 |
| 瀏覽器完整聲明 | Chromium ABOUT、headless LICENSE、Widevine LICENSE、Firefox 封裝授權頁 | 對齊真實版本的第三方 credits；逐一確認 Firefox 授權頁涵蓋範圍，補 WebKit 文件。Widevine 隨映像存在，亦須納入發布組件決策 |
| FFmpeg 與靜態內含組件 | 版本／編譯設定／COPYING.LGPLv2.1 | 補 libvpx、zlib 等實際版本、各自聲明與對應來源／建置資料，未以一份 COPYING 宣稱已齊全 |
| Go runtime／模組與 Docker CLI | Server／Manager binary 版本與 module build info；CLI 真版本 | 補與 binary 對應的 Go、Go modules、CLI 及其內含依賴 LICENSE／NOTICE；README 的本機 module cache 證據不等於已隨映像交付 |
| Web 靜態 bundle | 確認 runtime 為 Nginx，非 Node build stage | React／其他打入 bundle 的聲明仍需對應實際產物，不能因 runtime 無 Node 就排除前端依賴 |
| 最終發布映像 | 目前僅上述 QA image ID 的證據 | 確認真正分發的映像集合；將適用文件隨發布物保存，對最終 ID 重跑盤點。正常 Dockerfile 建置與來源可重現性仍獨立待驗 |
| Whippet 自身 LICENSE | 尚未選定 | 由使用者決定，本輪不替選、不把此項標為完成 |

## PM 可重跑的最短命令

在 repo 根目錄執行；只需 Python 內建庫與可連線本機 daemon 的 Docker CLI，不需 pip／npm 安裝：

```sh
python3 scripts/release/inventory-images.py
```

預設盤點本文件的五個 tag，也可只指定其中一個：

```sh
python3 scripts/release/inventory-images.py whippet-worker:m9-qa
```

腳本輸出 JSON 到 stdout，包含 identity、OS 檔雜湊、完整套件紀錄、版本輸出／exit code、授權候選路徑與雜湊、Firefox 封裝成員雜湊及已知限制。先解析 tag 成 image ID，再以該 ID 建立探測容器，避免執行途中 tag 改變而混用內容。沒有輸出檔或主機解壓縮，也不讀取 Docker config 的 Env 欄位。

Docker 不可用、缺映像或探測框架失敗時，該映像標為 `unverified`，程序 exit 1；未完成的授權清查及單項 runtime 非零 exit code 均保留在 JSON，不會以總 exit 0 宣稱法律合規。版本命令未找到是 127，與成功版本證據區分。自訂 tag 若不是這五個命名系列，Distroless／Go 路徑可能需另行適配。

實際驗證：Python 語法與 `--help` 通過；預設五映像主程式實跑 exit 0，五映像套件紀錄及上述授權雜湊可取得；headless shell、Firefox archive 授權頁已實跑確認。Docker 不可用的隔離模擬亦通過：五映像皆 `unverified`、exit 1，原始錯誤內容未洩漏。未安裝、下載、建置、部署、重啟既有服務或操作 Git，未更新 README／進度文件。
