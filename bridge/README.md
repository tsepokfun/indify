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

## 接口(v2 两段式)

| 接口 | 说明 | 认证 |
|---|---|---|
| `GET /v1/health` | Bridge 版本 + DSH/Dify 可达性 + adapter 版本列表 | 无 |
| `POST /v1/tasks` | 提交任务 `{mode:"create"\|"modify", spec, sessionId?, context?}` → `201 {taskId, status}` | token |
| `GET /v1/tasks/{taskId}` | 任务状态(task.json) | token |
| `POST /v1/tasks/{taskId}/decision` | HITL:`{action:"build"\|"revise-plan"\|"approve"\|"revise", planText?, feedback?}` → 202 | token |
| `POST /v1/tasks/{taskId}/injected` | 注入完成回报 `{appId?, appUrl?}` → 202 | token |
| `GET /v1/artifacts/{taskId}/{file}` | 产物原始文件:`ir.json` / `workflow.yaml` / `graph.json` / `result.json` / `plan.txt` / `plan-final.txt` | token |
| `GET /v1/adapter/{version}` | `skills/dify-workflow-dsl/adapter/dify-{version}.json` | token |
| `WS /v1/events?token=…` | 帧:`bridge.status` / `task.frame`(状态机每步广播) | token |

认证头:`X-Indify-Token: <token>`(token 值在 `.indifyrc.yaml`)。

## 任务状态机(v2 两段式)

```
queued → planning → plan-ready ──build──→ building → draft-ready ──approve──→ finalizing → ready → injecting → done
              ↑___________│                                        │
              └─ revise-plan(循环修订计划)                         └─ revise(结构迭代)
                                 任何环节出错 → failed
```

- `plan-ready`:Agent 已产出 `generated/{taskId}/plan.txt` + `result.json{status:"plan-ready"}`(计划闸口,
  等扩展发 `build`(带 `planText`,用户最终计划,唯一权威)或 `revise-plan`(带 `feedback`))。
  Bridge 会把用户的 planText 落盘为 `plan-final.txt`、反馈落盘为 `plan-feedback.txt`。
- `draft-ready`:Agent 已产出 `ir.json`(create)或 `graph.json`(modify)+ `result.json{status:"draft-ready"}`
  (结构闸口,等扩展发 `approve` / `revise`)
- `ready`:`workflow.yaml`(create)或终稿 `graph.json`(modify)就绪,扩展侧注入
- create 与 modify **都走计划阶段**(无快速模式);旧任务不迁移,重启时中断态任务标记 failed
- 状态持久化于 `generated/{taskId}/task.json`;`plan-ready / draft-ready / ready` 等稳定等待态重启后保留

## DSH 会话驱动

- 新任务无 sessionId 时经 `session.create` 建会话(cwd=工作区根);续聊任务复用 sessionId(U3)
- `session.prompt` 提交任务块(协议见 `src/orchestrator.ts` 的 prompt 模板);`events.mux` 帧 + 历史轮询双保险等 `turn/end`
- Agent 契约:按 `skills/dify-workflow-dsl/SKILL.md` 产出,只写自己 `generated/{taskId}/` 目录

## 依赖边界

运行时仅 `ws`(HTTP 用 `node:http`,DSH 客户端用 Node 内置 fetch + WebSocket)。
TypeScript 经 `tsc` 编译到 `dist/`(Node ≥20 可跑)。
