/**
 * ir_to_dsl.mjs — IR(中间表示)→ Dify 1.16.1 DSL YAML(version 0.7.0)。
 *
 * 职责(适配层核心):
 *   - 保真回填:round-trip 路径(所有节点已带 position)必须逐字段原样还原,不得重排。
 *   - 自动布局:节点缺 position 或显式要求时,按拓扑分层(列 = 最长路径深度)+ 列内纵向排布,
 *     节点尺寸按 node-catalog 默认宽高估算,避免重叠。
 *   - 默认值填充:features / app 图标 / 信封字段由适配层管理,Agent 不手写。
 *   - position 与 positionAbsolute 恒为同值(Agent 改 position 即整体移动节点)。
 *
 * 用法:
 *   node scripts/ir_to_dsl.mjs <ir.json> [out.yml] [--force-layout]
 *
 * 模块导出:
 *   irToDsl(irObject, options?) -> dslObject
 *   DEFAULT_FEATURES / DEFAULT_NODE_DIMENSIONS 等常量
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  deepClone,
  irTypeToDslType,
  DSL_VERSION,
  DSL_NODE_TYPES,
} from "./dsl_to_ir.mjs";

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/** features 默认值(与 1.16.1 官方导出样例一致,适配层管,Agent 不手写)。 */
export const DEFAULT_FEATURES = Object.freeze({
  file_upload: {
    allowed_file_extensions: [".JPG", ".JPEG", ".PNG", ".GIF", ".WEBP", ".SVG"],
    allowed_file_types: ["image"],
    allowed_file_upload_methods: ["local_file", "remote_url"],
    enabled: false,
    fileUploadConfig: {
      audio_file_size_limit: 50,
      batch_count_limit: 5,
      file_size_limit: 15,
      image_file_size_limit: 10,
      video_file_size_limit: 100,
      workflow_file_upload_limit: 10,
    },
    image: {
      enabled: false,
      number_limits: 3,
      transfer_methods: ["local_file", "remote_url"],
    },
    number_limits: 3,
  },
  opening_statement: "",
  retriever_resource: { enabled: true },
  sensitive_word_avoidance: { enabled: false },
  speech_to_text: { enabled: false },
  suggested_questions: [],
  suggested_questions_after_answer: { enabled: false },
  text_to_speech: { enabled: false, language: "", voice: "" },
});

/**
 * 节点默认宽高估算(key 为 IR 语义类型或 DSL type 字符串),单位 px。
 * 与 node-catalog.md「默认画布尺寸」一节保持一致。
 */
export const DEFAULT_NODE_DIMENSIONS = Object.freeze({
  start: [244, 90],
  end: [244, 90],
  answer: [244, 90],
  llm: [244, 90],
  code: [244, 90],
  http: [244, 90],
  tool: [244, 90],
  knowledge_retrieval: [244, 90],
  template_transform: [244, 90],
  variable_aggregator: [244, 90],
  iteration: [244, 90],
  question_classifier: [244, 126],
  if_else: [244, 126],
});

const DEFAULT_WIDTH = 244;
const DEFAULT_HEIGHT = 90;
const COLUMN_GAP_X = 60;
const ROW_GAP_Y = 40;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nodeDefaultSize(node) {
  const dims = DEFAULT_NODE_DIMENSIONS[node?.type] ?? DEFAULT_NODE_DIMENSIONS[node?.data?.type];
  return { width: dims?.[0] ?? DEFAULT_WIDTH, height: dims?.[1] ?? DEFAULT_HEIGHT };
}

function nodeSize(node) {
  const canvas = isPlainObject(node?.canvas) ? node.canvas : {};
  const width = typeof canvas.width === "number" ? canvas.width : nodeDefaultSize(node).width;
  const height = typeof canvas.height === "number" ? canvas.height : nodeDefaultSize(node).height;
  return { width, height };
}

function hasValidPosition(node) {
  const p = node?.position;
  return isPlainObject(p) && typeof p.x === "number" && typeof p.y === "number";
}

// ---------------------------------------------------------------------------
// 自动布局:拓扑分层(列 = 最长路径深度)+ 列内纵向排布
// ---------------------------------------------------------------------------

