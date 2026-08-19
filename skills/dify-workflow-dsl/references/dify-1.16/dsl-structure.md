# Dify 1.16.1 DSL YAML 结构(version 0.7.0)

> 本文是适配层对 Dify 1.16.1「导入/导出 DSL」信封的**权威人读文档**,与
> `scripts/dsl_to_ir.mjs` / `scripts/ir_to_dsl.mjs` 的行为一一对应。
> 依据:运行中控制台导出的官方样例(`tests/fixtures/official-sample-1.16.1.yml`)+
> api 容器内 `graphon` 0.6.0 源码(M0 实测,见 `docs/m0-findings.md` §3)。

## 1. 顶层信封

```yaml
app:            # 应用级元数据
dependencies: []  # 插件依赖(见 §1.2)
kind: app         # app | rag-pipeline | graph(本项目一期只用 app)
version: 0.7.0    # DSL 版本;1.16.1 = 0.7.0
workflow:         # 工作流配置(见 §2)
```

`kind` 决定 `workflow` 或 `graph` 的形态;本项目(workflow 模式)恒为 `kind: app`
+ `workflow:` 块。

### 1.1 app 字段

| 字段 | 类型 | 说明 | 缺省 |
|---|---|---|---|
| `name` | string | 应用名(IR `meta.name`) | 必填 |
| `description` | string | 描述(IR `meta.description`) | `""` |
| `mode` | string | `workflow` / `advanced-chat` / `agent` / `chat` / `rag-pipeline`(一期只用 `workflow`) | `workflow` |
| `icon` | string | emoji 字符或图片 URL | `🤖` |
| `icon_background` | string | 图标底色(hex) | `#FFEAD5` |
| `icon_type` | string | `emoji` / `image` | `emoji` |
| `use_icon_as_answer_icon` | boolean | 是否用 app 图标作答案图标 | `false` |

IR 侧:`meta = {name, description, mode}` 是 app 字段的语义投影;`app` 对象整体
原样保留在 IR 顶层(`ir.app`),用于 round-trip 保真。

### 1.2 dependencies

插件依赖数组,元素结构(`graphon.dsl.entities.DslDependency`):

```yaml
- type: marketplace            # marketplace | github | package
  plugin_unique_identifier: ...  # 插件唯一标识(可选)
  repo: ...                    # github 仓库(可选)
  package: ...                 # 包名(可选)
  source: {}                   # 附加来源信息(可选)
```

MVP:纯内置节点的工作流 `dependencies: []`。含插件节点(如 trigger-plugin / 第三方
tool)时,导入导出会携带依赖;适配层原样保留,不解析。

## 2. workflow 块

```yaml
workflow:
  conversation_variables: []      # 会话变量(§2.1)
  environment_variables: []       # 环境变量(§2.1)
  features: { ... }               # 功能开关(§2.2,含全字段默认值)
  graph:                          # 画布图(§3)
    edges: [ ... ]
    nodes: [ ... ]
    viewport: { x, y, zoom }
  rag_pipeline_variables: []      # RAG 流水线变量(§2.3;workflow 模式恒空)
```

### 2.1 conversation_variables / environment_variables

元素结构(`graphon.dsl.entities.DslRuntimeVariable`,导入/导出同构):

```yaml
- name: my_var      # 变量名
  value: ...        # 默认值(任意 JSON 标量/对象;环境变量常为字符串)
  source: {}        # 来源元数据(Mapping;环境变量的来源/凭据配置)
```

> 注意:DSL 文件里的运行时变量是「运行时变量视图」;控制台草稿 API 里的
> `environment_variables`/`conversation_variables` 是另一套更丰富的
> `VariableEntity` 结构(含 `label/type/required/options` 等)。二者**不要混用**:
> skill 只管 DSL 文件;草稿写回(modify 链路)走 graph JSON,见 `console-api.md`。

### 2.2 features(全字段默认值)

适配层管理 features 默认值(`scripts/ir_to_dsl.mjs` 的 `DEFAULT_FEATURES`),Agent 不手写。
1.16.1 官方导出的完整默认如下:

```yaml
features:
  file_upload:
    allowed_file_extensions: [.JPG, .JPEG, .PNG, .GIF, .WEBP, .SVG]
    allowed_file_types: [image]
    allowed_file_upload_methods: [local_file, remote_url]
    enabled: false
    fileUploadConfig:
      audio_file_size_limit: 50
      batch_count_limit: 5
      file_size_limit: 15
      image_file_size_limit: 10
      video_file_size_limit: 100
      workflow_file_upload_limit: 10
    image:
      enabled: false
      number_limits: 3
      transfer_methods: [local_file, remote_url]
    number_limits: 3
  opening_statement: ''
  retriever_resource:
    enabled: true
  sensitive_word_avoidance:
    enabled: false
  speech_to_text:
    enabled: false
  suggested_questions: []
  suggested_questions_after_answer:
    enabled: false
  text_to_speech:
    enabled: false
    language: ''
    voice: ''
```

### 2.3 rag_pipeline_variables

