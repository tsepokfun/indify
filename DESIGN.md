# Indify — Dify 工作流自然语言生成器 · 设计文档

> 状态:**已实现**(2026-08-20 全量 M0–M4 完成,附录 A 七条全部闭环;2026-08-27 **v2 三特性
> F2 两段式确认 / F3 Agent 实时输出流 / F1 附件+OCR 完成**,扩展升 0.2.0)。
> round-trip diff=∅;§11 模拟升版演练 6/6(扩展与 Bridge 零版本硬编码)。
> 目标 Dify 版本:1.16.1(docker-compose 已钉死:`langgenius/dify-api:1.16.1` / `dify-web:1.16.1`)
> 工作区:`D:\difyIndify`

---

## v3 技能运行时(实现中,2026-09)

> **定位重定义**:Dify 从「给人搭流程的低代码画布」升级为「给 AI 提供技能的运行时 + 技能注册中心」。
> 人不再手动点运行,而是「说话/打字 → AI 选用技能 → 跑 → 回报 → 再说话改进」。
> 详见 `docs/v3-skill-runtime-藍圖.md`(蓝图)、`docs/v3-execution-spec.md`(实现 spec)。

三层:
- **L0 运行时**:一个 Dify workflow = 一个 AI 可调用的 skill;「跑」= Service API `POST /v1/workflows/run`(Bearer `app-<key>`)。
- **L1 技能卡**:`registry/skillcard.schema.json` + `generate-skillcard.mjs`,从 workflow 反推「名字/何时用/入出参/副作用五阶/成功判定」。S1 ✅。
- **L2 注册中心 + 调用循环**:`generated/skill-registry.json`(技能 → app_id)+ 扩展侧「技能列表 + ▶运行」+ 副作用分级确认闸(S4 ✅)+ 改进闭环(S5 ✅)。

状态:S1 ✅ / S2(技能列表+按名运行)✅ / S3(run)✅ / Run 模式(说话选技能跑)✅ / S4(副作用审批闸)✅ / S5(改完自动 publish+run)✅ / MCP server(dify-mcp)✅。

红线不变:不 fork Dify、不改源码、渲染交给原生 Dify;执行侧走 content-script(浏览器同源,持 console cookie 才能建 app key)。app key 只进 `chrome.storage.local`,不入库。

---

## 0. 文档约定

- **ADR** = 已拍板的架构决策,编号连续,修改需显式说明理由。
- **未验证项** 集中在附录 A,实现期逐条闭环后再升为"已验证"。
- 术语见附录 B。

## 1. 背景与目标

**一句话目标**:用户在 Chrome 里用自然语言描述需求,Builder Agent 生成/修改 Dify 工作流,**改动立即呈现在原生 Dify 控制台画布上**;Dify 升级时,只需要更新 skill 与 adapter 配置,Agent 与扩展代码不动。

**范围(做什么)**
1. Chrome 扩展提供聊天框入口(Side Panel),在浏览原生 Dify 控制台时随时唤起。
2. Agent(本机 DSH 会话,即 DeepSeek Harness Web GUI 的 agent)负责理解需求、产出工作流结构。
3. DSL 适配层(skill + adapter JSON)是唯一懂得 Dify DSL / 控制台 API 细节的地方,按 Dify 版本封装。
4. 新建与修改两条注入路线:生成新工作流、就地修改当前打开的工作流,都在原生 Dify 页面上生效。
5. 两段式 HITL:扩展聊天框内预览确认 + 原生画布人工终检。

**非目标(明确不做)**
- 不 fork Dify 核心、不改 Dify 源码、不做 Dify 插件(plugin daemon)。
- 不自建工作流画布/渲染器——渲染一律交给原生 Dify。
- 不做多用户/SaaS;本机单用户工具。

**成功标准(验收)**
- Round-trip:官方示例 DSL YAML → IR → YAML,可逐字段比对一致(1.16.x)。
- 从聊天输入到画布可见,新建/修改两条链路全程 ≤ 一次页面刷新。
- Dify 升到新版本时,仅改 `skills/dify-workflow-dsl/` 与 `adapter/dify-<ver>.json`,扩展与伴生服务代码零改动。

## 2. 用户故事

