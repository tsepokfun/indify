# Indify

**一句话**:Chrome 扩展聊天框 + 本地伴生服务(Bridge)+ DSL 适配层(skill)——用自然语言生成/修改
Dify 工作流,改动立即呈现在原生 Dify 控制台画布上;Dify 升级时只更新 skill 与 adapter,扩展与 Bridge 代码零改动。

**v3 技能运行时(实现中)**:把 Dify 工作流重新定位成「AI 的技能」——侧栏把 workflow 当技能列出,点「▶」即跑
(publish → 建 app key → Service API `/v1/workflows/run`),再说话就地改进。详见 `DESIGN.md` 的「v3 技能运行时」与 `docs/v3-execution-spec.md`。

**MCP server(已实现)**:`mcp/dify-mcp.mjs` 把技能列表暴露成标准 MCP tools(`list_skills` / `run_skill`),
任何 MCP agent(Claude Code / Codex / Cursor / DSH)都能直接把 Dify workflow 当工具调。详见 `mcp/README.md`。

目标版本:**Dify 1.16.1**(docker-compose 已钉死,控制台 `http://localhost`)。设计文档见 `DESIGN.md`;
Dify 栈的 docker 部署细节见 `docs/dify-docker-deployment.md`。

## 定位 —— 真正的用法

把「自動化」從「你要會操作的面板」變成「AI 會調用的能力庫」。

- **對自己的價值**:13 個 workflow 變成隨叫隨到的工具,不用開 Dify、不用記 app_id。
- **對未來客戶 / STEAM 學生的價值**(「賣結果不賣技術」的底座):非程式設計師也能用自然語言驅動自動化。

## 架構

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
- **Windows 10/11** 或 **macOS**(Linux 同理):Node ≥ 20 + Docker(Dify 栈在 Docker 里跑)
- 本仓库所有组件跨平台:Bridge/skill/工具均为纯 Node;扩展是标准 Chrome MV3;仅 `tools/package-extension.ps1` 是 Windows 打包脚本,macOS 用 `cd extension && zip -r ../dist/indify-extension.zip manifest.json sidepanel.* service-worker.js content-script.js README.md` 等价替代

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

### 2.5 OCR 环境(附件功能用,可选)
```powershell
pwsh -File tools/setup-ocr.ps1     # 装 RapidOCR 到 .venv-ocr(约数百 MB;macOS/Linux 用 bash tools/setup-ocr.sh)
```
不装也能用全部功能,只是图片/扫描版 PDF 附件无法识别文本(面板会提示)。

### 3. Chrome 扩展(unpacked)
1. Chrome → `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `D:\difyIndify\extension`
3. 打开 Dify 控制台 `http://localhost`,点扩展图标打开侧边栏
4. 侧边栏粘贴 `.indifyrc.yaml` 里的 `token` 值 → 显示「Bridge 已连接」
   (打包分发:`pwsh -File tools/package-extension.ps1` → `dist/indify-extension-<ver>.zip`)

## 使用(v2)

- **新建(U1)**:Dify 任意页面 → 聊天框输入需求(📎 可带 PDF/图片/文本附件)→ **可编辑计划文本框**
  (可直接手改)→ [开始构建 Build / 让 Agent 修订] → 结构预览卡片 → [确认] → 自动导入并跳转新应用画布
- **修改(U2)**:打开某工作流画布页 → 聊天框说"把 XX 改成 YY" → 计划(改动方案)→ 构建 → 预览 →
  [确认] → 草稿就地写回 + 单次刷新,画布更新(无 YAML 往返)
- **迭代(U3)**:完成后直接继续提要求,同一会话续聊;「新会话」按钮可重置
- **实时输出(F3)**:规划/构建期间任务卡片内「Agent 输出」区逐字流式显示(60s 无输出有提示)
- **附件(F1)**:白名单 PDF/图片/文本;文字版 PDF 抽文本、扫描版 PDF/图片走 RapidOCR(文本标
  「可能有误」);计划阶段可「📎 补传附件」;附件用途(参考/生成含文件处理节点的工作流)由 Agent 决定并写进计划

## 使用(v3 技能运行时)

- **技能列表**:侧栏「技能」区列出 Dify 的 workflow 应用(注册表 `generated/skill-registry.json`),点「▶」即跑该技能,无需停在它的画布页。
- **运行**:publish 草稿 → 建/取 app API key(存 `chrome.storage.local`)→ Service API `POST /v1/workflows/run`(blocking)→ 面板显示 status/outputs/error/耗时。
- **副作用审批(S4)**:`side_effects.tier ∈ {write, external_send, irreversible}` 的技能运行前弹确认。
- **改进闭环(S5)**:改完 workflow 后自动 publish + run + 判定成功。

## 使用(MCP,已实现)

任何 MCP agent 都能把 Dify workflow 当工具调:

```json
{ "mcpServers": { "dify": { "command": "node", "args": ["D:\\difyIndify\\mcp\\dify-mcp.mjs"] } } }
```

- `list_skills` —— 列出全部技能(名称 / app id / 副作用 tier / 输入)
- `run_skill(skill, inputs)` —— 跑一个工作流,回 outputs

前置:`node tools/bootstrap-skillcards.mjs` 生成技能卡;workflow 需「已发布」;app key 填进 `mcp/config.json`(模板见 `mcp/config.example.json`,该文件 gitignored)。

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
| `bridge/` | 伴生服务(HTTP/WS + DSH 会话驱动 + 两段式状态机 + 附件/OCR) |
| `extension/` | Chrome 扩展 MV3 0.2.0(sidePanel + SW + content script;`mock-bridge.mjs` 为联调假 Bridge) |
| `skills/dify-workflow-dsl/` | DSL 适配层(唯一懂 Dify 版本细节的地方) |
| `tools/` | 联调/回归/演练脚本(probe-dsh、dify-console、drive-task、upgrade-drill、package-extension、bootstrap-skillcards、ocr.py、setup-ocr) |
| `mcp/` | MCP server(dify-mcp):把技能暴露成 MCP tools(`list_skills` / `run_skill`)给任意 agent 调 |
| `registry/` | 技能卡 manifest schema + 反推生成器 |
| `docs/m0-findings.md` | M0 全部实测证据(DSH /api 契约、控制台 API、DSL 结构) |
| `docs/upgrade-plan-v2.md` | v2 升级计划与实施进度(F2 两段式 / F3 实时流 / F1 附件) |
| `generated/` | 运行时产物(gitignored) |
