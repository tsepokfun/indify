# Indify v3 整合偵察地圖 —— 執行配接器 + 改進閉環接線

> 性質：**只讀偵察**,不改任何程式碼。本文僅回答「在哪裡插」。
> 基準：DESIGN.md（已實現 M0–M4 + v2 F1/F2/F3）、bridge 全源碼、extension 五檔、
> `skills/dify-workflow-dsl` 的 SKILL.md + scripts、docs 三份（m0 / upgrade-plan-v2 / s0-service-api）。
> 目標 Dify 1.16.1（DSL 0.7.0）,Service API 前綴 `/v1`。
> 所有行號以偵察當下的檔案為準。

---

## 0. 三個最關鍵整合點（先講結論）

1. **執行配接器 = 在「adapter JSON」新增 `serviceApi` 段 + 在「content script」加一個 run handler。**
   理由：`POST /v1/workflows/run` 是 **Bearer `app-<key>`** 認證,與 console 的 cookie+CSRF 是兩套面;
   而 `app-` key 只能由 console 登入態的 `POST /console/api/apps/{app_id}/api-keys` 產生 → 這一整段
   都落在 content script（同源、已帶 cookie + `host_permissions: http://localhost/*`）。
   Bridge 只負責「把 adapter 的 serviceApi 段吐給擴展」（既有 `GET /v1/adapter/{version}` 已夠用）。
2. **「改 skill = 改其 workflow」就是現成的 modify（U2/U3）,零新路徑。**
   skill = 一個已發布 workflow app（有 `app_id`）;改它 = 提交 `mode:"modify"` 任務,
   `context.appId` = 該 skill 的 app_id。唯一缺的一塊是「skill 名 → app_id」的解析表,不是新注入路徑。
3. **執行閉環的隱藏前置 = 「先 publish 再 run」。**
   Service API 跑的是**已發布版本**,而 modify 只寫了 draft;閉環必須在 run 之前
   走 `POST /console/api/apps/{app_id}/workflows/publish`（console,同源）。這一步目前在 create/modify
   兩條鏈裡都不存在,是新增點。

---

## 1. Bridge 架構

### 1.1 任務提交與狀態機

- **任務提交入口**：`bridge/src/server.ts:115-150` `POST /v1/tasks`。
  解析 `mode`（create/modify）、`spec`、`context`、`sessionId`、`attachments` → `store.create(...)` →
  `orchestrator.kick()`（串行隊列非阻塞踢動）→ 回 `201 {taskId, status:"queued"}`。
- **狀態枚舉**：`bridge/src/tasks.ts:11-22` `TaskStatus`：
  `queued / planning / plan-ready / building / agent-running / draft-ready / finalizing / ready / injecting / done / failed`。
- **狀態遷移實作**：`bridge/src/orchestrator.ts`：
  - `runTask`（:231-269）：`queued → planning → plan-ready`（建會話、modify 先落 `current-graph.json`、發計畫 prompt、驗 result.json）。
  - `runDecision`（:294-370）：`plan-ready --build--> building --> draft-ready`;`plan-ready --revise-plan--> planning --> plan-ready`;
    `draft-ready --approve--> finalizing --> ready`;`draft-ready --revise--> agent-running --> draft-ready`。
  - `markInjected`（:373-375）：`ready --> done`。
  - `fail`（:431-435）：任何異常 → `failed`。
- **⚠ 兩處與文件不一致（整合時要知曉）**：
  1. 實際程式有 `agent-running`（`revise` 迭代用）,DESIGN §5.2 主鏈沒列;面板 `sidepanel.js:7-22` 有對應文案。
  2. `injecting` 在 `TaskStatus` 型別與註解裡存在,但 **Bridge 程式裡沒有任何 transition 到 `injecting`**;
     Bridge 直接 `ready → done`。真正的「注入進度」是**擴展側**的 `task.inject.status` 子狀態
     （`idle / needDify / injecting / done / failed / importFailed`,見 `service-worker.js:382-387、389-512`）。
     → 若執行側要加「running」狀態,別照抄 `injecting` 的誤解,可仿照「擴展 inject 子狀態」或直接加一個 Bridge 狀態。
