# S0 · Dify 1.16.1 Service API 契約探查（執行側）

> 目的：為 Indify v3「執行側」探明 Dify 1.16.1 的 Service API 契約，用以運行已發布的 workflow。
> 版本基準：`D:\dify` 為官方完整 clone，工作樹在 `main`（`1.16.1-659-g98c2ffeec7`）；關鍵檔案另以 `git show 1.16.1:<path>` 對照 `1.16.1` tag 核實，二者一致。
> 本機 Dify 實跑容器為 `langgenius/dify-api:1.16.1`（見第 7 節）。
> 全部為「只讀探查」：未改動任何既有程式碼／設定，僅新建本文件。未記錄任何真實 key/token（未遇見）。

---

## 1. 運行 workflow 的端點 —— 源码核实

- Service API 藍圖前綴為 **`/v1`**：`api/controllers/service_api/__init__.py:6`
  ```python
  bp = Blueprint("service_api", __name__, url_prefix="/v1")
  ```
- 主端點確認為 **`POST /v1/workflows/run`**：`api/controllers/service_api/app/workflow.py:274`（`@service_api_ns.route("/workflows/run")`）。
- 同一 app/workflow 命名空間下的完整端點清單（`workflow.py`）：
  - `POST /v1/workflows/run`（:274）— 運行已發布 workflow（主入口）。
  - `POST /v1/workflows/<workflow_id>/run`（:375）— 按特定 workflow 版本 ID 運行。
  - `GET  /v1/workflows/run/<workflow_run_id>`（:219）— 查詢某次運行結果／狀態。
  - `POST /v1/workflows/tasks/<task_id>/stop`（:508）— 停止 streaming 中的 task。
  - `GET  /v1/workflows/logs`（:552）— 分頁查運行日誌。
- **別名／新版路徑**：`grep "v1/workflows"` 在 `api/` 下無任何命中；`grep "workflows/run"` 僅出現上述 controller 與 `api/controllers/web/workflow.py:41`（`/workflows/run`，屬 WebApp API `/api` 前綴、非 Service API）。故 **Service API 無別名，`/v1/workflows/run` 即唯一主路徑**。
- 對照 `1.16.1` tag：`git show 1.16.1:api/controllers/service_api/app/workflow.py` 五條 route 全部存在（`workflows/run`、`workflows/<workflow_id>/run`、`workflows/tasks/<task_id>/stop`、`workflows/logs`、`workflows/run/<workflow_run_id>`）。

---

## 2. 鑑權機制 —— 源码核实

- 進入點：`POST /v1/workflows/run` 掛載 `@validate_app_token(fetch_user_arg=FetchUserArg(fetch_from=WhereisUserArg.JSON, required=True))`（`workflow.py:324`）。
- 裝飾器定義：`api/controllers/service_api/wraps.py:99` `validate_app_token` → 呼叫 `validate_and_get_api_token("app")`（`wraps.py:105`）。
- Header 解析（`wraps.py:361` `validate_and_get_api_token`）：
  - 讀 `Authorization` header；必須含空格、scheme 必須為 `bearer`（大小寫不敏感，`wraps.py:372-380`）。
  - 形如 `Authorization: Bearer <app API key>`。
- Token 綁定邏輯（`api/services/api_token_service.py:282` `query_token_from_db`）：
  - `select(ApiToken).where(ApiToken.token == auth_token, ApiToken.type == "app")` → 用「token 值 + type=app」查 DB。
  - 命中後寫入 Redis cache（TTL 600s，`api_token_service.py:56`），並以 single-flight 鎖避免並發重複查庫（`fetch_token_with_single_flight`, :301）。
  - 查無 → `raise Unauthorized("Access token is invalid")`（:294）。
- Token 與 app 的綁定：`ApiToken` 模型（`api/models/model.py:2370`）表 `api_tokens`，欄位 `id / app_id / tenant_id / type / token / last_used_at / created_at`。`validate_app_token` 拿 `api_token.app_id` 查 `App`（`wraps.py:107`），並依次校驗：
  1. app 存在（:108）
  2. `app.status == "normal"`（:111）
  3. `app.enable_api == True`（:114，`App.enable_api` 欄位見 `model.py:434`）
  4. tenant 未被 archive（:117-121）
