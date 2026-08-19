/**
 * validate.mjs — IR / DSL 结构校验。
 *
 * 校验范围(不校验语义正确性,只校验"能否安全进入适配层"):
 *   - 结构:顶层必填字段、nodes/edges 数组、节点/边 id 唯一性。
 *   - 节点类型白名单:DSL 节点 data.type 必须 ∈ DSL_NODE_TYPES(1.16.1 全集);
 *     IR 节点 type 必须为已知语义类型或合法 DSL type 字符串(透传)。
 *   - 边端点存在性:边的 source/target 必须指向已声明节点。
 *   - 必填字段:meta.name(IR)/app.name(DSL)、mode 取值。
 *
 * 用法:
 *   node scripts/validate.mjs <file.json|file.yml>     # 自动判断 IR / DSL 并校验
 *   node scripts/validate.mjs --selftest               # 内置好/坏样例自测
 *
 * 模块导出:
 *   validateIr(ir) -> {valid, errors[], warnings[]}
 *   validateDsl(dsl) -> {valid, errors[], warnings[]}
 *   validate(value)  -> 自动判断类型后返回同构结果
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  DSL_NODE_TYPES,
  IR_NODE_TYPES,
  IR_VERSION,
  DSL_VERSION,
  irTypeToDslType,
} from "./dsl_to_ir.mjs";

const ALLOWED_MODES = new Set(["workflow", "advanced-chat", "agent", "chat", "rag-pipeline"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/** 收集器:累积错误与警告。 */
function makeReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(msg) {
      errors.push(msg);
    },
    warn(msg) {
      warnings.push(msg);
    },
    result() {
      return { valid: errors.length === 0, errors, warnings };
    },
  };
}

// ---------------------------------------------------------------------------
// 通用:节点/边结构
// ---------------------------------------------------------------------------

function checkGraphish(report, nodes, edges, opts) {
  const { isDsl } = opts;
  if (!Array.isArray(nodes)) {
    report.error(isDsl ? "workflow.graph.nodes 必须是数组" : "nodes 必须是数组");
    return;
  }
  if (!Array.isArray(edges)) {
    report.error(isDsl ? "workflow.graph.edges 必须是数组" : "edges 必须是数组");
    return;
  }

  const nodeIds = new Set();
  const dslTypeSet = new Set(DSL_NODE_TYPES);
  const irTypeSet = new Set(IR_NODE_TYPES);

  for (const [i, n] of nodes.entries()) {
    const where = `nodes[${i}]`;
    if (!isPlainObject(n)) {
      report.error(`${where} 不是对象`);
      continue;
    }
    if (!isNonEmptyString(n.id)) {
      report.error(`${where}.id 缺失或为空`);
    } else if (nodeIds.has(n.id)) {
      report.error(`${where}.id 重复:${n.id}`);
    } else {
      nodeIds.add(n.id);
    }

    if (isDsl) {
      // DSL 节点:data.type 必须存在且在白名单
      if (!isPlainObject(n.data)) {
        report.error(`${where}.data 缺失或非对象`);
      } else if (!isNonEmptyString(n.data.type)) {
        report.error(`${where}.data.type 缺失`);
      } else if (!dslTypeSet.has(n.data.type)) {
        report.error(`${where}.data.type 非法:${n.data.type}(不在 1.16.1 节点白名单)`);
      }
    } else {
      // IR 节点:type 为语义类型或合法 DSL type 透传
      if (!isNonEmptyString(n.type)) {
        report.error(`${where}.type 缺失`);
      } else {
        const dslType = irTypeToDslType(n.type);
        if (!irTypeSet.has(n.type) && !dslTypeSet.has(dslType) && !dslTypeSet.has(n.type)) {
          report.warn(`${where}.type 未知语义类型:${n.type}(将按 DSL type 透传,请确认)`);
        }
      }
      if (n.data !== undefined && !isPlainObject(n.data)) {
        report.error(`${where}.data 应为对象(节点语义配置)`);
      }
    }
  }

  const edgeIds = new Set();
  for (const [i, e] of edges.entries()) {
    const where = `edges[${i}]`;
    if (!isPlainObject(e)) {
      report.error(`${where} 不是对象`);
      continue;
    }
    if (!isNonEmptyString(e.id)) {
      report.warn(`${where}.id 缺失(建议提供唯一 id)`);
    } else if (edgeIds.has(e.id)) {
      report.error(`${where}.id 重复:${e.id}`);
    } else {
      edgeIds.add(e.id);
    }

    const sourceNode = isDsl ? e.source : e.source?.node;
    const targetNode = isDsl ? e.target : e.target?.node;
    if (!isNonEmptyString(sourceNode)) {
      report.error(`${where} 缺少 source 节点引用`);
    } else if (!nodeIds.has(sourceNode)) {
      report.error(`${where}.source 指向不存在的节点:${sourceNode}`);
    }
    if (!isNonEmptyString(targetNode)) {
      report.error(`${where} 缺少 target 节点引用`);
    } else if (!nodeIds.has(targetNode)) {
      report.error(`${where}.target 指向不存在的节点:${targetNode}`);
    }
  }
}

