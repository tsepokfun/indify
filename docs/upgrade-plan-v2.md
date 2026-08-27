# Indify 升级计划 v2.1 —— 文件上传 + 两段式确认 + Agent 实时输出流

> 状态:**已实现**(2026-08-27 三特性全部落地并推送;无浏览器链路验收完成,浏览器全流程实测待用户 walkthrough)
> 范围:三个特性;不包含音视频;不改 IR 契约与版本防波堤架构。
> 前置文档:`DESIGN.md`(已实现基线)、`docs/m0-findings.md`。

## 实施进度与已拍板补充

| 特性 | 状态 | 说明 |
|---|---|---|
| F2 两段式确认 | ✅ 已实现(707b8b4) | 状态机 planning/plan-ready/building + decision build/revise-plan + 可编辑计划文本框;无浏览器回归:双回路(revise-plan 修订生效、plan-edit 手改落盘 plan-final.txt 为唯一权威)、守卫 4×409 负向、生成物 round-trip diff=∅;浏览器端待最终全流程实测 |
| F3 Agent 实时输出流 | ✅ 已实现(4d6c6c9) | Bridge mux 帧过滤(text-delta/reasoning-delta/tool 提示)→ task.stream 广播,active 任务↔session 映射防串台;面板「Agent 输出」区逐字渲染/自动滚底/60s 无输出提示/turn 结束清流;无浏览器回归:--stream 实测规划与构建两阶段逐字流;浏览器端待最终全流程实测 |
| F1 附件 + OCR | ✅ 已实现(24c7cf4) | 白名单/上限双查(前端+桥侧权威)、pdfjs 抽文本与页渲染(≤30 页)、RapidOCR venv(Python 3.13 实测可用)、补传端点、附件随任务与计划引用;无浏览器回归:文字版 PDF/扫描版 PDF/图片/md 四类识别、.mp4/.docx 400 拒绝、生成物 round-trip diff=∅、真实扩展自动注入 Dify 成功(appId 已产生);修掉子进程 stdout 编码 bug(中文路径 GBK 打爆 print)。**多模态实测结论**:DSH 双模型不吃图,用户拍板仅 OCR 文本。浏览器端待最终全流程实测 |

**遗留决策拍板记录(2026-08-27)**:OCR 自动安装=允许;附件上限=沿用默认;模型不吃图=接受仅 OCR 文本(先暂停汇报后用户拍板);扩展版本=0.2.0;实测节奏=全部完成后一次性浏览器全流程实测;旧任务=不迁移。

---

## 特性一:多类型文件上传(附件)

### 目标

用户在扩展聊天框可以附加文件(**PDF、图片、纯文本类**),与自然语言需求一起交给 Builder Agent。
**用途由 Agent 决定**(已拍板 Q1):既可把文件当"生成参考"(按文件内容设计工作流),
也可让生成的工作流包含文件处理环节(文件上传节点/文档提取/知识检索等)——Agent 在计划里说明取舍。
**排除音视频**(用户明确要求)。

### 非目标

- 不做视频/音频转写与理解。
- 不做云上传/多端同步——文件只落本机工作区。

### 用户流程

```
聊天框输入需求 → 点 📎 → 选文件(可多选)→ 文件 chip 显示在输入框上方
→ 发送 → 任务创建 → 附件随任务进入 Agent 上下文 →(走特性二的两段式流程)
→ 计划修订阶段允许继续补传文件 → 后续计划/构建均可引用
```

### 支持的格式与限制(白名单)

| 类别 | 扩展名 | 上限 | 处理方式 |
|---|---|---|---|
| PDF(有文字层) | .pdf | ≤ 20MB/个 | Bridge 用 pdfjs 抽文本 → 存 `attachments/<名>.txt` |
| PDF(扫描版,无文字层) | .pdf | ≤ 20MB/个 | pdfjs 渲染每页为 PNG(≤30 页)→ **RapidOCR 逐页识别** → `attachments/<名>.ocr.txt`;页图保留供人工查看 |
| 图片 | .png .jpg .jpeg .webp .gif | ≤ 5MB/个、≤ 20 张/任务 | **RapidOCR 提字** → `<名>.ocr.txt`(面板标注「OCR 文本,可能有误」);原图保留 |
| 文本类 | .txt .md .csv .json .yaml .yml | ≤ 5MB/个 | 原样落盘 `attachments/`,prompt 引用路径,Agent 自行读取 |
| 其它(docx/xlsx/zip…) | —— | 拒绝 | 提示「暂不支持,请转为 PDF 或文本」 |
| 音视频 | 一切 | 拒绝 | 明确提示不支持 |

