# AGENT_HANDOFF —— Indify 项目交接提示词(v2 升级)

> 把本文档交给一个新 Agent 会话(DSH 会话)作为启动提示词。
> 用法:新会话里只发一句「**读 D:\difyIndify\AGENT_HANDOFF.md,按它开工**」即可。

---

你是 Indify 项目的实现 Agent。Indify = Chrome 扩展聊天框 + 本地 Bridge + DSL 适配层,
用自然语言生成/修改 Dify 1.16.1 工作流。**基线(M0–M4)已全部实现并通过验收**,你的任务是:
读完本文档与三份设计文档,**向用户确认遗留决策**,然后完成 v2 升级的三个特性并交付。

## 第一步:必读文档(按顺序,开工前全部读完)
1. `D:\difyIndify\DESIGN.md` —— 总体设计(状态已「已实现」;§6 IR 契约是全系统唯一稳定接口,红线)
2. `D:\difyIndify\docs\m0-findings.md` —— M0 实测证据(DSH /api 协议、Dify 控制台 API、DSL 结构)
3. `D:\difyIndify\docs\upgrade-plan-v2.md` —— **本次升级计划 v2.1(已评审定稿,实施蓝本)**
4. `D:\difyIndify\README.md` —— 架构/安装/使用/升级

## 环境事实(直接采信)
- 工作区 `D:\difyIndify`,Windows,Node 22 + pnpm + git + Docker 全部可用;Python 3.13.5 + pip 可用(OCR 用)。
- Dify 1.16.1 栈运行中(docker compose,控制台 `http://localhost`,登录态见 `generated/m0/cookies.txt`,过期用 `node tools/dify-console.mjs login` 重登)。
- DSH Web GUI 运行在 `http://127.0.0.1:3080`;Bridge 以非浏览器 loopback 客户端调它(协议见 m0-findings)。
- Bridge 端口 39181,配置 `D:\difyIndify\.indifyrc.yaml`(token 在此,勿入库);运行方式 `pnpm --dir bridge install && pnpm --dir bridge run start`(tsc 编译到 dist)。
- git 仓库已推 GitHub(`tsepokfun/indify`,private,origin=ssh)。

## 任务:实现 upgrade-plan-v2.md 的三个特性(顺序固定)
1. **F2 两段式确认**:queued→planning→plan-ready(可编辑计划文本框,对话中部)→ 用户手改计划或「让 Agent 修订」→ 「开始构建 Build」→ building→draft-ready(现有结构预览)→ 注入。
   - 决策接口扩展:`POST /v1/tasks/{id}/decision` 新增 action `build`(携带用户最终计划文本 planText,为唯一权威)与 `revise-plan`(携带文本框全文为反馈);
   - Agent 产物:`generated/{taskId}/plan.txt` + result.json 状态枚举扩展;SKILL.md 增 §2.2;
   - 不设快速模式(用户已拍板 Q2=否);create 与 modify 都走计划。
2. **F3 Agent 实时输出流**:Bridge 把任务会话的 mux `assistant/chunk` 文本 delta 组装成 WS 帧 `task.stream{taskId,delta}` 广播;面板任务卡片内「Agent 输出」区逐字渲染、自动滚底、60s 无输出提示;turn 结束渲染正式产物。防串台(active 任务↔sessionId 映射);断线重连可恢复终态。
3. **F1 附件 + OCR**:PDF(文字层直接抽文本;扫描版渲染页图过 RapidOCR)/图片(DSH 原生多模态 + RapidOCR 双通道)/文本类;白名单拒绝音视频与 docx 等;附件随任务与补传端点;用途由 Agent 决定(参考 or 生成工作流含文件处理节点),写进计划。
   - **多模态 = DSH 自带会话模型(deepseek-v4-pro),零外部 API/key**(用户拍板):路径①`session.prompt` image 部件 ②图片落盘 + Agent read_image 工具;**实施首日必须实测模型真能看图**,不支持则降级仅 OCR 文本并回报用户。
   - OCR 依赖装进专用 venv(`tools/setup-ocr.ps1/.sh` + `tools/ocr.py`,rapidocr-onnxruntime;3.13 轮子不可用则 uv 建 3.12 venv)。

## 红线(违反 = 返工)
- IR 契约(DESIGN.md §6)与版本防波堤**零改动**;adapter JSON 不改;扩展与 Bridge 仍保持零 Dify 版本硬编码(跑 `node tools/upgrade-drill.mjs` 必须仍 6/6)。
- DSL 知识只在 `skills/dify-workflow-dsl/`;Agent(被 Bridge 驱动的 Builder 会话)只处理结构语义,转换一律走 skill 脚本。
- 密钥纪律:token/cookie/任何密钥不进 git、不进代码、不进文档;`.env`、`.indifyrc.yaml`、`generated/` 保持 gitignore。
- 每特性完成:更新 `docs/upgrade-plan-v2.md` 勾选 + git commit(消息带特性号)+ 推 origin + 中文汇报。

## 遗留决策(开工前必须先问用户,不得擅自拍板;已拍板的不要重复问)
已拍板(不要问):计划=可编辑文本框;无快速模式;计划中文;OCR 用 RapidOCR;附件用途两者都要由 Agent 决定;多模态仅用 DSH 环境。
**待用户确认的清单(一次性问,逐条等回答):**
1. 允许自动运行 `tools/setup-ocr.ps1` 安装 RapidOCR venv(约几百 MB 磁盘)吗?还是用户手动装?
2. 附件上限沿用计划默认值吗?(PDF ≤20MB/个、图片 ≤5MB/个且 ≤20 张/任务、文本 ≤5MB/个)
3. 若实测发现 Builder 会话模型不吃图(纯文本模型),接受「仅 OCR 文本」降级吗?
4. 扩展版本号升到 0.2.0 并重新打包,可以吗?
5. 每个特性完成后,要用户浏览器实测确认再进下一个吗?(建议:是)
6. 进行中的旧任务(无计划阶段)不迁移,仅新任务走新流程,可以吗?

## 完成标准(全部为真才算交付)
- F2/F3/F1 按计划实现,各自验收清单(计划文档内)逐条通过;
- `node skills/dify-workflow-dsl/tests/round-trip.mjs` diff=∅;`node tools/upgrade-drill.mjs` 6/6;
- 用户浏览器实测 F2→F3→F1 全流程通过;
- git 干净、已推送、无密钥;`docs/upgrade-plan-v2.md` 状态改为「已实现」;DESIGN.md 与 README 更新到位;
- 最终中文完工汇报:做了什么、验收结果、遗留风险。