- U1:用户在 Dify 控制台页点开扩展聊天框,输入"做一个客服工单分类工作流,按情绪和主题分派"。扩展在聊天框展示结构预览,用户点"确认"。新工作流出现在 Dify 应用列表,画布完整渲染。
- U2:用户正开着某个工作流画布,在聊天框说"把知识检索节点改成先检索再重排序,输出加个置信度字段"。确认后,画布上的图**就地更新**。
- U3:用户对生成结果不满意,在聊天框继续补充要求,Agent 在已有会话上下文中迭代修改,直到确认。
- U4:Dify 从 1.16.x 升级到新版后,用户更新 skill 与 adapter JSON,全部功能继续工作。

## 3. 已定架构决策(ADR)

| # | 决策 | 理由 |
|---|---|---|
| ADR-1 | **入口 = Chrome 扩展(MV3)**,聊天框用 `chrome.sidePanel` | 用户要求"chat box 跑在 Chrome 上";Side Panel 可在 Dify 页旁常驻,不遮挡画布 |
| ADR-2 | **传输 = 本地伴生服务(Indify Bridge)**,扩展不直连 DSH `/api` | DSH `/api` 有浏览器信任墙(见 §10),扩展的 `chrome-extension://` Origin 会被 403;伴生服务以非浏览器 loopback 客户端身份天然过墙,且能读工作区文件(adapter JSON、生成的 YAML) |
| ADR-3 | **DSL 知识 = agent skill + 版本化 adapter JSON 双层**,Agent 只懂结构语义 | 满足"以后只更新 skill/MCP 就够";扩展侧的机器可读细节(端点/选择器/头)放 adapter JSON |
| ADR-4 | 新建走 **DSL YAML 导入**,修改走 **控制台草稿 graph 往返**(不走 YAML) | 修改已有工作流时 YAML 重导入只能产生新应用;草稿 API 往返才能就地更新画布 |
| ADR-5 | HITL 主闸口在**扩展聊天框**(预览确认),画布为最终人工检查;不依赖 DSH 的提问系统 | DSH 的提问 UI 在 DSH 页面,用户此时在 Dify 页面;扩展内确认流程简单可控 |
| ADR-6 | 结果传递双通道:短摘要走聊天消息,**结构化结果落盘工作区文件**由伴生服务读取 | 聊天消息适合给人看;机器消费的结构化 JSON/YAML 走文件,避免大 JSON 挤进聊天上下文 |

## 4. 系统架构总览

```
┌────────────── Chrome 浏览器 ─────────────────────────────────────────┐
│  Side Panel 聊天框(扩展 UI)                                          │
│   用户:自然语言需求 ──► 预览确认 ◄── 修正意见                          │
│        │ ▲ ws 帧(push)                                              │
│        ▼ │                                                          │
│  Service Worker(ws 客户端 + 任务编排)                                 │
│        │                                                            │
│  Content Script(注入原生 Dify 控制台页,http://localhost)               │
│    ├─ 读取当前草稿 graph / 页面状态                                    │
│    ├─ 新建:导入 DSL(原生导入或控制台 API)                              │
│    └─ 修改:写回草稿 graph → 触发页面刷新                               │
└──────────────┬──────────────────────────────────────────────────────┘
               │ ws + http(127.0.0.1:39181,本机 token 认证)
┌──────────────▼──────────────────────────────────────────────────────┐
│  伴生服务 Indify Bridge(Node.js,本机常驻)                              │
│   扩展侧:ws 帧转发、任务状态、文件内容服务                                │
│   DSH 侧:非浏览器 loopback 客户端 → POST /api RPC                     │
│   文件侧:读写 D:\difyIndify\generated\{taskId}\ 与 adapter JSON       │
└──────┬───────────────────────────────┬──────────────────────────────┘
       │ /api/session.create           │ 工作区文件
       │ /api/session.prompt           │
       │ /api/session.history          ▼
┌──────▼─────────────────┐   ┌────────────────────────────────────────┐
│ DSH Web GUI(本 GUI)     │   │ DSL 适配层(skill,由 Agent 加载)          │
│ 127.0.0.1:3080          │   │ skills/dify-workflow-dsl/               │
│ Agent 会话 = Builder    │◄──┤  ├─ SKILL.md(结构语义+生成流程)          │
│ (用 skill 生成 IR/YAML) │   │  ├─ references/dify-1.16/*.md           │
└─────────────────────────┘   │  ├─ scripts/ir_to_dsl、dsl_to_ir、校验    │
                              │  └─ adapter/dify-1.16.1.json            │
                              └───────────────┬────────────────────────┘
                                              │ 导入 / 草稿写回
                              ┌───────────────▼────────────────────────┐
                              │ Dify 1.16.1(docker-compose,http://localhost)│
                              │ api + web + plugin daemon + agent backend │
                              └────────────────────────────────────────┘
```