- **持久化/重啟**：`tasks.ts:74-104 loadAll` 掃 `generated/*/task.json`;`plan-ready/draft-ready/ready` 保留,
  進行中態轉 failed,`injecting → ready` 可重試。

### 1.2 DSH `session.prompt` 在哪呼叫、請求體形狀

- **封裝**：`bridge/src/dsh.ts`：
  - `rpc()`（:55-67）：一元 RPC,`POST {baseUrl}{apiPath}/{method}`,
    body = client-request 信封 `{type:"client-request", rpcId:<uuid>, method, payload}`;響應取 `full.result`。
  - `createSession(cwd, sessionId?)`（:69-73）：`session.create` payload `{cwd, ...(sessionId?{sessionId})}` → `value.sessionId`。
  - **`prompt(sessionId, text)`**（:75-82）：`session.prompt` payload
    `{sessionId, mode:"queue", content:[{type:"text", text}]}` → 期望 `value.accepted === true`。
  - `history()`（:84-88）/ `lastTurnNumber()`（:91-98）/ `lastAssistantText()`（:101-114）。
  - `waitTurnEnd()`（:180-219）：mux 幀判 `turn/end` + `history` 輪詢兜底,超時 10min。
- **實際發 prompt 的地方**：`orchestrator.ts` 的 `promptAndWait()`（:415-429）→ `this.dsh.prompt(sessionId, text)`。
  prompt 文字由 `buildPlanPrompt / buildFromPlanPrompt / buildApprovePrompt / buildRevisePrompt / buildRevisePlanPrompt`
  （:75-195）拼裝,一律指向 `generated/{taskId}/` 路徑與 SKILL.md。
- **DSH 基礎網址**：`config.ts:37-40` `dsh.baseUrl=http://127.0.0.1:3080, apiPath=/api, eventsMuxPath=/api/events.mux`。
- **mux 訂閱**：`dsh.ts:118-159 startMux/connectMux`;幀為 `server-request` 信封,`payload.type==="session/event"`。

### 1.3 result.json / artifacts 如何讀寫

- **白名單**：`tasks.ts:55` `ARTIFACT_WHITELIST = {ir.json, workflow.yaml, graph.json, result.json, plan.txt, plan-final.txt}`。
- **讀**：`readArtifact(taskId, file)`（:192-200）→ `readFileSync(generated/{taskId}/{basename})`,白名單外回 null;
  `readResult(taskId)`（:203-211）解析 `result.json` 為 `{status, summary, warnings[]}`。
- **HTTP 讀**：`server.ts:255-269` `GET /v1/artifacts/{taskId}/{file}`（回 Buffer,`.json`→application/json,其餘→text/yaml）。
- **寫的分工（DESIGN §9 約定,程式嚴格遵守）**：
  - Agent 寫：`ir.json / workflow.yaml / graph.json / result.json / plan.txt`（經 `session.prompt` 讓 Agent 直接落盤工作區）。
  - Bridge 只寫：`task.json`（`tasks.ts:152-159 persist` 原子寫）、`current-graph.json`
    （`orchestrator.ts:241-245`）、`plan-final.txt`（:304）、`plan-feedback.txt`（:319）、`attachments/`。
  - → 若要執行側「把 run 結果落盤」,遵守同一分工：新增一個 Agent 不碰、Bridge 寫的檔案（例如 `run-result.json`）,
    並把它加進 `ARTIFACT_WHITELIST` 才能在 `GET /v1/artifacts` 讀到。

### 1.4 WS 幀（task.frame / task.stream）在哪發

- **廣播**：`server.ts:37-46 broadcast(obj)` → 對所有 `/v1/events` 的 wsClients send JSON 字串。
- **task.frame（狀態機）**：`tasks.ts:161-175 emitFrame` → `{type:"task.frame", data:{taskId,status,phase,summary,error,appId,appUrl,artifact?}}`。
  由 `transition()`（:136-150）在每次狀態遷移時觸發;`store` 的 emit 回呼在 `server.ts:49`
  `new TaskStore((frame)=>broadcast(frame))` 接上。
