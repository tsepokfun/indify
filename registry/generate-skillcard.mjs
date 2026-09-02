#!/usr/bin/env node
/**
 * generate-skillcard.mjs — S1 技能卡反推生成器。
 *
 * 輸入一個 Dify DSL YAML 導出檔案(可選附 app 元數據 JSON),反推產出一張
 * 「技能卡」(skill card)manifest(JSON),以及一份可讀的 Markdown 摘要。
 *
 * 反推規則(對齊 docs/v3-skill-runtime-藍圖.md L1 與 registry/skillcard.schema.json):
 *   - name / description 取 DSL 的 app.name / app.description,缺則用檔名兜底。
 *   - input_schema 從 workflow.graph 的 start 節點 variables 反推(缺則退而用
 *     workflow.environment_variables);類型盡量推斷,缺省 "string"。
 *   - output_schema 從 end 節點 outputs 的 value_selector 目標變數反推,缺省 "string"。
 *   - side_effects 掃全部節點類型判定分級(參考 skills/dify-workflow-dsl/references/dify-1.16/node-catalog.md),
 *     聚合取最高;不確定 → 保守標 "write" 並寫 note。
 *   - verify 預設 how = "workflow run 状态为 succeeded 且 outputs 非空",並對布林式成功欄位做輕量啟發式。
 *
 * 依賴:僅 yaml@2.x(直接引用已安裝於 skills/dify-workflow-dsl/node_modules 的副本,
 *   避免二次安裝;當 registry 未來獨立成包時改為正規 dependency,見 docs/s1-skillcard-adl.md)。
 *
 * 用法:
 *   node registry/generate-skillcard.mjs <dsl.yml> <out-dir> [app-meta.json]
 *
 * 產出(寫入 <out-dir>):
 *   <slug>.skillcard.json   技能卡 manifest(JSON)
 *   <slug>.skillcard.md     可讀摘要(Markdown)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "../skills/dify-workflow-dsl/node_modules/yaml/dist/index.js";

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 副作用分級:依危險程度遞增(聚合取最高)。 */
const TIER_ORDER = Object.freeze({
  none: 0,
  read: 1,
  write: 2,
  external_send: 3,
  irreversible: 4,
});

/** start 節點 variables[].type → 技能卡變數型別。 */
const START_TYPE_MAP = Object.freeze({
  "text-input": "string",
  paragraph: "string",
  select: "string",
  number: "number",
  checkbox: "boolean",
  json_object: "object",
  file: "file",
  "file-list": "array",
  external_data_tool: "string", // 外部資料工具變數,型別未知,保守 string
});

/**
 * DSL 節點 type → 副作用分級(依 node-catalog.md 的 28 類節點全集)。
 * 未在此表的未知類型 → 保守 "write"(見 classifyNodeTier)。
 */
const NODE_TIER = Object.freeze({
  start: "none",
  end: "none",
  answer: "none",
  llm: "none",
  "knowledge-retrieval": "read", // 讀內部知識庫,不改動外部世界
  "question-classifier": "none",
  "if-else": "none",
  code: "none", // 沙箱程式執行,預設無對外存取
  "http-request": "external_send", // 對外 HTTP 呼叫
  tool: "external_send", // 工具呼叫(對外/寫庫未知,另做名稱啟發式)
  iteration: "none",
  "iteration-start": "none",
  "variable-aggregator": "none",
  "template-transform": "none",
  datasource: "read", // 讀外部資料源
  "variable-assigner": "none",
  assigner: "none",
  loop: "none",
  "loop-start": "none",
  "loop-end": "none",
  "parameter-extractor": "none",
  "document-extractor": "read", // 讀文件內容
  "list-operator": "none",
  agent: "external_send", // Agent 策略可調用工具,可能對外
  "human-input": "none", // HITL 暫停,無副作用
  "trigger-schedule": "none",
  "trigger-webhook": "none",
  "trigger-plugin": "none",
});

