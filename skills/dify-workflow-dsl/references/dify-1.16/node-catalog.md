# Dify 1.16.1 节点类型清单(node-catalog)

> 权威依据:api 容器内 `graphon` 0.6.0 各节点 `entities.py`(Pydantic 模型)与
> `core/workflow/nodes/**`(M0 实测)。节点 type 全集 = `graphon.enums.BuiltinNodeTypes`
> 25 个 + `core.trigger.constants` 3 个 trigger = **28 个**。
> 本文与 `scripts/dsl_to_ir.mjs` 的 `DSL_NODE_TYPES` / `DSL_TYPE_TO_IR_TYPE` 保持一致。

## 0. 语义映射总表(DSL type ↔ IR 语义类型)

IR 语义类型是 Builder Agent 面向的稳定词汇(DESIGN.md §6)。有语义类型的 13 类节点
在 IR 中归一为语义类型;其余 15 类节点在 IR 中**原样透传 DSL type 字符串**(round-trip
无损,语义后续版本逐步补充)。

| DSL type | IR 语义类型 | 说明 |
|---|---|---|
| `start` | `start` | 开始 |
| `end` | `end` | 结束 |
| `llm` | `llm` | LLM |
| `answer` | `answer` | 直接回复 |
| `knowledge-retrieval` | `knowledge_retrieval` | 知识检索 |
| `question-classifier` | `question_classifier` | 问题分类 |
| `if-else` | `if_else` | 条件分支 |
| `code` | `code` | 代码执行 |
| `http-request` | `http` | HTTP 请求 |
| `tool` | `tool` | 工具调用 |
| `iteration` | `iteration` | 迭代容器 |
| `variable-aggregator` | `variable_aggregator` | 变量聚合 |
| `template-transform` | `template_transform` | 模板转换 |
| `datasource` | `datasource`(透传) | 数据源(文件/在线文档) |
| `variable-assigner` | `variable-assigner`(透传) | 旧版变量赋值(legacy) |
| `loop` / `loop-start` / `loop-end` | 同左(透传) | 循环容器及起止 |
| `iteration-start` | `iteration-start`(透传) | 迭代子图入口 |
| `parameter-extractor` | `parameter-extractor`(透传) | 参数提取 |
| `assigner` | `assigner`(透传) | 变量赋值(v2) |
| `document-extractor` | `document-extractor`(透传) | 文档提取 |
| `list-operator` | `list-operator`(透传) | 列表操作 |
| `agent` | `agent`(透传) | Agent 策略 |
| `human-input` | `human-input`(透传) | 人工输入(HITL) |
| `trigger-schedule` | `trigger-schedule`(透传) | 定时触发 |
| `trigger-webhook` | `trigger-webhook`(透传) | Webhook 触发 |
| `trigger-plugin` | `trigger-plugin`(透传) | 插件事件触发 |

## 1. 公共 data 字段(BaseNodeData)

所有节点 `data` 都继承下列字段(`graphon.entities.base_node_data.BaseNodeData`,
`extra="allow"`,因此前端还会附加 `selected` 等兼容键,适配层一律原样保留):

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `type` | string | 必填 | 节点 DSL type 字符串(本目录 §0 左列) |
| `title` | string | `""` | 节点标题(IR `node.title`) |
| `desc` | string/null | `null` | 节点描述 |
| `version` | string | `"1"` | 节点 schema 版本 |
| `error_strategy` | string/null | `null` | `fail-branch` / `default-value`(异常分支/默认值) |
| `default_value` | array/null | `null` | 失败默认值 `[{key, type, value}]` |
| `retry_config` | object | `{max_retries:0, retry_interval:0, retry_enabled:false}` | 重试配置 |

> 1.16.1 的 `retry_config` 为 `{max_retries, retry_interval, retry_enabled}`(graphon 0.6.0)。
> 更早 DSL(0.3.x)里是 `{enabled, max_retries, retry_interval, exponential_backoff}`,
> 由控制台导入时自动迁移,skill 无需处理旧结构。

## 2. 节点逐一说明(按功能分组)

### 2.1 基础节点

**start**(`start`)
- data:`variables: [VariableEntity]`(输入变量定义)。
- `VariableEntity` 字段:`variable`(名)、`label`、`description`、`type`(
  `text-input`/`select`/`paragraph`/`number`/`external_data_tool`/`file`/`file-list`/
  `checkbox`/`json_object`)、`required`、`hide`、`default`、`max_length`、`options`、
  `allowed_file_types`、`allowed_file_extensions`、`allowed_file_upload_methods`、`json_schema`。
