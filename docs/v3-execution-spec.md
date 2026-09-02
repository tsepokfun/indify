# Indify v3 技能运行时 —— 实现 Spec(导演已拍板)

> 状态:实现中(2026-09)。本文件是 S2/S3/S4/S5 的单一权威约束;与 DESIGN.md 冲突时,以本文件为准。
> 性质:执行侧(「跑」)的实现蓝图。作者侧(create/modify)不重述,见 DESIGN.md。

## 0. 已定架构(来自 docs/recon-integration-map.md,已采纳)

1. **执行适配器 = adapter JSON `serviceApi` 段 + content-script `runWorkflow` handler**。
   理由:`POST /v1/workflows/run` 用 Bearer `app-<key>`(与 console cookie+CSRF 两套面);
   `app-` key 只能由 console 登录态 `POST /console/api/apps/{app_id}/api-keys` 生成 → 整段落在 content-script(同源、带 cookie、host_permissions 覆盖)。
2. **「改 skill = 改其 workflow」= 复用 modify(U2/U3),零新路径**。skill = 已发布 workflow app;
   改它 = `mode:"modify"` + `context.appId` = skill 的 app_id。缺的只是「skill 名 → app_id」表。
3. **run 前必须先 publish**:`POST /console/api/apps/{app_id}/workflows/publish`(create/modify 都没有的新步骤)。

## 1. 技能卡(S1,已实现)

- 标准:`registry/skillcard.schema.json`;生成器:`registry/generate-skillcard.mjs`(入出参反推自 start/end 节点)。
- 副作用五阶:`none < read < write < external_send < irreversible`(聚合取最高)。
- 节点→tier:http/tool/agent → external_send;knowledge/datasource/document → read;未知 → 保守 write。
- 导演裁定:`cost` 字段暂空,由 S2 用运行时数据(elapsed_time/total_tokens)回填;app-meta 对齐 `GET /apps/{app_id}` 返回(name/description/mode/icon)。

## 2. S3 核心:扩展侧 run(实现中)

四件套(只增不改,不破坏 create/modify):
1. adapter JSON(`skills/dify-workflow-dsl/adapter/dify-1.16.1.json`):`console.endpoints` 加 `createApiKey`/`listApiKeys`;顶层加 `serviceApi` 段(runWorkflow/runLog/stopTask/listLogs)。
2. content-script.js:`runWorkflow(appId, inputs, adapter)` = publish → 取/建 key(持久化 chrome.storage.local `appKey:<appId>`)→ `POST /v1/workflows/run` blocking → 返回 `{ok,status,outputs,error,workflowRunId}`;纯函数 `isRunSuccess(data)=status==="succeeded" && !error`。
3. service-worker.js:`indify:runWorkflow` 路由 + `indify:runResult` 广播。
4. sidepanel.js/html:画布页「▶ 运行」按钮 + 极简 inputs JSON 框(默认 `{}`)+ 结果区(status/outputs/error/elapsed)。

## 3. S4:副作用分级审批闸

- 触发条件:技能卡 `side_effects.tier ∈ {write, external_send, irreversible}` 时,run 前在面板弹确认;`none/read` 直接跑。
- 确认内容:tier + notes + 一句「此工作流会<写库/对外发送/不可逆操作>,确认运行?」。
- 落点:sidepanel.js 的 run-workflow 流程,拿到技能卡 tier 后判断;S3 核心先留 TODO,S4 补齐。

## 4. S5:改进闭环

- 目标:一条指令完成「改 skill → 自动 publish → 自动 run → 判定成功 → 反馈」。
- 接线:改 skill = modify(U2/U3);modify 写回草稿后(`doInjectModify` reload 前),接 `publishDraft(appId)` → `runWorkflow(appId, inputs, adapter)` → `isRunSuccess` 判定 → 面板显示。
- 优先序:先打通 publish(否则 run 永远跑旧版),再接 run+判定。

## 5. S2:技能注册中心

- `skill → app_id` 索引(建议 `.indifyrc.yaml` 的 `skills:` 段或 `generated/skill-registry.json`,均 gitignored)。
- 技能列表 + 技能卡:content-script 导出 DSL(`GET /apps/{app_id}/export`)→ 交 Bridge 跑 `generate-skillcard.mjs` → 更新索引。
- 为「talk → 选 skill → 填参 → 跑」(Phase 2,Agent-in-the-loop)铺路:Agent 读技能卡 when_to_use/input_schema 选型填参。

## 5.5 已核实端点事实(源码级,2026-09)

- `publish` = **POST** `/apps/{app_id}/workflows/publish`(`PublishWorkflowPayload{marked_name?,marked_comment?}`);GET 是「读已发布版本」,非发布动作。(`controllers/console/app/workflow.py:1258`)
- `createApiKey` = POST `/apps/{app_id}/api-keys` → 201 `{id,type,token,...}`,`token` 明文在响应里。
- `listApiKeys` = GET `/apps/{app_id}/api-keys` → `{data:[...]}`,`ApiKeyItem.token` **明文返回**(`ApiToken.token` 明文存储,未哈希)。
  → 侦察里「token 一次性、list 未必回明文」不成立;**取已存在 key 可直接 list**,仅当无 key 才 create。仍建议 create 后持久化到 chrome.storage.local 以减少重复调用。
- key 上限 10 支(`max_keys=10`),前缀 `app-`,需 console 登录态 + `edit_permission_required` + RBAC `APP_RELEASE_AND_VERSION`。

## 5.6 Run 模式(Agent-in-the-loop,「说话 → AI 选技能 → 跑」)

> 这是验收「一张技能卡驱动 Agent 读懂/选用/跑通」的核心,create/modify 之外的第三种任务模式。

- 新任务:`POST /v1/tasks {mode:"run", spec:"帮我跑发票提取…"}`。
- Agent(DSH)职责(协议见 `skills/run-workflow/SKILL.md`):
  1. 读 `generated/skill-registry.json`(技能列表)+ 技能卡(when_to_use/input_schema/side_effects);
  2. 据 spec 选技能、按 input_schema 填 inputs;
  3. 写 `generated/{taskId}/run.json` = `{appId, inputs, skillId?, needsConfirm?}`;
  4. 副作用 gate:若 `side_effects.tier >= write`,标 `needsConfirm:true` + 理由(S4)。
- Bridge(orchestrator)新增 run 状态机:`queued → planning → run-ready → (confirm?) → running → done|failed`,复用现有 HITL 闸(decision)。
- 执行:扩展 SW 收到 run-ready 的 `task.run` 帧 → content-script `runWorkflow(appId, inputs)`(S3 已建)→ 回 Bridge 写 `run-result.json` → 面板显示。
- MVP 简化:不强制 Agent 二次摘要,结果直接面板呈现;`needsConfirm` 走 S4 后接。

## 6. 非目标(保持既有红线)

- 不 fork Dify、不改源码、不自建画布;不做多用户/SaaS;不做技能市场。
- 改结构仍是「半自动 + 人审」;app key 只进浏览器 chrome.storage.local,不进仓库/日志。

## 7. 验收(端到端)

1. 浏览器打开「极简回显」`http://localhost/app/582fa07d-3af6-468c-a5f1-3754daa0957f/workflow` → 「▶ 运行」→ succeeded + outputs 回显。
2. 改一个 skill → 草稿就地更新 → 自动 publish → 自动 run → 判定成功。
3. 带副作用(tier≥write)的 workflow → run 前弹确认。
4. 现有 create/modify(U1/U2/U3)回归不破。
