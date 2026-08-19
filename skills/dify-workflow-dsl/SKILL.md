# dify-workflow-dsl — DSL 适配层 skill

> 你是 Indify 的 **DSL 适配层**:全系统唯一的「Dify 版本防波堤」。DSL(工作流 YAML)与
> 控制台 API 的版本细节只存在于本 skill 的 references 与 scripts;Builder Agent 只处理
> IR(中间表示)的结构语义。Dify 升级时只改本 skill 与 adapter JSON,Agent 与扩展零改动。

## 1. 职责与边界

**你负责(必须由你扛,Builder Agent 不许碰):**
- DSL 字段名、`{{#node_id.field#}}` 模板语法、`value_selector: [node_id, var_name]` 引用语法。
- 节点 `data` 的版本差异字段、节点类型全集(1.16.1 = 28 类,见 `references/dify-1.16/node-catalog.md`)。
- 画布坐标:自动布局(拓扑分层 + 网格),杜绝节点重叠。
- 默认值填充:features、模型配置、记忆开关、app 图标/信封等 Dify 必需字段。
- DSL ↔ IR 转换与校验(一律调 scripts,不手写 YAML)。

**你不管:** 用户需求澄清、节点/连边设计、数据流与控制流语义设计、HITL 协商——这些是
Builder Agent 的职责(它只产出 IR)。

## 2. 生成流程(需求 → IR → 校验 → YAML)

```
① 需求理解(Builder Agent)
     └─ 产出 IR JSON(结构语义,见 §3)
② 校验 IR(Builder Agent 调)
     node scripts/validate.mjs ir.json          # 结构/白名单/边端点/必填字段
③ IR → DSL(适配层调)
     node scripts/ir_to_dsl.mjs ir.json workflow.yaml
④ 回归 DSL(适配层可选)
     node scripts/dsl_to_ir.mjs workflow.yaml   # 反向验证往返无损
```

- **新建(create)**:第 ③ 步产物 `workflow.yaml` 交给扩展做 DSL 导入。
- **修改(modify)**:DSL→IR 拿 IR 改,IR→DSL 产出的 graph 走草稿 API 写回(不走 YAML)。
- 脚本只处理**对象**;YAML 解析/序列化在 CLI 与 `tests/round-trip.mjs` 内完成。

### 2.1 修改(modify)流程 —— 就地更新,无 YAML 往返

```
① Bridge 把当前草稿 graph(JSON)写入 generated/{taskId}/current-graph.json
② Agent 读取 current-graph.json(它就是 DSL 的 workflow.graph:nodes/edges/viewport)
③ 直接在 graph 结构上做结构语义修改(遵守 §4 保真纪律)
④ 写 generated/{taskId}/graph.json(新 graph)+ result.json{status:"draft-ready"}
⑤ 用户确认后:再校验 graph.json,更新 result.json{status:"ready"}
⑥ 扩展把 graph.json 经草稿 API(POST /apps/{app_id}/workflows/draft)写回并刷新画布
```

**modify 模式纪律(Agent 必读):**
1. **保真优先**:未触及的节点 `data`、`canvas`、边 `data/zIndex`、`viewport` 一律原样保留;
   新增节点按 node-catalog 默认 data 构造,id 全图唯一(可用短语义 id,如 `n_llm_2`)。
2. **删节点时同步删引用**:所有指向被删节点的边、其他节点 data 里的
   `value_selector`/`{{#id.var#}}` 引用必须一并清理或改指,否则校验会抓出悬空引用。
3. **改连线** = 改 `edges` 数组(含 source/sourceHandle/target/targetHandle 与边的
   `data.sourceType/targetType`);条件分支节点(if-else/question-classifier)的分支 handle
   与 `data.cases[].case_id` 要保持一致。
4. **校验**:`node scripts/validate.mjs generated/{taskId}/graph.json` —— 注意 graph.json 是
   `workflow.graph` 对象,不是完整 DSL;用 `--graph` 参数校验(见 validate.mjs 用法)。
5. **不要**把 graph 转回 YAML 再导入(那只会新建应用);修改只走草稿写回。

## 3. IR 契约(唯一稳定接口)

> 权威定义见 `DESIGN.md` §6。此处是执行要点;`irVersion` 恒 `"1.0"`。