- **task.stream（即時輸出/通知）**：`tasks.ts:178-180 emitRaw`（任意幀透傳）;
  發送點：(1) `orchestrator.ts:386-413 handleMuxPayload`（assistant/chunk 的 text-delta/reasoning-delta + tool/call）;
  (2) `attachments.ts` OCR 完成通知（`server.ts:52-55` 傳入 `emitNote`）。
- **WS 端點**：`server.ts:293-324` `/v1/events?token=…`,握手驗 token,連上先發 `bridge.status`。

---

## 2. 擴展架構

### 2.1 sidepanel ↔ service worker ↔ content script 資料流

```
panel(sidepanel.js) ── chrome.runtime.sendMessage ──► service-worker.js ── chrome.tabs.sendMessage(contextTabId) ──► content-script.js
panel ◄── chrome.runtime.onMessage 收 SW 廣播 ◄── SW broadcastTask/broadcastStatus ◄── WS task.frame/stream
content-script ── 同源 fetch ──► Dify console(/console/api,/v1),帶 cookie + X-CSRF-Token
```

- **panel → SW**（`sidepanel.js` sendMessagePromise :425-429;SW 路由 `service-worker.js:693-728`）訊息型別：
  `indify:submitTask / indify:decision / indify:addAttachments / indify:getArtifact / indify:getAdapter / indify:retryInject / indify:newSession / indify:getStatus`。
- **SW → panel 廣播**（`service-worker.js:82-97`）：`indify:status`、`indify:task`（task.frame）、`indify:stream`（task.stream）。
- **SW ↔ content-script**（`service-worker.js` 用 `chrome.tabs.sendMessage(contextTabId,...)`;content-script 監聽 `content-script.js:288-331`）：
  `indify:getContext / indify:ping / indify:getDraft / indify:injectCreate / indify:injectModify / indify:getDslVersion`。
- **上下文**：content-script `detectContext()`（:24-47）從 URL 解析 `appId`（`/app/{uuid}`）、`page:"workflow"`、`mode`;啟動即 `reportContext()`（:347）。

### 2.2 新建（導 YAML）注入

1. `sidepanel.js submit()`（:628-649）：非 workflow 頁 → `mode:"create"` → `indify:submitTask`。
2. `service-worker.js submitTask()`（:538-606）create 分支 → `POST /v1/tasks {mode:"create", spec}`。
3. 任務跑到 `ready`（workflow.yaml 就緒）→ `triggerInject`（:389-409）→ `doInject`（:412-459）：
   拉 `GET /v1/artifacts/{taskId}/workflow.yaml` → `chrome.tabs.sendMessage(indify:injectCreate)`。
4. `content-script.js injectCreate()`（:103-183）：`POST /console/api/apps/imports`（200 完成 / 202 confirm）→ 回 `{ok, appId}`。
5. SW 回報 `POST /v1/tasks/{taskId}/injected` → `chrome.tabs.update` 跳 `http://localhost/app/{appId}/workflow`。

### 2.3 修改（寫草稿）注入

1. `submitTask()` modify 分支（`service-worker.js:555-588`）：先 `indify:getDraft` 拿 graph →
   `body.context = {appId, appUrl, currentGraph: draft.graph}` → `POST /v1/tasks {mode:"modify", ...}`。
2. Agent 改 graph → `ready`（graph.json）→ `triggerInject` → `doInjectModify`（:462-512）:
   拉 `graph.json` → `indify:injectModify` → 回報 injected → `chrome.tabs.reload` 一次。
3. `content-script.js injectModify()`（:225-286）：先 `GET /console/api/apps/{app_id}/workflows/draft` 拿最新 `hash/features/env` →
   `POST draft {graph, features, hash, environment_variables, conversation_variables}`（CSRF 豁免,但同源帶 cookie）→ `{result:"success", hash}`。

### 2.4 「跑 workflow + 顯示結果」的入口應插在哪

