# Windows OpenCode pane 生命週期唯讀調查（2026-10-25）

調查時間：2026-10-25 上午，Asia/Taipei（+08:00）。
調查方式：透過 SSH 進入 Windows 主機，只做讀取。沒有修改原始碼、設定或執行中的程序，沒有送出模型請求，沒有手動觸發新的 split 或 task，也沒有螢幕截圖。
調查期間使用者的正常工作在 09:08 產生了新的 child pane；本次調查沒有觸發它。
本報告只保存證據與判讀，不包含修復。

證據標記：

- **[觀察]**：本次調查直接讀到的執行中狀態、日誌或檔案內容。
- **[推論]**：由觀察事實與原始碼路徑共同支持，但沒有做因果實驗。
- **[未驗證]**：本次沒有取得足以確認的證據。

---

## 1. 摘要

**[觀察]** 早期快照的四個子會話都成功建立 pane。bridge 的 placeholder 與 attach 都有開啟紀錄，attach 以 exit 0 結束。關閉不是 spawn 失敗：3 個由輪詢清理關閉，1 個由 `onSessionDeleted` 觸發。

**[觀察]** 其中一個子會話在輪詢清理後被恢復，並在同一個 child session 繼續執行工具呼叫。09:01:22 恢復後到 09:02:55 工作結束期間，沒有觀察到新的 tmux open 或 respawn。`skip` 訊息出現在 09:02:55 與 09:02:56，位置是恢復工作結束時，不是 09:01:22 恢復當下。

**[觀察]** 09:08 至 09:09 使用者正常工作又建立了新 child `ses_e8f664201ffeeBNKIPesRgHhwa`，pane `%121`。09:09:11.835 的 backend `list-panes -a` 顯示 `%1` 與 `%121` 兩個 pane，09:09:36.610 仍是兩個。§2 的「只有 `%1`、四個 children」是早期快照，不是最終狀態。

**[推論]** 可支持的推論是「恢復後的同一個 child session 沒有觀察到 pane recreation」。輪詢清理在 `closedByPolling` 留下 tombstone，`shouldSkipRespawnAfterPollingClose` 會跳過 respawn；但 guard 的 `skip` 出現在工作結束的 idle/deferred retry，不能直接證明 guard 在 09:01:22 的 busy 恢復當下介入。這是路徑層級的一致解釋，不是因果證明。

**[未驗證]** 初始 pane 或 attach 後的畫面是否真的顯示、是否曾有空白，以及使用者看到的 UI 狀態。本次沒有螢幕擷取，也沒有重現全新的可見性測試。attach 的 exit 0 與 `attachWaitMs=0` 不證明 UI 已渲染。

---

## 2. 執行環境與啟動事實

| 項目 | 本次觀察值 |
| --- | --- |
| OpenCode 程序 | `opencode.exe` PID 39912，啟動時間 08:54:21 |
| 啟動入口 | `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\bin\omo-opencode-port.ps1`（wrapper 本身沒有 `--port` 參數） |
| 實際 exe 參數 | 實際 `opencode.exe` 以 `--port 7801` 啟動 |
| 健康檢查 | `GET http://127.0.0.1:7801/global/health` 回傳 `healthy=true`、`version=1.19.4` |
| 安裝版 OmO | `C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest\node_modules\oh-my-openagent`，版本 5.1.45 |
| repo 套件版本 | 5.1.43-2 |
| psmux | 3.4.0，commit `20aa1d7` |
| psmux server | PID 41912 |
| psmux client | PID 21012，default client |
| 終端祖先 | WindowsTerminal |
| mux 狀態（早期快照） | 只有一個 client；default session `@1`，pane `%1`，`163x43`，`zoom 0` |
| 父會話 | `ses_e8f7096f2ffeC8K0hWsRa7Gc8U` |
| 專案目錄 | `C:\Users\Daniel\Documents\opencode\opencode_ctl` |
| 子會話查詢（早期快照） | `GET /session/<parent>/children` 回傳 4 個 persistent children |
| 狀態查詢（早期快照） | 未帶 `directory` 的 `GET /session/status` 回傳 `{}`；instance scope 未確認，不能當成同專案結論 |

補充說明：

- Warm server PID 28164 屬於 `__warm__`，不是使用者子會話的 pane。不能把它算成第五個 child pane。
- 安裝版 OmO 5.1.45 與 repo 的 5.1.43-2 有版本落差，但**[未驗證]** 版本落差本身是否造成本次現象；現有證據不足以把 drift 當成原因。
- 早期未帶 `directory` 的 `/session/status` 回傳 `{}`，其 instance scope 未確認，不能作為同專案證明。晚期專案範圍查詢與新 child 見 §3.2、§7。**[未驗證：scope]**