- 输出变量 = 每个 `variables[].variable`;边 handle 出 = `source`。

**end**(`end`)
- data:`outputs: [{variable, value_type, value_selector}]`。
- `value_selector: [上游节点 id, 变量名]` 指定每个输出的来源;`value_type` 取值见
  `OutputVariableType`(string/number/integer/boolean/object/file/array/array[…] 等)。
- 无输出(流程终止);边 handle 入 = `target`。

**answer**(`answer`)
- data:`answer: string`(模板,支持 `{{#node_id.var#}}` 引用)。
- 输出 = 渲染后的 `answer` 文本;作为流程终止/回复节点。

### 2.2 LLM 家族

**llm**(`llm`)
- data 核心:`model{provider, name, mode, completion_params}`、
  `prompt_template`(chat 模式为 `[{role, text, jinja2_text}]`,completion 模式为
  `{text, jinja2_text}`)、`prompt_config{jinja2_variables}`、`memory`(记忆,可空)、
  `context{enabled, variable_selector}`(上下文)、`vision{enabled, configs}`、
  `structured_output` / `structured_output_switch_on`、`reasoning_format`(`tagged`/`separated`)。
- 输出变量:`text`、`usage`、`reasoning_content`(separated 模式)。

**knowledge-retrieval**(`knowledge-retrieval`)
- data:`query_variable_selector`、`query_attachment_selector`、`dataset_ids`、
  `retrieval_mode`(`single`/`multiple`)、`multiple_retrieval_config`(top_k、
  score_threshold、reranking_mode、reranking_enable、reranking_model、weights)、
  `single_retrieval_config{model}`、`metadata_filtering_mode`、`metadata_model_config`、
  `metadata_filtering_conditions`、`vision`。
- 输出变量:`result`(检索片段数组)、`context`。

**question-classifier**(`question-classifier`)
- data:`query_variable_selector`、`model`、`classes: [{id, name, label}]`、`instruction`、
  `memory`、`vision`。
- 输出变量:`class_name`、`class_label`、`class_id`;每个 `class.id` 同时是一个出边 handle。

**parameter-extractor**(`parameter-extractor`,透传)
- data:`model`、`query: [selector]`、`parameters: [{name, type, options, description, required}]`、
  `instruction`、`memory`、`reasoning_mode`(`function_call`/`prompt`)、`vision`。
- 输出变量 = 各 `parameter.name`(另有内部保留 `__is_success`/`__reason`)。

**template-transform**(`template-transform`)
- data:`variables: [{variable, value_selector}]`、`template: string`。
- 输出变量:`output`。

**agent**(`agent`,透传)
- data:`agent_strategy_provider_name`、`agent_strategy_name`、`agent_strategy_label`、
  `memory`、`tool_node_version`、`agent_parameters: {name: {value, type}}`。
- 输出变量:`text`(及策略定义输出)。

### 2.3 控制流

**if-else**(`if-else`)
- data:`logical_operator`(legacy)、`cases: [{case_id, logical_operator, conditions}]`、
  `conditions`(legacy 扁平形态)。
- `Condition`:`variable_selector`、`comparison_operator`(contains/start with/=/≠/>/</
  ≥/≤/empty/not empty/in/not in/exists… 见 `graphon.utils.condition`)、`value`、
  `sub_variable_condition`、以及前端附加的 `id`/`varType`(原样保留)。
- 每个 `case_id` 是出边 handle(如 `true`/`false`);旧单条件结构用 `true` 分支。

**question-classifier / if-else** 均为分支节点(NodeExecutionType.BRANCH),出边 handle = 分支 id。

### 2.4 容器节点

**iteration**(`iteration`)
- data:`start_node_id`、`parent_loop_id`、`iterator_selector`、`output_selector`、
  `is_parallel`、`parallel_nums`、`error_handle_mode`(`terminated`/`continue-on-error`/
  `remove-abnormal-output`)、`flatten_output`。
- 子图入口节点为 `iteration-start`(独立节点,id 由 `start_node_id` 关联)。
- 输出变量 = `output_selector` 指向的聚合结果。

**iteration-start**(`iteration-start`,透传):data 仅 `type`。

**loop**(`loop`,透传)
- data:`start_node_id`、`loop_count`、`break_conditions: [Condition]`、`logical_operator`、
  `loop_variables: [{label, var_type, value_type, value}]`、`outputs`。
