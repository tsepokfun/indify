# Indify Chrome 扩展(M3:新建 U1 + 就地修改 U2 + 续聊 U3)

> Indify = Chrome 扩展聊天框 + 本地伴生服务(Indify Bridge)+ DSL 适配层,让用户用自然语言生成/修改 Dify 1.16.1 工作流(Dify 控制台在 `http://localhost`)。
>
> 本目录当前为 **M3**:聊天框输入 → 任务提交(create/modify)→ Agent 生成 → 结构预览卡片 → HITL 确认/修改 → 终稿生成 → 注入(新建导入 / 就地写回草稿 + 单次刷新)。**不含** React、构建链;纯 JS。

## 1. 目录结构

```
extension/
├─ manifest.json       # MV3:name "Indify",version "0.1.0";权限最小集
├─ README.md           # 本文档
├─ sidepanel.html      # 聊天框 UI:状态条 + 模式提示 + 输入框 + 消息区 + 任务卡片
├─ sidepanel.js        # 消息气泡 / 任务状态 / 预览卡片 / HITL / 续聊;纯 JS 无依赖
├─ service-worker.js   # ws 连接 + bridgeFetch + 任务路由 + 按 mode 的注入编排 + sessionId 透传
├─ content-script.js   # 上下文检测 + DSL 导入(create)+ 草稿读/写(modify)
└─ mock-bridge.mjs     # 本地联调用假 Bridge(纯 Node,无依赖)
```

## 2. 安装

1. 打开 Chrome,进入 `chrome://extensions`,右上角开 **开发者模式**。
2. **加载已解压的扩展程序**,选择本目录 `D:\difyIndify\extension`。
3. 启动 Bridge(或 mock):真 Bridge 见 `bridge/README.md`;联调可用
   `node extension/mock-bridge.mjs`(见 §7)。
4. 浏览器打开 Dify 控制台 `http://localhost`。
5. 点工具栏 **Indify 图标** → 右侧出现侧边栏;「Bridge 未连接」时在 token 框粘贴
   `.indifyrc.yaml` 的 `token`(mock 无需 token)。

> 若点图标无反应:图标右键 →「打开侧边栏」;或确认 Chrome ≥ 116(sidePanel 需要)。

## 3. 使用步骤

### U1 新建(create)

1. 在 Dify 应用列表页(`http://localhost/apps`)打开侧边栏,输入框下方提示「将新建工作流」。
2. 输入需求(如「做一个客服工单分类工作流,按情绪和主题分派」)→ 发送。
3. 状态流转:排队中 → Agent 生成中 → 等待确认(结构预览卡片)→ [确认/提出修改] → 生成终稿 → 已就绪 → 注入画布 → 完成。
4. 完成后显示「打开工作流画布 →」,点击打开新建应用画布(原生画布 = 最终人工闸口)。

### U2 就地修改(modify)

1. 打开某工作流画布页(`http://localhost/app/{uuid}/workflow`),侧边栏提示「将修改当前工作流」。
2. 输入修改需求(如「把知识检索节点改成先检索再重排序,输出加置信度字段」)→ 发送。
3. SW 先读当前草稿(`currentGraph`)随任务提交,Agent 产出新 `graph.json` + `result.json`。
4. 预览确认后,ready 时 SW **就地写回草稿 → 单次刷新**,画布立即呈现(无 YAML 往返)。
5. 完成后显示「画布已更新(已刷新)」。

### U3 同会话续聊

- 任务 done 后,任务卡片出现「继续修改(同一会话)」与「新会话」按钮。
- 同一应用连续多次修改时,SW 透传上次任务的 `sessionId`,Agent 记得上下文。
- 点「新会话」清空 `lastSessionId`,下次提交不复用旧会话。

## 4. 消息协议(最终)

