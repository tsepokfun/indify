# M0 实测结论(2026-08-19,Dify 1.16.1 / DSH rc.7)

> 本文档是 M0 验证阶段全部实测证据的落盘记录,是 Bridge(M1)、adapter JSON(M4)、
> skill references(M1)的直接输入。所有结论均来自本机运行中的系统,非文档推断。

## 1. DSH Web GUI `/api` 契约(127.0.0.1:3080)——附录A-1/A-2 ✅

### 传输层
- 一元调用:`POST /api/<method>`,请求体为 `ClientRequest` 信封:
  ```json
  { "type": "client-request", "rpcId": "<uuid>", "method": "session.create", "payload": { ... } }
  ```
  响应体为 `ServerResponse` 信封:`{ "type": "server-response", "rpcId": "<回显>", "result": { "ok": true, "value": ... } }`;
  错误走 `result.ok === false` + `result.error: { code, message, details }`。
- 事件流:`/api/events.mux` 对网络客户端**只接受 WebSocket 升级**(纯 HTTP GET 返回 `426 upgrade required`,
  无 SSE 回退)。Node 非浏览器客户端不带 Origin 头即可连上。
  WS 文本帧 = `ServerRequest` 信封:`{ "type": "server-request", "rpcId", "method": "session/event", "payload": {...} }`,
  其中 `method` 与 `payload.type` 相同。帧类型:`session/subscribed`(连上后为每个已附着会话各发一条,含 lastSeq)、
  `session/event`(原始会话事件)、`session/queue`、`session/jobs`、`session/projection`、
  `question/requested|resolved`、`approval/requested|resolved`、`stream/error`。
- **mux 是所有会话的聚合流**,Bridge 须按 `payload.sessionId` 过滤。

### 会话三件套(实测签名)
| 方法 | 请求 payload | 响应 value |
|---|---|---|
| `session.create` | `{ workspaceId?, cwd?, sessionId?, agentPreset? }` | `{ sessionId, agentPreset? }`(默认 preset = `standard`) |
| `session.prompt` | `{ sessionId, mode: "queue"\|"steer", content: [{ type:"text", text }], clientTimeZone? }` | `{ accepted: true, command? }` |
| `session.history` | `{ sessionId, beforeSeq?, maxMessages? }` | `{ events: [{ event: {type,seq,time,data}, view? }], hasMore, projections? }` |
| `session.list` | `{ cursor? }` | `{ items: [{ sessionId, running, blank, cwd, agentPreset, projections }] }` |

- 会话事件词汇(与 §1 附录A-1 判定相关):`turn/start` / `turn/end`(`data.reason.kind: completed|aborted|blocked|error|max-tokens|interrupted`)、
  `user/message`、`assistant/message`(`data.message.content`)、`assistant/chunk`、`tool/call`、`tool/result`、`step/start|end`、`todo/write`。
- **turn 结束判定**:过滤 `payload.type === "session/event"` 且 `payload.sessionId === 目标会话` 且 `event.type === "turn/end"`。
- `session.prompt` 提交后立刻返回 `{accepted:true}`,不等待模型;结果靠 mux 帧 + 最后 `session.history` 收尾(ADR-6 落盘产物由 Agent 直接写工作区文件,Bridge 读文件)。

### 信任墙(实测)
- 无浏览器标记的 loopback POST(Host=127.0.0.1:3080、无 Origin)→ 200 ✅
- 伪造 Origin(`origin: http://evil.example`)→ 403 ✅
- 结论:Bridge 以非浏览器 loopback 客户端身份调用 `/api` 天然过墙(ADR-2 实证)。

## 2. Dify 1.16.1 控制台 API——附录A-3 ✅

### 基础事实
- 控制台前端 = Next.js(`/app/targets/next/web`,next-server 16.2.12;vinext 未启用)。
- 前端 API 前缀:`/console/api`(nginx 代理到 `api:5001`)。
- **oRPC 生成的契约**位于 web 构建产物(`packages_contracts_generated_api_console_*_orpc_gen_ts_*.js`),
  M0 已提取全部 **778 条唯一路由** → `generated/m0/console-api-routes.json`(提取器 `tools/extract-console-routes.mjs`)。
- 后端源码完整存在于 api 容器 `/app/api`(Flask + flask_restx + pydantic;工作流引擎为 graphon 0.6.0)。

### 认证与 CSRF(实测)
- 登录:`POST /console/api/login`,body `{ email, password, language?, remember_me? }`,
  **password 字段 = base64(明文)**(非 RSA;`libs/encryption.py` `FieldEncryption.decrypt_field`)。
  成功响应 `Set-Cookie: access_token(HttpOnly) / refresh_token(HttpOnly) / csrf_token`,body `{"result":"success"}`。
- **CSRF 校验覆盖所有非 OPTIONS 方法(含 GET)**:请求头 `X-CSRF-Token` 必须等于 cookie `csrf_token`
  (JWT 校验由 PassportService 完成)。白名单:`/console/api/apps/<uuid>/workflows/draft`(草稿读写豁免 CSRF)。
  未登录时(login/register 等)不校验 CSRF。
- 登录态请求必须带:`Cookie: access_token=...` + `X-CSRF-Token: <csrf_token>`(draft 端点除外)。