## 5. 组件设计

### 5.1 Chrome 扩展(MV3)

| 部分 | 职责 |
|---|---|
| `side_panel` | 聊天框 UI:需求输入、任务进度、IR 结构预览卡片、确认/修正按钮、注入结果与跳转链接 |
| `service_worker` | 持有与伴生服务的 ws 连接(保活);任务编排;adapter JSON 缓存 |
| `content_script`(仅 Dify 控制台域) | 检测 Dify 版本与当前 app 上下文;新建模式:执行导入并跳转;修改模式:读草稿 graph、写回、触发刷新 |

- 域匹配:`http://localhost/*`(来自 `NGINX_SERVER_NAME=_`,§5.5),支持通过配置扩到其他域。
- UI 用 React + Tailwind 打包进扩展(体积无限制,不走远端 CDN)。
- 权限最小集:`sidePanel`、`storage`、`tabs`(跳转新 app)、host_permissions 仅 Dify 控制台域;与伴生服务通信用 `ws://127.0.0.1:39181`(可降级为 `runtime.connectNative` + stdio,作为 B 方案)。

### 5.2 伴生服务 Indify Bridge

- 技术:Node.js 20+(TS),运行时依赖 `ws` + `pdfjs-dist` + `@napi-rs/canvas`(OCR 依赖在专用 venv,不进 package.json)。
- 端口:`39181`(工作区 `.indifyrc.yaml` 可改)。
- 对外接口(扩展 ↔ Bridge,v2):

| 接口 | 说明 |
|---|---|
| `GET /v1/health` | 健康检查 + Bridge 版本 |
| `POST /v1/tasks` | 提交任务:`{mode: create\|modify, spec, context?, sessionId?, attachments?}` |
| `GET /v1/tasks/{taskId}` | 任务状态 |
| `POST /v1/tasks/{taskId}/decision` | HITL:`{action: build\|revise-plan\|approve\|revise, planText?, feedback?}` |
| `POST /v1/tasks/{taskId}/attachments` | 计划阶段补传附件(同一任务目录追加) |
| `POST /v1/tasks/{taskId}/injected` | 注入完成回报 |
| `WS /v1/events` | 帧:`task.frame`(状态机)/ `task.stream`(Agent 实时输出与附件识别通知) |
| `GET /v1/artifacts/{taskId}/{file}` | 读取落盘产物(`ir.json`、`workflow.yaml`、`graph.json`、`result.json`、`plan.txt`、`plan-final.txt`) |
| `GET /v1/adapter/{version}` | 返回 adapter JSON(扩展侧版本敏感细节的唯一来源) |

- DSH 侧:普通 fetch 客户端指向 `http://127.0.0.1:3080/api`,按 §7 协议调用;订阅 `/api/events.mux` WebSocket 监听会话帧(把 `assistant/chunk` 组装为 `task.stream` 广播,见 v2 F3)。
- 任务状态机(v2 两段式):
  `queued → planning → plan-ready ──build──→ building → draft-ready(HITL)→ finalizing → ready → injecting → done | failed`,
  `plan-ready` 可经 `revise-plan` 循环;`draft-ready` 可经 `revise` 迭代。状态持久化到工作区 `generated/{taskId}/task.json`,重启不丢(进行中的任务重启后标记 failed,不迁移)。
- 附件(v2 F1):白名单(PDF/图片/文本)+ 大小/张数上限,Bridge 权威校验;文字版 PDF 抽文本、
  扫描版 PDF 渲染页图后 RapidOCR、图片 RapidOCR(仅 OCR 文本通道,见 §13 R8);OCR 在专用 venv
  `.venv-ocr`(`tools/setup-ocr.ps1/.sh` 安装),任务排队期间后台跑,不阻塞主流程。
- 认证:首次运行生成 token 写入 `D:\difyIndify\.indifyrc.yaml`,扩展安装时由用户粘贴(或走 native messaging 自动交换,二期)。

### 5.3 Builder Agent(DSH 会话)