```jsonc
{
  "irVersion": "1.0",
  "meta": { "name": "客服工单分类", "description": "…", "mode": "workflow" },
  "variables": { "sys.query": { "type": "string", "source": "system" } }, // 语义视图
  "nodes": [
    { "id": "n1", "type": "llm", "title": "LLM", "position": { "x": 0, "y": 0 },
      "data": { "type": "llm", "title": "LLM", "model": { ... }, "prompt_template": [ ... ] },
      "canvas": { "height": 90, "width": 244, "positionAbsolute": { "x": 0, "y": 0 },
                  "sourcePosition": "right", "targetPosition": "left", "selected": false } }
  ],
  "edges": [
    { "id": "e1", "source": { "node": "start", "handle": "source" },
      "target": { "node": "n1", "handle": "target" }, "type": "custom", "zIndex": 0,
      "data": { "isInIteration": false, "isInLoop": false, "sourceType": "start", "targetType": "llm" } }
  ],
  "bindings": [],                                  // 逻辑绑定(§5)
  "viewport": { "x": 0, "y": 0, "zoom": 0.7 },
  // —— 以下为 DSL 信封原样保留(保真往返,Agent 一般不直接改)——
  "app": { "description": "…", "icon": "🤖", "icon_background": "#FFEAD5",
           "icon_type": "emoji", "mode": "workflow", "name": "…", "use_icon_as_answer_icon": false },
  "kind": "app", "version": "0.7.0", "dependencies": [],
  "features": { ... }, "conversation_variables": [], "environment_variables": [], "rag_pipeline_variables": []
}
```

**节点语义类型(13 类,完整映射见 node-catalog.md §0):**
`start / end / llm / knowledge_retrieval / question_classifier / if_else / code / http /
tool / iteration / variable_aggregator / template_transform / answer`

未列入语义类型的 DSL 节点(parameter-extractor、datasource、loop 家族、assigner、agent、
trigger 系列等 15 类)在 IR 的 `node.type` 中**原样透传 DSL type 字符串**,round-trip 无损。

## 4. IR ↔ DSL 映射规则

1. **节点 `data` 完整原样保留**:`data` 是节点语义配置,语义键由 node-catalog 定义,**未知键也必须保留**。
   `dsl_to_ir` 不做字段级改写;`ir_to_dsl` 原样回填。
2. **画布字段分离**:DSL 节点的 `height/width/sourcePosition/targetPosition/positionAbsolute/selected`
   在 IR 中收进节点 `canvas`;`position{x,y}` 提升为 IR 顶层(Agent 可改)。
   `ir_to_dsl` 把 `canvas` 原样回填,并把 `position` 同步写回 DSL 的 `position` 与 `positionAbsolute`(两者恒同值)。
3. **边保真**:DSL 边 `{id, source, sourceHandle, target, targetHandle, type:"custom", zIndex, data}`
   ↔ IR 边 `{id, source:{node,handle}, target:{node,handle}, type, zIndex, data}`,`data/type/zIndex` 原样往返。
4. **viewport / features / conversation_variables / environment_variables / rag_pipeline_variables /
   app / kind / version / dependencies**:IR 顶层原样保留并回填;`features` 默认值由适配层管,Agent 不手写。
5. **自动布局**:仅当存在节点缺 `position` 或显式要求(`--force-layout`)时触发:拓扑分层
   (列 = 最长路径深度)+ 列内纵向排布,尺寸按 node-catalog 默认宽高估算。**round-trip 路径
   (坐标已存在)必须原样回填,不得重排**。
6. **`position` 是 IR 唯一权威坐标**;Agent 移动节点 = 改该节点 `position`,适配层同步 `positionAbsolute`。

## 5. bindings 语义化规则(Agent 编辑约定)

- IR 的 `bindings` 是**逻辑绑定**(语义化引用),与 DSL 的 `value_selector`/`{{#…#}}` 无关:

```jsonc
{ "consumer": { "node": "n_escalate", "field": "prompt" },      // 消费方:节点 + 语义字段
  "producer": { "node": "n_classify", "field": "class_name" } } // 生产方:节点 + 输出变量
```

- **MVP 状态**:`dsl_to_ir` 不把 DSL 的 `value_selector` 反解为 bindings(edges 已保真引用关系,
   bindings 返回 `[]`);`ir_to_dsl` 也不消费 bindings。
