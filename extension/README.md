# Indify Chrome 扩展(M2:新建链路 U1)

> Indify = Chrome 扩展聊天框 + 本地伴生服务(Indify Bridge)+ DSL 适配层,让用户用自然语言生成/修改 Dify 1.16.1 工作流(Dify 控制台在 `http://localhost`)。
>
> 本目录当前为 **M2 新建链路(U1)**:聊天框输入 → 任务提交 → Agent 生成 → IR 结构预览卡片 → HITL 确认/修改 → 终稿生成 → content script 注入 → 自动跳转新应用画布。**不含** React、构建链;纯 JS。

## 1. 目录结构

```
extension/
├─ manifest.json       # MV3:name "Indify",version "0.1.0";权限最小集
├─ README.md           # 本文档
├─ sidepanel.html      # 聊天框 UI:状态条 + 输入框 + 消息区 + 任务卡片
├─ sidepanel.js        # 消息气泡 / 任务状态 / IR 预览卡片 / HITL;纯 JS 无依赖
├─ service-worker.js   # ws 连接 + bridgeFetch + 任务路由 + ready 注入编排
├─ content-script.js   # 上下文检测 + DSL 导入(route B,CSRF + confirm)
└─ mock-bridge.mjs     # 本地联调用假 Bridge(纯 Node,无依赖)
```

## 2. 安装与使用(U1 端到端步骤)

1. 打开 Chrome,进入 `chrome://extensions`,右上角开 **开发者模式**。
2. **加载已解压的扩展程序**,选择本目录 `D:\difyIndify\extension`。
3. 启动 Bridge(或 mock):真 Bridge 见 `bridge/README.md`;联调可用
   `node extension/mock-bridge.mjs`(见 §7)。
4. 在浏览器打开 Dify 控制台 `http://localhost`(content script 注入此域)。
5. 点工具栏 **Indify 图标** → 右侧出现侧边栏;若状态条显示「Bridge 未连接」,
   在 token 框粘贴 `.indifyrc.yaml` 的 `token`(mock 无需 token,连上即可)。
6. 在输入框输入需求,如「做一个客服工单分类工作流,按情绪和主题分派」→ 发送。
7. 观察任务卡片状态流转:排队中 → Agent 生成中 → 等待确认(出现**结构预览卡片**)。
8. 点 **[确认]**(或 [提出修改] 填写意见提交)→ 生成终稿 → 已就绪 → 自动注入画布。
9. 注入完成后显示 **[打开工作流画布 →]**,点击在新标签页打开新建应用(原生画布 = 最终人工闸口)。

> 若点图标无反应:图标右键 →「打开侧边栏」;或确认 Chrome ≥ 116(sidePanel 需要)。

## 3. 与 Indify Bridge 的连接说明

- Bridge 默认 `http://127.0.0.1:39181`,WS `ws://127.0.0.1:39181/v1/events`(DESIGN §5.2)。
- **认证**:除 `/v1/health` 外,Bridge 要求 `X-Indify-Token: <token>` 头;token 存
  `chrome.storage.local.bridgeToken`(侧边栏未连接时可粘贴保存),SW 的 `bridgeFetch`
  与 WS `?token=` 都带上。
- **WS 到 127.0.0.1 无需额外权限**;`host_permissions` 覆盖 `http://127.0.0.1/*`
  供 HTTP 接口、`http://localhost/*` 供 content script。
- **断线重连**:1s/2s/4s/… 封顶 30s;心跳 20s/次,60s 无帧判定僵死重连。
- Bridge 未启动时,侧边栏显示「Bridge 未连接」并持续重连,启动后自动恢复。

## 4. 消息协议(最终)

`context` 结构:`{ appId?, appName?, mode?, page:"workflow"|"apps"|"other", url }`。
任务对象(`indify:task` 的 `task`)结构:
`{ taskId, status, phase?, summary?, error?, spec?, mode?, sessionId?, inject?:{ status:"idle"|"injecting"|"done"|"failed"|"needDify", appId?, appUrl?, error? } }`。

### 4.1 扩展内部(panel ↔ SW ↔ content script)

| 方向 | 消息 | 说明 |
|---|---|---|
| content → SW | `{ type:"indify:context", context }` | 上报应用上下文 |
| SW → panel(广播) | `{ type:"indify:status", bridge:{connected,url}, context }` | 连接/上下文状态 |
| SW → panel(广播) | `{ type:"indify:task", task }` | 任务状态(submitAck 或 task.frame 转译) |
| panel → SW | `{ type:"indify:getStatus" }` | 拉当前状态(SW 回 `{bridge, context, task}` 并广播) |
| panel → SW | `{ type:"indify:submitTask", mode:"create", spec }` | 提交任务 → `{ok, taskId, status}` |
| panel → SW | `{ type:"indify:decision", taskId, action:"approve"\|"revise", feedback? }` | HITL 决策 → `{ok}` |
| panel → SW | `{ type:"indify:getArtifact", taskId, file }` | 拉产物 → `{ok, text}` |
| panel → SW | `{ type:"indify:getAdapter" }` | 拉 adapter(缓存)→ `{ok, adapter}` |
| panel → SW | `{ type:"indify:retryInject", taskId }` | 无 Dify 页/注入失败后重试 → `{ok}` |
| SW → content | `{ type:"indify:ping" }` | 存活探测 + 上下文刷新 |
| content → SW(响应) | `{ type:"indify:pong", context }` | ping 响应 |
| SW → content | `{ type:"indify:getContext" }` | 显式请求上下文 |
| content → SW(响应) | `{ type:"indify:context", context }` | getContext 响应 |
| SW → content | `{ type:"indify:injectCreate", yamlText, adapter }` | 执行 DSL 导入 |
| content → SW(响应) | `{ ok, appId?, error? }` | 导入结果 |