- 即本 GUI(DSH Web GUI)里的 agent 会话,由 Bridge 通过 `/api` 驱动。
- 职责:**只做结构语义**:需求澄清、节点/连边设计、数据流与变量绑定、控制流(条件/迭代)、HITL 协商。
- 加载 `dify-workflow-dsl` skill;IR ↔ DSL 转换与校验一律调 skill 的 scripts,不手写 YAML。
- 产出物(ADR-6):聊天消息给简短摘要;**`generated/{taskId}/`** 落盘结构化文件(见 §9)。
- 多任务并发:Bridge 可开多个 DSH 会话,按 `taskId` 对应;MVP 单会话串行即可。

### 5.4 DSL 适配层(skill + adapter JSON)——全系统的"版本防波堤"

```
D:\difyIndify\skills\dify-workflow-dsl\
├─ SKILL.md                    # 版本无关:结构语义、生成流程、IR↔DSL 映射规则、HITL 规范
├─ references\
│  └─ dify-1.16\
│     ├─ dsl-structure.md      # DSL YAML 字段结构(app/graph/nodes/edges/viewport/features)
│     ├─ node-catalog.md       # 节点类型清单与字段说明(1.16 实际节点集)
│     └─ console-api.md        # 控制台 API 端点、请求头、导入流程(人读版)
├─ scripts\
│  ├─ ir_to_dsl.mjs            # IR → DSL YAML(含自动布局)
│  ├─ dsl_to_ir.mjs            # DSL YAML → IR(round-trip 用)
│  └─ validate.mjs             # IR/DSL schema 校验(Pydantic 思路的等价物)
└─ adapter\
   └─ dify-1.16.1.json         # 机器可读:控制台端点、CSRF 头、导入选择器、Dify 版本探测规则
```

- skill 与 adapter JSON **同源维护**:console-api.md 与 adapter JSON 必须成对更新(可由脚本生成)。
- 未来需要 MCP 形态时,把 scripts 包一层 MCP 工具即可(同一真相源),本设计不阻塞该演进。

### 5.5 Dify 部署(现状,来自 `.env.example` / `docker-compose.yaml`)

- 版本 1.16.1:api、web、plugin daemon(0.6.10)、agent backend、sandbox、nginx、postgres、redis、weaviate。
- 控制台地址:nginx 80 端口、`NGINX_HTTPS_ENABLED=false`、`NGINX_SERVER_NAME=_` → **`http://localhost`**。
- 协作模式(collaboration)已启用 → 存在 websocket 服务,画布协作事件可用(二期可考虑监听草稿变化,替代整页刷新)。

## 6. IR 契约(全系统唯一稳定接口)

设计原则:**IR 与 Dify 版本无关**;所有 DSL 漂移被 §5.4 关住。IR 是 Builder Agent 与适配层之间的合同,变更需双版本兼容过渡。

```jsonc
{
  "irVersion": "1.0",                 // IR 自身版本;与 Dify 版本解耦
  "meta": {
    "name": "客服工单分类",
    "description": "…",
    "mode": "workflow"                 // workflow | advanced-chat | agent(一期只做 workflow)
  },
  "variables": {                       // 会话级/环境变量,逻辑名 → 类型
    "sys.query": { "type": "string", "source": "system" }
  },
  "nodes": [
    {
      "id": "n_classify",
      "type": "question_classifier",   // 语义节点类型(见下)
      "title": "分类",
      "position": { "x": 0, "y": 0 }, // 占位;最终布局由 ir_to_dsl 的自动布局覆盖
      "data": {                         // 语义字段,不含 DSL 字段名/引用语法
        "classes": [
          { "id": "angry", "name": "情绪激愤", "condition": "用户情绪为愤怒" }
        ],
        "model": { "provider": "default", "name": "auto" }
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": { "node": "start", "handle": "output" },
      "target": { "node": "n_classify", "handle": "input" }
    },
    {
      "id": "e2",
      "source": { "node": "n_classify", "handle": "angry" },   // handle=分类分支 id
      "target": { "node": "n_escalate", "handle": "input" }
    }
  ],
  "bindings": [                        // 变量引用:逻辑绑定,与 DSL 的 {{#node.var#}} 语法无关
    { "consumer": { "node": "n_escalate", "field": "prompt" },
      "producer": { "node": "n_classify", "field": "class_name" } }
  ]
}
```

语义节点类型(一期子集,按 node-catalog 扩展):
`start / end / llm / knowledge_retrieval / question_classifier / if_else / code / http / tool / iteration / variable_aggregator / template_transform / answer`

