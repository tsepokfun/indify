# Dify 1.16.1 控制台 API(人读版)

> 依据:M0 实测(见 `docs/m0-findings.md` §2),从运行中的 dify 容器验证。
> 这是「控制台自己调用的后端接口」(非公开 Service API),前缀 `/console/api`,
> nginx 代理到 `api:5001`。本文件供人读/实现;机器可读细节在 M4 的
> `adapter/dify-1.16.1.json`(与本文件同源维护,成对更新)。

## 1. 认证与 CSRF

### 登录

```
POST /console/api/login
Content-Type: application/json

{ "email": "user@example.com",
  "password": "<base64(明文密码)>",   // 注意:是 base64,不是 RSA 加密
  "language": "en-US",
  "remember_me": true }
```

- 成功:`200`,响应体 `{"result":"success"}`;
- `Set-Cookie`:`access_token`(HttpOnly)、`refresh_token`(HttpOnly)、`csrf_token`。
- 密码字段 = `base64(明文)`,由 `libs/encryption.py` `FieldEncryption.decrypt_field` 解码。

### CSRF 规则

- 校验**覆盖所有非 OPTIONS 方法(含 GET)**。
- 请求头 `X-CSRF-Token` 必须等于 cookie `csrf_token`(JWT 校验由 PassportService 完成)。
- 登录态请求必须带:`Cookie: access_token=…` + `X-CSRF-Token: <csrf_token>`。
- **白名单豁免**:`/console/api/apps/<uuid>/workflows/draft`(草稿读写不校验 CSRF)。
- 未登录时(login/register 等)不校验 CSRF。

> 浏览器 content script 是同源 fetch,天然携带 cookie,只需额外读 `csrf_token` cookie
> 填入 `X-CSRF-Token` 头(draft 端点可省)。

## 2. 核心端点

### 2.1 DSL 导入(新建路线)

```
POST /console/api/apps/imports
{ "mode": "yaml-content",            // 或 "yaml-url"
  "yaml_content": "<DSL YAML 字符串>",  // mode=yaml-content 时
  // "yaml_url": "…",               // mode=yaml-url 时
  "name": "...", "description": "...", "icon": "…", "icon_background": "…",
  "icon_type": "emoji", "app_id": null }
```

- 同步完成:`200 { status: "completed"|"completed-with-warnings", app_id,
  current_dsl_version, imported_dsl_version, warnings[] }`。
- 含插件/依赖时:`202 { status: "pending", import_id }`,需再
  `POST /console/api/apps/imports/{import_id}/confirm` 确认。
- **旧版 DSL 自动迁移**(0.3.1 → 0.7.0 实测通过)。
- 得到 `app_id` 后跳转 `http://localhost/app/{app_id}/workflow` 打开画布。

### 2.2 创建应用(空壳)

```
POST /console/api/apps
{ "name": "...", "mode": "workflow", "description": "..." }
→ 201 { id, mode, ... }
```

> 注意:创建时**不生成草稿**;首次导出会 500(`Missing draft workflow configuration`)。
> 草稿在首次 POST draft 时创建。

### 2.3 草稿读写(modify 路线)

```
GET /console/api/apps/{app_id}/workflows/draft
→ 200 { id, graph, features, hash, version, marked_name, marked_comment,
        created_by, created_at, updated_by, updated_at, tool_published,
        environment_variables, conversation_variables, rag_pipeline_variables }
```

```
POST /console/api/apps/{app_id}/workflows/draft
{ "graph": <graph JSON>, "features": <features>,
  "hash": "<旧 hash>",                       // 乐观锁,不匹配 → 冲突错误
  "_is_collaborative": false,
  "environment_variables": [...], "conversation_variables": [...] }
→ 200 { result: "success", hash: "<新 hash>", updated_at }
```

- `graph` 的结构就是 DSL 的 `workflow.graph`(nodes/edges/viewport)。
- 写回必须带旧 `hash`,成功返回新 `hash`(下次写回用)。
- M0 已实测:GET draft → 改 start 节点标题 → POST(带旧 hash)→ GET 读回一致。

### 2.4 发布 / 导出 / 版本

