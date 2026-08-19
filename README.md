# Indify

**一句话**:Chrome 扩展聊天框 + 本地伴生服务(Bridge)+ DSL 适配层(skill)——用自然语言生成/修改
Dify 工作流,改动立即呈现在原生 Dify 控制台画布上;Dify 升级时只更新 skill 与 adapter,扩展与 Bridge 代码零改动。

目标版本:**Dify 1.16.1**(docker-compose 已钉死,控制台 `http://localhost`)。设计文档见 `DESIGN.md`;
Dify 栈的 docker 部署细节见 `docs/dify-docker-deployment.md`。

## 架构

```
Chrome 扩展(sidePanel 聊天框 + SW + content script)
   │ ws + http(127.0.0.1:39181,本机 token)
   ▼
Indify Bridge(Node 20+ TS,本机常驻)
   │ POST /api/session.*        │ 工作区文件 generated/{taskId}/
   ▼                            ▼
DSH Web GUI(127.0.0.1:3080)  DSL 适配层 skills/dify-workflow-dsl/
(Agent 会话 = Builder)        (SKILL.md + references + scripts + adapter)
   │
   ▼
Dify 1.16.1(http://localhost)— 新建走 DSL 导入,修改走草稿 API 就地写回
```

DSL 知识只存在于 `skills/dify-workflow-dsl/` 与 `adapter/dify-<ver>.json`;Agent 只处理 IR
(中间表示,`DESIGN.md` §6)结构语义;渲染一律交给原生 Dify 画布。

## 安装

### 0. 前置
- Windows 10/11,Node ≥ 20(Dify 栈本身在 Docker 里运行;本仓库已含其部署文件)

### 1. Dify 栈(通常已运行)
```powershell
docker compose up -d          # 已在运行的跳过
# 控制台 http://localhost(浏览器登录)
```

### 2. Indify Bridge
```powershell
pnpm --dir bridge install
pnpm --dir bridge run start   # 监听 127.0.0.1:39181;首次运行生成 .indifyrc.yaml(token)
# 自检:curl http://127.0.0.1:39181/v1/health  → 返回 dsh/dify 可达性
```

### 3. Chrome 扩展(unpacked)
1. Chrome → `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `D:\difyIndify\extension`
3. 打开 Dify 控制台 `http://localhost`,点扩展图标打开侧边栏
4. 侧边栏粘贴 `.indifyrc.yaml` 里的 `token` 值 → 显示「Bridge 已连接」
   (打包分发:`pwsh -File tools/package-extension.ps1` → `dist/indify-extension-<ver>.zip`)

## 使用

- **新建(U1)**:Dify 任意页面 → 扩展聊天框输入需求 → 结构预览卡片 → [确认] → 自动导入并跳转新应用画布
- **修改(U2)**:打开某工作流画布页 → 聊天框说"把 XX 改成 YY" → 预览 → [确认] → 草稿就地写回 + 单次刷新,画布更新(无 YAML 往返)
- **迭代(U3)**:完成后直接继续提要求,同一会话续聊;「新会话」按钮可重置

## 升级(Dify 升版)

只改两处(详见 `DESIGN.md` §11 与 `tools/upgrade-drill.mjs`):
1. `skills/dify-workflow-dsl/references/dify-<新版本>/` 与 `SKILL.md` §0 版本指针
2. `skills/dify-workflow-dsl/adapter/dify-<新版本>.json`

回归:`node skills/dify-workflow-dsl/tests/round-trip.mjs`(diff 必须为空);
全流程演练:`node tools/upgrade-drill.mjs`(模拟升版 6 项检查)。
扩展与 Bridge 不含任何 Dify 版本硬编码(由演练脚本强制验证)。

## 目录

| 路径 | 说明 |
|---|---|
| `bridge/` | 伴生服务(HTTP/WS + DSH 会话驱动 + 任务状态机) |
| `extension/` | Chrome 扩展 MV3(sidePanel + SW + content script;`mock-bridge.mjs` 为联调假 Bridge) |
| `skills/dify-workflow-dsl/` | DSL 适配层(唯一懂 Dify 版本细节的地方) |
| `tools/` | 联调/回归/演练脚本(probe-dsh、dify-console、drive-task、upgrade-drill、package-extension) |
| `docs/m0-findings.md` | M0 全部实测证据(DSH /api 契约、控制台 API、DSL 结构) |
| `generated/` | 运行时产物(gitignored) |
