# M10 search：真自試修復與 Manager 收尾缺陷

2026-11-14，PM t4s／Server t50／Runtime t4z。

## 可直接採用的修復候選

retry5兩次未通過自試的原候選、report已由既有finally及回收清理，不冒稱可精確回放。t50改用固定部署Worker `c310550a…`、同shop fixture源碼隔離複本、新合成憑證，實跑verifyDraft/loginAs/@lib。人工最小search候選保留原slug、run({page})、動態DOM productId、price120、真登入與商品內容斷言。

最終正常候選734ms PASS；未登入1556ms、錯價121之694ms均按原斷言FAIL。最初最終版負向替換未命中而誤PASS，修正測試替換命中後取得上述結果，產品/harness斷言未弱化。候選及driver位於 `/private/tmp/whippet-m10-search-repro`；完整候選已納入repo的retry6.preparation，避免只依賴暫存。

直接PUT草稿會使原Plan失敗鏈CAS過期，現有API不支援無模型原地採用，因此沿既有Stage retry、相同預算/模型/作用域，以完整已驗候選要求原樣stage/commit/短final；不建立新API、不繞過正式validation。11項一般/-O guard測試與isolated PG候選hash相符/漂移/無候選控制PASS。

## retry6現場結果

完整前置後只POST一次，Plan r15/running，Run `dc65295a-f787-4856-93c5-705827f57573`、attempt `8df08d6d-5704-48cf-ace0-e0c05e0dbf00`。原retry5 payload保持，新content/pin/budget實讀PASS。

Worker真自試1通過/0失敗，checkpointCreated/PresentAtFinalize/RetainedAfterSecretGuard均true，terminal COMPLETED。但Manager未進collect、無正式candidate/artifact/validation，Plan stopped/r16且回收。這證明自試已跨過，不能宣稱稿已成功落地。

## 已定位的產品缺陷

經PM批准，對單一精確attempt journal作逐層NOFOLLOW、regular/64MiB上限、duplicate/type驗型的記憶體固定投影；不輸出raw、不保存raw副本。只回phase及固定error enum/布林，結果：complete、CREDENTIAL_EVIDENCE_REJECTED、credentialsUsed=true、credentialsSanitized=false、reclaimed=true。

Manager `sanitizeCredentialOutputs` 呼叫scrubCredentialBytes；後者對JSON重新Unmarshal/Marshal，會改變欄位順序／換行。Module分支把任何byte變更當成候選被秘密遮蔽，因此乾淨Node序列化artifact也可能被誤拒。該分支將dispatch設nil，跳過collect，與現場全部Manager診斷欄尚未執行的形狀一致。

Runtime正在建立實際Worker格式red並最小修補：乾淨Module原bytes保留，真正秘密（含escape）、duplicate/非法/超限仍拒，其他報告遮蔽不變；另驗collect/parser/upload成功路徑。尚未宣稱修補部署通過；不重送retry6。


補充診斷語意：Manager sidecar的present=false在本次表示collect分支未被執行，不能當成Worker檔案從未寫出。實際Worker COMPLETED在成功寫入author/result之後發出；精確journal拒絕分支與真序列化red相符。修補正負測試已green，完整收集/上傳整合與新固定包仍待完成。


## 修補與部署

`a895872` 僅改Manager credential_artifacts.go與測試。Module逐token檢查解碼後字串及key、duplicate/非法/深度/秘密，通過後不重寫author.json；原openArtifact大小/regular-file及一般ZIP/HTML/results遮蔽保持。真Worker serializer red→green、完整Manager runAttempt收集/解析/上傳控制與定向race PASS；容器及HTTP為替身，沒有冒稱真main/provider整合。Linux arm64 source重建逐byte相同。

Manager-only固定包 `manager-credential-release` 最終89檔SHA256SUMS `f739a71be1954361b257148bd1c9dc249b4c0d19ea43e72723ceef94fc08330d`（9e3de653…只是封包清單中間值，未採用）。COPY-only image `sha256:655d9bd4d69e1e8cb5f06014e5c0a588375f2a0bdcfa133ec7b42d21e97cf0ce`。

獨立切換初次斷言因Docker Binds列表順序不同停止；新Manager已Running。PM獨立只讀核排序逐值相同、原env/port/restart/workdir/entrypoint/Worker相同、Server/PG/Web ID不變及queue0，再收尾pending receipt，沒有重跑apply。receipt `bounded-manager-sanitize-repair.json`鏈接原兩receipt；原receipt未改。repair-manager-sanitize.py --apply已用不得重跑。

retry7單次授權：完整前置與三receipt鏈PASS，CAS16/1/7、content逐字同retry6，候選/預算/模型不變；exclusive intent後唯一POST，Run `ff056bf9-37da-4130-89c0-3758a855872b`，Plan running/r17，snapshot proof PASS。只觀察到回收，不追加retry/summary/publish，結果待驗。


## 現場修復驗證成功

retry7 search selftest1/0、checkpoint三true、Manager result/parser/upload全部accepted；candidateCount=1且bodyHashMatches/harnessHashMatches/metadataMatches皆true，已驗人工候選原樣落地。正式validation `d80088bd-bcd5-4d52-8759-30d83c09a8c7` succeeded。原sanitize誤拒已跨過，Plan search ready並自動啟動order；四Stage與整批驗證/發佈尚未完成。


## 最終驗收與限制

Plan composed/r18，login/search/order/verify全ready；三author、三Module正式validation與整體Use Case validation `70f3d51a-56d8-4e17-a3d3-6d617ab21e06` 共7 Run全部succeeded且回收。各Module自試1/0、Manager ACCEPTED，search內容hash完全符合已驗候選。active/unreclaimed/unresolvedValidation/activePlans全0，source payload未變。最終證據 `services/server/m10_shop_t50_retry7.final.json`、`.review.json`。

本輪實際修復search流程並驗證Manager誤拒缺陷已消除；retry5已刪原稿的具體失敗斷言仍不可回溯，沒有把後續產品缺陷回填為retry5根因。M10.10完成，M10.9整批摘要與發佈尚未執行，M10.Z其他缺口與原golden分數不回填。沒有重跑M1–M9、tag/push、追加retry、summary或publish。