---

## 3. 子會話的建立與關閉（早期與晚期）

時間已由 UTC 換算為 Asia/Taipei（+08:00）。`spawn` 與 `activate` 保留日誌中的毫秒精度。下表前四列是早期快照；09:08 之後的新 child 見 §3.2。

| 子會話 | session id | pane | spawn | activate | close | 關閉備註 |
| --- | --- | --- | --- | --- | --- | --- |
| Plan safe Lightroom edit | `ses_e8f6fef50ffeisPgIoY3xAFw3E` | `%102` | 08:57:33.305 | 08:57:35.544 | 08:59:10.161 | `missingSince` 30043 ms |
| Analyze railway photo references | `ses_e8f6e7203ffe9NCV3PflJUGt5j` | `%109` | 08:59:11.695 | 08:59:12.460 | 09:00:16.772；CtrlC 09:00:16.890 | close 由 `onSessionDeleted` 觸發 |
| Assess target photo exposure | `ses_e8f6da6caffe7uUxFdznFkaAFP` | `%113` | 09:00:03.754 | 09:00:05.142 | 09:00:57.042 | `missingSince` 30310 ms |
| Plan Lightroom final export | `ses_e8f6a9c5bffetqA7UwfSspSOnT` | `%117` | 09:03:23.190 | 09:03:25.766 | 09:05:05.990 | `missingSince` 30374 ms |

**[觀察]** 四個關閉流程都出現 CtrlC 與 `kill-pane`。第二個子會話的 close 觸發點是 `onSessionDeleted`（09:00:16.772），CtrlC 在 09:00:16.890；其餘三個由輪詢清理關閉。`kill-pane` 回傳 exit 1，判讀為 pane 已經關閉，不是 spawn 失敗。這個判讀與下面 bridge 的呼叫統計一致：4 次 `kill-pane` 都標記在 graceful CtrlC 之後。

**[觀察]** 下一個 spawn 當下的 window state 會列出前一個 pane。例如 09:00:02.378 的 `agentPanes[%109]`。這表示 `%109` 在當時確實存在，不只是 spawn 回報成功。

### 3.1 日誌摘錄

以下兩段是從 `C:\Users\Daniel\AppData\Local\Temp\oh-my-opencode.log` 取出的**摘錄**，不是完整 JSON。`sessionId` 以 `<Assess>` 代替完整識別字，避免把縮寫內容誤當成原始精度。

```text
[2026-10-25T01:00:57.042Z] [tmux-session-manager] session check {sessionId:<Assess>,isIdle:false,elapsedMs:53288,stableIdlePolls:0,activityVersion:1437,missingSince:30310,missingTooLong:true,isTimedOut:false,shouldCloseViaStability:false}
```

```text
[2026-10-25T01:02:55.410Z] [tmux-session-manager] skipping tmux respawn because polling already closed the session {sessionId:<Assess>,source:session.idle retry}
```

同一段 `skip` 訊息在 `[2026-10-25T01:02:56.419Z]` 再次出現，來源同為 `session.idle retry`。

**[觀察]** 第一段顯示 `missingSince=30310` 且 `missingTooLong=true`，但 `isIdle=false`、`isTimedOut=false`、`shouldCloseViaStability=false`。關閉條件不是 idle 穩定，而是 missing 超過門檻。

**[觀察]** 第二段發生在 09:02:55，顯示輪詢清理已先把 session 記入 tombstone，因此 `session.idle retry` 的 respawn 被跳過。

日誌開頭記錄的設定值：`enabled=true`、`isInsideTmux=true`、`layout=main-vertical`、`main_pane_size=50`、最小寬度 40、`isolation=inline`、`server=7801`、`source=%1`。

### 3.2 晚期即時觀察（09:08 至 09:09）

**[觀察]** 09:09:11.835（Asia/Taipei）直接對 backend 執行 `list-panes -a`，輸出兩個 pane：

```text
default|@1|%1|42556|node|81x43|WINDOWS-DANIEL
default|@1|%121|38004|opencode|81x43|omo-subagent-Plan native Lightroo
```

第二列的 pane title 在本次輸出中呈現為 `omo-subagent-Plan native Lightroo`，字串以此形式截斷。這兩個 pane 是使用者正常工作產生的，不是本次調查觸發。