function autoLayout(nodes, edges) {
  const ids = nodes.map((n) => n.id).filter((id) => id !== undefined);
  const adjacency = new Map(ids.map((id) => [id, []]));
  const inDegree = new Map(ids.map((id) => [id, 0]));

  for (const e of edges ?? []) {
    const s = e?.source?.node;
    const t = e?.target?.node;
    if (s && t && adjacency.has(s) && adjacency.has(t)) {
      adjacency.get(s).push(t);
      inDegree.set(t, inDegree.get(t) + 1);
    }
  }

  // Kahn 拓扑 + 最长路径深度(列号)
  const depth = new Map(ids.map((id) => [id, 0]));
  const remaining = new Map(inDegree);
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const nb of adjacency.get(id)) {
      depth.set(nb, Math.max(depth.get(nb) ?? 0, (depth.get(id) ?? 0) + 1));
      remaining.set(nb, remaining.get(nb) - 1);
      if (remaining.get(nb) === 0) queue.push(nb);
    }
  }
  // 环内节点未入队:其 depth 已在入边放宽时更新为可达深度,保持即可。

  // 按列分组
  const columns = new Map(); // depth -> node[]
  let maxDepth = 0;
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    maxDepth = Math.max(maxDepth, d);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }

  // 每列宽度 = 该列最大节点宽
  const colWidth = new Map();
  for (const [d, list] of columns) {
    let w = DEFAULT_WIDTH;
    for (const n of list) w = Math.max(w, nodeSize(n).width);
    colWidth.set(d, w);
  }

  // 累计列 x 起点
  const xOffset = new Map();
  let accX = 0;
  for (let d = 0; d <= maxDepth; d++) {
    xOffset.set(d, accX);
    accX += (colWidth.get(d) ?? DEFAULT_WIDTH) + COLUMN_GAP_X;
  }

  // 列内纵向排布,避免重叠
  for (let d = 0; d <= maxDepth; d++) {
    const list = columns.get(d);
    if (!list) continue;
    let y = 0;
    for (const n of list) {
      n.position = { x: xOffset.get(d), y };
      y += nodeSize(n).height + ROW_GAP_Y;
    }
  }
}