| 端点 | 方法 | 说明 |
|---|---|---|
| `/console/api/apps/{app_id}/workflows/publish` | GET / POST | 发布草稿 → 已发布版本 |
| `/console/api/apps/{app_id}/export` | GET | `200 { data: "<DSL YAML 字符串>" }`;query `include_secret=false`(默认) |
| `/console/api/app-dsl-version` | GET | `{ app_dsl_version: "0.7.0" }` |
| `/console/api/apps/{app_id}/workflows/default-workflow-block-configs` | GET | 各节点类型默认配置数组(code/llm/trigger-schedule/… 共 10 项,无 start/end) |

## 3. 注入路线对应

- **新建(create)**:Agent 产出 `workflow.yaml` → content script 二选一:
  - A 原生导入:模拟控制台「导入 DSL」文件框塞入 `File` 对象(复用 Dify 自身导入路径);
  - B 控制台导入 API:`POST /apps/imports`(2.1 节)。
  - 失败降级:YAML 入剪贴板 + 引导手动导入(逃生舱)。
- **修改(modify)**:`GET draft` 拿 graph → Agent 改 → `POST draft`(带 hash)→ 刷新页面。
  - 已知风险:控制台草稿自动 sync 与写回存在时序竞争,必要时写回后立即 reload(见 DESIGN.md R4)。

## 4. 与 DSL 文件的差异注意

- DSL 文件里的 `environment_variables`/`conversation_variables` 是运行时变量视图
  (`{name, value, source}`);草稿 API 里同名字段是更丰富的 `VariableEntity` 结构。二者不要混用。
- 草稿 `graph` 的节点/边结构与 DSL 的 `workflow.graph` 一致;`features` 结构一致。

## 5. Service API 执行侧(运行已发布 workflow)

> 与 `adapter/dify-1.16.1.json` 的 `serviceApi` 段成对维护;契约依据 `docs/s0-service-api-findings.md`。
> 这是公开 Service API,前缀 `/v1`,nginx 代理到 `api:5001`(与 `/console/api` 同源)。

### 5.1 鉴权

- **Bearer 认证**,请求头 `Authorization: Bearer app-<24位key>`。
- key 前缀 `app-`(`ApiToken.generate_api_key("app-", 24)`),与 console 的 cookie+CSRF 是两套面。
- key 校验:`app.status == "normal"`、`app.enable_api == true`;每 app 上限 10 支 key。
- key 由 console `POST /apps/{app_id}/api-keys` 创建(需 console 登录态),响应含 `token`(**一次性可见**,须当下持久化);
  `GET /apps/{app_id}/api-keys` 列表项通常不含 token 明文。

### 5.2 运行 workflow(blocking)

```
POST /v1/workflows/run
Authorization: Bearer app-<key>
Content-Type: application/json

{ "inputs": { "query": "..." },   // object,必填(至少 {})
  "user": "indify",               // string,必填非空
  "response_mode": "blocking" }   // 省略即 blocking;streaming 为 SSE
```

响应(blocking):

```json
{
  "task_id": "<task id>",
  "workflow_run_id": "<run id>",
  "data": {
    "id": "<run id>",
    "workflow_id": "<本次执行的 workflow 版本 id>",
    "status": "succeeded | failed | stopped | paused | running",
    "outputs": { "...end 节点输出..." } | null,
    "error": "<错误信息>" | null,
    "elapsed_time": 0.123,
    "total_tokens": 42,
    "total_steps": 3,
    "created_at": 1700000000,
    "finished_at": 1700000001 | null
  }
}
```

- **成功判定**:`data.status === "succeeded" && !data.error`。
- 失败时 `status="failed"` 且 `error` 带字符串;`stopped/paused/running` 均非成功,须能呈现。
- 前置:**run 只认已发布版本**;改 draft 后须先 `POST /apps/{app_id}/workflows/publish`。

### 5.3 其它端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/workflows/run/{workflow_run_id}` | GET | 查询某次运行结果/状态(轮询用) |
| `/v1/workflows/tasks/{task_id}/stop` | POST | 停止 streaming 中的 task |
| `/v1/workflows/logs` | GET | 分页查询运行日志 |

### 5.4 streaming(后置)

- `response_mode:"streaming"` → `Content-Type: text/event-stream`,每帧 `data: {JSON}\n\n`。
- 关键事件:`workflow_started` / `node_started` / `node_finished` / `workflow_finished`(含 outputs/error/elapsed)/ `error` / `ping`。
- MVP 先用 blocking;streaming 与轮询 `runLog` 后置。