适配层职责边界(必须由它扛,Agent 不许碰):
- DSL 字段名、`{{#node_id.field#}}` 引用语法、节点 `data` 的版本差异字段。
- 画布坐标:自动布局(拓扑分层 + 网格),杜绝节点重叠。
- 默认值填充:模型配置、记忆开关、功能开关(features)等 Dify 必需字段。

**Round-trip 验收**(skill 自带脚本):
1. 从 Dify 1.16.1 导出官方示例 DSL(从运行中的控制台导出)。
2. `dsl_to_ir` → `ir_to_dsl` → 与原 YAML 逐字段 diff。
3. 通过 = 该版本适配层可信;Dify 升级后先跑回归,再谈新功能。

## 7. 会话协议(扩展 ↔ Bridge ↔ DSH)

### 7.1 任务消息(扩展 → Bridge)

```jsonc
{ "taskId": "t_20260711_01",
  "mode": "create",                     // create | modify
  "difyVersion": "1.16.1",
  "spec": "做一个客服工单分类工作流…",      // 自然语言
  "context": {                          // modify 模式由 content script 采集
    "appId": "…", "appUrl": "http://localhost/app/…/workflow",
    "currentGraph": { "nodes": […], "edges": […], "viewport": … }
  },
  "sessionId": "existing-or-null"       // 续聊复用会话
}
```

### 7.2 Bridge → DSH(RPC 草图,实现期对 127.0.0.1:3080 实测)

- `session.create`(必要时带 agentPreset/workspace 参数)→ 拿 sessionId。
- `session.prompt` 提交:结构化任务块(模式、规格、当前 graph JSON)+ 要求 Agent 遵守 skill 产出约定。
- Bridge 同时订阅 `events.mux` 帧,跟踪 `turn/end`;结束后:
  1. 调 `session.history` 取最后 assistant 消息(摘要 + 结果清单,给人看);
  2. 读工作区 `generated/{taskId}/result.json`(机器消费)。
- 续聊:`session.prompt` 复用同一 sessionId。

### 7.3 HITL 流程(ADR-5,v2 两段式)

```
用户输入(可带附件)─► Bridge ─► Agent 写实施计划 ─► result.json{status:"plan-ready"}
  ─► 扩展聊天框渲染「可编辑计划文本框」(对话中部,用户可直接手改;附件用途取舍写在计划里)
      ├─ [开始构建] ─► 用户最终计划文本(唯一权威,落盘 plan-final.txt)
      │      ─► Agent 构建 ─► result.json{status:"draft-ready"}
      │      ─► 扩展渲染结构预览卡片(节点/连边清单 + 简要说明)
      │          ├─ [确认] ─► Bridge 续发 approved ─► Agent 产出终稿(YAML/graph) ─► status:"ready" ─► 注入
      │          └─ [修改意见] ─► Bridge 续发修改意见 ─► Agent 迭代结构 ─► 回到预览
      └─ [让 Agent 修订](附补充说明)─► Agent 重写计划 ─► 回到 plan-ready(循环)
注入完成 ─► 扩展提示"已更新,请查看画布"(原生画布 = 最终人工闸口)
```

- create 与 modify **都走计划阶段**(无快速模式);无计划直接 Build 被状态机守卫拒绝。
- v2 F3:规划/构建期间 Agent 输出逐字流式推送到面板(60s 无输出有提示),turn 结束渲染正式产物。

## 8. 注入路线(Dify 控制台)

### 8.1 新建(create)

> M0 实测(见 `docs/m0-findings.md` §2):路线 B 的控制台导入 API **已实测可用**
> (`POST /console/api/apps/imports`,body `{mode:"yaml-content", yaml_content}` → 200/202,旧版 DSL 自动迁移);
> 附录A-7 结论:官方 CLI 导入在 1.16.1 不存在,C 方案 = 剪贴板逃生舱。实现时优先 B,失败降级剪贴板。

1. Agent 产出 `workflow.yaml`(skill 的 ir_to_dsl)。
2. 扩展 content script 二选一(adapter JSON 指定,含降级策略):
   - **A 原生导入**:模拟控制台"导入 DSL"文件选择框,塞入 YAML 的 `File` 对象——复用 Dify 自己的导入代码路径,最不易碎;
   - **B 控制台导入 API**:直接 POST 导入端点(1.16.1 端点以容器内源码为准)。