### 4.2 Bridge 接口(SW 通过 bridgeFetch 调用)

| 接口 | 说明 |
|---|---|
| `POST /v1/tasks` `{mode:"create", spec, sessionId?, context?}` | → `201 {taskId, status:"queued"}` |
| `GET /v1/tasks/{taskId}` | 任务详情 |
| `POST /v1/tasks/{taskId}/decision` `{action, feedback?}` | → `202 {accepted:true}` |
| `POST /v1/tasks/{taskId}/injected` `{appId?, appUrl?}` | → `202 {accepted:true}` |
| `GET /v1/artifacts/{taskId}/{file}` | 原始文件体(ir.json/result.json/workflow.yaml) |
| `GET /v1/adapter/1.16.1` | adapter JSON |
| `WS /v1/events?token=…` | `bridge.status` 与 `task.frame` 帧 |

任务状态机:`queued → agent-running → draft-ready(HITL)→ finalizing → ready → injecting → done | failed`。

## 5. 注入编排(ready 时 SW 自动触发)

1. `task.frame` 状态变 `ready` → SW 触发 `doInject(taskId)`(内存 Set 幂等,重复 ready 帧不重触发)。
2. 取 adapter(缓存)+ `workflow.yaml` 产物。
3. 找到 Dify 标签页(`contextTabId`,由 content script 上报)→ 发 `indify:injectCreate`。
   - 无 Dify 页 → 广播 `inject.status:"needDify"`,面板提示「先打开 Dify」+「重试注入」按钮。
4. content script 执行 route B 导入(§6)→ 返回 `{ok, appId}`。
5. SW `POST /v1/tasks/{taskId}/injected {appId, appUrl}` → `chrome.tabs.update` 打开
   `adapter.urls.workflowPagePattern`(替换 `{app_id}`)画布页。

## 6. content script 导入(route B,§8.1)

- `POST {baseUrl}{apiPrefix}/apps/imports`,`body {mode:"yaml-content", yaml_content}`。
- CSRF:读 `document.cookie` 的 `csrf_token` → 头 `X-CSRF-Token`;`credentials:"same-origin"`。
- `200` → `{ok:true, appId: body.app_id}`;`202` → 再 `POST /apps/imports/{import_id}/confirm`
  → `200` 后取 `app_id`;`400` → `{ok:false, error}`。
- 端点/前缀/CSRF 头名全部来自 adapter JSON,content script 不硬编码 Dify 细节。

## 7. mock-bridge(仅联调)

```powershell
node extension/mock-bridge.mjs                       # 默认 39181(被真 Bridge 占用会提示冲突并退出)
$env:MOCK_BRIDGE_PORT=39182; node extension/mock-bridge.mjs   # 改端口避开真 Bridge
$env:MOCK_HITL=1; node extension/mock-bridge.mjs              # HITL 模式:停在 draft-ready 等 approve
```

- 实现 `/v1/tasks`、`/v1/tasks/{id}`、`decision`、`injected`、`/v1/artifacts/{id}/{file}`、
  `/v1/adapter/1.16.1`(读 `skills/dify-workflow-dsl/adapter/dify-1.16.1.json`)、WS `/v1/events`。
- 提交任务后按 `queued → agent-running → draft-ready → finalizing → ready` 顺序推 `task.frame`;
  `injected` 后推 `injecting → done`。
- 纯 `node:http` + `node:crypto` + `node:fs`,不校验 token(便于联调)。

> 注意:mock 只是让扩展走通消息流;真实导入需要 Dify 控制台 + 真 Bridge。

## 8. 与 M3 的接缝(尚未实现)

| 位置 | M2 现状 | M3 需补充 |
|---|---|---|
| 任务模式 | 仅 `create` | `modify`:content script 读草稿 graph(§8.2)随任务提交 |
| 续聊 | 无 | U3:`sessionId` 复用,submitTask 带 `sessionId` |
| 注入写回 | 仅新建导入(route B) | 修改路线:`draftPost` 写回 + 刷新 |
| 版本探测 | adapter 固定 1.16.1 | 运行时版本探测(§5.1) |
| 导入降级 | 无 | 剪贴板逃生舱(route B 失败时) |

## 9. 权限清单(最小集)

- `permissions`: `sidePanel`(侧边栏)、`storage`(token/adapter/状态)、`tabs`(打开新应用页)。
- `host_permissions`: `http://localhost/*`(content script)、`http://127.0.0.1/*`(Bridge HTTP)。
- 不申请任何 Dify 之外的域名权限;WS 到 `ws://127.0.0.1` 无需额外权限。