function layoutNodes(irNodes, irEdges, options) {
  const nodes = deepClone(irNodes ?? []);
  const allPositioned = nodes.length > 0 && nodes.every(hasValidPosition);
  if (options.forceLayout || !allPositioned) {
    autoLayout(nodes, irEdges);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// 节点 / 边重建(按 DSL 0.7.0 官方 key 顺序)
// ---------------------------------------------------------------------------

function buildDslNode(irNode) {
  const data = isPlainObject(irNode.data) ? deepClone(irNode.data) : irNode.data ?? {};
  // 语义标题/类型同步回 DSL data(round-trip 时值不变,保真)
  if (irNode.title !== undefined && isPlainObject(data)) {
    data.title = irNode.title;
  }
  if (isPlainObject(data) && data.type === undefined && irNode.type !== undefined) {
    data.type = irTypeToDslType(irNode.type);
  }

  const canvas = isPlainObject(irNode.canvas) ? irNode.canvas : {};
  const size = nodeSize(irNode);
  const pos = hasValidPosition(irNode) ? irNode.position : (canvas.positionAbsolute ?? { x: 0, y: 0 });
  const x = typeof pos?.x === "number" ? pos.x : 0;
  const y = typeof pos?.y === "number" ? pos.y : 0;

  const node = {
    data,
    height: canvas.height ?? size.height,
    id: irNode.id,
    position: { x, y },
    positionAbsolute: { x, y }, // 与 position 同值
    selected: canvas.selected ?? false,
    sourcePosition: canvas.sourcePosition ?? "right",
    targetPosition: canvas.targetPosition ?? "left",
    type: "custom",
    width: canvas.width ?? size.width,
  };
  // 保真:canvas 中的未知字段原样追加(不在上表键内)
  for (const k of Object.keys(canvas)) {
    if (!(k in node)) node[k] = canvas[k];
  }
  return node;
}

function buildDslEdge(irEdge, nodeTypeMap) {
  let data = irEdge.data;
  if (data === undefined) {
    // 手工 IR 无 data 时,按官方导出补默认(round-trip 有 data,走原样分支)
    const sourceType = nodeTypeMap?.get(irEdge.source?.node);
    const targetType = nodeTypeMap?.get(irEdge.target?.node);
    data = {
      isInIteration: false,
      isInLoop: false,
      ...(sourceType !== undefined ? { sourceType } : {}),
      ...(targetType !== undefined ? { targetType } : {}),
    };
  }
  const edge = {
    data,
    id: irEdge.id,
    source: irEdge.source?.node,
    sourceHandle: irEdge.source?.handle,
    target: irEdge.target?.node,
    targetHandle: irEdge.target?.handle,
    type: irEdge.type ?? "custom",
    zIndex: irEdge.zIndex,
  };
  // 保真:IR 边的未知字段原样追加
  for (const k of Object.keys(irEdge)) {
    if (k !== "source" && k !== "target" && !(k in edge)) edge[k] = irEdge[k];
  }
  return edge;
}

// ---------------------------------------------------------------------------
// app 信封
// ---------------------------------------------------------------------------

function buildApp(ir, meta) {
  let app;
  if (isPlainObject(ir.app)) {
    // round-trip 路径:原样保留(含 key 顺序),仅覆盖语义投影字段的值
    app = deepClone(ir.app);
    if (meta.name !== undefined) app.name = meta.name;
    if (meta.description !== undefined) app.description = meta.description;
    if (meta.mode !== undefined) app.mode = meta.mode;
    if (app.name === undefined) app.name = "Untitled";
    if (app.description === undefined) app.description = "";
    if (app.mode === undefined) app.mode = "workflow";
    if (app.icon === undefined) app.icon = "🤖";
    if (app.icon_background === undefined) app.icon_background = "#FFEAD5";
    if (app.icon_type === undefined) app.icon_type = "emoji";
    if (app.use_icon_as_answer_icon === undefined) app.use_icon_as_answer_icon = false;
  } else {
    // 手工 IR:按官方 key 顺序构造
    app = {
      description: meta.description ?? "",
      icon: "🤖",
      icon_background: "#FFEAD5",
      icon_type: "emoji",
      mode: meta.mode ?? "workflow",
      name: meta.name ?? "Untitled",
      use_icon_as_answer_icon: false,
    };
  }
  return app;
}

// ---------------------------------------------------------------------------
// IR → DSL
// ---------------------------------------------------------------------------

/**
 * IR 对象 → DSL 对象。
 * @param {object} ir IR 对象。
 * @param {{forceLayout?: boolean}} options forceLayout=true 时强制自动布局。
 * @returns {object} DSL 对象(可直接 YAML.stringify)。
 */
export function irToDsl(ir, options = {}) {
  const meta = isPlainObject(ir?.meta) ? ir.meta : {};
  const app = buildApp(ir ?? {}, meta);

  const laidOutNodes = layoutNodes(ir?.nodes, ir?.edges, options);
  // 节点 id → DSL type,用于给缺 data 的边补 sourceType/targetType
  const nodeTypeMap = new Map();
  for (const n of laidOutNodes) {
    const dt = isPlainObject(n?.data) ? n.data.type : undefined;
    if (dt !== undefined) nodeTypeMap.set(n.id, dt);
  }
  const nodes = laidOutNodes.map(buildDslNode);
  const edges = (ir?.edges ?? []).map((e) => buildDslEdge(e, nodeTypeMap));

  const features =
    isPlainObject(ir?.features) && Object.keys(ir.features).length > 0
      ? deepClone(ir.features)
      : deepClone(DEFAULT_FEATURES);

  const viewport = isPlainObject(ir?.viewport)
    ? deepClone(ir.viewport)
    : { x: 0, y: 0, zoom: 1 };

  const workflow = {
    conversation_variables: Array.isArray(ir?.conversation_variables)
      ? deepClone(ir.conversation_variables)
      : [],
    environment_variables: Array.isArray(ir?.environment_variables)
      ? deepClone(ir.environment_variables)
      : [],
    features,
    graph: {
      edges,
      nodes,
      viewport,
    },
    rag_pipeline_variables: Array.isArray(ir?.rag_pipeline_variables)
      ? deepClone(ir.rag_pipeline_variables)
      : [],
  };

  return {
    app,
    dependencies: Array.isArray(ir?.dependencies) ? deepClone(ir.dependencies) : [],
    kind: ir?.kind ?? "app",
    version: ir?.version ?? DSL_VERSION,
    workflow,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith("-"));
  if (!inputPath) {
    console.error("用法: node scripts/ir_to_dsl.mjs <ir.json> [out.yml] [--force-layout]");
    process.exit(2);
  }
  const forceLayout = args.includes("--force-layout");
  const text = readFileSync(inputPath, "utf8");
  const ir = JSON.parse(text);
  const dsl = irToDsl(ir, { forceLayout });
  const yamlText = YAML.stringify(dsl);
  const outPath = args.find((a) => a !== inputPath && !a.startsWith("-"));
  if (outPath) {
    writeFileSync(outPath, yamlText, "utf8");
    console.log(`已写入 ${outPath}`);
  } else {
    console.log(yamlText);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