- Key 格式（源码核实）：app key 前綴 **`app-`** + 24 位隨機字元（`api/controllers/console/apikey.py:237` `token_prefix = "app-"`；`model.py:2388` `generate_api_key(prefix, n)` = `prefix + generate_string(n)`，n=24，見 `apikey.py:130`）。dataset key 前綴為 `ds-`。
- 附註（源码核实）：`api/libs/oauth_bearer.py:589` 註明「`app-` keys belong to service_api/wraps.py:validate_app_token」——即 `app-` 前綴 key 走 app token 校驗，與 oauth bearer token（`dfoa_`/`dfoe_` 前綴）分流。

---

## 3. 請求體 schema —— 源码核实

- 運行入口使用的模型：`WorkflowRunPayload`（`workflow.py:70`），繼承 `WorkflowRunPayloadBase`（`api/controllers/common/controller_schemas.py:156`）。
- 欄位（`controller_schemas.py:156-172` + `workflow.py:71-80`）：

  | 欄位 | 必填 | 類型 | 預設 | 說明 |
  |---|---|---|---|---|
  | `inputs` | **是** | `dict[str, Any]` | 無 | workflow 輸入變數鍵值；file 型變數值為 file object 陣列 |
  | `files` | 否 | `list[dict] \| null` | `null` | workflow 系統「檔案上傳」輸入（upload file） |
  | `response_mode` | 否 | `"blocking" \| "streaming" \| null` | `null` | 省略時＝**blocking**（`workflow.py:71-77`、判定 `streaming = payload.response_mode == "streaming"` 於 `:344`） |
  | `user` | **是** | `string`（JSON body） | 無 | 終端使用者識別，由 `validate_app_token(fetch_user_arg=... required=True)` 強制（`wraps.py:126-137`，缺值即 `ValueError("Arg user must be provided.")`） |

- `user` 必填是「源码核实」：`wraps.py:136-137` 在 `required=True` 且缺值時拋錯；空字串也算缺值。
- file object 結構（`controller_schemas.py:111-142`，`INPUT_FILE_ITEM_SCHEMA`）：
  - 必填：`type`（`document | image | audio | video | custom`）、`transfer_method`（`remote_url | local_file`）。
  - `remote_url` 時給 `url`（`format: url`）；`local_file` 時給 `upload_file_id`（來自 `POST /v1/files/upload`）。
- 最小可用請求（源码核实）：`{"inputs": {...}, "user": "<非空字串>"}`；`response_mode` 省略即 blocking。測試佐證：`api/tests/unit_tests/controllers/service_api/app/test_workflow.py:563` 以 `{"inputs": {}}` 建 request context。
- 額外可選欄位：`trace_session_id`（body，`SkipJsonSchema`，`workflow.py:78`）與 header `external_trace_id` / trace session（`workflow.py:338-343`）。

---

## 4. 響應體 schema —— 源码核实

### 4.1 blocking（`response_mode` 省略或 `"blocking"`）
- 返回 `WorkflowAppBlockingResponse`（`api/core/app/entities/task_entities.py:892`），形狀：

  ```json
  {
    "task_id": "<task id>",
    "workflow_run_id": "<run id>",
    "data": {
      "id": "<run id，等於 workflow_run_id>",
      "workflow_id": "<本次執行的 workflow 版本 id>",
      "status": "succeeded | failed | stopped | paused | running",
      "outputs": { "...end 節點輸出..." } | null,
      "error": "<錯誤訊息>" | null,
      "elapsed_time": 0.123,
      "total_tokens": 42,
      "total_steps": 3,
      "created_at": 1700000000,
      "finished_at": 1700000001 | null
    }
  }
  ```
  - 欄位定義見 `task_entities.py:897-914`（`Data`：`id/workflow_id/status/outputs/error/elapsed_time/total_tokens/total_steps/created_at/finished_at`；外層 `workflow_run_id` + `task_id`）。
  - `data.outputs` 即 workflow `end` 節點的 `outputs`；失敗時 `status="failed"` 且 `error` 帶字串。
  - `status` 型別為 `graphon.enums.WorkflowExecutionStatus`（外部編譯套件 `graphon==0.7.0`，見 `api/pyproject.toml:48`，源碼樹內無定義——**此枚舉值為「推断」**）。終態值佐證：`workflow.py:85` 的 `WorkflowLogQuery.status` 為 `Literal["succeeded","failed","stopped"]`；`workflow.py:152` 另見 `WorkflowExecutionStatus.PAUSED`。故終態＝`succeeded / failed / stopped`，另有 `paused`（HITL 暫停）與進行中 `running`。