// ---------------------------------------------------------------------------
// IR 校验
// ---------------------------------------------------------------------------

export function validateIr(ir) {
  const report = makeReport();
  if (!isPlainObject(ir)) {
    report.error("IR 顶层必须是对象");
    return report.result();
  }
  if (ir.irVersion !== IR_VERSION) {
    report.warn(`irVersion 期望 "${IR_VERSION}",实际 ${JSON.stringify(ir.irVersion)}`);
  }
  if (!isPlainObject(ir.meta)) {
    report.error("meta 缺失");
  } else {
    if (!isNonEmptyString(ir.meta.name)) report.error("meta.name 缺失或为空");
    if (ir.meta.mode !== undefined && !ALLOWED_MODES.has(ir.meta.mode)) {
      report.error(`meta.mode 非法:${ir.meta.mode}`);
    }
  }
  if (ir.nodes === undefined) report.error("nodes 缺失");
  if (ir.edges === undefined) report.error("edges 缺失");
  if (ir.bindings !== undefined && !Array.isArray(ir.bindings)) {
    report.error("bindings 必须是数组");
  }
  checkGraphish(report, ir.nodes, ir.edges, { isDsl: false });
  return report.result();
}

// ---------------------------------------------------------------------------
// DSL 校验
// ---------------------------------------------------------------------------

export function validateDsl(dsl) {
  const report = makeReport();
  if (!isPlainObject(dsl)) {
    report.error("DSL 顶层必须是对象");
    return report.result();
  }
  if (!isPlainObject(dsl.app)) {
    report.error("app 缺失");
  } else {
    if (!isNonEmptyString(dsl.app.name)) report.error("app.name 缺失或为空");
    if (dsl.app.mode !== undefined && !ALLOWED_MODES.has(dsl.app.mode)) {
      report.error(`app.mode 非法:${dsl.app.mode}`);
    }
  }
  if (dsl.version === undefined) {
    report.warn(`version 缺失(1.16.1 期望 ${DSL_VERSION})`);
  } else if (dsl.version !== DSL_VERSION) {
    report.warn(`version 期望 ${DSL_VERSION},实际 ${dsl.version}(可能触发自动迁移)`);
  }
  if (dsl.kind !== undefined && dsl.kind !== "app") {
    report.warn(`kind 期望 "app",实际 ${JSON.stringify(dsl.kind)}`);
  }
  const workflow = dsl.workflow;
  if (!isPlainObject(workflow)) {
    report.error("workflow 缺失");
    return report.result();
  }
  if (!isPlainObject(workflow.graph)) {
    report.error("workflow.graph 缺失");
    return report.result();
  }
  checkGraphish(report, workflow.graph.nodes, workflow.graph.edges, { isDsl: true });
  return report.result();
}

/** 自动判断 IR / DSL 并校验。 */
export function validate(value) {
  if (isPlainObject(value) && typeof value.irVersion === "string" && value.workflow === undefined) {
    return validateIr(value);
  }
  return validateDsl(value);
}

/**
 * 校验「裸 graph 对象」({nodes, edges, viewport?},modify 模式 graph.json 的形态)。
 * 包一层临时 DSL 壳复用 validateDsl 的 graph 检查。
 */