3. 得到新 app → 扩展 `tabs.update` 打开该 app 的工作流页 → 原生画布渲染。
4. 失败降级:把 YAML 放入剪贴板 + 引导用户手动导入(永远可用的逃生舱)。

### 8.2 修改(modify)

> M0 实测(见 `docs/m0-findings.md` §2):草稿读写端点已实测
> (`GET|POST /console/api/apps/{id}/workflows/draft`;POST body `{graph, features, hash?, environment_variables?, conversation_variables?}`,
> hash 乐观锁;该路径在 CSRF 白名单中)。写回→读回一致性已闭环。

1. content script 通过控制台 API 读当前草稿 graph(端点/头见 adapter JSON;同源 fetch 天然携带控制台 cookie)。
2. graph JSON 随任务交给 Agent(§7.1 context)。
3. Agent 按 skill 规则直接改 graph(结构就是 DSL 的 workflow.graph,skill 知道节点 data 细节)。
4. content script 写回草稿 API → 刷新页面 → 画布立即显示改动。
5. **已知风险**:控制台有草稿自动 sync,写回与自动 sync 存在时序竞争;实现期需验证"写回后立刻 reload"是否总是赢,必要时暂停编辑器自动保存(见 §13 R4)。

## 9. 工作区文件约定

```
D:\difyIndify\
├─ DESIGN.md                        # 本文档
├─ .indifyrc.yaml                   # Bridge 配置(端口、token、Dify 控制台 URL 映射)
├─ .venv-ocr\                       # RapidOCR 专用 venv(gitignored,tools/setup-ocr 安装)
├─ skills\dify-workflow-dsl\…        # §5.4
└─ generated\{taskId}\
   ├─ task.json                     # 任务与状态机
   ├─ plan.txt                      # 阶段一实施计划(Agent 写,可编辑文本框的底稿)
   ├─ plan-final.txt                # 用户最终计划(Bridge 写,构建唯一权威)
   ├─ plan-feedback.txt             # 计划修订反馈(Bridge 写)
   ├─ current-graph.json            # modify 模式当前草稿 graph(Bridge 写)
   ├─ ir.json                       # 终稿 IR(机器消费)
   ├─ workflow.yaml                 # create 模式 DSL
   ├─ graph.json                    # modify 模式新 graph
   ├─ result.json                   # {status: plan-ready|draft-ready|ready|failed, summary, warnings[]}
   └─ attachments\                  # v2 F1 附件(原件 + .txt/.ocr.txt/页图)
```

约定:Agent 只写自己 taskId 的目录;Bridge 只读 Agent 产物,只写
task.json、current-graph.json、plan-final.txt、plan-feedback.txt 与 attachments/(附件处理)。

## 10. 安全与信任

- **DSH `/api` 信任墙**(已勘察 `dsh-client-connection` README):所有 `/api` 请求要求 Host 为 loopback 或受信权威;带浏览器标记时 Origin 必须等于 Host。Bridge 是非浏览器 loopback 客户端(无 Origin 标记、Host=127.0.0.1:3080)→ 天然过墙,这是选 ADR-2 的根本原因。实现期实测确认。
- 特权方法(host.pickDirectory、settings、credentials 等)仅 loopback —— 我们只用 session 类方法,且全部经 Bridge 中转,扩展接触不到特权面。
- Bridge 只监听 127.0.0.1;ws 握手验证 token。
- Dify 凭据:cookie 由浏览器 content script 同源请求天然携带,不落盘、不进 Bridge。
- LLM API key:由 DSH 会话自己的模型配置承担,Bridge 不持有。

## 11. Dify 版本升级流程(验证"只更新 skill/adapter")

1. 从升级后的 Dify 导出示例 DSL → 跑 round-trip 回归,列出 diff。
2. 更新 `skills/dify-workflow-dsl/references/dify-<新版本>/`(dsl-structure、node-catalog、console-api)。
3. 重新生成 `adapter/dify-<新版本>.json`(控制台端点/头/选择器/版本探测规则)。
4. 扩展零改动:adapter 按运行时探测到的 Dify 版本选择(§5.1);Bridge 只透传版本号。
5. 回归 U1–U4。
- 诚实边界:扩展与 Bridge 代码仍可能有"结构性"变化(如 Chrome API 变动、DSH `/api` 变动),但**任何 Dify 版本变化**都不该触碰它们。