- **UI 入口**：`extension/sidepanel.html` 的 `<footer>` 或 task 卡片 `done` 區。最自然：在 `buildTaskCard` 的
  `status==="done"`（`sidepanel.js:202-217`）之後,新增一個「▶ 運行」按鈕 + 一個 run-result 顯示區;
  按鈕 `data-action="run-workflow"`,在 `sidepanel.js:809-880` 的委派 switch 加 `case "run-workflow"`。
- **消息鏈**：panel → `indify:runWorkflow`（新訊息型別,SW `service-worker.js:693-728` 加 case）→
  SW `chrome.tabs.sendMessage(contextTabId, {type:"indify:runWorkflow", appId, inputs, adapter})` →
  content-script 新 handler（見 §3）。
- **結果回傳**：content-script 回 `{ok, status, outputs, error}` → SW 用既有 `chrome.runtime.sendMessage({type:"indify:runResult"})`
  廣播 → panel 在 `onMessage`（`sidepanel.js:911-920`）加 `indify:runResult` 分支渲染。
- **appId 來源**：`state.context.appId`（panel）/ `context.appId`（SW）/ content-script `detectContext().appId` 三處都已有,直接取用。

---

## 3. 執行配接器建議落點

### 3.1 版本防波堤：adapter JSON 新增 `serviceApi` 段（**必要**）

`skills/dify-workflow-dsl/adapter/dify-1.16.1.json` 目前只有 `console` 段。建議同級新增（與 `console` 並列）,
並同步在 `references/dify-1.16/console-api.md` 補「§3 Service API 執行側」成對維護：

```jsonc
"serviceApi": {
  "baseUrl": "http://localhost",            // nginx 已把 /v1 → api:5001（s0 §7）
  "auth": { "type": "bearer", "scheme": "Bearer", "keyPrefix": "app-" },
  "endpoints": {
    "runWorkflow": { "method": "POST", "path": "/v1/workflows/run",
      "payload": { "inputs": "object(必填)", "user": "string(必填,非空)", "response_mode": "blocking|streaming(缺省=blocking)" },
      "response": { "task_id": "string", "workflow_run_id": "string",
        "data": { "id": "string", "workflow_id": "string", "status": "succeeded|failed|stopped|paused|running",
                  "outputs": "object|null", "error": "string|null", "elapsed_time": "number",
                  "total_tokens": "number", "total_steps": "number", "created_at": "int", "finished_at": "int|null" } } },
    "runLog":      { "method": "GET",  "path": "/v1/workflows/run/{workflow_run_id}" },
    "stopTask":    { "method": "POST", "path": "/v1/workflows/tasks/{task_id}/stop" },
    "listLogs":    { "method": "GET",  "path": "/v1/workflows/logs" },
    // —— 以下三個是 console 面（cookie+CSRF）,放在既有 console.endpoints 裡,執行側要用 ——
    "createApiKey":{ "method": "POST", "path": "/apps/{app_id}/api-keys" },
    "listApiKeys": { "method": "GET",  "path": "/apps/{app_id}/api-keys" },
    "publishDraft":{ "method": "GET|POST", "path": "/apps/{app_id}/workflows/publish" }
  }
}
```

> 說明：`createApiKey / listApiKeys / publishDraft` 屬 console 認證面,嚴格說應放回 `console.endpoints`;
> 上面的 `serviceApi` 只是把「執行側需要的端點」集中列示,實作時按認證面拆分,別混進 Bearer 面。

### 3.2 推薦：新增哪個 Bridge 模組 + 函式簽名（給出具體草案,不破壞 create/modify）

**結論：最簡閉環「不需」新增 Bridge 模組**;run 全程放 content-script（同源、零 CORS、已帶 cookie,
`host_permissions` 已覆蓋 `http://localhost/*`）。只有當你想要「運行狀態/結果落盤為任務產物、
streaming 長運行、SW 休眠不中斷、歷史結果可查」時,才新增 `bridge/src/executor.ts`。

**方案 A（推薦,最小改動）：content-script 新增 handler**