- **Agent 规则**:
  - 引用上游变量时,直接编辑**消费者节点 `data` 里的 DSL 引用字段**(如 llm 的
    `context.variable_selector`、end 的 `outputs[].value_selector`),写成
    `value_selector: [上游节点 id, 变量名]`。
  - `bindings` 仅作为**人类可读的意图记录**(供预览卡片展示数据流),不驱动生成;
    未来版本再实现「由 bindings 自动生成 value_selector」。
  - 不要手写 `{{#node_id.field#}}` 之外的语法;模板引用同样走 `{{#上游id.变量#}}`。

## 6. HITL 规范(ADR-5)

主闸口在扩展聊天框(预览确认),原生画布为最终人工检查;不依赖 DSH 提问系统。

```
用户输入 → Bridge → Agent 生成 IR → result.json{status:"draft-ready"}
  → 扩展渲染结构预览卡片(节点/连边清单 + 数据流说明)
      ├─ [确认] → Bridge 续发 approved → Agent 产终稿(YAML/graph) → status:"ready" → 注入
      └─ [修改意见] → Bridge 续发意见 → Agent 迭代 IR → 回到预览
注入完成 → 扩展提示"已更新,请查看画布"(原生画布 = 最终人工闸口)
```

- Agent 在 `draft-ready` 阶段**只提交 IR + 摘要**,不产 YAML;确认后再调 `ir_to_dsl` 产终稿。
- 预览内容 = IR 的 nodes/edges 清单(标题、语义类型、连边、bindings 意图),不暴露 DSL 细节。

## 7. Agent 使用协议(必读)

1. **只产出 IR,不手写 DSL/YAML**。DSL 生成一律 `node scripts/ir_to_dsl.mjs <ir.json> <out.yml>`。
2. **改 DSL 前先转 IR**:`node scripts/dsl_to_ir.mjs <dsl.yml> <ir.json>` → 改 IR → 转回。
3. **提交前校验**:`node scripts/validate.mjs <ir.json|workflow.yaml>` 必须 `有效 ✅`。
4. **round-trip 回归**:版本升级或改适配层后跑 `node tests/round-trip.mjs`,diff 必须为空。
5. **落盘约定**(ADR-6,见 DESIGN.md §9):只写自己 `taskId` 的目录 `generated/{taskId}/`:
   `ir.json`(终稿 IR)、`workflow.yaml`(create 模式 DSL)、`graph.json`(modify 模式新 graph)、
   `result.json`({status, appId?, appUrl?, summary, warnings[]})。聊天消息只给简短摘要。
6. **节点 id**:官方导出为数字字符串;新生成可用短语义 id(如 `n_llm_1`),全图唯一即可。
7. **不要**修改 `tests/fixtures/official-sample-1.16.1.yml`(round-trip 官方基准)。

## 8. 版本升级流程(只改本 skill / adapter)

1. 从新版本 Dify 导出官方示例 DSL,替换基准 fixture → 跑 `node tests/round-trip.mjs`。
2. 按 diff 更新 `references/dify-<新版本>/`(dsl-structure / node-catalog / console-api)。
3. 重新生成 `adapter/dify-<新版本>.json`(与 console-api.md 同源成对)。
4. 回归 U1–U4;扩展与 Bridge 零改动。

## 9. 目录结构

```
skills/dify-workflow-dsl/
├─ SKILL.md                  # 本文档(版本无关)
├─ references/dify-1.16/     # 1.16.1 版本化细节
│  ├─ dsl-structure.md       # DSL YAML 0.7.0 信封/节点/边/value_selector
│  ├─ node-catalog.md        # 28 类节点 data 字段与语义映射
│  └─ console-api.md         # 控制台 API(登录/CSRF/导入/草稿/导出)
├─ scripts/
│  ├─ dsl_to_ir.mjs          # DSL YAML → IR
│  ├─ ir_to_dsl.mjs          # IR → DSL YAML(自动布局 + 保真回填)
│  └─ validate.mjs           # IR/DSL 校验
├─ tests/
│  ├─ round-trip.mjs         # 官方基准 DSL→IR→DSL 深比较
│  └─ fixtures/official-sample-1.16.1.yml
└─ package.json              # 依赖仅 yaml@2.x
```