## 12. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 验证 | 对着运行中的 DSH(127.0.0.1:3080)实测 `/api` 会话三件套;从 dify-web 容器抠 1.16.1 控制台 API 端点/CSRF;导出官方示例 DSL | ✅ 附录 A 清单闭环(2026-08-19,`docs/m0-findings.md`) |
| M1 底座 | skill v1(SKILL.md + 1.16 参考 + 三脚本)+ round-trip 通过;Bridge 最小版;扩展骨架(panel/SW/content script 空壳) | ✅ round-trip diff=∅(2026-08-19);`GET /v1/health` 通;扩展骨架可 unpacked 加载(附录A-6 待浏览器实测) |
| M2 新建链路 | U1 全流程:聊天 → IR 预览 → 确认 → YAML → 原生导入 → 画布 | ✅ 无浏览器链路实测跑通(2026-08-19:queued→agent-running→draft-ready→finalizing→ready→injected→done;approve 与 revise 双路径;生成物 round-trip diff=∅);浏览器侧 U1 演示待用户 walkthrough |
| M3 修改链路 | U2 全流程:草稿读 → Agent 改 → 写回 → 画布就地更新;U3 迭代续聊 | ✅ 无浏览器链路实测通过(2026-08-19:echo 应用 2→3 节点就地更新、code 节点标题/desc 同会话二次修改,全程 graph JSON + 草稿 API,无 YAML 往返;U3 同会话 12s 续改);浏览器侧 R4 时序竞争待真机验证 |
| M4 版本化完善 | adapter JSON 完整、版本探测、升级演练(11 节流程走一遍)、打包与自托管安装说明 | ✅ 版本探测(扩展按 /app-dsl-version 选 adapter)、`tools/upgrade-drill.mjs` 模拟升版 6/6 通过、Bridge/扩展 0 处版本硬编码、`tools/package-extension.ps1` 打包、根 README 安装/使用/升级说明齐全 |
| v2 体验升级 | F2 两段式确认(计划文本框 + build/revise-plan);F3 Agent 实时输出流(task.stream);F1 附件 + RapidOCR(白名单/PDF/扫描件/图片,补传端点) | ✅ 无浏览器链路全部实测(2026-08-27:两段式双回路、流式逐字、4 类附件识别、负向拒绝、守卫 409、生成物 round-trip diff=∅、`upgrade-drill` 仍 6/6);扩展升 0.2.0 打包;**多模态实测否决**(DSH 双模型不吃图,用户拍板仅 OCR 文本);浏览器全流程实测待用户 walkthrough |

## 13. 风险与开放问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | DSH `/api` 会话方法的实际参数/响应与 README 描述有出入 | Bridge 联调返工 | M0 先行实测,协议层集中在 Bridge 一处 |
| R2 | Dify 1.16.1 控制台 API 端点/CSRF 未验证 | 注入链路受阻 | 从本地 dify-web 容器产物提取(本环境无法访问 GitHub,容器即真相);保留"剪贴板逃生舱" |
| R3 | DSL 结构漂移(升版后字段变化) | 生成物失效 | 版本化 skill/adapter + round-trip 回归(§11) |
| R4 | 草稿写回与控制台自动 sync 的时序竞争 | 改动被旧草稿覆盖 | 实测;必要时注入后立即 reload 或暂停编辑器自动保存 |
| R5 | MV3 service worker 休眠导致 ws 断开 | 任务推送丢失 | ws 保活 + 任务状态落盘可恢复 + 重连重放 |
| R6 | 控制台域名/端口非 localhost(用户改过 nginx 配置) | content script 不注入 | 域匹配从 `.indifyrc.yaml` 读取,支持多域列表 |
| R7 | DSH 提问系统(HITL)不在扩展内 | 用户错过确认 | ADR-5 已规避:确认流程自建在扩展聊天框;DSH 提问联动列为二期 |
| R8 | Builder 会话模型无视觉能力(实测:deepseek-v4-pro/flash 均不吃图,`MODEL_DOES_NOT_SUPPORT_IMAGES`) | 图片/扫描件无法直接看图 | **已定案(2026-08-27,用户拍板)**:仅 RapidOCR 文本通道,面板标注「OCR 文本,可能有误」;原件/页图保留供人工核对;DSH 若换用视觉模型可再启用多模态路径 |
| R9 | RapidOCR 对模糊/手写/复杂表格识别有错漏;Python 3.13 轮子可用性 | 文本内容有误/安装失败 | OCR 文本标注可能有误;setup 脚本含 uv/3.12 兜底;3.13 + onnxruntime 1.29 已实测可用 |