| 子會話 | session id | pane | spawn | activate | 建立呼叫 |
| --- | --- | --- | --- | --- | --- |
| Plan native Lightroom export | `ses_e8f664201ffeeBNKIPesRgHhwa` | `%121` | 09:08:08.048 | 09:08:10.398 | `split-window` 01:08:07.138Z exit 0；`respawn-pane` 01:08:10.380Z exit 0 |

**[觀察]** 09:09:34.589 的 lifecycle log 顯示這個 child 仍是 busy，`missingSince=0`。09:09:36.610 backend 仍顯示 `%1` 與 `%121` 兩個 pane。因此晚期 current state 不是「只有 `%1`」，而是兩個 pane；§2 的 four-children 清單是早期快照，不能當成最終清單。

---

## 4. Bridge 呼叫與 attach 證據

**[觀察]** canonical bridge 日誌是 `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\bin\state\shim-calls.jsonl`。下表是早期快照，統計自 00:54:20Z 起，不包含 §3.2 晚期新 child 的 split 與 respawn：

| 呼叫 | 次數 | exit | 分類 |
| --- | --- | --- | --- |
| `split-window` | 4 | 0 | `placeholder-split` |
| `respawn-pane` | 4 | 0 | `attach-respawn` |
| `list-panes` | 168 | 0 | 無 |
| `send-keys` | 4 | 0 | 無 |
| `kill-pane` | 4 | 1 | graceful CtrlC 之後 |

**[觀察]** 早期四組 helper trace 都顯示：placeholder 已開啟，attach 也已開啟。以最後一組 `%117` 為例，attach 的終端成功時間是 `01:05:07.123Z`，發生在 cleanup 期間、CtrlC intent `01:05:06.372Z` 之後，不是之前。沒有發現 attach 立即崩潰；但 exit 0 與 `attachWaitMs=0` 不證明 UI 已渲染或沒有空白畫面。

**[觀察]** 最後一組 correlation ID：

- placeholder：`pane-mvn4j9kj-60218e3c`
- attach：`pane-mvn4jcav-b9a84094`

attach 的 state 檔為 `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\state\pane-pane-mvn4jcav-b9a84094.jsonl`。檔案記錄：

- opened：`01:03:26.3577757Z`
- succeeded：`01:05:07.1233612Z`
- `attachWaitMs=0`
- `attachRetries=0`

**[觀察]** `attachWaitMs=0` 與 `attachRetries=0` 表示這次 attach 沒有等待或重試紀錄。搭配 exit 0，沒有支持「attach 立即崩潰」的證據；但不能延伸成畫面成功顯示。

**[觀察]** 舊根目錄 `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin\state` 的 last write 是 2026-10-23 20:49，canonical 日誌則持續寫到 2026-10-25。**[未驗證]** 沒有證據顯示舊路徑的殘留狀態造成本次現象，不能把 stale path migration 當成原因。

---

## 5. 恢復後的行為：觀察到的缺口

**[觀察]** 直接查詢 `GET /session/<Assess>/message?limit=12` 的 metadata，時間序列如下：

| 時間（Asia/Taipei） | 事件 |
| --- | --- |
| 09:00:01.737 | 初始 user 訊息 |
| 09:00:27.823 | assistant 第一次 `finish`，`stop` |
| 09:01:22.358 | 新的 USER 訊息 |
| 09:01:22 至 09:02:55 | assistant 繼續工具呼叫，包括 read、Lightroom settings、previews、metadata |
| 09:02:55.383 | 最終 `finish`，`stop` |

**[觀察]** 09:01 至 09:03 之間沒有 tmux open 或 respawn。`skip` 訊息在 09:02:55 與 09:02:56，發生在恢復工作結束時，不是 09:01:22 的 busy 恢復當下。

**[觀察]** 恢復後的任務確實繼續執行，工具呼叫有產出，最終回覆正常結束，errors 為 null。因此不能說「關閉 pane 中斷了工作」。

**[推論]** 缺口不是「所有初始 create 都失敗」，而是「initial create 成功，完成後 pane 被輪詢清理，之後同一個 child session 被恢復時沒有觀察到再建立 pane」。tombstone 與 guard 路徑和這個時間線一致，但 guard 也會阻擋 idle/deferred retry，不能直接證明它處理了 09:01:22 的 busy 事件。任務本身仍有執行；本次沒有螢幕驗證，不能延伸成使用者視覺經驗的證明。

---