- `GET /v1/workflows/run/{workflow_run_id}` 回 `WorkflowRunResponse`（`workflow.py:116-127`）：`id / workflow_id / status / inputs / outputs / error / total_steps / total_tokens / created_at / finished_at / elapsed_time`。
- HTTP 錯誤物件（源码核实）：Service API 統一錯誤形狀 `{code, message, status}`，由 `api/libs/external_api.py:29` `_finalize` 產出（`code` 為錯誤碼字串如 `not_workflow_app`、`provider_not_initialize`、`invalid_param`、`unauthorized` 等，見 `workflow.py:280-303` 的 400/401/403/404/429/500 文案）。

### 4.2 streaming（`response_mode: "streaming"`）
- `Content-Type: text/event-stream`；每幀為 **`data: {JSON}\n\n`**（`api/core/app/apps/base_app_generator.py:324`）。
- 每幀 JSON（`ChunkWorkflowEvent`）基本形狀：`{ "event": "...", "task_id": "...", "workflow_run_id": "...", ...資料 }`，由 `WorkflowAppGenerateResponseConverter`（`api/core/app/apps/workflow/generate_response_converter.py:44-76`）組裝。
- 事件種類（`StreamEvent` 枚舉，`task_entities.py:62-95`）：`workflow_started / node_started / node_finished / node_retry / workflow_finished / workflow_paused / iteration_started|next|completed / loop_started|next|completed / text_chunk / text_replace / reasoning_chunk / ping / error / agent_log / human_input_required ...`。
- 關鍵事件資料：
  - `workflow_started`：`data:{id, workflow_id, inputs, created_at, reason}`（`task_entities.py:205-224`）。
  - `workflow_finished`：`data:{id, workflow_id, status, outputs, error, elapsed_time, total_tokens, total_steps, created_by, created_at, finished_at, exceptions_count, files}`（`task_entities.py:227-253`）。
  - `node_started`：`data:{id, node_id, node_type, title, index, predecessor_node_id, inputs, created_at, ...}`（`task_entities.py:377-420`）。
  - `node_finished`：`data:{id, node_id, node_type, title, index, inputs, process_data, outputs, status, error, elapsed_time, created_at, finished_at, files, ...}`（`task_entities.py:423-484`）。
  - `error`：`{event:"error", workflow_run_id, message, status, code}`（`ErrorStreamResponse` `task_entities.py:107` + converter 的 `_error_to_stream_response`）。
  - `ping`：心跳，converter 直接 `yield "ping"`（`generate_response_converter.py:60`）。

---

## 5. app API key 從哪來 —— 源码核实

- 控制台（Console API，前綴 `/console/api`）後端端點（`api/controllers/console/apikey.py`）：
  - `POST /console/api/apps/<app_id>/api-keys`（:217-232，`create_app_api_key`）→ 建立 key。
  - `GET  /console/api/apps/<app_id>/api-keys`（:201-215）→ 列出該 app 的 keys。
  - `DELETE /console/api/apps/<app_id>/api-keys/<api_key_id>`（:240-267）→ 刪除。
- 建立邏輯（`apikey.py:107-139` `_create_api_key`）：`ApiToken.generate_api_key("app-", 24)` → 寫入 `api_tokens`（`type=APP`、`app_id=該 app`、`tenant_id=當前工作區`）。回傳 `ApiKeyItem{id, type, token, last_used_at, created_at}`（`apikey.py:39-44`）。每 app 上限 **10** 支 key（`apikey.py:77` `max_keys = 10`）。
- 手動取得路徑：控制台 App →「API 訪問 / API Access」→ 建立/複製 key（UI 即調上述 Console 端點）。
- 自動建立的前置（源码核实 + 推断）：Console 端點受 `login_required`、`edit_permission_required`、`rbac_permission_required`（`apikey.py:205-207` 等）保護——需要「Console 使用者登入態」（session/oauth），**不是**用 Service API 的 `app-` key 自己就能建。未來 Agent 自動建 key，需先取得 Console 登入憑證（帳號密碼／email 登入／OAuth），再調 `POST /console/api/apps/<app_id>/api-keys`。

---

## 6. 原生 MCP 形態 —— 源码核实（1.16.1 已內建）