/** 疑似代表布林「成功」的 end 輸出變數名。 */
const SUCCESS_FIELD_NAMES = Object.freeze([
  "success",
  "ok",
  "is_success",
  "succeeded",
  "passed",
  "status",
]);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 轉 slug:小寫字母/數字/連字號;非 ASCII(如中文)會被清掉,交由 buildId 兜底。 */
function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 產生穩定短雜湊(用於無可 slug 名稱時兜底)。 */
function shortHash(s) {
  return createHash("sha1").update(String(s ?? "")).digest("hex").slice(0, 8);
}

/** 由名稱推 id(slug);層層兜底,最終用雜湊保證非空且合法。 */
function buildId(name, fallbackName) {
  let id = slugify(name);
  if (!id) id = slugify(fallbackName);
  if (!id) id = "skill-" + shortHash(name || fallbackName);
  return id;
}

/** 取檔案 basename(去副檔名),用於 name/description 兜底。 */
function stemOf(p) {
  const b = basename(String(p ?? ""));
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

// ---------------------------------------------------------------------------
// 反推:輸入 / 輸出 schema
// ---------------------------------------------------------------------------

/** start 變數 Dify type → 技能卡型別(缺省 string)。 */
function inferStartType(difyType) {
  return START_TYPE_MAP[difyType] ?? "string";
}

/** end 輸出 value_type → 技能卡型別(缺省 string)。 */
function inferEndType(valueType) {
  const v = String(valueType ?? "").trim().toLowerCase();
  if (!v) return "string";
  if (v === "integer") return "number"; // 正規化 integer → number
  if (v.startsWith("array")) return "array"; // array[xxx] → array
  if (["string", "number", "boolean", "object", "array", "file"].includes(v)) return v;
  return "string";
}

/** 在圖中找第一個 type === want 的節點;找不到回 null。 */
function findNode(nodes, want) {
  for (const n of nodes ?? []) {
    if (isPlainObject(n) && isPlainObject(n.data) && n.data.type === want) return n;
  }
  return null;
}

/** 由 start 節點 variables 反推輸入 schema。 */
function inputSchemaFromStart(startNode) {
  const out = {};
  const vars = startNode?.data?.variables;
  if (!Array.isArray(vars)) return out;
  for (const v of vars) {
    if (!isPlainObject(v)) continue;
    const name = v.variable;
    if (typeof name !== "string" || !name) continue;
    out[name] = {
      type: inferStartType(v.type),
      description: (typeof v.description === "string" && v.description) ||
        (typeof v.label === "string" && v.label) ||
        "",
      required: v.required === true,
    };
  }
  return out;
}

/**
 * 兜底:由 workflow.environment_variables 反推輸入 schema。
 * environment_variables 形如 {id, name, value, description, value_type};required 一律 false。
 */
function inputSchemaFromEnv(envVars) {
  const out = {};
  if (!Array.isArray(envVars)) return out;
  for (const v of envVars) {
    if (!isPlainObject(v)) continue;
    const name = v.name;
    if (typeof name !== "string" || !name) continue;
    const rawType = String(v.value_type ?? "").toLowerCase();
    const type = rawType === "number" || rawType === "integer" ? "number" : "string";
    out[name] = {
      type,
      description: (typeof v.description === "string" && v.description) || "",
      required: false,
    };
  }
  return out;
}

/**
 * 由 value_selector 找輸出變數的描述(僅當來源是 start 節點時取用其 label/description)。
 * 否則回空字串(DSL 未提供輸出描述)。
 */
function lookupOutputDescription(nodes, valueSelector) {
  if (!Array.isArray(valueSelector) || valueSelector.length < 2) return "";
  const [nodeId, varName] = valueSelector;
  const src = findNode(nodes, "start");
  if (!src || src.id !== nodeId) return "";
  const vars = src?.data?.variables;
  if (!Array.isArray(vars)) return "";
  const hit = vars.find((v) => isPlainObject(v) && v.variable === varName);
  if (!hit) return "";
  return (typeof hit.description === "string" && hit.description) ||
    (typeof hit.label === "string" && hit.label) ||
    "";
}

/** 由 end 節點 outputs 反推輸出 schema。 */
function outputSchemaFromEnd(nodes, endNode) {
  const out = {};
  const outputs = endNode?.data?.outputs;
  if (!Array.isArray(outputs)) return out;
  for (const o of outputs) {
    if (!isPlainObject(o)) continue;
    const name = o.variable;
    if (typeof name !== "string" || !name) continue;
    out[name] = {
      type: inferEndType(o.value_type),
      description: lookupOutputDescription(nodes, o.value_selector),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 反推:副作用分級
// ---------------------------------------------------------------------------

/** tool 節點名稱啟發式:分辨「對外發送」與「寫庫」,其餘保守 external_send。 */
function classifyTool(node) {
  const d = isPlainObject(node?.data) ? node.data : {};
  const hay = [
    d.tool_name,
    d.tool_label,
    d.provider_name,
    d.plugin_unique_identifier,
  ]
    .filter((x) => typeof x === "string")
    .join(" ")
    .toLowerCase();
  if (/(mail|email|send|sms|notify|webhook|publish|push)/.test(hay)) {
    return { tier: "external_send", reason: "工具疑似對外發送(mail/notify/webhook)" };
  }
  if (/(write|insert|update|delete|upsert|create|save|db|database|sql)/.test(hay)) {
    return { tier: "write", reason: "工具疑似寫庫" };
  }
  return { tier: "external_send", reason: "工具調用,對外/寫庫未知,保守標 external_send" };
}

/** 單一節點 → {tier, reason}。 */
function classifyNodeTier(node) {
  const dslType = isPlainObject(node?.data) ? node.data.type : undefined;
  if (typeof dslType !== "string" || !dslType) {
    return { tier: "write", reason: "未知節點類型,保守標 write" };
  }
  if (!(dslType in NODE_TIER)) {
    return { tier: "write", reason: `未知節點類型 ${dslType},保守標 write` };
  }
  if (dslType === "tool") return classifyTool(node);
  if (dslType === "http-request") {
    const method = isPlainObject(node?.data) ? node.data.method : undefined;
    return { tier: "external_send", reason: `HTTP 請求對外呼叫${method ? `(method=${method})` : ""}` };
  }
  if (dslType === "agent") {
    return { tier: "external_send", reason: "Agent 策略可調用工具,可能對外" };
  }
  const tier = NODE_TIER[dslType];
  return { tier, reason: tier === "none" ? "" : `${dslType} 節點:${tier}` };
}

/** 掃全部節點,聚合最高分級 + 逐節點 note。 */
function buildSideEffects(nodes) {
  let topTier = "none";
  const notes = [];
  for (const node of nodes ?? []) {
    const { tier, reason } = classifyNodeTier(node);
    if (TIER_ORDER[tier] > TIER_ORDER[topTier]) topTier = tier;
    if (tier !== "none" && reason) {
      const label = isPlainObject(node?.data) ? node.data.title || node.data.type : node?.id;
      notes.push(`${node?.id ?? "?"}(${label ?? "?"}): ${reason}`);
    }
  }
  return { tier: topTier, notes };
}

// ---------------------------------------------------------------------------
// 反推:verify / when_to_use
// ---------------------------------------------------------------------------

/** 預設 how + 對布林式成功欄位的輕量啟發式。 */
function buildVerify(endNode) {
  const v = { how: "workflow run 状态为 succeeded 且 outputs 非空" };
  const outputs = endNode?.data?.outputs;
  if (!Array.isArray(outputs)) return v;
  const hit = outputs.find((o) => {
    const n = String(o?.variable ?? "").toLowerCase();
    return SUCCESS_FIELD_NAMES.includes(n);
  });
  if (hit) {
    v.success_field = hit.variable;
    const n = String(hit.variable).toLowerCase();
    if (["success", "ok", "is_success", "succeeded", "passed"].includes(n)) {
      v.success_values = ["true", "1", "success", "ok", "succeeded", "passed"];
    }
  }
  return v;
}

/** 由 name/description/入出參組出自然語言使用指引(草稿,可再精修)。 */
function buildWhenToUse(name, description, inputSchema, outputSchema) {
  const ins = Object.keys(inputSchema);
  const outs = Object.keys(outputSchema);
  let s = `當需要「${name}」時使用:${description}`;
  if (ins.length) s += ` 提供輸入:${ins.join("、")};`;
  if (outs.length) s += ` 產出輸出:${outs.join("、")}。`;
  return s;
}

// ---------------------------------------------------------------------------
// 組裝技能卡
// ---------------------------------------------------------------------------

/**
 * 讀取可選 app 元數據 JSON(扁平鍵:app_id / workflow_id / name / description)。
 * 解析失敗回 null(呼叫方降級為無元數據)。
 */
function loadMeta(metaPath) {
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return isPlainObject(meta) ? meta : null;
  } catch (e) {
    console.warn(`[warn] 無法解析 app 元數據 ${metaPath},忽略:${e.message}`);
    return null;
  }
}

/** 主反推:DSL 物件 → 技能卡物件。 */
export function buildSkillCard(dsl, options = {}) {
  const app = isPlainObject(dsl?.app) ? dsl.app : {};
  const workflow = isPlainObject(dsl?.workflow) ? dsl.workflow : {};
  const graph = isPlainObject(workflow.graph) ? workflow.graph : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

  const fallbackName = options.fallbackName || "workflow";
  const name = (typeof app.name === "string" && app.name.trim()) ||
    (typeof options.name === "string" && options.name.trim()) ||
    fallbackName;
  const description = (typeof app.description === "string" && app.description.trim()) ||
    (typeof options.description === "string" && options.description.trim()) ||
    `Dify 工作流 ${name}(由 ${fallbackName} 反推)`;

  const startNode = findNode(nodes, "start");
  const endNode = findNode(nodes, "end");

  let inputSchema = inputSchemaFromStart(startNode);
  if (Object.keys(inputSchema).length === 0) {
    inputSchema = inputSchemaFromEnv(workflow.environment_variables);
  }
  const outputSchema = outputSchemaFromEnd(nodes, endNode);

  const card = {
    id: buildId(name, fallbackName),
    name,
    description,
    when_to_use: buildWhenToUse(name, description, inputSchema, outputSchema),
  };

  if (typeof options.app_id === "string" && options.app_id) card.app_id = options.app_id;
  if (typeof options.workflow_id === "string" && options.workflow_id) card.workflow_id = options.workflow_id;

  card.input_schema = inputSchema;
  card.output_schema = outputSchema;
  card.side_effects = buildSideEffects(nodes);
  card.verify = buildVerify(endNode);
  card.source = {
    kind: "dify-workflow",
    dslPath: options.dslPath ?? null,
    version: typeof dsl?.version === "string" ? dsl.version : null,
  };

  return card;
}

// ---------------------------------------------------------------------------
// 可讀 Markdown
// ---------------------------------------------------------------------------

function escapeMd(s) {
  return String(s ?? "").replace(/([|\\`*_[\]<>])/g, "\\$1");
}

/** 變數 schema → markdown 表格。 */
function schemaToTable(schema) {
  if (!isPlainObject(schema) || Object.keys(schema).length === 0) {
    return "_無(空 schema)_\n";
  }
  let t = "| 變數 | 類型 | 必填 | 描述 |\n|---|---|---|---|\n";
  for (const [k, v] of Object.entries(schema)) {
    const def = isPlainObject(v) ? v : {};
    const req = def.required === true ? "是" : "否";
    t += `| \`${escapeMd(k)}\` | \`${escapeMd(def.type ?? "string")}\` | ${req} | ${escapeMd(def.description ?? "")} |\n`;
  }
  return t;
}

function renderMarkdown(card) {
  const lines = [];
  lines.push(`# ${card.name}`);
  lines.push("");
  lines.push(`- **id**: \`${card.id}\``);
  if (card.app_id) lines.push(`- **app_id**: \`${card.app_id}\``);
  if (card.workflow_id) lines.push(`- **workflow_id**: \`${card.workflow_id}\``);
  lines.push("");
  lines.push(`## 描述`);
  lines.push("");
  lines.push(card.description);
  lines.push("");
  lines.push(`## 何時使用 (when_to_use)`);
  lines.push("");
  lines.push(card.when_to_use);
  lines.push("");
  lines.push(`## 輸入 (input_schema)`);
  lines.push("");
  lines.push(schemaToTable(card.input_schema));
  lines.push(`## 輸出 (output_schema)`);
  lines.push("");
  lines.push(schemaToTable(card.output_schema));
  lines.push(`## 副作用 (side_effects)`);
  lines.push("");
  lines.push(`- **tier**: \`${card.side_effects.tier}\``);
  if (Array.isArray(card.side_effects.notes) && card.side_effects.notes.length) {
    for (const n of card.side_effects.notes) lines.push(`- ${n}`);
  } else {
    lines.push(`- _無_`);
  }
  lines.push("");
  lines.push(`## 驗證 (verify)`);
  lines.push("");
  lines.push(`- **how**: ${card.verify.how}`);
  if (card.verify.success_field) {
    lines.push(`- **success_field**: \`${card.verify.success_field}\``);
    if (Array.isArray(card.verify.success_values)) {
      lines.push(`- **success_values**: ${card.verify.success_values.map((x) => `\`${x}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push(`## 來源 (source)`);
  lines.push("");
  lines.push(`- **kind**: \`${card.source.kind}\``);
  if (card.source.dslPath) lines.push(`- **dslPath**: \`${card.source.dslPath}\``);
  if (card.source.version) lines.push(`- **version**: \`${card.source.version}\``);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.error(
    [
      "用法: node registry/generate-skillcard.mjs <dsl.yml> <out-dir> [app-meta.json]",
      "",
      "  <dsl.yml>       Dify DSL 導出 YAML 檔案(必填)",
      "  <out-dir>       輸出目錄(必填,自動建立)",
      "  [app-meta.json] 可選:app 元數據 JSON(扁平鍵 app_id / workflow_id / name / description)",
      "",
      "產出: <out-dir>/<slug>.skillcard.json 與 <out-dir>/<slug>.skillcard.md",
    ].join("\n"),
  );
}

function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (positional.length < 2) {
    printUsage();
    process.exit(2);
  }
  const [inputPath, outDir, metaPath] = positional;

  let dsl;
  try {
    dsl = YAML.parse(readFileSync(inputPath, "utf8"));
  } catch (e) {
    console.error(`[error] 無法讀取或解析 DSL YAML(${inputPath}):${e.message}`);
    process.exit(1);
  }
  if (!isPlainObject(dsl)) {
    console.error(`[error] DSL YAML(${inputPath})解析結果不是物件(可能為空檔案)。`);
    process.exit(1);
  }

  const meta = loadMeta(metaPath);
  const card = buildSkillCard(dsl, {
    fallbackName: stemOf(inputPath),
    dslPath: inputPath,
    ...(meta ?? {}),
  });

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${card.id}.skillcard.json`);
  const mdPath = join(outDir, `${card.id}.skillcard.md`);
  writeFileSync(jsonPath, JSON.stringify(card, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, renderMarkdown(card), "utf8");

  console.log(`技能卡已生成:`);
  console.log(`  JSON : ${jsonPath}`);
  console.log(`  MD   : ${mdPath}`);
  console.log(`  id   : ${card.id}`);
  console.log(`  tier : ${card.side_effects.tier}`);
  console.log(`  input: ${Object.keys(card.input_schema).length} 個變數`);
  console.log(`  output: ${Object.keys(card.output_schema).length} 個變數`);
}

// CLI 入口(僅當本檔案被直接執行時)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
