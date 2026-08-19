/**
 * dsl_to_ir.mjs — Dify 1.16.1 DSL YAML(version 0.7.0)→ IR(中间表示)。
 *
 * 设计原则(见 DESIGN.md §6 与 SKILL.md):
 *   - IR 与 Dify 版本无关;本文件是"版本防波堤"中 DSL 侧唯一的入口。
 *   - 保真优先:节点 `data` 完整原样保留(它是节点语义配置,未知键也必须保留);
 *     节点画布字段(height/width/sourcePosition/targetPosition/positionAbsolute/selected)
 *     拆到 IR 节点的 `canvas`;边 `data`/`type`/`zIndex` 原样保留到 IR 边。
 *   - IR 节点 `type` 是语义类型;DSL type 字符串仍保存在 `node.data.type` 中,保证无损往返。
 *
 * 用法:
 *   node scripts/dsl_to_ir.mjs <dsl.yml> [out.json]     # CLI:读 YAML,写 IR JSON(stdout 缺省)
 *
 * 模块导出:
 *   dslToIr(dslObject) -> irObject
 *   DSL_TYPE_TO_IR_TYPE / IR_TYPE_TO_DSL_TYPE / NODE_TYPE_WHITELIST 等常量
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// 节点类型映射:DSL type 字符串(0.7.0)<-> IR 语义类型
// ---------------------------------------------------------------------------

/**
 * DSL type 字符串 → IR 语义类型。
 * 未出现在此表的 DSL type(如 parameter-extractor、datasource、loop 家族、trigger 家族等)
 * 在 IR 中**原样透传**,保证往返无损;它们的语义在 node-catalog.md 中逐步补充。
 */
export const DSL_TYPE_TO_IR_TYPE = Object.freeze({
  start: "start",
  end: "end",
  llm: "llm",
  answer: "answer",
  "knowledge-retrieval": "knowledge_retrieval",
  "question-classifier": "question_classifier",
  "if-else": "if_else",
  code: "code",
  "http-request": "http",
  tool: "tool",
  iteration: "iteration",
  "variable-aggregator": "variable_aggregator",
  "template-transform": "template_transform",
});

/** IR 语义类型 → DSL type 字符串(仅含 IR 一侧声明的 13 个语义类型)。 */
export const IR_TYPE_TO_DSL_TYPE = Object.freeze({
  start: "start",
  end: "end",
  llm: "llm",
  answer: "answer",
  knowledge_retrieval: "knowledge-retrieval",
  question_classifier: "question-classifier",
  if_else: "if-else",
  code: "code",
  http: "http-request",
  tool: "tool",
  iteration: "iteration",
  variable_aggregator: "variable-aggregator",
  template_transform: "template-transform",
});

/** IR 语义节点类型全集(DESIGN.md §6)。 */
export const IR_NODE_TYPES = Object.freeze(Object.keys(IR_TYPE_TO_DSL_TYPE));

/**
 * DSL 1.16.1 节点 type 白名单(25 内置 + 3 trigger = 28)。
 * 来自 graphon 0.6.0 `BuiltinNodeTypes` + core.trigger.constants(M0 实测)。
 */
export const DSL_NODE_TYPES = Object.freeze([
  "start",
  "end",
  "answer",
  "llm",
  "knowledge-retrieval",
  "if-else",
  "code",
  "template-transform",
  "question-classifier",
  "http-request",
  "tool",
  "datasource",
  "variable-aggregator",
  "variable-assigner", // legacy
  "loop",
  "loop-start",
  "loop-end",
  "iteration",
  "iteration-start",
  "parameter-extractor",
  "assigner",
  "document-extractor",
  "list-operator",
  "agent",
  "human-input",
  "trigger-schedule",
  "trigger-webhook",
  "trigger-plugin",
]);

export const DSL_VERSION = "0.7.0";
export const IR_VERSION = "1.0";

/** 从 DSL type 字符串映射到 IR 语义类型;未知类型原样透传。 */
export function dslTypeToIrType(dslType) {
  if (typeof dslType !== "string") return dslType ?? null;
  return DSL_TYPE_TO_IR_TYPE[dslType] ?? dslType;
}