> **2026-08-27 实测修正(用户已拍板)**:原计划的多模态兜底(① `session.prompt` image 部件
> ② Agent `read_image`)经实施首日实测**不可用**——DSH 环境内 deepseek-v4-pro 与
> deepseek-v4-flash 均在 prompt 准入层拒绝 image 部件(`MODEL_DOES_NOT_SUPPORT_IMAGES`)。
> 最终定案:**仅 OCR 文本通道**;OCR 未安装/失败时任务不阻塞,面板经 `task.stream` 提示
> 「OCR 环境未安装/识别失败,原文件保留供人工查看」。

### OCR 引擎选型(用户拍板:用好的 OCR)
- **主引擎:RapidOCR**(`rapidocr-onnxruntime`,本地 Python + ONNX Runtime,CPU 可跑,中英混排识别质量高)。
- 一次性安装脚本 `tools/setup-ocr.ps1`(pip 装到专用 venv `.venv-ocr`;实测 **Python 3.13.5 +
  onnxruntime 1.29.0(cp313 轮子)直接可用**,无需 uv 兜底;脚本仍保留 uv/3.12 兜底分支);
  macOS/Linux 提供等价 `tools/setup-ocr.sh`。
- **运行链路**:Bridge 检测 PDF 无文字层 / 收到图片 → 调 venv 内 `python tools/ocr.py` 识别 → 写 `.ocr.txt`;
  识别在任务排队期间后台跑(计划 prompt 前等待 ≤180s),完成后经 `task.stream` 通知「附件识别完成」。
- **多模态兜底(原计划)**:~~DSH 原生 image 部件 + read_image~~ —— 见上方实测修正,已按用户拍板移除。

### 协议与实现变更

1. **扩展 panel**:`<input type="file" multiple>` + 文件 chip(名称/大小/移除);白名单校验在前端先做一次。
2. **SW → Bridge**:`POST /v1/tasks` 增 `attachments: [{name, mimeType, size, dataBase64}]`。
3. **Bridge**:
   - 全部附件解码写入 `generated/{taskId}/attachments/`;PDF 抽文本,为空则渲染页图走 OCR;
   - 图片与扫描版 PDF 页走 RapidOCR(venv)识别 → `.ocr.txt`(仅 OCR 文本通道,无多模态);
   - 异步 OCR(任务排队期间后台跑,计划 prompt 前等待 ≤180s;结果经 `task.stream` 通知「附件识别完成」);
   - 新端点 `POST /v1/tasks/{taskId}/attachments`(plan-ready 阶段补传,同一目录追加);
   - 依赖新增:`pdfjs-dist` + `@napi-rs/canvas`(Node 下 pdfjs 自动 fake worker + canvas);OCR 依赖在 venv 内(`rapidocr-onnxruntime`),不进 Bridge 的 package.json。
4. **Agent prompt 契约**:任务块列出附件清单(原文件 + `.txt`/`.ocr.txt` 路径 + 「OCR 文本可能有误」标注),要求「设计前先读取相关文件」,
   并明确:**附件用途由 Agent 决定**——作为生成参考,或让生成的工作流包含文件处理环节(文件上传/文档提取/知识检索节点);
   取舍必须写进计划,供用户审阅。
5. **落盘**:`generated/{taskId}/attachments/`(gitignored,与现有产物约定一致)。

### 安全

- 白名单 + 大小上限双重校验(Bridge 侧为权威校验);扩展名与 MIME 双查。
- 文件不离开本机;不执行任何文件内容;任务结束后附件随 `generated/` 可人工清理。

### 验收

1. [x] 上传 1 个文字版 PDF + 1 个扫描版 PDF + 1 张图片 + 1 个 md → 任务创建成功;
    文字版 PDF 出 `.txt`、扫描版 PDF 出 `.ocr.txt`(+页图)、图片出 `.ocr.txt`(无浏览器 E2E 实测,见 F1 报告);
2. [x] 计划(特性二)中能体现 PDF 与图片里的内容(如引用文档字段名/图内文字)—— 无浏览器实测中 Agent 计划/构建均引用发票字段并设计文档提取节点;
3. [x] OCR 未安装时任务不阻塞:附件标注「OCR 环境未安装,原文件保留供人工查看」并经 task.stream 面板提示(多模态兜底已按拍板移除);
4. [x] 传 .mp4/.docx → 前端与 Bridge 均拒绝并给出友好提示(Bridge 400 attachment-rejected 已实测;前端 chip 校验同规则);
5. [ ] U1–U3 回归不破坏(浏览器最终全流程实测时覆盖)。

### 风险

- **OCR 质量**:RapidOCR 对清晰扫描件/截图质量高,对模糊、手写、复杂表格仍有错漏 →
  缓解:结果里标注「OCR 文本,可能有误」,页图与原文件保留供人工核对。