## 6. 安裝版原始碼行號

檔案：`C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest\node_modules\oh-my-openagent\dist\index.js`，版本 5.1.45。以下行號屬於 **Windows 安裝版 bundle**，不是 repo 內 `.contract` 的 5.1.43 引用。

| 行號 | 內容角色 |
| --- | --- |
| 8155 | `SESSION_MISSING_GRACE_MS=30*1000` |
| 159185 | `isIdle = status?.type === "idle"` |
| 159186 至 159190 | 只有 status 存在時才刷新 `lastSeenAt`；之後計算 `missingTooLong` 門檻 |
| 159243 | 關閉條件為 stability、`missingTooLong`、timeout 三者之一 |
| 160465 至 160467 | `closeSessionFromPolling` 先把 `sessionId` 加入 `closedByPolling`，再關閉 |
| 160469 至 160477 | `shouldSkipRespawnAfterPollingClose` 在集合含該 id 時回傳 true，並記錄 skip |
| 160174 至 160176 | `retryFailedReadinessSession` 對 `source: session.idle retry` 的 guard 提前返回 |
| 160221 | deferred attach 也有同樣的 guard |
| 160479 至 160489 | `onEvent` 先處理 polling，之後只處理 `session.idle retry`；本次沒有觀察到通用的 busy-resume pane recreation |

**[推論]** 這些行號與日誌時間線一致：輪詢以 missing 門檻關閉 pane，並留下 tombstone；恢復工作結束時，idle/deferred retry 被 guard 跳過。這是路徑層級的一致解釋，不是「guard 在 busy 恢復當下直接介入」的因果證明，也不是 UI 顯示結果的證明。

---

## 7. 上游狀態模型與專案範圍查詢

**[觀察]** 查閱官方 primary source：

`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts`

該檔案顯示：設定 `idle` 時會發出 status 與 idle 事件，並從 map 刪除該筆 entry。

**[限制]** 這是 `dev` 分支的原始碼，不是本次執行的 1.19.4 精確版本。它只能作為狀態模型佐證，不能標示為與部署版本 byte-identical 的證據。

**[觀察]** 早期未帶 `directory` 的 `GET /session/status` 回傳 `{}`；這次查詢的 instance scope 未確認，不能當成同專案狀態證明。

**[觀察]** 09:09:51.027 以 `directory=[Uri]::EscapeDataString(C:\Users\Daniel\Documents\opencode\opencode_ctl)` 明確 scope 後，`/session/status` 回傳 parent busy 與新 child `e8f664201` busy。同 scope 的 children 查詢回傳 `e8f6e720`、`e8f6da6c`、`e8f6a9c`、`e8f664201`；早期 `e8f6fef50` 在當時已從 children 消失。

**[觀察]** 這表示較舊的 persisted children 沒有出現在當前 status，但仍留在 children。它支持「沒有 status 不等於已刪除」，但不宣稱所有舊 session 都保持不變，也不把早期未 scope 的 `{}` 當成同專案證據。

---

## 8. 判定與非判定

### 8.1 可以支持的判定

1. 早期初始建立路徑可用：4 次 placeholder split 都 exit 0，4 次 attach respawn 都 exit 0，attach trace 也有 exit 0；晚期新 child 的 split 與 respawn 同樣 exit 0。
2. 早期 4 個 pane 最後都關閉：3 個由輪詢清理，1 個由 `onSessionDeleted` 觸發；`kill-pane` exit 1 標記在 graceful CtrlC 之後。
3. 專案範圍 children 查詢在 09:09:51.027 仍列出 `e8f6e720`、`e8f6da6c`、`e8f6a9c`、`e8f664201`；同一 scope 的 status 只有 parent 與新 child 是 busy。舊的 `e8f6fef50` 在當時已不在 children，因此不能宣稱所有舊 session 不變。
4. 恢復期間沒有觀察到 pane recreation；skip 只在 09:02:55/56 工作結束時出現。guard 也會阻擋 idle/deferred retry，不能直接證明 guard 處理了 09:01:22 的 busy 恢復。
5. 晚期 `%121` 在 09:09:34.589 仍是 busy、`missingSince=0`，09:09:36.610 backend 仍有 `%1` 與 `%121`。

### 8.2 不能支持的判定

