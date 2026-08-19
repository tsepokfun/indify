# Indify Bridge

本地伴生服务:Chrome 扩展 ↔ DSH Web GUI `/api` 之间的中转、任务状态、adapter 与产物文件通道。
端口 **39181**(配置见工作区根目录 `.indifyrc.yaml`)。

## 运行

```powershell
cd D:\difyIndify
pnpm --dir bridge install        # 或 npm --prefix bridge install
pnpm --dir bridge run start      # node --experimental-strip-types src/server.ts
```

首次运行自动在工作区根目录生成 `.indifyrc.yaml`(含随机 token,**严禁提交 git**)。

## 接口(M1)

| 接口 | 说明 | 认证 |
|---|---|---|
| `GET /v1/health` | Bridge 版本 + DSH/Dify 可达性 + adapter 版本列表 | 无 |
| `GET /v1/adapter/{version}` | 返回 `skills/dify-workflow-dsl/adapter/dify-{version}.json` | token |
| `WS /v1/events?token=…` | 任务事件流(M1 仅 status 帧占位;M2 接任务状态机) | token |

认证头:`X-Indify-Token: <token>`(token 值在 `.indifyrc.yaml`)。

```powershell
curl.exe http://127.0.0.1:39181/v1/health
curl.exe -H "X-Indify-Token: $(你的token)" http://127.0.0.1:39181/v1/adapter/1.16.1
```

## 依赖边界

运行时仅 `ws` 一个依赖(HTTP 用 `node:http`)。TypeScript 为可擦除子集,
`start` 用 Node 22 的 `--experimental-strip-types` 直跑,`build` 产出 `dist/`。

## M2 起将新增

`POST /v1/tasks`、任务状态机(`generated/{taskId}/task.json`)、DSH 会话驱动
(`session.create/prompt/history` + `events.mux` 订阅,协议见 `docs/m0-findings.md` §1)、
`GET /v1/artifacts/{taskId}/{file}`。