- **Python 环境**:onnxruntime 对 Python 3.13 的轮子可用性已在实施首日验证(1.29.0 cp313 可用);
  不可用时 `tools/setup-ocr.ps1` 用 `uv` 建 3.12 venv(脚本自动处理)。
- 图片理解无多模态通道(实测否决,用户拍板仅 OCR 文本)。

---

## 特性二:两段式确认(计划 → Build → 结构确认)

### 目标

现在的「输入 → 直接出结构预览」确认太薄。改为:

1. **阶段一:计划(Plan)**——Agent 先用自然语言写一份实施计划,以** 可编辑文本框**显示在对话**中部**;
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
[计划文本框(对话中部,可直接编辑的 textarea,markdown 纯文本)]
   ├─ 用户直接改文本 → 按「开始构建」= 以当前文本为准构建
   ├─ 或按「让 Agent 修订」(附补充说明)→ Agent 重写计划 → 文本框更新(循环)
   └─ 「开始构建 Build」──────────────────┐
                                          ↓
[构建中(附 Agent 实时输出流,见特性三)]     ← building
        ↓
[结构预览卡片(现有)]                      ← draft-ready,[确认]/[提出修改] 不变
        ↓
[结果气泡:已注入/已更新]                  ← done
```

### 状态机变更(Bridge)

```
queued → planning → plan-ready → building → draft-ready → finalizing → ready → injecting → done | failed
              ↑___________↓                    (revise-plan 循环)