- **1.16.1 已內建把 app/workflow 暴露成 MCP server**（非「未見」）。
- 路由：藍圖 `url_prefix="/mcp"`（`api/controllers/mcp/__init__.py:6`）；端點 **`POST /mcp/server/<server_code>/mcp`**（`api/controllers/mcp/mcp.py:44`）。
- 協議：MCP 的 **Streamable HTTP**（JSON-RPC 2.0 over HTTP POST），非舊式 `GET /sse`。實作見 `api/core/mcp/server/streamable_http.py`（`handle_mcp_request`）。以 `MCP-Protocol-Version` header 協商版本（`mcp.py:74-83`）；僅接受 `notifications/initialized` 通知（:155）。
- 入口識別：`server_code`（AppMCPServer 模型，`api/models/model.py:2259-2299`，`server_code` 為 16 位隨機碼，`generate_server_code(16)`）。
- 工具命名規律（源码核实 + 部分推断）：每個 app/workflow 的「使用者輸入表單（user_input_form）」變數即成為 MCP 工具參數（`mcp.py:183-226` `_get_user_input_form` / `_create_variable_entity`）；MCP 工具本身由 app 的工作流輸入定義驅動。確切的「工具名」產生規則在 `api/core/mcp/server/streamable_http.py`（外部 graphon 協作）中，屬編譯／內部實作，未逐行展開（此細項標「推断」）。
- 管理端點：`api/controllers/console/app/mcp_server.py`（create/list/update app MCP server；`server_code` 建立時生成，:126、:204）。
- 授權：`app_factory.py:82` 將 `/mcp` 與 `/v1` 同列為 `_LicenseGatedSurface`（Bearer 表面），即 `/mcp` 同受 license gate 保護（與 Service API 同級）。
- nginx 亦代理 `/mcp` → `api:5001`（見第 7 節）。

---

## 7. 本地運行棧現狀 —— 源码核实（執行環境實測）

- `docker ps`（2026-07 運行中，皆 Up 13 days）關鍵容器：
  - `docker-api-1` — `langgenius/dify-api:1.16.1`（healthy）
  - `docker-worker-1` / `docker-worker_beat-1` / `docker-api_websocket-1` — 同 `dify-api:1.16.1`
  - `docker-web-1` — `dify-web:1.16.1`
  - `docker-plugin_daemon-1` — `dify-plugin-daemon:0.6.10-local`
  - `docker-sandbox-1`（0.2.15）、`docker-local_sandbox-1`、`docker-redis-1`（6-alpine）、`docker-db_postgres-1`（postgres:15-alpine）、`docker-weaviate-1`（1.27.0）、`docker-ssrf_proxy-1`、`docker-agent_*` 等。
- `/v1` 路由已暴露（容器內實測，源码核实）：
  - `docker exec docker-api-1 grep url_prefix .../service_api/__init__.py` → `url_prefix="/v1"`。
  - `docker exec docker-api-1 grep url_prefix .../mcp/__init__.py` → `url_prefix="/mcp"`。
  - 容器內 `python --version` → `Python 3.12.13`。
  - 容器內 HTTP 探測：`GET /v1/workflows/logs` → **401**（鑑權 wrapper 生效、路由存在）；`GET /v1/workflows/run` → **405**（僅 POST，路由已註冊）；`GET /v1/` → **404**（index 根路由未命中，屬修飾性差異，不影響 `/v1/workflows/*`）。
- nginx 反代（`D:\difyIndify\nginx\conf.d\default.conf`）：`/v1` → `api:5001`（:29-33）、`/mcp` → `api:5001`（:66-70）、`/console/api` → `api:5001`（:8-12）、`/api` → `api:5001`（:14-18）。
- 未執行任何需要寫入／帶密鑰的操作；未接觸真實 key（未記錄）。

---

## 結論（≤150 字）

執行側走 Service API 可行且成熟：`POST /v1/workflows/run`，`Authorization: Bearer app-<key>`，最小請求體僅需 `{"inputs":{...},"user":"<非空>"}`，省略 `response_mode` 即 blocking 同步回傳 `data.outputs`；`app-` key 由 `POST /console/api/apps/<app_id>/api-keys` 產生。MCP 亦可選用（`/mcp/server/<server_code>/mcp`，Streamable HTTP），但需先經 Console 建 App MCP server 並取得 `server_code`。
