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

## 接口(v2 两段式 + 附件 + 实时流)

| 接口 | 说明 | 认证 |
|---|---|---|
| `GET /v1/health` | Bridge 版本 + DSH/Dify 可达性 + adapter 版本列表 | 无 |
| `POST /v1/tasks` | 提交任务 `{mode:"create"\|"modify", spec, sessionId?, context?, attachments?}` → `201 {taskId, status}`(attachments=[{name,mimeType,size,dataBase64}],Bridge 权威校验) | token |
| `GET /v1/tasks/{taskId}` | 任务状态(task.json) | token |
| `POST /v1/tasks/{taskId}/decision` | HITL:`{action:"build"\|"revise-plan"\|"approve"\|"revise", planText?, feedback?}` → 202 | token |
| `POST /v1/tasks/{taskId}/attachments` | 计划阶段(plan-ready)补传附件 `{attachments}` → 202 | token |
| `POST /v1/tasks/{taskId}/injected` | 注入完成回报 `{appId?, appUrl?}` → 202 | token |
| `GET /v1/artifacts/{taskId}/{file}` | 产物原始文件:`ir.json` / `workflow.yaml` / `graph.json` / `result.json` / `plan.txt` / `plan-final.txt` | token |
| `GET /v1/adapter/{version}` | `skills/dify-workflow-dsl/adapter/dify-{version}.json` | token |
| `WS /v1/events?token=…` | 帧:`bridge.status` / `task.frame` / `task.stream`(Agent 实时输出 + 附件识别通知) | token |

认证头:`X-Indify-Token: <token>`(token 值在 `.indifyrc.yaml`)。

## 附件处理(F1)

- 白名单:PDF ≤20MB、图片(png/jpg/jpeg/webp/gif)≤5MB/个且 ≤20 张/任务、文本(txt/md/csv/json/yaml/yml)≤5MB;
  其它类型与音视频拒绝(400 `attachment-rejected`)。扩展名与 MIME 双查,Bridge 侧为权威。
- 落盘 `generated/{taskId}/attachments/`:文字版 PDF → pdfjs 抽文本 `<名>.txt`;扫描版 PDF → 渲染页图(≤30 页)
  → RapidOCR `<名>.ocr.txt`;图片 → RapidOCR `<名>.ocr.txt`;文本类原样。
- OCR 运行在专用 venv `.venv-ocr`(安装:`pwsh -File tools/setup-ocr.ps1` / `bash tools/setup-ocr.sh`,
  Python 3.13 + onnxruntime 1.29 实测可用,脚本保留 uv/3.12 兜底);未安装时任务不阻塞,
  附件标注「OCR 环境未安装,原文件保留供人工查看」。
- 识别在任务排队期间后台跑(计划 prompt 前等待 ≤180s),完成后 `task.stream` 通知;附件用途由 Agent 决定并写进计划。

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

运行时仅 `ws`、`pdfjs-dist`(PDF 抽文本/页渲染,Node 下自动 fake worker)、`@napi-rs/canvas`(页渲染画布)。
HTTP 用 `node:http`,DSH 客户端用 Node 内置 fetch + WebSocket;OCR 依赖在 `.venv-ocr`(RapidOCR),不进 package.json。
TypeScript 经 `tsc` 编译到 `dist/`(Node ≥20 可跑)。
