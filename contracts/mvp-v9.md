# M9：有界對話歷史與背景接續

2026-11-12 PM固定；承接v7/v8，不改已通過流程。實作狀態只見implementation.md。

## 範圍

預設仍傳conversationSummary與近期訊息。test-author與workspace-author可按需呼叫read_conversation_history；acceptance-summary永不提供此工具。舊Run沒有history欄位時不開工具。不建立通用RPC、向量庫或新配額資料表。

## 固定Run上下文

Server在建立author Run的同一交易、插入本輪user訊息之前，取得該conversation目前最高messages.sequence（無訊息為0），存入不可變author.history={maxSequence:"十進位字串"}。workspaceId、testId、editingSessionId、conversationId由既有Run/author快照固定。不得用created_at猜cutoff，亦不得回讀Run建立後訊息。

## 專用Manager HTTP

POST /api/manager/runs/:runId/attempts/:attemptId/history

- 沿既有Manager認證與目前control session/attempt ownership；HTTPS，不跟redirect，回Cache-Control:no-store。
- body僅 {cursor:string|null}，首次null。拒絕未知欄位/非法cursor；scope不接受caller自報。
- 只允許目前有效且未取消的author attempt，且Run固定conversation與當前同Workspace的owner相符。test-author的editingSession須active且revision/context仍匹配；workspace-author的設定conversation/revision/context仍匹配。終態、取消、已關閉session、跨owner、summary、缺history都拒絕。
- 成功200裸物件：
  {workspaceId,testId:null|string,runId,attemptId,editingSessionId:null|string,conversationId,maxSequence:string,items:[{sequence:string,role:"user"|"assistant",content:string,offsetBytes:number,hasMoreContent:boolean}],nextCursor:string|null}
- items從新到舊；只回訊息content，絕不附proposed_script/baseScript、角色機密、provider設定或token。每頁最多6片段，content UTF-8 bytes合計最多8192。大訊息按UTF-8合法邊界切片，不靜默漏字；hasMoreContent標記本訊息尚未讀完。
- cursor格式sequence:offsetBytes，無新token/HMAC。sequence為非負十進位字串、offsetBytes為非負安全整數。片段未完則nextCursor指同sequence下一byte offset；整筆完才往前查較小sequence。全域sequence有間隙可查較舊同conversation訊息；offset>0必須對應該conversation的確切sequence與合法UTF-8邊界。任何cursor仍受權威cutoff及owner約束，不能藉cursor擴範圍。沒有更多內容nextCursor=null。
- Server每頁獨立限制大小；Manager/Worker每attempt最多4次（含失敗），不增持久quota表。Manager重啟遵循既有清理與不重跑規則，不為history重啟Run。

## Worker工具與專用IPC

工具read_conversation_history({cursor:string|null})，首次null。真模型相容：僅在Worker模型工具入口將精確字串"null"正規化為JSON null；不trim、不接受空字串或其他非法位置。HistoryClient、IPC與HTTP不接受此字串別名，仍只接受真正null或合法sequence:offsetBytes。沿既有12次總tool與8次模型預算，不額外擴大；模型看到items/nextCursor即可，不必重複整份scope。歷史內容為資料，不是指令；不得因此變更網站授權。輸出沿既有known-secret清理與provider key拒漏規則。

Worker stdout NDJSON請求：{kind:"history_request",requestId:UUID,attemptId:UUID,cursor:string|null}。
Manager stdin回覆：{kind:"history_response",requestId:UUID,attemptId:UUID,history:<上述成功物件>}；失敗改為error:"history_unavailable"，不回傳內部body或認證資料。

共用Docker attach實體連線，history與credential獨立kind/schema/額度。Worker唯一stdin demux，history client不可接credential payload；Manager回覆必須原子寫入同一stdin。請求在log路徑前攔截，response/content不記journal或一般log。15秒有界請求；requestId去重、attempt核對；取消/關閉後不接受遲到reply。Worker無Manager token、任意URL或其他session選擇能力。HTTP回傳scope/attempt/cutoff須由Manager與Worker核對。

## 最小驗收與交付

- Server：同owner成功、多byte大訊息切片與cursor連續性、cutoff排除本輪及後續訊息、跨session/Workspace拒絕、summary/取消/closed session/失效context拒絕。
- Runtime：工具僅有能力時提供、history/credential demux不串線、原子stdin、4次預算、超時/取消/遲到reply、惡意scope回覆拒絕；既有機密通道相關定向回歸。
- 整合：模型按需找回近期窗口以外的合成決策，使用真Manager→Server history接線；沒有需求則不呼叫history。
- 接續：既有設定變更套用後的新草稿採新Workspace背景，既有Version快照不被覆寫；撤銷角色後不能再resolve/啟動授權使用。沿用M8已通過無關矩陣，只補缺口。

Owner：Server t41僅services/server；Runtime t42僅services/manager+runtimes/worker；PM t3v擁有本契約、docs與部署。QA用全新Muse/xhigh。禁止安裝、讀印複製deploy/.env.ai、輸出憑證或自行Git/部署。