`workflow` 模式下恒为 `[]`。元素(仅 `rag-pipeline` 模式)继承
`VariableEntity`(字段见 `node-catalog.md` 的「start 变量」)并追加
`tooltips` / `placeholder` / `belong_to_node_id`。适配层原样保留。

## 3. graph:节点 / 边 / viewport

### 3.1 节点对象

```yaml
- data:            # 节点语义配置(核心,见 node-catalog.md)
    type: start    # DSL type 字符串(节点类型,1.16.1 全集见 node-catalog.md)
    title: Start
    desc: ''
    ...            # 各类型专属字段
  height: 90       # 画布尺寸(px)
  width: 244
  id: '1754154032319'   # 节点 id:数字字符串(官方样例),可自定义字符串
  position: { x: 30, y: 227 }            # 画布坐标
  positionAbsolute: { x: 30, y: 227 }    # 绝对坐标(与 position 同值)
  selected: false                        # 是否被选中
  sourcePosition: right                  # 出边锚点方向
  targetPosition: left                   # 入边锚点方向
  type: custom                           # 恒为 custom(React Flow 节点类型)
```

字段要点:

- `data.type` 才是 Dify 的节点类型;**外层 `type: custom` 是 React Flow 画布类型,恒为
  `custom`**,不要改。
- `id` 官方导出为数字字符串;导入接受任意唯一字符串。IR 中 id 原样保留。
- `position` 与 `positionAbsolute` 在官方导出中**恒为同值**;适配层也按同值回填
  (IR 的 `position` 是唯一权威,`ir_to_dsl` 同步写两者)。
- `height`/`width`/`sourcePosition`/`targetPosition`/`positionAbsolute`/`selected`
  是画布字段,在 IR 中收进节点的 `canvas` 对象保真往返。

### 3.2 边对象

```yaml
- data:
    isInIteration: false   # 是否位于迭代子图内
    isInLoop: false        # 是否位于循环子图内
    sourceType: start      # 源节点 DSL type
    targetType: end        # 目标节点 DSL type
  id: 1754154032319-source-1754154034161-target
  source: '1754154032319'      # 源节点 id
  sourceHandle: source         # 源出边句柄(普通输出为 'source';分支为分支 id)
  target: '1754154034161'      # 目标节点 id
  targetHandle: target         # 目标入边句柄(普通输入为 'target')
  type: custom                 # 恒 custom
  zIndex: 0                    # 层级
```

> 注意:`data` 里四个字段**并非总是全量出现**(例如分支边可能缺 `isInIteration`)。
> 适配层对边 `data` 整体原样保留,不做字段级归一化,以保证 round-trip diff=∅。

### 3.3 viewport

```yaml
viewport: { x: 0, y: 0, zoom: 0.7 }
```

画布视口,IR 顶层 `viewport` 原样往返。

## 4. value_selector 引用语法

节点之间的变量引用用**数组**表达,格式恒为 `[节点 id, 变量名]`:

```yaml
value_selector:
  - '1754154032319'   # 生产节点 id
  - query             # 该节点输出的变量名
```

出现位置示例:

- `end` 节点 `data.outputs[].value_selector`
- `llm` 节点 `data.context.variable_selector`(上下文变量)
- `if-else` 节点 `data.cases[].conditions[].variable_selector`
- `question-classifier` 节点 `data.query_variable_selector`
- `code` 节点 `data.variables[].value_selector`
- 模板字符串内联:`{{#node_id.var_name#}}`(如 `{{#1754154032319.query#}}`)

> **value_selector 是适配层内部知识**:IR 的 `bindings` 是逻辑绑定(语义化引用),
> 与 DSL 的 `value_selector`/`{{#…#}}` 语法无关。MVP 中 round-trip 保真优先,
> dsl_to_ir 不把 value_selector 反解为 bindings(edges 已保真引用关系);Agent 编辑
> bindings 的语义化规则见 `SKILL.md` §5。

## 5. 导入导出注意点

1. **版本迁移**:旧版 DSL(如 0.3.1)经控制台导入会自动迁移到 0.7.0;`POST
   /console/api/apps/imports` 响应会回传 `imported_dsl_version` / `current_dsl_version`。
2. **导出**:`GET /console/api/apps/{id}/export` 返回 `{ data: "<DSL YAML 字符串>" }`,
   `include_secret=false` 时凭据类字段脱敏。
3. **round-trip 保真原则**:`dsl_to_ir` → `ir_to_dsl` 后,节点 `data`、边 `data`/`zIndex`/`type`、
   画布字段、features、conversation/environment/rag 变量、viewport、dependencies 全部原样;
   唯一被"规范化"的是 `position` 与 `positionAbsolute` 强制同值(官方导出本就同值,故 diff=∅)。
4. **key 顺序**:适配层按本文档列出的顺序输出 YAML,round-trip 深比较对 key 顺序敏感。
5. **数值类型**:`position.x/y`、`zoom`、`zIndex` 为 number;`id`/`source`/`target` 为字符串。