```js
// content-script.js 新增（console 面 publish+key,Bearer 面 run,皆同源 fetch）
// 回傳 { ok, status, outputs, error, workflowRunId } ; 由 SW indify:runWorkflow 觸發
async function runWorkflow(appId, inputs, adapter) {
  // 1) 發布草稿（console,cookie+CSRF）── run 只認「已發布版本」
  await fetch(consoleUrl(adapter, adapter.console.endpoints.publishDraft.path, appId),
              { method:"POST", headers: buildHeaders(adapter), credentials:"same-origin" });
  // 2) 取 app key：先 GET list,拿不到 token 再 POST create（create 回應含 token,見 s0 §5）
  //    ⚠ token 通常只回一次,必須在 create 當下持久化（chrome.storage.local 或回傳 Bridge 存 .indifyrc）
  // 3) 執行
  const res = await fetch(adapter.serviceApi.baseUrl + adapter.serviceApi.endpoints.runWorkflow.path, {
    method:"POST", credentials:"same-origin",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer " + appKey },
    body: JSON.stringify({ inputs, user:"indify", response_mode:"blocking" })
  });
  const body = await res.json();
  return { ok: body.data && body.data.status === "succeeded",
           status: body.data && body.data.status,
           outputs: body.data && body.data.outputs,
           error: body.data && body.data.error, workflowRunId: body.workflow_run_id };
}
```

**方案 B（可選,Bridge 執行器,給出簽名草案）**——只做 `/v1` 純 HTTP 客戶端,key 當參數傳入、不落盤 cookie：

```ts
// bridge/src/executor.ts（新增,無狀態、無副作用,不碰 create/modify 的 Orchestrator/TaskStore）
export interface RunRequest {
  appId: string;
  appKey: string;                              // "app-<24字元>",由擴展經 console api 建立後傳入
  inputs: Record<string, unknown>;
  user?: string;                               // 預設 "indify";Service API 強制非空（s0 §3）
  responseMode?: "blocking" | "streaming";     // 預設 "blocking"
}
export interface RunResult {
  ok: boolean;                                 // status==="succeeded" && !error
  workflowRunId?: string;
  taskId?: string;
  status?: "succeeded" | "failed" | "stopped" | "paused" | "running";
  outputs?: Record<string, unknown> | null;
  error?: string;
  elapsedTime?: number;
  totalTokens?: number;
}
export async function runWorkflow(cfg: BridgeConfig, req: RunRequest): Promise<RunResult>;
export async function getRun(cfg: BridgeConfig, workflowRunId: string): Promise<RunResult>;  // 輪詢/補查
```

若採 B,Server 端對應加一個端點（仿 `server.ts` 既有路由風格,不碰 `/v1/tasks`）：

```
POST /v1/run                     body {appId, appKey, inputs, user?, responseMode?}  → RunResult
GET  /v1/run/{workflowRunId}     → RunResult
```

> 但注意：`publish` 與 `createApiKey` 仍必須在 content-script（console cookie+CSRF,Bridge 不持 cookie,見 DESIGN §10）。
> 所以無論 A/B,「publish + 取 key」都在擴展側;差別只在「最後那一發 `/v1/workflows/run`」由誰發。

### 3.3 是否新增 `skills/run-workflow/` 給 Agent —— **不建議**

- Agent（DSH 會話）職責是「結構語義」,其輸出通道是「寫工作區檔案 + 回摘要」;
  沒有確定性的「對 Dify 發 HTTP 並判定成功」能力,也不該把 app key 塞進 prompt。
- 執行是**確定性的 HTTP 步驟**,應留在 Bridge/擴展側（與 create 的匯入、modify 的草稿寫回同級）。
- 若要讓 Agent「知道改完會被自動發布+運行+判定」,只需在現有 `SKILL.md` 補一條約定（§2 之後）,
  **不必新建 skill**;同理未來要 MCP 化,是包 `scripts` 而不是包「run」。

### 3.4 不破壞 create/modify 的紀律

1. 新增端點掛在既有 `handleHttp` 的新 `if` 分支（`server.ts:84-284` 尾部),**不復用** `/v1/tasks*` 路徑匹配,
   不新增 TaskStatus 到既有狀態機（除非你要落盤 run 結果,才加一個獨立檔案）。
