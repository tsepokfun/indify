# Indify 升级计划 v2 —— 文件上传 + 两段式确认

> 状态:**规划稿,待用户拍板后实施**(2026-08-20)
> 范围:两个特性;不包含音视频;不改 IR 契约与版本防波堤架构。
> 前置文档:`DESIGN.md`(已实现基线)、`docs/m0-findings.md`。

---

## 特性一:多类型文件上传(附件)

### 目标
用户在扩展聊天框可以附加文件(**PDF、图片、纯文本类**),与自然语言需求一起交给 Builder Agent,
让 Agent 基于文件内容设计工作流。**排除音视频**(用户明确要求)。

### 非目标
- 不做视频/音频转写与理解。
- 不做云上传/多端同步——文件只落本机工作区。
- 不让生成的工作流"自动处理这些附件"(见「待确认问题 Q1」)。

### 用户流程
```
聊天框输入需求 → 点 📎 → 选文件(可多选)→ 文件 chip 显示在输入框上方
→ 发送 → 任务创建 → 附件随任务进入 Agent 上下文 →(走特性二的两段式流程)
→ 计划修订阶段允许继续补传文件 → 后续计划/构建均可引用
```

### 支持的格式与限制(白名单)
| 类别 | 扩展名 | 上限 | 处理方式 |
|---|---|---|---|
| PDF | .pdf | ≤ 20MB/个 | Bridge 用纯 JS(pdfjs)抽文本 → 存 `attachments/<名>.txt`,prompt 引用文本 |
| 图片 | .png .jpg .jpeg .webp .gif | ≤ 5MB/个、≤ 20 张/任务 | 走 **DSH 原生图片摄入**(`session.prompt` content 的 image 部件,base64;M0 已实测该通道上限:5MB/张、20 张/消息) |
| 文本类 | .txt .md .csv .json .yaml .yml | ≤ 5MB/个 | 原样落盘 `attachments/`,prompt 引用路径,Agent 自行读取 |
| 其它(docx/xlsx/zip…) | —— | 拒绝 | 提示「暂不支持,请转为 PDF 或文本」 |
| 音视频 | 一切 | 拒绝 | 明确提示不支持 |

### 协议与实现变更
1. **扩展 panel**:`<input type="file" multiple>` + 文件 chip(名称/大小/移除);白名单校验在前端先做一次。
2. **SW → Bridge**:`POST /v1/tasks` 增 `attachments: [{name, mimeType, size, dataBase64}]`。
3. **Bridge**:
   - 图片 → 组装进 `session.prompt` 的 content 部件(DSH 原生通道,无需落盘);
   - 其它 → 解码写入 `generated/{taskId}/attachments/`,PDF 同步抽取 `<原名>.txt`;
   - 新端点 `POST /v1/tasks/{taskId}/attachments`(计划修订阶段补传,同一目录追加);
   - 依赖新增:仅 `pdfjs-dist`(纯 JS,无原生模块)。
4. **Agent prompt 契约**:任务块列出附件清单(路径 + 一句话说明),并要求「设计前先读取 attachments 目录下相关文件」。
5. **落盘**:`generated/{taskId}/attachments/`(gitignored,与现有产物约定一致)。

### 安全
- 白名单 + 大小上限双重校验(Bridge 侧为权威校验);扩展名与 MIME 双查。
- 文件不离开本机;不执行任何文件内容;任务结束后附件随 `generated/` 可人工清理。

### 验收
1. 上传 1 个 PDF + 2 张图片 + 1 个 md → 任务创建成功,PDF 文本与 md 落盘,图片进入 prompt;
2. 计划(特性二)中能体现 PDF 内容(如引用文档里的字段名);
3. 传 .mp4/.docx → 前端与 Bridge 均拒绝并给出友好提示;
4. U1–U3 回归不破坏。

### 风险
- **扫描版 PDF**(纯图片)抽不出文字 → 计划中定:抽文本为空时自动提示「该 PDF 无文字层,请改传图片并文字说明」。
- 图片理解依赖 Builder 会话模型的视觉能力(当前 deepseek-v4-pro 支持;若换模型需复核)。

---

## 特性二:两段式确认(计划 → Build → 结构确认)

### 目标
现在的「输入 → 直接出结构预览」确认太薄。改为:
1. **阶段一:计划(Plan)**——Agent 先用自然语言写一份实施计划,以聊天气泡形式显示在对话**中部**;
2. 用户可**修改计划/补充信息** → Agent 修订计划(循环);
3. 用户点 **「开始构建(Build)」** → Agent 才动手生成工作流结构;
4. 阶段二:**结构预览确认**(现有卡片,保留)——人工终检后注入。