/** 从 IR 语义类型映射回 DSL type;未知类型原样透传。 */
export function irTypeToDslType(irType) {
  if (typeof irType !== "string") return irType ?? null;
  return IR_TYPE_TO_DSL_TYPE[irType] ?? irType;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 结构化深拷贝(JSON 可序列化对象)。 */
export function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// DSL → IR
// ---------------------------------------------------------------------------

/**
 * 将单个 DSL 节点拆为 IR 节点:
 *   - 外层字段除 {id, type, data, position} 外全部进入 `canvas`(保真)。
 *   - `data` 深拷贝原样保留;`data.type` 用于派生 IR 语义 `type`。
 *   - `position` 提升为 IR 顶层 `position{x,y}`(Agent 可改)。
 */
function convertNode(dslNode) {
  const { id, type: _outerType, data, position, ...canvas } = dslNode ?? {};
  const rawData = isPlainObject(data) ? deepClone(data) : data;
  const dslType = isPlainObject(rawData) ? rawData.type : undefined;
  const irType = dslTypeToIrType(dslType);
  const node = {
    id,
    type: irType,
    title: isPlainObject(rawData) ? rawData.title : undefined,
    position: isPlainObject(position)
      ? { x: position.x ?? 0, y: position.y ?? 0 }
      : (canvas.positionAbsolute ?? { x: 0, y: 0 }),
    data: rawData,
    canvas: deepClone(canvas),
  };
  // 清理无意义的 undefined 字段,保持 IR 干净(不影响 DSL 往返,因为 data/canvas 已完整保留)
  if (node.title === undefined) delete node.title;
  return node;
}

/** 将单个 DSL 边拆为 IR 边(保留 data/type/zIndex 及一切未知字段)。 */
function convertEdge(dslEdge) {
  const { source, sourceHandle, target, targetHandle, ...rest } = dslEdge ?? {};
  return {
    ...deepClone(rest), // 先铺开 id/type/zIndex/data 等未知字段
    source: { node: source, handle: sourceHandle },
    target: { node: target, handle: targetHandle },
  };
}

/**
 * 尽力从运行时变量派生 IR `variables` 视图(逻辑名 → {type, source})。
 * 仅作语义视图,ir_to_dsl 回填时**不使用**它,而是用 IR 顶层原样保留的
 * conversation_variables / environment_variables,故不影响 round-trip。
 */
function deriveVariables(conversationVariables, environmentVariables) {
  const out = {};
  for (const v of conversationVariables ?? []) {
    if (isPlainObject(v) && typeof v.name === "string" && v.name) {
      out[v.name] = { type: "string", source: "conversation" };
    }
  }
  for (const v of environmentVariables ?? []) {
    if (isPlainObject(v) && typeof v.name === "string" && v.name) {
      out[v.name] = { type: "string", source: "environment" };
    }
  }
  return out;
}

/**
 * DSL 对象 → IR 对象。
 * @param {object} dsl 已解析的 DSL YAML 对象(顶层含 app/kind/version/workflow)。
 * @returns {object} IR 对象。
 */
export function dslToIr(dsl) {
  const app = isPlainObject(dsl?.app) ? dsl.app : {};
  const workflow = isPlainObject(dsl?.workflow) ? dsl.workflow : {};
  const graph = isPlainObject(workflow.graph) ? workflow.graph : {};

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(convertNode) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.map(convertEdge) : [];

  return {
    irVersion: IR_VERSION,
    meta: {
      name: app.name ?? "",
      description: app.description ?? "",
      mode: app.mode ?? "workflow",
    },
    // DSL 信封原样保留(保真往返)
    app: deepClone(app),
    kind: dsl?.kind ?? "app",
    version: dsl?.version ?? DSL_VERSION,
    dependencies: Array.isArray(dsl?.dependencies) ? deepClone(dsl.dependencies) : [],
    features: isPlainObject(workflow.features) ? deepClone(workflow.features) : {},
    conversation_variables: Array.isArray(workflow.conversation_variables)
      ? deepClone(workflow.conversation_variables)
      : [],
    environment_variables: Array.isArray(workflow.environment_variables)
      ? deepClone(workflow.environment_variables)
      : [],
    rag_pipeline_variables: Array.isArray(workflow.rag_pipeline_variables)
      ? deepClone(workflow.rag_pipeline_variables)
      : [],
    viewport: isPlainObject(graph.viewport) ? deepClone(graph.viewport) : { x: 0, y: 0, zoom: 1 },
    // 结构语义视图
    variables: deriveVariables(workflow.conversation_variables, workflow.environment_variables),
    nodes,
    edges,
    bindings: [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith("-"));
  if (!inputPath) {
    console.error("用法: node scripts/dsl_to_ir.mjs <dsl.yml> [out.json]");
    process.exit(2);
  }
  const text = readFileSync(inputPath, "utf8");
  const dsl = YAML.parse(text);
  const ir = dslToIr(dsl);
  const outPath = args.find((a) => a !== inputPath && !a.startsWith("-"));
  const json = JSON.stringify(ir, null, 2);
  if (outPath) {
    writeFileSync(outPath, json + "\n", "utf8");
    console.log(`已写入 ${outPath}`);
  } else {
    console.log(json);
  }
}

// CLI 入口(仅当本文件被直接执行时)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