## 附录 A:未验证清单(实现期逐条闭环)

1. [x] DSH `/api`:session.create / session.prompt / session.history 的确切参数、返回结构、错误码。
   **M0 已验证**——线格式 `POST /api/<method>` + client-request/server-response 信封;三件套签名见 `docs/m0-findings.md` §1。
2. [x] DSH `/api/events.mux` 帧格式与 `turn/end` 判定;非浏览器 loopback 客户端实测过信任墙。
   **M0 已验证**——网络客户端仅 WS 升级(纯 GET 返回 426);帧为 server-request 信封,`session/event` + `event.type==="turn/end"` 判结束;loopback 无标记 200 / 伪造 Origin 403。
3. [x] Dify 1.16.1 控制台:导入端点、草稿读写端点、CSRF 头、响应结构(从 dify-web 容器产物 grep)。
   **M0 已验证**——oRPC 契约提取 778 条路由;`POST /apps/imports`(yaml-content/yaml-url,200/202)、`GET|POST /apps/{id}/workflows/draft`(hash 乐观锁、CSRF 白名单豁免)、`GET /apps/{id}/export`(`{data: YAML}`)全部实测通过;CSRF=`X-CSRF-Token` 头 == `csrf_token` cookie,覆盖所有非 OPTIONS 方法;登录密码为 base64 编码。详见 `docs/m0-findings.md` §2。
4. [x] Dify 1.16.1 DSL:导出官方示例,确认 app 级字段、graph 结构、节点 data 字段集(喂给 node-catalog)。
   **M0 已验证**——官方 echo 样例经运行中控制台导入(0.3.1)→导出(0.7.0),基准文件 `skills/dify-workflow-dsl/tests/fixtures/official-sample-1.16.1.yml`;节点类型全集(25 内置 + trigger 系列)取自 graphon 0.6.0 `BuiltinNodeTypes`。详见 `docs/m0-findings.md` §3。
5. [x] 草稿写回后页面刷新是否稳定呈现;自动 sync 竞争实测(R4)。
   **M0 部分验证 + M3 实测**——API 侧闭环:GET draft → 改标题 → POST draft(带 hash)→ GET 读回一致;
   M3 无浏览器链路实测 echo 应用 2→3 节点就地更新;**2026-08-20 用户浏览器 walkthrough 确认**:
   写回 → 单次刷新画布呈现稳定;未观察到自动 sync 覆盖(「GET 最新 hash → 写回 → 单次刷新」策略有效)。
6. [x] Chrome sidePanel 在用户主动点开场景下的可用性;ws 到 127.0.0.1 的扩展权限细节。
   **2026-08-20 用户浏览器实测通过**——unpacked 加载成功;点扩展图标打开 sidePanel 正常;
   content script 正确注入并识别 appId/画布页上下文;粘贴 token 后 ws 连接 Bridge 成功;
   MV3 下 ws://127.0.0.1 无需额外权限(与设计一致)。
7. [x] 官方 CLI 导入是否可被 Bridge 直接调用(作为原生导入的 C 方案)。
   **M0 已验证:不可用**——1.16.1 api 容器无 `dify` CLI、flask CLI 无 import 命令;C 方案定案为剪贴板逃生舱(见 `docs/m0-findings.md` §4),已实现于扩展(route B 失败时一键复制 YAML 手动导入)。

## 附录 B:术语表

| 术语 | 含义 |
|---|---|
| Builder Agent | 负责工作流结构语义的 agent(本设计 = DSH 会话) |
| IR | 中间表示:与 Dify 版本无关的工作流结构 JSON(§6) |
| DSL | Dify 工作流导出/导入用的 YAML 格式 |
| adapter JSON | 机器可读的 Dify 版本敏感细节(端点/头/选择器) |
| Indify Bridge | 本地伴生服务,扩展与 DSH /api 之间的中转与文件通道 |
| 控制台 API | Dify web 控制台自己调用的后端接口(非公开 Service API) |
| Round-trip | DSL→IR→DSL 的往返校验,适配层的验收标准 |
| HITL | Human-in-the-loop,人工确认闸口 |