2. adapter JSON 只**加** `serviceApi` 段與 console 的 `createApiKey/listApiKeys/publishDraft` 端點,不動既有 key。
3. content-script 只**加** handler 與 message case,不改 `injectCreate / getDraft / injectModify`。
4. SW 只**加** `indify:runWorkflow / indify:runResult` 兩個 case,不改 submitTask/doInject/doInjectModify。

---

## 4. 「改 skill = 改其 workflow」如何復用 U2/U3

### 4.1 概念映射

| 概念 | 對應 |
|---|---|
| 一個「skill」 | 一個已發布的 Dify workflow app（有 `app_id`;草稿 = 其 workflow.graph） |
| 「改一個 skill」 | 一次 `mode:"modify"` 任務,`spec` = 對該 skill 的改動需求,`context.appId` = skill 的 app_id |
| 「跑一個 skill」 | §3 執行配接器:對同一 `app_id` publish → `POST /v1/workflows/run` |

→ 兩件事都以 **`app_id`** 為錨;modify 路徑（U2/U3）**原封不動直接可用**,唯一缺的是「skill 名 → app_id」解析。

### 4.2 app_id → 草稿 API 的呼叫鏈（精確,現成程式）

1. 解析 skill 名 → `app_id`（**新增**,見 §4.3）。
2. `sidepanel.js submit()`：`isWorkflowPage()` 為真 → `mode:"modify"`;但「改 skill」不必在畫布頁,可直接指定 app_id,
   因此更精準的做法是：SW 的 `submitTask()` 在 modify 分支**不再依賴 `context.appId`**,改用 skill 表解出的 app_id 填 `body.context.appId`。
3. `service-worker.js submitTask()` modify 分支（:555-588）：`indify:getDraft` → `body.context.currentGraph = draft.graph` → `POST /v1/tasks`。
4. `content-script.js getDraft()`（:196-222）：`GET /console/api/apps/{app_id}/workflows/draft`（同源,CSRF 豁免）。
5. Bridge `orchestrator.ts runTask()`（:238-246）：把 `context.currentGraph` 寫成 `generated/{taskId}/current-graph.json`。
6. Agent 改 graph → `graph.json`（modify 的 build prompt `orchestrator.ts:109-128`）。
7. `service-worker.js doInjectModify()`（:462-512）→ `content-script.js injectModify()`（:225-286）：
   `GET draft` 拿最新 hash → `POST draft {graph, features, hash, ...}` → `chrome.tabs.reload` 一次。
8. 若閉環要「改完自動跑」：在第 7 步 reload 前後,接 §3 的 publish + run（S5）。

### 4.3 把「改 skill」映射過去的方案（最小改動）

- **新增一張「skill → app_id」表**。建議落點：`.indifyrc.yaml` 加 `skills:` 段（config 屬 workspace,gitignored,`config.ts`
  已有 mini-YAML 解析器,加一個欄位 + `coerce` 解析即可）,或獨立 `generated/skill-registry.json`。
  形如：`skills: { "客服工单分类": "<app_id>", "发票提取": "<app_id>" }`。
- **改動點（2 處,非新路徑）**：
  1. `sidepanel.js submit()`：當 `spec` 命中 skill 名（或新增一個 skill 選擇器）時,發
     `indify:submitTask {mode:"modify", spec, skillId}`。
  2. `service-worker.js submitTask()`：`skillId` 存在時,用 registry 解出 `appId` 填入 `body.context.appId`,
     並跳過「必須在畫布頁」的守衛（:558 那支 `needDify` 檢查）。其餘照走既有 modify 鏈。
- **app_url**：`adapter.urls.workflowPagePattern` 已能由 app_id 組出（`service-worker.js:578-580`）。

---

## 5. 缺口 / 風險

### 5.1 DSH 會話模型能力限制

- 單會話串行（`orchestrator.pump()` 一次一個 queued 任務）;`session.prompt` 只支持 text content,
  已實測不吃圖（R8）——**執行判定不得靠 Agent 發 HTTP**,必須 Bridge/擴展側做。