```

- `plan-ready`:Agent 已写 `generated/{taskId}/plan.txt`(纯文本/markdown)+ `result.json{status:"plan-ready", plan, summary}`。
- 决策扩展:`POST /v1/tasks/{taskId}/decision` 新增两个 action:
  - `revise-plan`(+feedback,feedback = 用户当前文本框全文 + 补充说明):回 `planning` → Agent 重写计划 → 回 `plan-ready`(同会话续聊,U3 能力复用);
  - `build`(+planText,planText = 用户当前文本框全文,即**人工修改后的计划为唯一权威**):进入 `building` → Agent 以该计划文本为准产 IR(graph)→ 进入现有 `draft-ready` 流程。
- `task.frame` 新增 `planning / plan-ready / building` 状态与 `artifact:{file:"plan.txt"}` 帧。
- create 与 modify **都**走计划阶段(modify 的计划 = "改动方案说明")。

### 协议与实现变更

1. **SKILL.md**:新增 §2.2「计划-构建两段式」——Prompt#1 只写计划(不产 IR);
   Prompt#2(build)= 以用户最终计划文本为准执行原生成流程;Prompt#2(revise-plan)= 按用户全文修订计划;result.json 状态枚举扩展。
2. **Bridge**:orchestrator 的 prompt 模板与状态机按上图扩展;`build`/`revise-plan` 的 planText/feedback 均写入任务目录(`plan-final.txt`);plan.txt 进产物白名单(artifacts 可读)。
3. **扩展 panel**:计划为**可编辑文本框**(textarea,首行摘要 + 全文可改),不再是只读气泡;
   按钮两个:「开始构建」「让 Agent 修订」;**不设快速模式**(计划阶段必走,用户拍板 Q2=否)。
4. **Agent 实时输出流**:见特性三。

### 验收

1. [x] 完整链路:输入 → 计划文本框(对话中部,可直接编辑)→ 用户改文本 → Build → 结构预览 → 确认 → 注入,每步状态与文案正确 —— 无浏览器回归已验证 queued→planning→plan-ready→building→draft-ready→finalizing→ready(浏览器端待最终全流程实测);
2. [ ] 「让 Agent 修订」≥2 轮不丢上下文(U3 语义);revise-plan 中补传附件可用(补传附件在 F1 验收);
3. [ ] 用户手改后的计划文本确实传给 Agent 且生效(抽查:改掉节点名,预览中体现)—— plan-final.txt 落盘与驱动脚本 --plan-edit 通道已验证,「生效抽查」待浏览器实测;
4. [x] 无计划直接 Build 不可达(状态机守卫)—— Bridge decide() 按 status 守卫(build/revise-plan 仅 plan-ready;approve/revise 仅 draft-ready);U1–U3 回归待最终实测。

### 风险

- 每任务多一轮 turn(约 +1 分钟);无快速模式,靠特性三的实时流让等待可感知;
- 计划与构建两步可能互相矛盾 → Agent prompt 中约定「构建时以用户最终计划文本为准,偏差在预览摘要中说明」。

---

## 特性三:Agent 响应实时可见(替代"干等进度条")

### 问题(用户反馈)

Agent 跑一次有时要 5 分钟,面板只有一根进度条,用户完全不知道 Agent 在干什么。

### 目标

把 Agent 的**实时输出流**推送到面板:规划/构建阶段显示 Agent 正在写的文本(逐字流式),计划文本框在
turn 结束时用终稿填充;加载条保留但只作为阶段指示,不再是唯一信息。

### 方案

1. **Bridge 转发流**:Bridge 已订阅 DSH `events.mux`;新增过滤——目标任务会话的
   `session/event` 帧中 `assistant/chunk`(文本 delta)与 `assistant/message`(整段落盘),
   组装成 WS 帧 `{type:"task.stream", data:{taskId, delta}}` 广播给扩展。
   - 同一会话可能串行跑多个任务 → 按「当前 active 任务 ↔ sessionId」映射转发,防串台;
   - 断线重连兜底:扩展重连后可 `GET /v1/tasks/{id}` + 拉 artifacts 恢复终态,流式仅为增强。
2. **扩展 panel**:任务卡片内新增「Agent 输出」滚动区(等宽字体、自动滚底),`task.stream` 逐帧追加;
   turn 结束(plan-ready/draft-ready 帧)时清空流式区并渲染正式产物(计划文本框 / 预览卡片)。
   - 只显示文本 delta,过滤工具调用内部噪音(可选:collapsed 小字提示"执行工具中…",由 `tool/call` 帧触发)。
3. **超时与节奏**:Bridge 的 turn 超时保持 10 分钟不变;面板在 60s 无新 delta 时提示
   「Agent 仍在工作(无新输出)」,避免误以为卡死。

### 验收

1. [x] 提交一个真实任务,面板能实时看到 Agent 逐字输出(非一次性出现)—— Bridge 侧 task.stream 帧(assistant/chunk 的 text-delta/reasoning-delta + tool/call 提示)已实测逐帧广播;面板逐字渲染待浏览器最终实测;
2. [x] 计划/构建两个阶段均有流式输出;任务间不串台 —— active 任务↔sessionId 映射仅 turn 期间登记,驱动脚本 --stream 实测规划/构建阶段均有 delta 流;串行队列同一时刻仅一个 active turn;
3. [x] 断线重连后状态与产物可恢复 —— 流式为增强不补发;终态与产物走既有 GET /v1/tasks + artifacts 拉取路径(SW 重连 + 面板重开恢复),与 M3 基线一致。

---

## 影响面汇总


| 组件                 | F1 附件                                               | F2 两段式                                                      | F3 实时流                        |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| extension(panel/SW)  | 文件选择/chip、上传组装                               | 时间线 UI、可编辑计划文本框、按钮状态机                        | 流式输出区、delta 渲染、超时提示 |
| bridge               | 附件解码/PDF 抽文本与页渲染/OCR 调度/新端点/prompt 组装(+`pdfjs-dist`;OCR 在 venv) | 状态机、决策 action(build/revise-plan)、prompt 模板、plan 产物 | mux 帧过滤与`task.stream` 转发   |
| skills(SKILL.md)     | 附件引用约定                                          | §2.2 两段式流程与 result.json 枚举                            | 无                               |
| adapter JSON         | 无变化                                                | 无变化                                                         | 无变化                           |
| IR 契约 / 版本防波堤 | **不动**                                              | **不动**                                                       | **不动**                         |
| tools(新增)          | `setup-ocr.ps1/.sh`(RapidOCR venv)+ `ocr.py`          | 无                                                             | 无                               |

## 工作量估计(agent 工时)

- F2:SKILL/Bridge 0.5d + 扩展 UI 1d + 回归 0.5d ≈ **2d**(先行,流程骨架)
- F3:Bridge 0.5d + 扩展 0.5d + 联调 0.5d ≈ **1.5d**(紧随 F2)
- F1:扩展 0.5d + Bridge(附件/PDF/OCR)1.5d + OCR 脚本与联调 1d ≈ **3d**
- 合计 ≈ **6.5d**;实施顺序:F2 → F3 → F1。

## 已拍板项(2026-08-20 用户确认)

1. **Q1 附件用途 = 两者都要,由 Agent 决定**:附件既可作为生成参考,也可在设计工作流时
   让 Agent 决定是否加入「文件上传/处理节点」(知识检索/文档提取等);Agent 在计划里说明用途取舍。
2. **Q2 快速模式 = 否**:不设 skipPlan,计划阶段必走。
3. **Q3 扫描版 PDF/图片 = 用好的 OCR(不再降级)**:RapidOCR(本地,中英混排质量高)识别扫描 PDF 页与
   图片文本;OCR 不可用/失败时多模态模型视觉兜底;仅当两者都不可用才提示用户文字描述。
4. **Q4 计划语言 = 中文**。