`context` 结构:`{ appId?, appName?, mode?, page:"workflow"|"apps"|"other", url }`。
任务对象(`indify:task` 的 `task`)结构:
`{ taskId, status, phase?, summary?, error?, spec?, mode?, sessionId?, context?, inject?:{ status:"idle"|"injecting"|"done"|"failed"|"needDify", appId?, appUrl?, error? } }`。

### 4.1 扩展内部(panel ↔ SW ↔ content script)

| 方向 | 消息 | 说明 |
|---|---|---|
| content → SW | `{ type:"indify:context", context }` | 上报应用上下文 |
| SW → panel(广播) | `{ type:"indify:status", bridge:{connected,url}, context, lastSessionId }` | 连接/上下文/会话状态 |
| SW → panel(广播) | `{ type:"indify:task", task }` | 任务状态(submitAck 或 task.frame 转译) |
| panel → SW | `{ type:"indify:getStatus" }` | 拉当前状态 → `{bridge, context, task, lastSessionId}` |
| panel → SW | `{ type:"indify:submitTask", mode:"create"\|"modify", spec }` | 提交任务 → `{ok, taskId, status}`(modify 失败返回 `needDify:true`) |
| panel → SW | `{ type:"indify:decision", taskId, action:"approve"\|"revise", feedback? }` | HITL 决策 → `{ok}` |
| panel → SW | `{ type:"indify:getArtifact", taskId, file }` | 拉产物 → `{ok, text}` |
| panel → SW | `{ type:"indify:getAdapter" }` | 拉 adapter(缓存)→ `{ok, adapter}` |
| panel → SW | `{ type:"indify:retryInject", taskId }` | 注入失败/无 Dify 页后重试 → `{ok}` |
| panel → SW | `{ type:"indify:newSession" }` | 清空 lastSessionId → `{ok}` |
| SW → content | `{ type:"indify:ping" }` / `{ type:"indify:getContext" }` | 存活/上下文 |
| content → SW(响应) | `{ type:"indify:pong"\|"indify:context", context }` | 响应 |
| SW → content | `{ type:"indify:injectCreate", yamlText, adapter }` | create:DSL 导入 |
| content → SW(响应) | `{ ok, appId?, error? }` | 导入结果 |
| SW → content | `{ type:"indify:getDraft", appId, adapter }` | modify:读草稿 |
| content → SW(响应) | `{ ok, draft? , error? }` | 完整草稿(graph/features/hash/env) |
| SW → content | `{ type:"indify:injectModify", appId, graphText, adapter }` | modify:写回草稿 |
| content → SW(响应) | `{ ok, hash?, error? }` | 写回结果 |

### 4.2 Bridge 接口(SW 通过 bridgeFetch 调用)

| 接口 | 说明 |
|---|---|
| `POST /v1/tasks` `{mode, spec, sessionId?, context?}` | → `201 {taskId, status:"queued"}`;modify 的 `context={appId, appUrl, currentGraph}` |
| `GET /v1/tasks/{taskId}` | 任务详情 |
| `POST /v1/tasks/{taskId}/decision` `{action, feedback?}` | → `202 {accepted:true}` |
| `POST /v1/tasks/{taskId}/injected` `{appId?, appUrl?}` | → `202 {accepted:true}` |
| `GET /v1/artifacts/{taskId}/{file}` | 原始文件体(ir.json / result.json / workflow.yaml / graph.json) |
| `GET /v1/adapter/1.16.1` | adapter JSON |
| `WS /v1/events?token=…` | `bridge.status` 与 `task.frame` 帧 |

任务状态机:`queued → agent-running → draft-ready(HITL)→ finalizing → ready → injecting → done | failed`。

## 5. 注入编排(ready 时 SW 自动触发,按 mode 分支)

- **create**:拉 `workflow.yaml` → `indify:injectCreate` → `injected` → `chrome.tabs.update` 打开新应用页。
- **modify**:拉 `graph.json` → `indify:injectModify`(读最新 hash 再写回)→ `injected` → `chrome.tabs.reload`(**唯一一次刷新**)。
- 幂等:内存 `injecting` + `injectedTaskIds`(storage.session)保证重复 ready 帧不重触发;
  `needDify`(无 Dify 页)不标记为已注入,允许后续 `indify:retryInject`。