- `mode:"queue"` 提交後立刻回 `accepted:true`,真正完成靠 `turn/end`;turn 超時 10min（`TURN_TIMEOUT_MS`）。
- Agent 只能「寫檔案 + 回摘要」;若讓它判定成功,只能叫它讀回執行結果檔案再回 result.json——間接且不可靠,不建議。

### 5.2 cookie / CSRF / CORS

- **console 面**（`/console/api`）：cookie `access_token`(HttpOnly) + `X-CSRF-Token`==cookie `csrf_token`
  （覆蓋所有非 OPTIONS,含 GET）;`draft` 路徑 CSRF 豁免。content-script 同源 fetch 天然帶 cookie,只需補 CSRF 頭（`buildHeaders` :65-72）。
- **Service API 面**（`/v1`）：**Bearer `app-<key>`**,不走 console cookie,也無 console 那套 CSRF。
  `app-` key 由 console `POST /console/api/apps/{app_id}/api-keys` 產生（**需要 console 登入態 + edit 權限**）。
- **CORS**：content-script 同源 fetch → 無 CORS;Bridge（Node）→ 無 CORS。
  若從 SW 直接 `fetch("http://localhost/v1/...")`,`host_permissions` 對 fetch 的跨域豁免在 MV3 仍需實測;
  最穩是 content-script 同源。

### 5.3 擴展跨域

- `manifest.json` 已 `host_permissions:["http://localhost/*","http://127.0.0.1/*"]`,`/v1` 在 `http://localhost` 下 → 覆蓋。
- content_scripts `matches:["http://localhost/*"]` 已注入 → run handler 可直接掛。
- `/v1` 是 nginx 反代（s0 §7),對瀏覽器而言是**同源**,無新權限需求。

### 5.4 Service API 與 console cookie 的區別（關鍵,勿混）

| 面 | 認證 | 憑證位置 | 誰能調 |
|---|---|---|---|
| console `/console/api` | cookie `access_token` + `X-CSRF-Token` | 瀏覽器（HttpOnly） | content-script 同源 |
| Service API `/v1` | `Authorization: Bearer app-<key>` | 應用 API key（`api_tokens` 表,type=app） | 任何持 key 者（Node/Bridge 亦可） |
| app key 產生 | console `POST /apps/{app_id}/api-keys`（需登入態） | 回傳 `{id, type, token, ...}` | content-script |

- 後果：**Bridge 不能獨自完成執行**（它不持 console cookie、不能建 key）;執行必須「擴展側取 key → 交 Bridge 或直接 content-script run」。

### 5.5 其他風險

- **publish 前置**：run 認「已發布版本」;modify 只寫 draft → 閉環須先 `publish`,這是新步驟（見 §0.3、S5）。
- **app key 一次性**：s0 §5 只證明 create 回應含 token;list 端點**未必回傳 token 明文** →
  必須在 create 當下持久化（chrome.storage.local 或 `.indifyrc.yaml`）,否則取不回。
- **每 app 上限 10 支 key**（s0 §5）;`enable_api` 須為 true、`app.status==normal`（s0 §2）,否則 401/403。
- **`user` 必填非空**、`inputs` 必填（s0 §3）;缺了直接 400/ValueError。
- **blocking vs streaming**：先做 blocking（同步回 `data.outputs`,最簡）;streaming 是 SSE（`data: {JSON}\n\n`）,
  後置;長運行要配 `GET /v1/workflows/run/{workflow_run_id}` 輪詢。
- **判定成功**：以 `data.status==="succeeded" && !data.error` 為準（s0 §4.1）;`failed/stopped/paused/running` 都要能呈現。
- **`.indifyrc.yaml` 是 gitignored**（config 自動生成,含 token）;skill→app_id 表與 app key 放這裡即不入庫,符合「不寫密鑰」。

---

## 6. 最小端到端接線順序（S1 → S5）