export function validateGraph(graph) {
  if (!isPlainObject(graph)) {
    return { valid: false, errors: ["graph 必须是对象"], warnings: [] };
  }
  const shell = {
    app: { name: "x", mode: "workflow" },
    kind: "app",
    version: DSL_VERSION,
    workflow: { graph, features: {} },
  };
  return validateDsl(shell);
}

// ---------------------------------------------------------------------------
// 内置自测样例
// ---------------------------------------------------------------------------

function sampleGoodIr() {
  return {
    irVersion: "1.0",
    meta: { name: "三节点分支", description: "自测", mode: "workflow" },
    nodes: [
      { id: "start", type: "start", title: "Start", position: { x: 0, y: 0 }, data: { type: "start", title: "Start", variables: [] } },
      { id: "branch", type: "if_else", title: "IF/ELSE", position: { x: 300, y: 0 }, data: { type: "if-else", title: "IF/ELSE", cases: [] } },
      { id: "end", type: "end", title: "End", position: { x: 600, y: 0 }, data: { type: "end", title: "End", outputs: [] } },
    ],
    edges: [
      { id: "e1", source: { node: "start", handle: "source" }, target: { node: "branch", handle: "target" } },
      { id: "e2", source: { node: "branch", handle: "true" }, target: { node: "end", handle: "target" } },
    ],
    bindings: [],
  };
}

function sampleBadIr() {
  const ir = sampleGoodIr();
  ir.edges.push({ id: "e3", source: { node: "branch", handle: "false" }, target: { node: "ghost", handle: "target" } });
  return ir;
}

function sampleGoodDsl() {
  return {
    app: { description: "", icon: "🤖", icon_background: "#FFEAD5", mode: "workflow", name: "echo", use_icon_as_answer_icon: false },
    dependencies: [],
    kind: "app",
    version: "0.7.0",
    workflow: {
      conversation_variables: [],
      environment_variables: [],
      features: {},
      graph: {
        edges: [],
        nodes: [
          { data: { type: "start", title: "Start", variables: [] }, height: 90, id: "start", position: { x: 0, y: 0 }, positionAbsolute: { x: 0, y: 0 }, selected: false, sourcePosition: "right", targetPosition: "left", type: "custom", width: 244 },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      rag_pipeline_variables: [],
    },
  };
}

function sampleBadDsl() {
  const dsl = sampleGoodDsl();
  dsl.workflow.graph.nodes.push({
    data: { type: "made-up-node", title: "Ghost" },
    height: 90,
    id: "ghost",
    position: { x: 0, y: 0 },
    positionAbsolute: { x: 0, y: 0 },
    selected: false,
    sourcePosition: "right",
    targetPosition: "left",
    type: "custom",
    width: 244,
  });
  return dsl;
}

function runSelfTest() {
  const cases = [
    { name: "好 IR", value: sampleGoodIr(), kind: "IR", expectValid: true },
    { name: "坏 IR(边指向不存在节点)", value: sampleBadIr(), kind: "IR", expectValid: false },
    { name: "好 DSL", value: sampleGoodDsl(), kind: "DSL", expectValid: true },
    { name: "坏 DSL(节点 type 不在白名单)", value: sampleBadDsl(), kind: "DSL", expectValid: false },
  ];
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const r = validate(c.value);
    const ok = r.valid === c.expectValid;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  [${c.kind}] ${c.name} -> valid=${r.valid} ${r.valid ? "" : "(" + r.errors.join("; ") + ")"}`);
  }
  console.log(`\n自测结果:${pass} 通过,${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest") || args.length === 0) {
    runSelfTest();
    return;
  }
  const inputPath = args.find((a) => !a.startsWith("-"));
  if (!inputPath) {
    console.error("用法: node scripts/validate.mjs <file.json|file.yml> [--graph] | --selftest");
    process.exit(2);
  }
  const asGraph = args.includes("--graph");
  const text = readFileSync(inputPath, "utf8");
  const value = inputPath.endsWith(".yml") || inputPath.endsWith(".yaml")
    ? YAML.parse(text)
    : JSON.parse(text);
  const r = asGraph ? validateGraph(value) : validate(value);
  console.log(`校验 ${inputPath}:${r.valid ? " 有效 ✅" : " 无效 ❌"}`);
  for (const e of r.errors) console.log(`  [error] ${e}`);
  for (const w of r.warnings) console.log(`  [warn ] ${w}`);
  process.exit(r.valid ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
