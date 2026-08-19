# Indify Bridge

本地伴生服务:Chrome 扩展 ↔ DSH Web GUI `/api` 之间的中转、任务状态机、adapter 与产物文件通道。
端口 **39181**(配置见工作区根目录 `.indifyrc.yaml`)。

## 运行

```powershell
cd D:\difyIndify
pnpm --dir bridge install        # 或 npm --prefix bridge install
pnpm --dir bridge run start      # 编译 tsc → dist 并启动(node ≥20)
```

首次运行自动在工作区根目录生成 `.indifyrc.yaml`(含随机 token,**严禁提交 git**)。

## 接口(M2)

| 接口 | 说明 | 认证 |
|---|---|---|
| `GET /v1/health` | Bridge 版本 + DSH/Dify 可达性 + adapter 版本列表 | 无 |
| `POST /v1/tasks` | 提交任务 `{mode:"create"\|"modify", spec, sessionId?, context?}` → `201 {taskId, status}` | token |
| `GET /v1/tasks/{taskId}` | 任务状态(task.json) | token |
| `POST /v1/tasks/{taskId}/decision` | HITL:`{action:"approve"\|"revise", feedback?}` → 202 | token |
| `POST /v1/tasks/{taskId}/injected` | 注入完成回报 `{appId?, appUrl?}` → 202 | token |
| `GET /v1/artifacts/{taskId}/{file}` | 产物原始文件:`ir.json` / `workflow.yaml` / `graph.json` / `result.json` | token |
| `GET /v1/adapter/{version}` | `skills/dify-workflow-dsl/adapter/dify-{version}.json` | token |
| `WS /v1/events?token=…` | 帧:`bridge.status` / `task.frame`(状态机每步广播) | token |

认证头:`X-Indify-Token: <token>`(token 值在 `.indifyrc.yaml`)。

## 任务状态机

```
queued → agent-running → draft-ready ──approve──→ finalizing → ready → injecting → done
                    ↑                              │
                    └────────── revise ────────────┘
                    任何环节出错 → failed
```

- `draft-ready`:Agent 已产出 `generated/{taskId}/ir.json` + `result.json{status:"draft-ready"}`(HITL 闸口,等扩展发 decision)
- `ready`:`workflow.yaml` 就绪,扩展侧注入
- 状态持久化于 `generated/{taskId}/task.json`,Bridge 重启后中断任务标记 failed,其余可查

## DSH 会话驱动

- 新任务无 sessionId 时经 `session.create` 建会话(cwd=工作区根);续聊任务复用 sessionId(U3)
- `session.prompt` 提交任务块(协议见 `src/orchestrator.ts` 的 prompt 模板);`events.mux` 帧 + 历史轮询双保险等 `turn/end`
- Agent 契约:按 `skills/dify-workflow-dsl/SKILL.md` 产出,只写自己 `generated/{taskId}/` 目录

## 依赖边界

运行时仅 `ws`(HTTP 用 `node:http`,DSH 客户端用 Node 内置 fetch + WebSocket)。
TypeScript 经 `tsc` 编译到 `dist/`(Node ≥20 可跑)。

## M3 起将新增

modify 模式草稿往返(读 graph → Agent 改 → 写回)、U3 会话续聊链路、多任务队列优化。