### 非目标
- 不改变 IR 契约、不改 DSL 适配层、不动版本防波堤。
- 计划只是蓝图文本;最终结构以阶段二预览为准(计划与实际允许有合理偏差,Agent 在计划里声明)。

### 交互流程(面板)
```
[用户气泡:需求(+附件)]
        ↓
[计划气泡(对话中部,markdown 渲染)]          ← plan-ready,含两个按钮
   ├─ [修改计划 / 补充信息] → 输入框 → 修订循环(plan-ready ↔ planning)
   └─ [开始构建 Build] ────────────────────┐
                                            ↓
[系统气泡:构建中…]                          ← building
        ↓
[结构预览卡片(现有)]                        ← draft-ready,[确认]/[提出修改] 不变
        ↓
[结果气泡:已注入/已更新]                    ← done
```

### 状态机变更(Bridge)
```
queued → planning → plan-ready → building → draft-ready → finalizing → ready → injecting → done | failed
              ↑___________↓                    (revise-plan 循环)
```
- `plan-ready`:Agent 已写 `generated/{taskId}/plan.txt`(markdown)+ `result.json{status:"plan-ready", plan, summary}`。
- 决策扩展:`POST /v1/tasks/{taskId}/decision` 新增两个 action:
  - `revise-plan`(+feedback):回 `planning` → Agent 修订计划 → 回 `plan-ready`(同会话续聊,U3 能力复用);
  - `build`:进入 `building` → Agent 按计划产 IR(graph)→ 进入现有 `draft-ready` 流程。
- `task.frame` 新增 `planning / plan-ready / building` 状态与 `artifact:{file:"plan.txt"}` 帧。
- create 与 modify **都**走计划阶段(modify 的计划 = "改动方案说明")。

### 协议与实现变更
1. **SKILL.md**:新增 §2.2「计划-构建两段式」——Prompt#1 只写计划(不产 IR);
   Prompt#2(build)= 按计划执行原生成流程;Prompt#2(revise-plan)= 修订计划;result.json 状态枚举扩展。
2. **Bridge**:orchestrator 的 prompt 模板与状态机按上图扩展;plan.txt 进产物白名单(artifacts 可读)。
3. **扩展 panel**:消息时间线渲染(用户气泡/计划气泡/构建气泡/预览卡/结果),计划气泡支持 markdown 与按钮;
   修订输入框复用现有 revise 交互。
4. **可选快速模式**:任务提交时带 `skipPlan:true`(面板设置项)→ 跳过计划阶段直接构建(保留给老用户/简单需求)。

### 验收
1. 完整链路:输入 → 计划气泡(对话中部)→ 修改计划 → 新计划 → Build → 结构预览 → 确认 → 注入,每步状态与文案正确;
2. 计划修订 ≥2 轮不丢上下文(U3 语义);revise-plan 中补传附件可用;
3. 无计划直接 Build 不可达(状态机守卫);U1–U3 回归通过。

### 风险
- 每任务多一轮 turn(约 +1 分钟),由「快速模式」缓解;
- 计划与构建两步可能互相矛盾 → Agent prompt 中约定「构建时以最新版计划为准,偏差在预览摘要中说明」。

---

## 影响面汇总

| 组件 | F1 附件 | F2 两段式 |
|---|---|---|
| extension(panel/SW) | 文件选择/chip、上传组装 | 时间线 UI、按钮状态机、markdown 计划气泡 |
| bridge | 附件解码/PDF 抽文本/新端点/prompt 组装(+`pdfjs-dist`) | 状态机、决策 action、prompt 模板、plan 产物 |
| skills(SKILL.md) | 附件引用约定 | §2.2 两段式流程与 result.json 枚举 |
| adapter JSON | 无变化 | 无变化 |
| IR 契约 / 版本防波堤 | **不动** | **不动** |

## 工作量估计(agent 工时)
- F1:扩展 0.5d + Bridge 1d + 联调 0.5d ≈ **2d**
- F2:SKILL/Bridge 0.5d + 扩展 UI 1d + 回归 0.5d ≈ **2d**
- 合计 ≈ **4d**;建议实施顺序:F2 先行(流程骨架,无新依赖)→ F1 随后(附件叠加在计划阶段)。

## 待确认问题(拍板后开工)
1. **Q1 附件用途**:按「给 Agent 作参考」设计(本文假设)。你是否还需要「生成的工作流能处理这些文件」?
2. **Q2 快速模式**:要不要保留 `skipPlan` 开关(跳过计划直接构建)?
3. **Q3 扫描件 PDF**:接受「无文字层则提示改用图片+文字说明」吗?(不做 OCR)
4. **Q4 计划语言**:计划气泡用中文(默认)即可?