### 注入路线核心端点(实测)
| 端点 | 方法 | 契约 |
|---|---|---|
| `/console/api/apps/imports` | POST | body `{ mode: "yaml-content"\|"yaml-url", yaml_content?, yaml_url?, name?, description?, icon?, icon_background?, icon_type?, app_id? }`;响应 `200 {status:"completed"\|"completed-with-warnings", app_id, current_dsl_version, imported_dsl_version, warnings[]}` 或 `202 {status:"pending", import_id}`(有插件/依赖时,需 `POST /apps/imports/{import_id}/confirm`)。**旧版 DSL 自动迁移**(0.3.1 → 0.7.0 实测通过)。 |
| `/console/api/apps` | POST | 创建应用 `{ name, mode: "workflow", description? }` → `201 {id, mode, ...}`。注意:**创建时不生成草稿**,首次导出会 500(`Missing draft workflow configuration`);草稿在首次 POST draft 时创建。 |
| `/console/api/apps/{app_id}/workflows/draft` | GET | `200 {id, graph, features, hash, version, marked_name, marked_comment, created_by, created_at, updated_by, updated_at, tool_published, environment_variables, conversation_variables, rag_pipeline_variables}` |
| 同上 | POST | body `{ graph, features, hash?, _is_collaborative?, environment_variables?, conversation_variables? }` → `200 {result:"success", hash:<新>, updated_at}`。`hash` 是乐观锁(不匹配 → 冲突错误)。**CSRF 豁免**。 |
| `/console/api/apps/{app_id}/workflows/publish` | GET/POST | 发布草稿 → 已发布版本 |
| `/console/api/apps/{app_id}/export` | GET | `200 { data: "<DSL YAML 字符串>" }`;query `include_secret=false`(默认) |
| `/console/api/app-dsl-version` | GET | `{ app_dsl_version: "0.7.0" }` |
| `/console/api/apps/{app_id}/workflows/default-workflow-block-configs` | GET | 各节点类型默认配置数组(code/llm/trigger-schedule/… 共 10 项,无 start/end) |

### 草稿写回实测(附录A-5 API 侧 ✅)
- GET draft → 改 start 节点 `data.title` → POST draft(带旧 hash)→ `{result:"success", hash:<新>}` → GET 读回确认改动持久化 ✅。
- 浏览器刷新呈现部分留待 M2/M3 扩展注入实测。

## 3. DSL 结构(1.16.1,version 0.7.0)——附录A-4 ✅

官方样例(`skills/dify-workflow-dsl/tests/fixtures/official-sample-1.16.1.yml`,由 Dify 官方 echo 样例
0.3.1 经运行中控制台导入→导出为 0.7.0):

```
app:      {description, icon, icon_background, icon_type, mode, name, use_icon_as_answer_icon}
dependencies: []
kind: app
version: 0.7.0
workflow:
  conversation_variables: []
  environment_variables: []
  features: {file_upload{...全默认}, opening_statement, retriever_resource, sensitive_word_avoidance,
             speech_to_text, suggested_questions, suggested_questions_after_answer, text_to_speech}
  graph:
    nodes: [{data, height, id, position, positionAbsolute, selected, sourcePosition, targetPosition, type:"custom", width}]
    edges: [{data:{isInIteration, isInLoop, sourceType, targetType}, id, source, sourceHandle, target, targetHandle, type:"custom", zIndex}]
    viewport: {x, y, zoom}
  rag_pipeline_variables: []
```

- start 节点 `data`: `{desc, selected, title, type:"start", variables:[{label, max_length, options, required, type:"text-input", variable}]}`
- end 节点 `data`: `{desc, outputs:[{value_selector:[nodeId,varName], value_type, variable}], selected, title, type:"end"}`
- 节点 id 为数字字符串;引用语法 `value_selector: [node_id, variable_name]`。
- **1.16.1 内置节点类型全集(graphon BuiltinNodeTypes)**:
  `start, end, answer, llm, knowledge-retrieval, if-else, code, template-transform, question-classifier,
  http-request, tool, datasource, variable-aggregator, variable-assigner(legacy), loop(+loop-start/loop-end),
  iteration(+iteration-start), parameter-extractor, assigner, document-extractor, list-operator, agent, human-input`
  + trigger 系列(`trigger-schedule / trigger-webhook / trigger-plugin`,来自 core.trigger.constants)。
- 官方 graph 级 fixture(节点 data 的官方样例,供 node-catalog 参考)在 api 容器
  `/app/api/tests/fixtures/workflow/*.yml`(25 个)。

## 4. 官方 CLI 导入——附录A-7 ✅(结论:不可用)

- api 容器**没有** `dify` CLI 二进制,`commands/*.py`(flask CLI)中**无 import-app/import 命令**。
- 结论:1.16.1 下"官方 CLI 导入"不存在,**C 方案 = 剪贴板逃生舱**(把 YAML 写入剪贴板引导用户手动导入),已按此定案。

## 5. 附录A-6(Chrome sidePanel)

- 留待 M1 扩展构建后在 Chrome 实测(unpacked 加载 + sidePanel 唤起 + ws 到 127.0.0.1 权限)。
- 预判:MV3 扩展到 `ws://127.0.0.1:39181` 的 ws 连接无 host_permissions 限制(ws 不受 CORS 管),
  `tabs` 跳转 + `http://localhost/*` host_permissions 用于 content script。

## 6. 工具链资产(已入库 `tools/`)

- `tools/probe-dsh.mjs` — DSH /api 探针(三件套 + mux + 信任墙),产物 `generated/m0/dsh-probe.json`。
- `tools/dify-console.mjs` — 控制台 API 客户端(登录/base64 密码/CSRF/`--yaml` 导入/`--out` 落盘),M2/M3 联调复用。
- `tools/extract-console-routes.mjs` — 从 dify-web 构建产物提取 oRPC 路由契约。
- `tools/build-draft-post.mjs` — 草稿写回探针。
- 实测原始数据全部在 `generated/m0/`(gitignored):cookies、导入/导出样例、路由全量契约、draft 往返记录。
