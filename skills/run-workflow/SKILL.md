# run-workflow — 執行側 skill

> 你是 Indify 的**執行側「手」**:把「已發布的 Dify workflow」當技能跑起來。
> 生成側(DSL/IR)歸 `dify-workflow-dsl` 管;本 skill 只管「跑」與「讀結果」。
> 調用入口只有一個腳本:`scripts/run.mjs`,零第三方依賴,Node 22 全局 fetch。

## 0. 先結論

- **什麼時候跑**:用戶要「執行/驗證/拿結果」一個已發布 workflow 時,才跑;不是在生成階段跑。
- **要什麼**:app_id(已發布應用的 ID)、inputs(workflow 起始節點輸入變數的 JSON)、一支 app API key。
- **怎麼跑**:
  `node scripts/run.mjs --app-id <id> --inputs '<json>' [--api-key <key>]`
- **結果怎麼看**:退出碼 0 = 成功;stdout 是一行 JSON,`ok`/`status`/`outputs` 是核心欄位。
- **有副作用先問**:跑之前若 workflow 定義或任務卡標註「有對外副作用」(發訊息、寫外部系統、花錢調模型等),**先向用戶確認再跑**。

## 1. 何時該跑、何時不該跑

**該跑:**
- 用戶明確要「跑一下/執行/試試/拿輸出/驗證結果」。
- 生成側已把 workflow 發布(有可用的 app_id),用戶要驗證端到端結果。

**不該跑:**
- 生成/修改 workflow 階段(那走 `dify-workflow-dsl`,不是本 skill)。
- 沒有 app_id 或沒有 API key 時(先向用戶要,不要硬跑)。
- workflow 帶對外副作用且用戶未確認時(見 §4)。

## 2. 前置:拿到三樣東西

1. **app_id**:已發布 workflow 應用的 ID。
   - 在 Dify 控制台 App 的 URL 裡:`/app/<app_id>/...`;或由生成側在 `result.json` 的 `appId` 提供。
   - 必須是**已發布**的 workflow;草稿不會被 Service API 執行。
2. **inputs**:workflow「開始(start)節點」定義的輸入變數,組 JSON。
   - 無輸入變數:`'{}'`。
   - 有輸入變數,例如 start 節點有 `query`(文本):`'{"query":"幫我查台北天氣"}'`。
   - 檔案型變數不走這裡的簡易路徑(需先 `POST /v1/files/upload` 拿 upload_file_id,見 `references/service-api.md`)。
3. **app API key**:`app-` 前綴的 Service API key。
   - 生成位置:Dify 控制台 → 對應 App → 左側「API 訪問 / API Access」→ 建立/複製。
   - 傳入:優先 `--api-key <key>`,其次環境變數 `DIFY_APP_API_KEY`。**不要**把 key 寫進對話、筆記或腳本輸出;腳本也不會回顯。

## 3. 調用方式

```
node scripts/run.mjs --app-id <id> --inputs '<json>' [--api-key <key>] \
  [--user <u>] [--response-mode blocking|streaming] [--timeout-ms N] [--base-url <url>]
```

| 參數 | 預設 | 說明 |
|---|---|---|
| `--app-id` | 必填 | 已發布 workflow 應用 ID |
| `--inputs` | 必填 | 起始節點輸入變數的 JSON 物件 |
| `--api-key` | 環境變數 | `app-` 前綴 key;`--api-key` 優先於 `DIFY_APP_API_KEY` |
| `--user` | `indify` | 終端使用者識別(非空字串) |
| `--response-mode` | `blocking` | `blocking` 同步等結果;`streaming` 逐行轉發 SSE 事件 |
| `--timeout-ms` | `60000` | 請求逾時(毫秒) |
| `--base-url` | `http://localhost` | Dify 根位址(nginx 已代理 `/v1`) |

**默認用法(blocking,拿最終輸出):**
```
node scripts/run-workflow/scripts/run.mjs --app-id <id> --inputs '{"query":"..."}' --api-key app-xxxx
```

## 4. 副作用分級(跑之前必查)

執行一個 workflow 可能觸發對外副作用。**跑之前**先看該 workflow 的定義(或任務卡備註),按下表分級:

| 級別 | 判定 | 處置 |
|---|---|---|
| 無副作用 | 純計算/讀取/內部 LLM,不碰外部寫入、不發訊息 | 可直接跑 |
| 有副作用 | 節點含 HTTP 對外寫入、發郵件/簡訊、發 Webhook、調外部收費 API、寫資料庫等 | **先向用戶確認**再跑,說明會觸發什麼 |
| 不確定 | 定義裡有 HTTP/工具節點但無法確定讀或寫 | 按「有副作用」處理,向用戶確認 |

確認時用一句話說清:要跑哪個 workflow、會觸發什麼外部動作、inputs 是什麼;得到同意後再跑。

## 5. 解讀結果

**blocking(預設):** stdout 一行 JSON,形如:
```json
{"ok":true,"task_id":"...","workflow_run_id":"...","status":"succeeded","outputs":{...},"error":null,"elapsed_time":1.23,"total_tokens":42,"total_steps":3}
```
- `ok===true` 且退出碼 0 = 成功;`outputs` 是 workflow `end` 節點的輸出(用戶要的答案通常在此)。
- `ok===false`:`error` 給原因。常見:
  - `status:"failed"` → workflow 跑到中途失敗,`error` 是 workflow 內部錯誤訊息。
  - `HTTP 401 ... invalid` → key 錯/過期/未開啟 API 訪問,去控制台重新生成。
  - `HTTP 400/404 ...` → app_id 錯、未發布、或 `inputs` 缺必填變數。
  - `請求超時` → `--timeout-ms` 調大,或 workflow 本身過慢。

**streaming:** stdout 是逐行 JSON 事件(`workflow_started`/`node_started`/`node_finished`/`workflow_finished`/`error`)。
- 最後一個 `workflow_finished` 的 `data.status==="succeeded"` → 退出碼 0;否則非 0。
- 用來看節點級進度/卡在哪個節點;`workflow_finished.data.outputs` 是最終輸出。

**對用戶的匯報:** 只給簡短摘要(成功/失敗 + 一句原因 + 關鍵輸出),不要把整段 JSON、更不要把 key 貼給用戶。

## 6. 注意事項

- **不回顯 key**:任何輸出、錯誤訊息、日誌都不得含 key 本體;腳本已保證。
- **只跑已發布**:草稿不會被執行,報錯時先確認 app 已發布且 API 訪問已開啟。
- **inputs 要對齊 start 節點**:變數名、型別都要與 workflow 定義一致,缺/錯會 400。
- **檔案型輸入**:簡易路徑不支援;需先 `POST /v1/files/upload` 拿 `upload_file_id`,再把 file object 放進 `inputs`(見 `references/service-api.md`)。
- 失敗時**不要**盲目重試多次:先讀 `error` 分類處理(鑒權/app 狀態/inputs 型別)。

## 7. 目錄結構

```
skills/run-workflow/
├─ SKILL.md                 # 本文檔
├─ references/
│  └─ service-api.md        # Dify 1.16.1 Service API 备忘(端点/鉴权/请求/响应/SSE)
└─ scripts/
   └─ run.mjs               # 唯一入口:运行 workflow(blocking / streaming)
```

## 8. Run 模式協議(Bridge 驅動的生產路徑)

> 當 Bridge 以「Run Agent」身份發來 run 任務時(提示詞會明確說「你是 Indify 的 Run Agent」),
> **不要調用 run.mjs、不要發 HTTP**。此時你是「大腦」:只負責選技能、填參,把執行交給擴展。

協議:
1. 讀 `generated/skill-registry.json`,裡面每個技能含 name/description/whenToUse/inputSchema/sideEffects。
2. 選最匹配用戶請求的一個技能。
3. 按該技能的 inputSchema 填 inputs(拿不準的欄位省略,給 `{}` 也行)。
4. 寫 `generated/{taskId}/run.json`:`{"appId":"<選中技能的 id>","inputs":{...},"skillId":"<可選>","needsConfirm":false}`。
5. 寫 `generated/{taskId}/result.json`:`{"status":"run-ready","summary":"<一句中文>","warnings":[]}`。
6. 只寫這兩個檔案;不要跑、不要問、不要產出其它檔案;最終回覆一句簡短中文。

> `run.mjs`(上文 §3)是「直接 CLI 跑」的開發/無頭工具;run 模式下 Agent 不調用它。