- 无 Dify 页 → `inject.status:"needDify"`,面板提示「先打开 Dify」+「重试注入」按钮。

## 6. content script 的 Dify 操作

- **create 导入(route B)**:`POST /apps/imports`(`yaml-content`)→ 200 取 `app_id`;202 再 `confirm`;400 报错。
- **modify 读草稿**:`GET /apps/{app_id}/workflows/draft`(CSRF 豁免,顺手带 `X-CSRF-Token`)。
- **modify 写回**:先 GET 拿**最新 hash/features/env** → `POST /apps/{app_id}/workflows/draft`
  `{graph, features, hash, environment_variables, conversation_variables}` → 200 成功。
- 端点/前缀/CSRF 头名全部来自 adapter JSON,content script 不硬编码 Dify 细节。

### 写回 → 单次刷新时序与 409 冲突策略

1. `injectModify` 内部**先 GET 最新草稿再 POST**(拿最新 hash),把乐观锁冲突概率降到最低。
2. 写回成功(200)→ SW `chrome.tabs.reload` **唯一一次刷新**,画布就地呈现。
3. 若仍 409(hash 冲突,如草稿自动 sync 抢先):返回 `{ok:false, error:"…请重试"}`,面板显示
   「注入失败」+「重试注入」→ `indify:retryInject` 重新走「GET 最新 hash → 写回」流程。
4. **不在 content script 里 reload**,刷新统一由 SW 控制,避免多次刷新竞态。

## 7. mock-bridge(仅联调)

```powershell
node extension/mock-bridge.mjs                       # 默认 39181(被真 Bridge 占用会提示冲突并退出)
$env:MOCK_BRIDGE_PORT=39182; node extension/mock-bridge.mjs   # 改端口避开真 Bridge
$env:MOCK_HITL=1; node extension/mock-bridge.mjs              # HITL 模式:停在 draft-ready 等 approve
```

- 支持 `mode=create|modify`;modify 时 `artifacts` 提供 `graph.json`。
- 实现 `/v1/tasks`、`/v1/tasks/{id}`、`decision`、`injected`、`/v1/artifacts/{id}/{file}`、
  `/v1/adapter/1.16.1`(读 `skills/dify-workflow-dsl/adapter/dify-1.16.1.json`)、WS `/v1/events`。
- 提交后推 `queued → agent-running → draft-ready → finalizing → ready`;`injected` 后推 `injecting → done`。
- 纯 `node:http` + `node:crypto` + `node:fs`,不校验 token(便于联调)。

> 注意:mock 只是让扩展走通消息流;真实导入/写回需要 Dify 控制台 + 真 Bridge。

## 8. 遗留风险与待办(M4 起)

| 位置 | 现状 | 说明/风险 |
|---|---|---|
| 草稿写回 vs 自动 sync | 已做「GET 最新 hash → 写回 → 单次刷新」 | R4:极端时序下仍可能 409,靠重试缓解;必要时 M4 暂停编辑器自动保存 |
| 版本探测 | adapter 固定 1.16.1 | M4 做运行时探测(§5.1) |
| 导入降级 | 无 | 剪贴板逃生舱(route B 失败时) |
| modify 预览 | 用 graph.json 节点/边清单 | 不渲染坐标/连线细节,仅结构清单 |

## 9. 权限清单(最小集)

- `permissions`: `sidePanel`、`storage`、`tabs`(reload/update/create 打开应用页)。
- `host_permissions`: `http://localhost/*`(content script)、`http://127.0.0.1/*`(Bridge HTTP)。
- 不申请任何 Dify 之外的域名权限;WS 到 `ws://127.0.0.1` 无需额外权限。