- 子图为 `loop-start` → … → `loop-end`。

**loop-start / loop-end**(透传):data 仅 `type`。

### 2.5 工具 / 数据 / 变量

**tool**(`tool`)
- data:`provider_id`、`provider_type`、`provider_name`、`tool_name`、`tool_label`、
  `tool_configurations`、`credential_id`、`plugin_unique_identifier`、
  `tool_parameters: {name: {value, type}}`(type=`mixed`/`variable`/`constant`)、
  `tool_node_version`。
- 输出变量 = 工具定义的输出。

**http-request**(`http-request`)
- data:`method`(get/post/…)、`url`、`authorization{type: no-auth|api-key, config{type:
  basic|bearer|custom, api_key, header}}`、`headers`、`params`、`body{type: none|form-data|
  x-www-form-urlencoded|raw-text|json|binary, data}`、`timeout{connect,read,write}`、`ssl_verify`。
- 输出变量:`body`、`status_code`、`headers`、`files`。

**datasource**(`datasource`,透传)
- data:`plugin_id`、`provider_name`、`provider_type`、`datasource_name`、
  `datasource_configurations`、`plugin_unique_identifier`、
  `datasource_parameters: {name: {value, type}}`。
- 输出变量 = 数据源 provider 定义(文件等)。

**variable-aggregator**(`variable-aggregator`)
- data:`output_type`、`variables: [[selector…]]`、`advanced_settings{group_enabled,
  groups: [{output_type, variables, group_name}]}`。
- 输出变量:聚合结果(多路变量合流,常用于多分支汇合)。

**assigner**(`assigner`,透传,即 v2 变量赋值)
- data:`version: "2"`、`items: [{variable_selector, input_type: variable|constant,
  operation: over-write|clear|append|extend|set|+=|-=|*=|/=|remove-first|remove-last, value}]`。

**variable-assigner**(`variable-assigner`,透传,legacy):旧版变量赋值节点,结构随版本迁移。

**list-operator**(`list-operator`,透传)
- data:`variable: [selector]`、`filter_by{enabled, conditions}`、`order_by{enabled, key,
  value: asc|desc}`、`limit{enabled, size}`、`extract_by{enabled, serial}`。
- 输出变量:`result`。

**document-extractor**(`document-extractor`,透传)
- data:`variable_selector: [selector]`。
- 输出变量:`text`(提取的文档文本)。

**human-input**(`human-input`,透传)
- data:仅 BaseNodeData(`type`)。运行时暂停等待人工输入(HITL),出边 handle = 用户选择的选项。

### 2.6 触发器(workflow 入口)

**trigger-schedule**(`trigger-schedule`,透传)
- data:`mode`(`visual`/`cron`)、`frequency`(`hourly`/`daily`/`weekly`/`monthly`)、
  `cron_expression`、`visual_config`、`timezone`。

**trigger-webhook**(`trigger-webhook`,透传)
- data:`method`、`content_type`、`headers: [{name, type, required}]`、`params`(查询参数)、
  `body: [{name, type, required}]`、`status_code`、`response_body`、`webhook_id`、`timeout`。

**trigger-plugin**(`trigger-plugin`,透传)
- data:`plugin_id`、`provider_id`、`event_name`、`subscription_id`、
  `plugin_unique_identifier`、`event_parameters: {name: {value, type}}`。

## 3. 默认画布尺寸(自动布局估算)

`scripts/ir_to_dsl.mjs` 的 `DEFAULT_NODE_DIMENSIONS` 用于自动布局时的占位尺寸:

| 节点 | 宽 × 高(px) |
|---|---|
| 默认(多数节点) | 244 × 90 |
| `if-else` / `question-classifier` | 244 × 126 |

round-trip 路径使用节点自带的 `width`/`height`,不用默认值。

## 4. 覆盖核对

- 内置节点:25 个(BuiltinNodeTypes:start/end/answer/llm/knowledge-retrieval/if-else/code/
  template-transform/question-classifier/http-request/tool/datasource/variable-aggregator/
  variable-assigner/loop/loop-start/loop-end/iteration/iteration-start/parameter-extractor/
  assigner/document-extractor/list-operator/agent/human-input)。
- 触发器:3 个(trigger-schedule/trigger-webhook/trigger-plugin)。
- 合计 **28** 个,与 `DSL_NODE_TYPES` 白名单一致。
