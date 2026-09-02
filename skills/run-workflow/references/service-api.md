# Dify 1.16.1 Service API 备忘（执行侧）

> 提炼自 `docs/s0-service-api-findings.md`（源码核实 + 本机容器实测）。
> 权威契约为 s0-findings；本文只做执行侧最小备忘，供未来维护。

## 1. 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/workflows/run` | POST | **主入口**：运行已发布 workflow |
| `/v1/workflows/<workflow_id>/run` | POST | 按特定 workflow 版本 ID 运行 |
| `/v1/workflows/run/<workflow_run_id>` | GET | 查询某次运行结果/状态 |
| `/v1/workflows/tasks/<task_id>/stop` | POST | 停止 streaming 中的 task |
| `/v1/workflows/logs` | GET | 分页查运行日志 |

- Service API 蓝图前缀 `/v1`（nginx 已代理到 `api:5001`）。
- 无别名路径；`/v1/workflows/run` 即唯一主路径。

## 2. 鉴权

- 头：`Authorization: Bearer <app API key>`；scheme `bearer`（大小写不敏感）。
- key 前缀 `app-` + 24 位随机字符；生成处：控制台 App →「API 访问 / API Access」。
- 校验：token 值 + `type=="app"` 查 `api_tokens`；再校 app 存在 / `status=="normal"` / `enable_api==True` / tenant 未 archive。
- 无 key / key 错 → 401；`GET /v1/workflows/logs` 无鉴权即 401（wrapper 生效）。

## 3. 请求体（POST /v1/workflows/run）

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `inputs` | 是 | `dict[str, Any]` | workflow 输入变量键值；file 型变量值为 file object 数组 |
| `user` | 是 | string（JSON body） | 非空字符串；缺值抛 `ValueError("Arg user must be provided.")` |
| `response_mode` | 否 | `"blocking" \| "streaming"` | 省略即 blocking |
| `files` | 否 | `list[dict] \| null` | 系统「文件上传」输入（upload file） |
| `trace_session_id` | 否 | — | 追踪（SkipJsonSchema） |

- 最小可用：`{"inputs": {...}, "user": "<非空>"}`。
- file object：必填 `type`（document/image/audio/video/custom）、`transfer_method`（remote_url/local_file）；
  `remote_url` 给 `url`，`local_file` 给 `upload_file_id`（来自 `POST /v1/files/upload`）。

## 4. 响应（blocking）

```json
{
  "task_id": "<task id>",
  "workflow_run_id": "<run id>",
  "data": {
    "id": "<run id>",
    "workflow_id": "<本次 workflow 版本 id>",
    "status": "succeeded | failed | stopped | paused | running",
    "outputs": { "...end 节点输出..." } | null,
    "error": "<错误>" | null,
    "elapsed_time": 0.123,
    "total_tokens": 42,
    "total_steps": 3,
    "created_at": 1700000000,
    "finished_at": 1700000001 | null
  }
}
```

- `data.outputs` = end 节点 outputs；失败时 `status=="failed"` 且 `error` 带字串。
- HTTP 错误统一形状 `{code, message, status}`（code 例：`unauthorized` / `not_workflow_app` / `invalid_param` / `provider_not_initialize` 等）。

## 5. 响应（streaming）

- `Content-Type: text/event-stream`；每帧 `data: {JSON}\n\n`。
- 每帧 JSON 形如 `{ "event": "...", "task_id": "...", "workflow_run_id": "...", ...data }`。
- 关键事件：
  - `workflow_started`：`data:{id, workflow_id, inputs, created_at, reason}`。
  - `workflow_finished`：`data:{id, workflow_id, status, outputs, error, elapsed_time, total_tokens, total_steps, created_by, created_at, finished_at, exceptions_count, files}`。
  - `node_started`：`data:{id, node_id, node_type, title, index, predecessor_node_id, inputs, created_at, ...}`。
  - `node_finished`：`data:{id, node_id, node_type, title, index, inputs, process_data, outputs, status, error, elapsed_time, created_at, finished_at, files, ...}`。
  - `error`：`{event:"error", workflow_run_id, message, status, code}`。
  - `ping`：心跳（非 JSON，转发端应忽略）。

## 6. app key 生成

- Console 端点（前缀 `/console/api`，需登录态）：
  - `POST /console/api/apps/<app_id>/api-keys` 建 key；`GET .../api-keys` 列；`DELETE .../api-keys/<id>` 删。
  - 每 app 上限 10 支 key；生成逻辑 `ApiToken.generate_api_key("app-", 24)`。
- 注意：不能用 Service API 的 `app-` key 自己建 key；自动建 key 需先取得 Console 登录态。