> 工作區未找到名為 S1–S5 的既有計畫文件（grep 僅命中不相干的 S3 雲存儲）,以下按兩特性拆成五步,
> 若與你手頭 S1–S5 編號不同,請以「內容」對齊而非編號。

| 步 | 內容 | 交付/驗證 |
|---|---|---|
| S1 | adapter JSON 加 `serviceApi` 段 + console 補 `publishDraft/createApiKey/listApiKeys`;console-api.md 同步 | `GET /v1/adapter/1.16.1` 能讀到執行側端點 |
| S2 | content-script 加 `runWorkflow` handler（publish → 取/建 key → run blocking）+ SW 加 `indify:runWorkflow` 路由 | 控制台手動觸發一次,拿到 `data.outputs` 與 `status` |
| S3 | **panel 入口 + 結果顯示**：先加「▶ 運行」按鈕 + `indify:runResult` 渲染（blocking 結果:outputs/error/elapsed） | 畫布頁點按鈕 → 面板看到 succeeded/failed + outputs |
| S4 | **「改 skill」接線**：skill→app_id 表（`.indifyrc.yaml` 或 registry）+ SW submitTask 支持 `skillId` 直填 `context.appId`（復用 U2/U3 全程） | 改一個 skill → 草稿就地更新（與現 modify 同） |
| S5 | **端到端閉環**：改 skill → 自動 publish → 自動 run → 判定成功 → 回饋 | 一條指令完成「改+跑+報成功」 |

**S3 先做什麼（按優先序）**：
1. 只接 **blocking** 路徑（最簡,同步回 `data.outputs`）,streaming 明確後置。
2. 先在 `sidepanel.html` 加一個最小「▶ 運行」按鈕 + 一個 `<pre>` 結果區,`sidepanel.js` 加
   `case "run-workflow"`（:809-880）與 `indify:runResult` 分支（:911-920）—— 不動既有卡片結構。
3. 成功判定函式先獨立成純函式 `isRunSuccess(data) = data.status==="succeeded" && !data.error`,供 S5 直接復用。

**S5 先做什麼（按優先序）**：
1. **先打通「publish」**：把 S2 的 publish 步驟抽成 content-script 可單獨呼叫的 `publishDraft(appId)`,
   並在 `doInjectModify` 寫回草稿後（`service-worker.js:503-508` reload 之前）接上;否則 run 永遠跑舊版。
2. **再做「run + 判定成功」**：把 S3 的 `isRunSuccess` 接到「改完自動 run」的尾端,輸出 outputs 作為閉環回饋;
   失敗/暫停/停止都要能回顯,不靜默。

---

## 附錄：關鍵行號索引

| 主題 | 位置 |
|---|---|
| `POST /v1/tasks` 提交 | `bridge/src/server.ts:115-150` |
| TaskStatus 枚舉 | `bridge/src/tasks.ts:11-22` |
| 狀態遷移 | `bridge/src/orchestrator.ts:231-269, 294-370, 373-375` |
| `session.prompt` 封裝 + 請求體 | `bridge/src/dsh.ts:75-82`（信封 :55-67） |
| result.json / artifacts 讀寫 | `bridge/src/tasks.ts:55, 192-211`;HTTP `server.ts:255-269` |
| WS 幀 task.frame / task.stream | `tasks.ts:161-180`;`orchestrator.ts:386-413`;`server.ts:37-46, 293-324` |
| sidepanel↔SW↔content 訊息路由 | SW `service-worker.js:693-728`;content `content-script.js:288-331`;panel `sidepanel.js:911-920` |
| 新建注入（導 YAML） | `service-worker.js:412-459`;`content-script.js:103-183` |
| 修改注入（寫草稿） | `service-worker.js:462-512`;`content-script.js:196-286` |
| 草稿讀寫契約 | `references/dify-1.16/console-api.md:70-88`;adapter JSON `draftGet/draftPost/draftPublish` |
| Service API run 契約 | `docs/s0-service-api-findings.md` §1–§5 |
| 「改 skill」復用點 | `service-worker.js:555-588`(modify 分支)、`orchestrator.ts:238-246`、`content-script.js:225-286` |