- 不能說「初始 pane 從未顯示」。本次沒有螢幕截圖，**[未驗證]** 初始可見性。
- 不能把早期未帶 `directory` 的 `{}` 當成同專案 status 證明。
- 不能說 attach 的 exit 0 或 `attachWaitMs=0` 證明 UI 已渲染或沒有空白畫面。
- 不能說 guard 在 09:01:22 的 busy 恢復當下直接介入；skip 出現在 09:02:55/56 的工作結束時。
- 不能說「pane 關閉中斷了已恢復的工作」。恢復後的工具呼叫與最終回覆都正常。
- 不能說「5.1.45 與 5.1.43-2 的版本落差就是原因」。目前只有版本落差的事實，沒有隔離實驗。
- 不能說「舊路徑 migration 造成問題」。舊 state 的 last write 較早，但沒有因果證據。
- 不能把 `dev` 分支原始碼當成 1.19.4 的逐位元部署證據。
- 不能把 `kill-pane` exit 1 直接當成 spawn 或 attach 失敗。日誌語意是「已關閉」。

---

## 9. 限制

- 本次調查沒有觸發全新的 task 或 split；09:08 的新 child 是使用者正常工作，不是調查送出。
- 沒有螢幕擷取，因此 UI 與空白畫面都沒有視覺驗證。
- 初始 pane 是否「從來沒被看到」仍未有定論。
- 早期 `/session/status` 查詢未帶 `directory`，其 instance scope 未確認。
- 本次是唯讀查詢；HTTP GET 與檔案讀取可能更新存取時間等 metadata，但沒有刻意修改 session、設定或程序。
- 沒有執行修復，也不建議在本報告內直接修改任何檔案。
- 日誌摘錄經過縮寫與節錄，不能當成完整原始 payload。

---

## 10. 安全唯讀重查命令

以下命令供日後重查，**本次調查沒有執行**。全部是讀取檔案、程序資訊或 HTTP GET。直接呼叫 backend `psmux.exe` 可避免 shim 追加日誌；若呼叫 bare `psmux` 或 shim，可能追加 `shim-calls.jsonl`。

```powershell
# 1. 健康狀態，只讀 GET
Invoke-RestMethod 'http://127.0.0.1:7801/global/health' | ConvertTo-Json -Compress

# 2. 程序與啟動時間
Get-Process opencode, psmux -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime

# 3. 專案範圍的狀態與 children，只讀 GET
$parent = 'ses_e8f7096f2ffeC8K0hWsRa7Gc8U'
$dir = [Uri]::EscapeDataString('C:\Users\Daniel\Documents\opencode\opencode_ctl')
Invoke-RestMethod "http://127.0.0.1:7801/session/status?directory=$dir" | ConvertTo-Json -Compress
Invoke-RestMethod "http://127.0.0.1:7801/session/$parent/children?directory=$dir" |
  ConvertTo-Json -Depth 6

# 4. 最近的 OmO lifecycle 日誌
Get-Content -LiteralPath "$env:TEMP\oh-my-opencode.log" -Tail 120

# 5. 最近的 bridge 呼叫紀錄
Get-Content -LiteralPath 'C:\Users\Daniel\AppData\Local\omo-psmux-bridge\bin\state\shim-calls.jsonl' -Tail 40

# 6. 安裝版 bundle 的指定行，索引為 0 基
$p = 'C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest\node_modules\oh-my-openagent\dist\index.js'
$l = Get-Content -LiteralPath $p
$l[8154]
$l[159184..159242]
$l[160173..160176]
$l[160464..160489]

# 7. backend pane 清單，直接呼叫 backend 避免 shim 追加日誌
& 'C:\Users\Daniel\AppData\Local\psmux\psmux.exe' list-panes -a
```

---

## 11. 引用檔案

| 用途 | 路徑 |
| --- | --- |
| OmO lifecycle 日誌 | `C:\Users\Daniel\AppData\Local\Temp\oh-my-opencode.log`（即 `$env:TEMP\oh-my-opencode.log`） |
| Bridge 呼叫日誌 | `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\bin\state\shim-calls.jsonl` |
| attach helper trace | `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\state\pane-pane-mvn4jcav-b9a84094.jsonl` |
| 安裝版 OmO bundle | `C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest\node_modules\oh-my-openagent\dist\index.js` |
| 啟動 wrapper | `C:\Users\Daniel\AppData\Local\omo-psmux-bridge\bin\omo-opencode-port.ps1` |
| 舊根目錄 state | `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin\state`（last write 2026-10-23 20:49） |
| 上游狀態模型 | `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts` |

本次調查於 2026-10-25 上午完成，沒有變更任何原始碼、設定或執行中的 Windows 程序。
